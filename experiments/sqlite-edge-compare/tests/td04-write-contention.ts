/**
 * TD04 - Write contention: single-row inserts and hot-row increments at
 * concurrency 1/4/16/64 on D1, Turso libSQL and Postgres via Hyperdrive; plus
 * a Turso-engine (MVCC, BEGIN CONCURRENT) row if the Platform API can create one.
 *
 * Question: as writers are added, what happens to throughput, error rate and
 * correctness on each backend? D1 documents each database as single-threaded
 * ("processes queries one at a time") with an overflow error ("D1 DB is
 * overloaded. Too many requests queued."); libSQL is SQLite with one writer;
 * Postgres takes row locks. Facts: docs/research/2026-10-15-sqlite-edge-compare-facts.md.
 *
 * Every Worker row: vantage = the probe Worker (colo recorded per row), one
 * statement per op in mode "each", autocommit. Concurrency C is spread over
 * ceil(C/4) parallel Worker invocations of min(C,4) lanes each (Workers let six
 * connections per invocation wait at once; the same shape for every backend).
 * Parallel invocations from one client do not always land in one colo (smoke
 * 2026-10-15: SIN plus MRS or NRT), so each row records inv_colos, the colo
 * of every invocation with counts. Backends: d1 (binding, location hint oc,
 * served_by_region recorded), turso
 * (libSQL database in aws-ap-southeast-2 over @libsql/client/web), pg
 * (node-postgres through Hyperdrive with caching off, Supabase ap-southeast-2).
 *
 *   TD04a-<backend>-c<C>  INSERT INTO td04_ins (v) VALUES (<64-byte constant>),
 *                         n = TD04_OPS attempted (256 full, 16 smoke); rows
 *                         counted afterwards must equal the ok ops.
 *   TD04b-<backend>-c<C>  UPDATE td04_ctr SET n = n + 1 WHERE id = 1 (one hot
 *                         row, an atomic increment); final n must equal the ok
 *                         ops. A mismatch is a "fail" (an errored op that
 *                         committed, or a lost update).
 *   TD04m0  POST /v1/organizations/{org}/databases with use_tursodb: true (the
 *           field turso-cli sends for `db create --tursodb`; not in the API
 *           reference). Engine read from the returned DbId the way turso-cli
 *           does (byte 5 = 0x10). "not creatable via Platform API" with the
 *           response when it fails. Smoke 2026-10-15: HTTP 400 "tursodb is not
 *           enabled for organization ...; an owner must enable it in the
 *           organization settings", and GET /v1/organizations/{org} carries
 *           tursodb_enabled: false (recorded; this module never changes org
 *           settings, so TD04m1/m2 run only on an org where it is enabled).
 *   TD04m1  PRAGMA journal_mode on both databases; BEGIN CONCURRENT then
 *           ROLLBACK on both (the libSQL one is the control).
 *   TD04m2-<engine>-<workload>-c<C>  local vantage only (the probe Worker binds
 *           only the fixture's libSQL database): interactive transactions over
 *           Hrana HTTP, one statement per round trip. tursodb opens with BEGIN
 *           CONCURRENT, the libSQL baseline with BEGIN IMMEDIATE. Workloads:
 *           insert (BEGIN; INSERT; COMMIT) and rmw (BEGIN; SELECT n; UPDATE
 *           SET n = <read + 1>; COMMIT). Conflict-shaped errors are retried up
 *           to 25 attempts; committed transactions, conflicts, final counter vs
 *           committed (lost updates) recorded. n = TD04_MVCC_OPS (64 / 8).
 *
 * Status: pass = no errors and the count matches; info = errors (recorded
 * verbatim, with counts) but the count matches the ok ops; fail = count
 * mismatch. Order: concurrency levels ascend; backend order rotates per level
 * (roundRobin) and the two workloads alternate which goes first.
 *
 * Not settled by this module: contention across regions or read replicas,
 * multi-row transactions under contention (TD07 covers one concurrent writer),
 * D1 throughput from many Worker colos at once (all invocations originate from
 * one client and land in one colo), and anything about the Turso engine beyond
 * whether BEGIN CONCURRENT is accepted and how it behaves on one hot row.
 *
 * DESTRUCTIVE: creates td04_* tables on the three fixture backends (dropped in
 * finally), td04m_* tables on the fixture's libSQL database (dropped), and one
 * sec-td04m-* Turso database in the fixture's group (deleted in finally).
 * Self-skips without the fixture; the TD04m rows skip without TURSO_API_TOKEN
 * and PVLAB_TURSO_ORG / PVLAB_ORG_TURSO.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { type Fixture, fixtureOrSkip, mergeRuns, type RunResult, runOnWorker } from "../lib/client";
import { DO_LOCATION_HINT, type WorkerBackend } from "../lib/contract";
import { roundRobin, summarize, summaryColumns } from "../lib/stats";
import { HranaStream, runTx, type TxOutcome } from "../lib/td04-07-hrana";
import {
  dialectOf,
  withTursodb,
  firstMeta,
  isConflict,
  laneSplit,
  perInvocation,
  scalar,
  scrub,
  TD04_PAYLOAD,
  TD04_SQL,
  td04Sizes,
  throughput,
  topErrors,
  tursoEngineOf,
} from "../lib/td04-07-plan";
import { assertSec, deleteTursoDb, sleep, turso, tursoCreds, tursoDbToken } from "../lib/vendors";

const ID = "TD04";
const BASE_BACKENDS: WorkerBackend[] = ["d1", "turso", "do", "pg"];
type Workload = "insert" | "incr";

/** "SIN:3,MRS:1" in order of first appearance. */
function coloCounts(colos: string[]): string {
  const m = new Map<string, number>();
  for (const c of colos) m.set(c, (m.get(c) ?? 0) + 1);
  return [...m.entries()].map(([c, n]) => `${c}:${n}`).join(",");
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function dataRegion(fx: Fixture, b: WorkerBackend, r?: RunResult): string {
  if (b === "d1") return (r && firstMeta(r.ops, "served_by_region")) || "?";
  if (b === "turso" || b === "tursodb") return fx.turso?.location ?? "?";
  if (b === "do") return `hint ${DO_LOCATION_HINT}`;
  return fx.supabase?.region ?? "?";
}

async function setupSql(fx: Fixture, b: WorkerBackend, sqls: string[]): Promise<RunResult> {
  return runOnWorker(fx, { backend: b, mode: "batch", statements: sqls.map((sql) => ({ sql })), label: "td04-setup" });
}

/** One Worker cell: reset, run, count. */
async function cell(fx: Fixture, b: WorkerBackend, wl: Workload, c: number, total: number, lit: string[]): Promise<TestResult> {
  const sql = TD04_SQL[dialectOf(b)];
  const id = `${ID}${wl === "insert" ? "a" : "b"}-${b}-c${c}`;
  const title = `${wl === "insert" ? "single-row inserts" : "hot-row increment"}, ${b}, concurrency ${c}`;
  const reset = await setupSql(fx, b, sql.reset);
  if (!reset.ok || reset.errors.length) {
    return { id, title, status: "fail", detail: `reset failed: ${scrub(reset.error ?? topErrors(reset.errors), lit)}`, measurements: { backend: b, vantage: "worker", workload: wl, concurrency: c } };
  }
  const { invocations, lanes } = laneSplit(c);
  const per = perInvocation(total, invocations);
  const stmt = wl === "insert" ? { sql: sql.insert, params: [TD04_PAYLOAD] } : { sql: sql.incr };
  const t0 = performance.now();
  // k single-invocation calls in parallel (what runOnWorker's `invocations` does), kept apart so each
  // invocation's colo is known: parallel requests from one client do not always land in one colo.
  const parts = await Promise.all(Array.from({ length: invocations }, () => runOnWorker(fx, { backend: b, statements: [stmt], repeat: per, concurrency: lanes, label: `td04-${wl}-c${c}` })));
  const res = mergeRuns(parts, parts.flatMap((p) => p.httpMs));
  const invColos = coloCounts(parts.map((p) => p.colo || "?"));
  const clientWall = performance.now() - t0;
  const tp = throughput(res.ops, res.lanes);
  const check = await runOnWorker(fx, { backend: b, statements: [{ sql: wl === "insert" ? sql.countIns : sql.readCtr }], returnRows: true, label: "td04-check" });
  const finalRaw = scalar(check);
  const final = finalRaw === null ? Number.NaN : Number(finalRaw);
  const diff = final - tp.ok;
  const lat = summarize(res.ops.filter((o) => o.ok).map((o) => o.ms));
  const status = !Number.isFinite(final) ? "fail" : diff !== 0 ? "fail" : tp.failed || tp.laneErrors || res.error ? "info" : "pass";
  const errs = scrub(topErrors(res.errors, 3), lit);
  return {
    id,
    title,
    status,
    detail:
      `${tp.ok}/${tp.attempted} ok, ${tp.opsPerSec} ops/s over ${tp.spanMs} ms (${invocations} inv x ${lanes} lanes, colos ${invColos}); ` +
      `${wl === "insert" ? "rows counted" : "final counter"} ${Number.isFinite(final) ? final : `unreadable (${scrub(check.error ?? topErrors(check.errors), lit)})`} vs ${tp.ok} ok ops` +
      (errs ? `; errors: ${errs}` : "") +
      (res.error ? `; request: ${scrub(res.error, lit).slice(0, 200)}` : ""),
    measurements: {
      backend: b,
      vantage: "worker",
      colo: res.colos.join("+") || "?",
      inv_colos: invColos,
      data_region: dataRegion(fx, b, res),
      workload: wl,
      concurrency: c,
      invocations,
      lanes_per_inv: lanes,
      n: tp.attempted,
      ok: tp.ok,
      failed: tp.failed,
      lane_errors: tp.laneErrors,
      error_rate: tp.errorRate,
      ops_s: tp.opsPerSec,
      span_ms: tp.spanMs,
      client_wall_ms: Math.round(clientWall),
      ...summaryColumns("lat", lat),
      final_count: Number.isFinite(final) ? final : "unreadable",
      count_minus_ok: Number.isFinite(diff) ? diff : "n/a",
      distinct_errors: res.errors.length,
      driver: `${res.driver.name} ${res.driver.version}`.trim(),
    },
    ...(res.errors.length ? { evidence: scrub(topErrors(res.errors, 10, 500), lit) } : {}),
  };
}

/* --------------------------- Turso engine (MVCC) -------------------------- */

interface Engine {
  label: "tursodb" | "libsql";
  url: string;
  token: string;
  begin: string;
  location: string;
}

async function waitAnswers(url: string, token: string, tries = 24): Promise<string> {
  let last = "";
  for (let i = 0; i < tries; i++) {
    const s = new HranaStream(url, token);
    try {
      await s.exec("select 1");
      await s.close();
      return "";
    } catch (e) {
      last = errMsg(e);
      await sleep(5_000);
    }
  }
  return last || "no answer";
}

/**
 * Run `sql` in order; returns the last statement's rows. Turso Cloud answers
 * an autocommit statement with no baton, on the libSQL and the Turso-engine
 * database alike (TD04m1, 2026-10-16), so the stream ends there and only a
 * statement inside an open transaction gets one back; HranaStream then raises
 * its own STREAM_CLOSED on the next exec. Statements get a stream each unless
 * `sameStream` (needed for BEGIN ... ROLLBACK).
 */
async function oneShot(e: Pick<Engine, "url" | "token">, sql: string[], sameStream = false): Promise<{ ok: boolean; rows: unknown[][]; error?: string }> {
  let s = new HranaStream(e.url, e.token);
  try {
    let rows: unknown[][] = [];
    for (const [i, q] of sql.entries()) {
      if (i > 0 && !sameStream) {
        await s.close();
        s = new HranaStream(e.url, e.token);
      }
      rows = (await s.exec(q)).rows;
    }
    await s.close();
    return { ok: true, rows };
  } catch (err) {
    await s.close();
    const code = (err as { code?: string }).code;
    return { ok: false, rows: [], error: `${code ? `[${code}] ` : ""}${errMsg(err)}` };
  }
}

/** C lanes run interactive transactions until `total` have been attempted. */
async function mvccCell(e: Engine, wl: "insert" | "rmw", c: number, total: number, maxAttempts: number, lit: string[]): Promise<TestResult> {
  const id = `${ID}m2-${e.label}-${wl}-c${c}`;
  const title = `${e.label} ${e.begin} interactive ${wl === "insert" ? "insert" : "read-modify-write on one row"}, concurrency ${c} (local)`;
  const reset = await oneShot(e, ["DELETE FROM td04m_ins", "DELETE FROM td04m_ctr", "INSERT INTO td04m_ctr (id, n) VALUES (1, 0)"]);
  if (!reset.ok) return { id, title, status: "fail", detail: `reset: ${scrub(reset.error ?? "", lit)}`, measurements: { engine: e.label, vantage: "local", workload: wl, concurrency: c } };
  const outcomes: TxOutcome[] = [];
  let next = 0;
  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: c }, async () => {
      while (next < total) {
        next++;
        outcomes.push(
          await runTx(
            () => new HranaStream(e.url, e.token),
            e.begin,
            async (s) => {
              if (wl === "insert") await s.exec("INSERT INTO td04m_ins (v) VALUES (?)", [TD04_PAYLOAD]);
              else {
                const r = await s.exec("SELECT n FROM td04m_ctr WHERE id = 1");
                await s.exec("UPDATE td04m_ctr SET n = ? WHERE id = 1", [Number(r.rows[0]?.[0] ?? 0) + 1]);
              }
            },
            isConflict,
            maxAttempts,
          ),
        );
      }
    }),
  );
  const wall = performance.now() - t0;
  const committed = outcomes.filter((o) => o.ok).length;
  const conflicts = outcomes.reduce((a, o) => a + o.conflicts, 0);
  const check = await oneShot(e, [wl === "insert" ? "SELECT count(*) FROM td04m_ins" : "SELECT n FROM td04m_ctr WHERE id = 1"]);
  const final = check.ok ? Number(check.rows[0]?.[0]) : Number.NaN;
  const errCounts = new Map<string, number>();
  for (const o of outcomes) for (const t of o.errors) errCounts.set(t, (errCounts.get(t) ?? 0) + 1);
  const errors = [...errCounts.entries()].map(([text, count]) => ({ text, count })).sort((a, b) => b.count - a.count);
  const diff = final - committed;
  const attempts = outcomes.map((o) => o.attempts);
  const status = !Number.isFinite(final) || diff !== 0 ? "fail" : committed < outcomes.length || errors.length ? "info" : "pass";
  const errs = scrub(topErrors(errors, 3), lit);
  return {
    id,
    title,
    status,
    detail:
      `${committed}/${outcomes.length} committed, ${conflicts} retried conflicts, ${Math.round((committed * 100000) / wall) / 100} tx/s over ${Math.round(wall)} ms; ` +
      `${wl === "insert" ? "rows counted" : "final counter"} ${Number.isFinite(final) ? final : `unreadable (${scrub(check.error ?? "", lit)})`} vs ${committed} committed` +
      (errs ? `; errors: ${errs}` : ""),
    measurements: {
      engine: e.label,
      begin: e.begin,
      vantage: "local",
      colo: "local",
      data_region: e.location,
      workload: wl,
      concurrency: c,
      n: outcomes.length,
      committed,
      gave_up: outcomes.length - committed,
      conflicts_retried: conflicts,
      attempts_max: attempts.length ? Math.max(...attempts) : 0,
      tx_s: Math.round((committed * 100000) / wall) / 100,
      wall_ms: Math.round(wall),
      ...summaryColumns("tx", summarize(outcomes.filter((o) => o.ok).map((o) => o.ms))),
      final_count: Number.isFinite(final) ? final : "unreadable",
      count_minus_committed: Number.isFinite(diff) ? diff : "n/a",
      distinct_errors: errors.length,
      driver: "hrana-http /v2/pipeline (hand-rolled)",
    },
    ...(errors.length ? { evidence: scrub(topErrors(errors, 10, 500), lit) } : {}),
  };
}

async function mvccRows(fx: Fixture, out: TestResult[], lit: string[]): Promise<void> {
  const t = tursoCreds();
  if (!t) {
    out.push({ id: `${ID}m0`, title: "Turso-engine database via the Platform API", status: "skip", detail: "TURSO_API_TOKEN and PVLAB_TURSO_ORG (or PVLAB_ORG_TURSO) not set" });
    return;
  }
  lit.push(t.org);
  const sz = td04Sizes();
  const name = assertSec(`sec-td04m-${Date.now().toString(36)}`);
  const group = assertSec(fx.turso!.group);
  let created = false;
  const lib: Engine = { label: "libsql", url: fx.turso!.url, token: fx.turso!.token!, begin: "BEGIN IMMEDIATE", location: fx.turso!.location };
  let libTables = false;
  try {
    // m0: create with the field turso-cli sends for --tursodb.
    const t0 = performance.now();
    const r = await turso<{ database?: { DbId?: string; Hostname?: string; Name?: string } }>(t, "POST", "databases", { name, group, use_tursodb: true });
    const createMs = Math.round(performance.now() - t0);
    created = r.status === 200 || r.status === 201;
    const engine = tursoEngineOf(r.json.database?.DbId);
    const ctl = await turso<{ database?: { DbId?: string } }>(t, "GET", `databases/${encodeURIComponent(fx.turso!.db)}`);
    // The org object carries the gate (read only; this module never changes org settings).
    const orgRead = await fetch(`https://api.turso.tech/v1/organizations/${t.org}`, { headers: { Authorization: `Bearer ${t.token}` }, signal: AbortSignal.timeout(30_000) })
      .then(async (x) => ((await x.json()) as { organization?: Record<string, unknown> }).organization ?? {})
      .catch(() => ({}) as Record<string, unknown>);
    const orgGate = orgRead.tursodb_enabled === undefined ? "absent" : String(orgRead.tursodb_enabled);
    const orgPlan = String(orgRead.plan_id ?? "?");
    const ctlEngine = tursoEngineOf(ctl.json.database?.DbId);
    const body = scrub(r.text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>"), lit).slice(0, 400);
    const creatable = created && engine === "tursodb";
    out.push({
      id: `${ID}m0`,
      title: "Turso-engine (MVCC) database via the Platform API (use_tursodb: true)",
      status: creatable ? "pass" : "info",
      detail: creatable
        ? `created in ${createMs} ms, DbId classifies as tursodb (fixture database: ${ctlEngine ?? "?"})`
        : created
          ? `HTTP ${r.status} but the DbId classifies as ${engine ?? "?"}: the field was ignored or the classifier does not apply; not creatable via Platform API as far as this row shows. Response: ${body}`
          : /not enabled for organization/i.test(r.text)
            ? `not creatable via Platform API on this org: the API reads use_tursodb but refuses it until an org owner enables tursodb in the organization settings (org object: tursodb_enabled ${orgGate}, plan_id ${orgPlan}). HTTP ${r.status} ${body}`
            : `not creatable via Platform API: HTTP ${r.status} ${body}`,
      measurements: { http_status: r.status, create_ms: createMs, engine: engine ?? "unknown", control_engine: ctlEngine ?? "unknown", org_tursodb_enabled: orgGate, org_plan_id: orgPlan, group_location: fx.turso!.location, vantage: "local" },
      evidence: body,
    });
    if (!created) {
      out.push({ id: `${ID}m2`, title: "BEGIN CONCURRENT interactive transactions", status: "skip", detail: "no Turso-engine database (TD04m0)" });
      return;
    }
    const host = r.json.database?.Hostname ?? "";
    if (host) lit.push(host);
    const token = await tursoDbToken(t, name, "1d");
    const mv: Engine = { label: "tursodb", url: `https://${host}`, token, begin: "BEGIN CONCURRENT", location: fx.turso!.location };
    const wait = await waitAnswers(mv.url, mv.token);
    if (wait) {
      out.push({ id: `${ID}m1`, title: "journal_mode and BEGIN CONCURRENT", status: "fail", detail: `new database did not answer /v2/pipeline: ${scrub(wait, lit)}` });
      return;
    }

    // m1: what each database says about journal_mode and BEGIN CONCURRENT.
    const jm = { tursodb: await oneShot(mv, ["PRAGMA journal_mode"]), libsql: await oneShot(lib, ["PRAGMA journal_mode"]) };
    let setMvcc: Awaited<ReturnType<typeof oneShot>> | null = null;
    if (!jm.tursodb.ok || String(jm.tursodb.rows[0]?.[0] ?? "").toLowerCase() !== "mvcc") {
      // Docs disagree on the default; try the documented opt-in on the throwaway database only.
      setMvcc = await oneShot(mv, ["PRAGMA journal_mode = 'mvcc'"]);
    }
    const bc = { tursodb: await oneShot(mv, ["BEGIN CONCURRENT", "ROLLBACK"], true), libsql: await oneShot(lib, ["BEGIN CONCURRENT", "ROLLBACK"], true) };
    // Two autocommit statements on one Hrana stream: does the server keep the stream open between them?
    const two = { tursodb: await oneShot(mv, ["SELECT 1", "SELECT 2"], true), libsql: await oneShot(lib, ["SELECT 1", "SELECT 2"], true) };
    // Is journal_mode settable on Cloud? Throwaway database only; the answer is recorded, not relied on.
    const setWal = await oneShot(mv, ["PRAGMA journal_mode = wal"]);
    const show = (x: Awaited<ReturnType<typeof oneShot>>) => (x.ok ? `ok ${JSON.stringify(x.rows[0] ?? [])}` : `error: ${scrub(x.error ?? "", lit)}`);
    out.push({
      id: `${ID}m1`,
      title: "PRAGMA journal_mode and BEGIN CONCURRENT on the Turso-engine database vs the libSQL fixture database",
      status: bc.tursodb.ok ? "pass" : "info",
      detail:
        `tursodb: journal_mode ${show(jm.tursodb)}${setMvcc ? `; set mvcc ${show(setMvcc)}` : ""}; BEGIN CONCURRENT ${show(bc.tursodb)}. ` +
        `libsql: journal_mode ${show(jm.libsql)}; BEGIN CONCURRENT ${show(bc.libsql)}. ` +
        `Second autocommit statement on one stream: tursodb ${show(two.tursodb)}, libsql ${show(two.libsql)}. tursodb PRAGMA journal_mode = wal: ${show(setWal)}`,
      measurements: {
        vantage: "local",
        tursodb_journal_mode: jm.tursodb.ok ? String(jm.tursodb.rows[0]?.[0] ?? "") : "error",
        tursodb_set_mvcc: setMvcc ? (setMvcc.ok ? String(setMvcc.rows[0]?.[0] ?? "ok") : "error") : "not tried",
        tursodb_begin_concurrent: bc.tursodb.ok ? "accepted" : "error",
        libsql_journal_mode: jm.libsql.ok ? String(jm.libsql.rows[0]?.[0] ?? "") : "error",
        libsql_begin_concurrent: bc.libsql.ok ? "accepted" : "error",
        tursodb_stream_after_autocommit: two.tursodb.ok ? "open" : "closed",
        libsql_stream_after_autocommit: two.libsql.ok ? "open" : "closed",
        tursodb_set_wal: setWal.ok ? "accepted" : "refused",
      },
    });
    if (!bc.tursodb.ok) return;

    // m2: interactive transactions, tursodb BEGIN CONCURRENT vs libSQL BEGIN IMMEDIATE.
    const ddl = ["CREATE TABLE IF NOT EXISTS td04m_ins (id INTEGER PRIMARY KEY, v TEXT NOT NULL)", "CREATE TABLE IF NOT EXISTS td04m_ctr (id INTEGER PRIMARY KEY, n INTEGER NOT NULL)"];
    for (const e of [mv, lib]) {
      const d = await oneShot(e, ddl);
      if (e === lib) libTables = true;
      if (!d.ok) {
        out.push({ id: `${ID}m2-${e.label}`, title: `${e.label} schema`, status: "fail", detail: scrub(d.error ?? "", lit) });
        return;
      }
    }
    for (const [k, c] of sz.mvccLevels.entries()) {
      const engines = k % 2 ? [lib, mv] : [mv, lib];
      for (const wl of k % 2 ? (["rmw", "insert"] as const) : (["insert", "rmw"] as const)) {
        for (const e of engines) out.push(await mvccCell(e, wl, c, sz.mvccOps, sz.mvccMaxAttempts, lit));
      }
    }
  } catch (e) {
    out.push({ id: `${ID}m`, title: "Turso-engine rows", status: "fail", detail: `threw: ${scrub(errMsg(e), lit)}` });
  } finally {
    const notes: string[] = [];
    if (libTables) {
      const d = await oneShot(lib, ["DROP TABLE IF EXISTS td04m_ins", "DROP TABLE IF EXISTS td04m_ctr"]);
      notes.push(`td04m_* on libSQL ${d.ok ? "dropped" : `drop failed: ${scrub(d.error ?? "", lit)}`}`);
    }
    if (created) {
      const st = await deleteTursoDb(t, name).catch((e) => `error ${errMsg(e)}`);
      notes.push(`Turso-engine database delete: ${st}`);
    }
    if (notes.length) out.push({ id: `${ID}mz`, title: "cleanup (Turso-engine rows)", status: notes.some((n) => /fail|error/.test(n)) ? "fail" : "pass", detail: notes.join("; ") });
  }
}

/* --------------------------------- module -------------------------------- */

const mod: TestModule = {
  id: ID,
  title: "Write contention: single-row inserts and hot-row increments at concurrency 1/4/16/64 on D1, Turso libSQL and Postgres via Hyperdrive",
  where: "local",
  requires: [],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const fx = await fixtureOrSkip(ctx);
    if ("skip" in fx) return [{ id: ID, title: this.title, status: "skip", detail: fx.skip }];
    const BACKENDS = withTursodb(fx, BASE_BACKENDS);
    const sz = td04Sizes();
    const lit = [fx.supabase?.ref, fx.d1?.id, fx.turso?.hostname, fx.tursodb?.hostname, fx.turso?.org].filter((x): x is string => !!x);
    const out: TestResult[] = [];
    const ready: WorkerBackend[] = [];
    try {
      for (const b of BACKENDS) {
        const r = await setupSql(fx, b, TD04_SQL[dialectOf(b)].create);
        if (r.ok && !r.errors.length) ready.push(b);
        else out.push({ id: `${ID}-${b}-setup`, title: `schema on ${b}`, status: "fail", detail: scrub(r.error ?? topErrors(r.errors), fx.turso ? lit : []) });
      }
      // Warm-up: one cheap op per backend so cell 1 does not pay a cold path alone. Not recorded.
      for (const b of ready) await runOnWorker(fx, { backend: b, statements: [{ sql: "SELECT 1" }], label: "td04-warmup" });
      out.push({
        id: `${ID}-plan`,
        title: "sizes and vantage",
        status: "info",
        detail: `levels ${sz.levels.join("/")}, ${sz.opsPerCell} ops per cell, ${sz.smoke ? "SMOKE sizes" : "full sizes"}; backends ${ready.join(",")}; one warm-up op per backend before the first cell, not recorded`,
        measurements: { smoke: sz.smoke ? 1 : 0, ops_per_cell: sz.opsPerCell, levels: sz.levels.join("/"), warmup_ops_per_backend: 1, supabase_region: fx.supabase?.region ?? "?", turso_location: fx.turso?.location ?? "?", d1_location_hint: fx.d1?.locationHint ?? "?" },
      });
      const schedule = roundRobin(ready, sz.levels.length);
      for (const [k, c] of sz.levels.entries()) {
        const order = schedule.filter((s) => s.iter === k).map((s) => s.item);
        const wls: Workload[] = k % 2 ? ["incr", "insert"] : ["insert", "incr"];
        for (const wl of wls) for (const b of order) out.push(await cell(fx, b, wl, c, sz.opsPerCell, lit));
      }
      await mvccRows(fx, out, lit);
    } catch (e) {
      out.push({ id: ID, title: this.title, status: "fail", detail: `threw: ${scrub(errMsg(e), lit)}` });
    } finally {
      const notes: string[] = [];
      for (const b of BACKENDS) {
        const d = await setupSql(fx, b, TD04_SQL[dialectOf(b)].drop).catch((e) => ({ ok: false, error: errMsg(e), errors: [] }) as unknown as RunResult);
        notes.push(`${b} ${d.ok && !d.errors.length ? "dropped" : `drop failed: ${scrub(d.error ?? topErrors(d.errors), lit)}`}`);
      }
      out.push({ id: `${ID}z`, title: "cleanup", status: notes.some((n) => n.includes("failed")) ? "fail" : "pass", detail: `td04_* tables: ${notes.join("; ")}` });
    }
    return out;
  },
};
export default mod;
