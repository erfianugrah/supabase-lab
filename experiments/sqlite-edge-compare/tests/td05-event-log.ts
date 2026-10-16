/**
 * TD05 - Analytics event log: batched ingest of seeded gateway request events, then five dashboard aggregates, on D1, Turso and Postgres
 *
 * Shape: an edge gateway's request log (ts, path, status, country, colo,
 * latency_ms, ua_class), append-only, read by a dashboard. Same schema and
 * one ts index on every backend; the seeded events (TD05_SEED) are generated
 * here, so the JavaScript ground truth checks every aggregate's answer.
 *
 * Vantage: the probe Worker for all rows (colo recorded), backends
 *   d1    the D1 binding (location hint oc; served_by_region recorded)
 *   turso @libsql/client/web over HTTP to the aws-ap-southeast-2 group
 *   tursodb  same client and group, Turso-engine database (when the fixture has one)
 *   pg    node-postgres through Hyperdrive with caching OFF, Supabase
 *         ap-southeast-2 (Micro) direct connection
 *
 *   TD05a-<backend>  ingest: `events` rows in ops of `batchRows` rows, the
 *                    backends taking turns per batch (order rotates). D1 and
 *                    Turso: one batch() per op of multi-row INSERTs of 14 rows
 *                    (D1 allows 100 bound parameters per query, 7 columns);
 *                    Postgres: one multi-row INSERT per op. Records summed op
 *                    time and rows/s on it, client wall (HTTP round trips
 *                    included), per-op p50/p95, row count after, D1
 *                    rows_written and size_after, ANALYZE outcome.
 *   TD05b-<backend>-<query>  by_hour, top_paths, status_by_country,
 *                    p95_by_colo (window functions on all three, SQLite has
 *                    no percentile aggregate), last_24h: warm-up iterations
 *                    dropped and counted, then n per query; one Worker
 *                    invocation per (iteration, backend) runs the five in
 *                    sequence, the order rotated per iteration (each query
 *                    leads equally often; p50 when first vs not first is
 *                    recorded); backends round-robin per iteration. `correct`
 *                    = the rows equal the JavaScript truth. D1 rows: rows_read
 *                    and sql_duration_ms from the binding's meta.
 *   TD05c[-tursodb]  Turso Platform API usage (rows read / written, storage)
 *                    for each Turso database, before and after, each read
 *                    repeated until rows_written settles; rows_written per
 *                    ingested event isolates the engines on one workload
 *                    before and after, when readable; the counter may lag.
 *   TD05z            cleanup.
 *
 * Sizes (env): full 100k events, 1000-row ops, n=20, warm-up 2; TD_SMOKE=1:
 * 1k events, 200-row ops, n=5, warm-up 1 (TD05_EVENTS, TD05_BATCH_ROWS,
 * TD05_N, TD05_WARMUP override).
 *
 * Pass means the backend ingested every row and every aggregate returned the
 * truth; fail is a measured error or a wrong answer (detail quotes it). Faster
 * or slower is a reading for the write-up, only where p25-p75 do not overlap.
 *
 * Not settled by this module: the local vantage (all rows are Worker-side),
 * concurrent ingest (one op in flight at a time), ingest while the dashboard
 * reads, Postgres-native percentile_cont or BRIN/partitioning (same SQL and
 * one btree on all three by design), Hyperdrive's cache on aggregates,
 * D1 read replicas (default session), cost per month.
 *
 * DESTRUCTIVE: creates table td05_events on the fixture's D1, Turso and
 * Postgres databases; dropped at start (leftover) and in finally. Self-skips
 * without the fixture (.fixture.json / PVLAB_ENDPOINT_FIXTURE).
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { fixtureOrSkip, type RunResult, runOnWorker } from "../lib/client";
import type { RunRequest, Stmt, WorkerBackend } from "../lib/contract";
import type { Fixture } from "../lib/fixture";
import { rotate, roundRobin, summarize, summaryColumns } from "../lib/stats";
import {
  chunk,
  type Dialect,
  fingerprint,
  genEvents,
  metaDistinct,
  metaNums,
  multiInsert,
  r3,
  rowsPerStatement,
  sum,
  TD05_COLS,
  TD05_QUERIES,
  TD05_SEED,
  type Td05Query,
  td05Aggregates,
  td05Ddl,
  td05Sizes,
  td05Truth,
} from "../lib/td05-06-08-data";
import { withTursodb } from "../lib/td04-07-plan";
import { tursoCreds, turso } from "../lib/vendors";

const ID = "TD05";
const BASE_BACKENDS: { b: WorkerBackend; d: Dialect }[] = [
  { b: "d1", d: "sqlite" },
  { b: "turso", d: "sqlite" },
  { b: "do", d: "sqlite" },
  { b: "pg", d: "pg" },
];
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);
const firstErr = (r: RunResult) => r.error ?? r.errors[0]?.text ?? "";

async function run(fx: Fixture, req: RunRequest<WorkerBackend>): Promise<RunResult> {
  return runOnWorker(fx, req, { timeoutMs: 180_000 });
}

/** Turso usage counters for the fixture DB, or the reason they are not readable. */
async function tursoUsage(db: string): Promise<Record<string, number> | string> {
  const t = tursoCreds();
  if (!t) return "TURSO_API_TOKEN / PVLAB_ORG_TURSO not in env";
  try {
    const r = await turso<{ database?: { usage?: Record<string, number> } }>(t, "GET", `databases/${encodeURIComponent(db)}/usage`);
    if (r.status !== 200 || !r.json.database?.usage) return `HTTP ${r.status}`;
    return r.json.database.usage;
  } catch (e) {
    return errMsg(e);
  }
}

/**
 * Usage after a wait (TD05_USAGE_WAIT_MS, default 300 s: the counter lagged by more than 20 s on 2026-10-16), then
 * re-read until rows_written stops moving (two equal reads 20 s apart, at most 6 reads).
 */
async function settledUsage(db: string): Promise<{ u: Record<string, number> | string; reads: number }> {
  await new Promise((r) => setTimeout(r, Number(process.env.TD05_USAGE_WAIT_MS ?? 300_000)));
  let prev = await tursoUsage(db);
  for (let i = 1; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 20_000));
    const cur = await tursoUsage(db);
    if (typeof prev !== "string" && typeof cur !== "string" && cur.rows_written === prev.rows_written) return { u: cur, reads: i + 1 };
    prev = cur;
  }
  return { u: prev, reads: 6 };
}

const mod: TestModule = {
  id: ID,
  title: "Analytics event log: batched ingest of seeded gateway request events, then five dashboard aggregates, on D1, Turso and Postgres",
  where: "local",
  // The battery always runs with the PAT; requiring it keeps an offline run from probing a live fixture.
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const fx = await fixtureOrSkip(ctx);
    if ("skip" in fx) return [{ id: ID, title: this.title, status: "skip", detail: fx.skip }];
    const BACKENDS = withTursodb(fx, BASE_BACKENDS);
    const sz = td05Sizes();
    const out: TestResult[] = [];
    const vantage = {
      vantage: "worker",
      seed: TD05_SEED,
      turso_location: fx.turso?.location ?? "",
      supabase_region: fx.supabase?.region ?? "",
      d1_location_hint: fx.d1?.locationHint ?? "",
      pg_driver: fx.meta?.drivers?.pg ?? "",
      libsql_driver: fx.meta?.drivers?.["@libsql/client"] ?? "",
    };
    const broken = new Map<WorkerBackend, string>();
    const live = () => BACKENDS.filter((x) => !broken.has(x.b));
    /** Drop on every backend; returns the failures ("" when all dropped). */
    const drop = async (): Promise<string> => {
      const bad: string[] = [];
      for (const { b } of BACKENDS) {
        const r = await run(fx, { backend: b, statements: [{ sql: "DROP TABLE IF EXISTS td05_events" }] }).catch((e) => ({ ok: false, error: errMsg(e), ops: [] }) as unknown as RunResult);
        if (!r.ok || !r.ops[0]?.ok) bad.push(`${b}: ${r.ops[0]?.error ?? firstErr(r)}`);
      }
      return bad.join("; ");
    };

    try {
      ctx.log(`${ID}: sizes ${JSON.stringify(sz)}`);
      const events = genEvents(sz.events);
      const truth = td05Truth(events);

      // ---- schema (drop leftover, create, index) ----
      for (const { b, d } of BACKENDS) {
        const r = await run(fx, { backend: b, statements: td05Ddl(d).map((sql) => ({ sql })) }).catch((e) => ({ ok: false, error: errMsg(e) }) as RunResult);
        const bad = !r.ok || (r.ops ?? []).some((o) => !o.ok) || (r.ops ?? []).length === 0;
        if (bad) broken.set(b, `schema: ${firstErr(r) || "no ops"}`);
      }
      // Usage per Turso database (libSQL and, when present, the Turso engine): the same ingest on both isolates rows_written per engine.
      const usageDbs: [string, string][] = [["turso", fx.turso!.db], ...(fx.tursodb?.url ? ([["tursodb", fx.tursodb.db]] as [string, string][]) : [])];
      const usage0 = new Map<string, Record<string, number> | string>();
      for (const [k, db] of usageDbs) usage0.set(k, (await settledUsage(db)).u);

      // ---- ingest: backends take turns per batch, order rotating ----
      const batches = chunk(events, sz.batchRows);
      type Acc = { opMs: number[]; httpMs: number[]; errs: Map<string, number>; rowsOk: number; colos: Set<string>; ops: RunResult["ops"] };
      const acc = new Map<WorkerBackend, Acc>(BACKENDS.map(({ b }) => [b, { opMs: [], httpMs: [], errs: new Map(), rowsOk: 0, colos: new Set(), ops: [] }]));
      const per = rowsPerStatement(TD05_COLS.length);
      for (const slot of roundRobin(BACKENDS, batches.length)) {
        const { b, d } = slot.item;
        if (broken.has(b)) continue;
        const rows = batches[slot.iter]!;
        const statements: Stmt[] = d === "sqlite" ? chunk(rows, per).map((r) => multiInsert("sqlite", "td05_events", TD05_COLS, r)) : [multiInsert("pg", "td05_events", TD05_COLS, rows)];
        const a = acc.get(b)!;
        const send = () =>
          run(fx, { backend: b, statements, mode: d === "sqlite" ? "batch" : "each", returnMeta: b === "d1", label: `${ID} ingest ${slot.iter}` }).catch(
            (e) => ({ ok: false, error: errMsg(e), ops: [], httpMs: [], colos: [] }) as unknown as RunResult,
          );
        let r = await send();
        if (!(r.ok && r.ops?.[0]?.ok)) {
          // ids are generated, so re-send only when the count shows the batch did not land (an HTTP 520 lost a batch per Turso database on 2026-10-16).
          const t = r.ops?.[0]?.error ?? firstErr(r) ?? "no op";
          const c = await run(fx, { backend: b, statements: [{ sql: "SELECT count(*) AS n FROM td05_events" }], returnRows: true, returnMeta: false }).catch(() => null);
          const n = Number(Object.values((c?.ops?.[0]?.out?.[0]?.rows?.[0] ?? {}) as Record<string, unknown>)[0]);
          if (n === a.rowsOk) {
            a.errs.set(`retried after: ${t}`, (a.errs.get(`retried after: ${t}`) ?? 0) + 1);
            r = await send();
          }
        }
        a.httpMs.push(...(r.httpMs ?? []));
        for (const c of r.colos ?? []) a.colos.add(c);
        const op = r.ops?.[0];
        if (r.ok && op?.ok) {
          a.opMs.push(op.ms);
          a.rowsOk += rows.length;
          a.ops.push(op);
        } else {
          const t = op?.error ?? firstErr(r) ?? "no op";
          a.errs.set(t, (a.errs.get(t) ?? 0) + 1);
        }
      }

      // ---- row counts, ANALYZE ----
      for (const { b } of BACKENDS) {
        const a = acc.get(b)!;
        const m: Record<string, number | string> = { backend: b, ...vantage, rows_target: sz.events, batch_rows: sz.batchRows, batches: batches.length };
        if (broken.has(b)) {
          out.push({ id: `${ID}a-${b}`, title: `ingest ${sz.events} events (${b})`, status: "fail", detail: broken.get(b)!, measurements: m });
          continue;
        }
        const cnt = await run(fx, { backend: b, statements: [{ sql: "SELECT count(*) AS n FROM td05_events" }], returnRows: true });
        const rowsAfter = Number((cnt.ops[0]?.out?.[0]?.rows?.[0] as { n?: unknown } | undefined)?.n ?? Number.NaN);
        const an = await run(fx, { backend: b, statements: [{ sql: "ANALYZE td05_events" }] });
        const opSum = sum(a.opMs);
        const s = summarize(a.opMs);
        Object.assign(m, {
          colo: [...a.colos].join("/"),
          n: a.opMs.length,
          stmts_per_op: b === "pg" ? 1 : Math.ceil(sz.batchRows / per),
          rows_ok: a.rowsOk,
          rows_after: rowsAfter,
          ingest_op_ms_sum: r3(opSum),
          ingest_http_ms_sum: r3(sum(a.httpMs)),
          rows_per_s: r3(a.rowsOk / (opSum / 1000)),
          rows_per_s_e2e: r3(a.rowsOk / (sum(a.httpMs) / 1000)),
          op_ms_p50: s.p50,
          op_ms_p95: s.p95,
          op_ms_max: s.max,
          failed_ops: sum([...a.errs.entries()].filter(([t]) => !t.startsWith("retried after")).map(([, c]) => c)),
          ingest_retries: sum([...a.errs.entries()].filter(([t]) => t.startsWith("retried after")).map(([, c]) => c)),
          analyze: an.ops[0]?.ok ? "ok" : (an.ops[0]?.error ?? firstErr(an)).slice(0, 200),
        });
        if (b === "d1") {
          m.served_by_region = metaDistinct(a.ops, "served_by_region");
          m.served_by_colo = metaDistinct(a.ops, "served_by_colo");
          m.d1_rows_written = sum(metaNums(a.ops, "rows_written"));
          const sizes = metaNums(a.ops, "size_after");
          if (sizes.length) m.d1_size_after_bytes = Math.max(...sizes);
        }
        const errs = [...a.errs.entries()].map(([t, c]) => `${c}x ${t}`).join(" | ");
        const ok = a.rowsOk === sz.events && rowsAfter === sz.events;
        if (!ok) broken.set(b, `ingest incomplete: ${a.rowsOk}/${sz.events} rows ok, count ${rowsAfter}`);
        out.push({
          id: `${ID}a-${b}`,
          title: `ingest ${sz.events} events in ${sz.batchRows}-row ops (${b}, Worker)`,
          status: ok ? "pass" : "fail",
          detail: `${a.rowsOk} rows in ${a.opMs.length} ops, ${r3(opSum)} ms summed op time (${m.rows_per_s} rows/s), count after ${rowsAfter}${errs ? `; errors: ${errs.slice(0, 400)}` : ""}`,
          measurements: m,
        });
      }

      // Queries skipped per backend (TD05_SKIP, "backend/query" list; empty string runs everything). Default: the
      // Turso engine's p95_by_colo, which counts about 4 rows written per input row per execution
      // (scripts/rows-written-probe.ts, 2026-10-16): a full run would pass the Free plan's monthly write allowance.
      const skipQ = new Set((process.env.TD05_SKIP ?? "tursodb/p95_by_colo").split(",").map((x) => x.trim()).filter(Boolean));
      const qsFor = (b: WorkerBackend) => TD05_QUERIES.filter((q) => !skipQ.has(`${b}/${q}`));

      // ---- correctness: one pass returning rows ----
      const correct = new Map<string, number>();
      const wrong: string[] = [];
      for (const { b, d } of live()) {
        const aggs = td05Aggregates(d);
        const qs = qsFor(b);
        const r = await run(fx, { backend: b, statements: qs.map((q) => aggs[q]), returnRows: true, rowsLimit: 1000, returnMeta: false });
        for (const [k, q] of qs.entries()) {
          const op = r.ops.find((o) => o.stmt === k);
          const ok = !!op?.ok && fingerprint(op.out?.[0]?.rows ?? []) === fingerprint(truth[q]);
          correct.set(`${b}/${q}`, ok ? 1 : 0);
          if (!ok) wrong.push(`${b}/${q}: ${op?.error ?? `rows differ (got ${op?.out?.[0]?.rowCount ?? 0}, want ${truth[q].length})`}`);
        }
      }

      // ---- timed aggregates: round-robin per iteration, warm-up first ----
      type Sample = { ms: number; ok: boolean; warm: boolean; error?: string; meta?: Record<string, unknown>; pos?: number };
      const samples = new Map<string, Sample[]>();
      const colos = new Map<WorkerBackend, Set<string>>();
      const served = new Map<string, unknown[]>();
      for (const slot of roundRobin(live(), sz.n + sz.warmup, sz.warmup)) {
        const { b, d } = slot.item;
        const aggs = td05Aggregates(d);
        // Order rotates per iteration so the first-statement cost (client setup on the invocation) is spread over every query.
        const order = rotate(qsFor(b), slot.iter);
        const r = await run(fx, { backend: b, statements: order.map((q) => aggs[q]), returnMeta: b === "d1", label: `${ID} agg ${slot.iter}` }).catch(
          (e) => ({ ok: false, error: errMsg(e), ops: [], colos: [] }) as unknown as RunResult,
        );
        for (const c of r.colos ?? []) (colos.get(b) ?? colos.set(b, new Set()).get(b)!).add(c);
        for (const [k, q] of order.entries()) {
          const op = r.ops?.find((o) => o.stmt === k);
          const key = `${b}/${q}`;
          const list = samples.get(key) ?? samples.set(key, []).get(key)!;
          list.push(op ? { ms: op.ms, ok: op.ok, warm: slot.warmup, error: op.error, meta: op.out?.[0]?.meta, pos: k } : { ms: Number.NaN, ok: false, warm: slot.warmup, error: firstErr(r) || "no op" });
          if (b === "d1" && op?.out?.[0]?.meta) (served.get(key) ?? served.set(key, []).get(key)!).push(op.out[0].meta);
        }
      }
      for (const { b } of live()) {
        for (const q of TD05_QUERIES as readonly Td05Query[]) {
          const key = `${b}/${q}`;
          if (skipQ.has(key)) {
            out.push({
              id: `${ID}b-${b}-${q}`,
              title: `${q} on ${b}: skipped`,
              status: "skip",
              detail: `skipped (TD05_SKIP): on the Turso engine this window-function query counted about 4 rows written per input row per execution (scripts/rows-written-probe.ts, 2026-10-16); ${sz.events} rows x ${sz.n + sz.warmup + 1} passes would exhaust the Free plan's monthly write allowance`,
              measurements: { backend: b, query: q, skipped: 1 },
            });
            continue;
          }
          const list = samples.get(key) ?? [];
          const kept = list.filter((x) => !x.warm && x.ok).map((x) => x.ms);
          const s = { ...summarize(kept), dropped: list.filter((x) => x.warm).length };
          const fails = list.filter((x) => !x.warm && !x.ok);
          const m: Record<string, number | string> = {
            backend: b,
            query: q,
            ...vantage,
            rows_in_table: sz.events,
            colo: [...(colos.get(b) ?? [])].join("/"),
            ...summaryColumns("ms", s),
            failed: fails.length,
            correct: correct.get(key) ?? 0,
            query_order: "rotated per iteration",
          };
          const kk = list.filter((x) => !x.warm && x.ok);
          const first = kk.filter((x) => x.pos === 0).map((x) => x.ms);
          const later = kk.filter((x) => x.pos !== 0).map((x) => x.ms);
          m.n_first_in_invocation = first.length;
          if (first.length) m.ms_p50_first_in_invocation = summarize(first).p50;
          if (later.length) m.ms_p50_not_first = summarize(later).p50;
          if (b === "d1") {
            const metas = (served.get(key) ?? []).map((meta) => ({ ok: true, ms: 0, stmt: 0, out: [{ meta: meta as Record<string, unknown> }] }));
            m.served_by_region = metaDistinct(metas, "served_by_region");
            m.served_by_colo = metaDistinct(metas, "served_by_colo");
            const rr = metaNums(metas, "rows_read");
            if (rr.length) m.d1_rows_read_p50 = summarize(rr).p50;
            const sd = metaNums(metas, "timings.sql_duration_ms");
            if (sd.length) m.d1_sql_duration_ms_p50 = summarize(sd).p50;
          }
          const ok = fails.length === 0 && s.n > 0 && m.correct === 1;
          out.push({
            id: `${ID}b-${b}-${q}`,
            title: `${q} over ${sz.events} events (${b}, Worker)`,
            status: ok ? "pass" : "fail",
            detail: ok
              ? `p50 ${s.p50} ms, p95 ${s.p95} ms (n=${s.n}, ${s.dropped} warm-up dropped)${m.d1_rows_read_p50 !== undefined ? `, D1 rows_read ${m.d1_rows_read_p50}` : ""}`
              : `${fails.length} failed${fails[0]?.error ? `: ${fails[0].error.slice(0, 300)}` : ""}${m.correct ? "" : `; wrong answer: ${wrong.find((w) => w.startsWith(key)) ?? "not checked"}`}`,
            measurements: m,
          });
        }
      }

      // ---- Turso usage counters ----
      for (const [b, db] of usageDbs) {
        const u0 = usage0.get(b)!;
        const { u: u1, reads } = await settledUsage(db);
        const id = b === "turso" ? `${ID}c` : `${ID}c-${b}`;
        if (typeof u0 === "string" || typeof u1 === "string") {
          out.push({ id, title: `Turso usage counters (${b}, Platform API)`, status: "info", detail: `not readable: ${typeof u0 === "string" ? u0 : u1}` });
          continue;
        }
        const m: Record<string, number | string> = { backend: b, source: "GET /v1/organizations/{org}/databases/{db}/usage", usage_reads_after: reads, events: sz.events };
        for (const k of ["rows_read", "rows_written", "storage_bytes"]) {
          m[`${k}_before`] = u0[k] ?? Number.NaN;
          m[`${k}_after`] = u1[k] ?? Number.NaN;
          m[`${k}_delta`] = (u1[k] ?? Number.NaN) - (u0[k] ?? Number.NaN);
        }
        m.rows_written_per_event = Math.round(((m.rows_written_delta as number) / sz.events) * 1000) / 1000;
        out.push({
          id,
          title: `Turso usage counters across TD05 (${b}; Platform API, re-read until rows_written settled)`,
          status: "info",
          detail: `rows_read +${m.rows_read_delta}, rows_written +${m.rows_written_delta} (${m.rows_written_per_event} per ingested event), storage ${m.storage_bytes_after} bytes after; read after a ${Number(process.env.TD05_USAGE_WAIT_MS ?? 300_000) / 1000} s wait, settled after ${reads} reads (the counter lags; earlier writes to the same database can still land in the before-read)`,
          measurements: m,
        });
      }
    } catch (e) {
      out.push({ id: ID, title: this.title, status: "fail", detail: `threw: ${errMsg(e)}` });
    } finally {
      const bad = await drop();
      out.push({ id: `${ID}z`, title: "cleanup", status: bad ? "fail" : "pass", detail: bad ? `drop failed: ${bad}` : "dropped td05_events on every backend in the run" });
    }
    return out;
  },
};
export default mod;
