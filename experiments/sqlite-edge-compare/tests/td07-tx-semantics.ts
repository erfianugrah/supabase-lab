/**
 * TD07 - Transaction semantics from a Worker: interactive transaction,
 * rollback on error, read-your-write after commit, and a concurrent writer
 * during a transaction, on D1, Turso libSQL and Postgres via Hyperdrive.
 *
 * Question: which transaction shapes does each backend support from inside a
 * Cloudflare Worker, and what does a reader or a second writer see? D1
 * documents batch() as its transaction (statements run sequentially, the whole
 * batch rolls back on failure) and no interactive transaction through the
 * binding; libSQL over HTTP offers interactive transactions (client.transaction
 * opens BEGIN IMMEDIATE for "write"); Postgres through Hyperdrive is a normal
 * session for the life of the client. Facts: docs/research/2026-10-15-sqlite-edge-compare-facts.md.
 *
 * Vantage for every row: the probe Worker (colo recorded), backends d1
 * (binding, served_by_region recorded), turso (libSQL, aws-ap-southeast-2,
 * @libsql/client/web), pg (node-postgres via Hyperdrive, caching off,
 * Supabase ap-southeast-2) and, for one read-your-write row, pg_cached
 * (Hyperdrive with caching on). One table, td07_kv (k primary key, v int).
 *
 *   TD07a-<b>          mode "tx": INSERT a, SELECT a inside one interactive
 *                      transaction; then a separate request reads a. D1 gets
 *                      BEGIN TRANSACTION sent as a statement (the executor's
 *                      tx path) and its error text is the measurement.
 *   TD07a-d1-batch     the same two statements as a D1 batch (the documented alternative).
 *   TD07b-<b>-<mode>   INSERT b, then INSERT b again (primary-key violation)
 *                      in one batch / one tx; rows with k 'b%' afterwards must
 *                      be 0 (rolled back). Mode "each" is the autocommit
 *                      control (expected 1). D1 has no tx row (TD07a covers it).
 *   TD07c-<b>-same     n iterations of [UPDATE v = v + 1; SELECT v] in one
 *                      invocation, autocommit; the read must equal the
 *                      iteration number. n = TD07_RYW (30 full, 5 smoke).
 *   TD07c-<b>-next     n pairs of separate requests: increment, then read in
 *                      the NEXT request (another invocation, another
 *                      connection). Also d1 with withSession("first-unconstrained")
 *                      on the read, and pg_cached for the read after a pg
 *                      write (Hyperdrive caching documents that writes do not
 *                      invalidate cached results; stale reads are counted).
 *   TD07d-<b>          A: one transaction [SELECT v; F filler round trips;
 *                      SELECT v; UPDATE v = v + 1] (D1: a batch); B: W
 *                      autocommit increments in a separate invocation, fired
 *                      300 ms after A. Recorded: A's two reads, A's outcome
 *                      and time, B's ok count, slowest op and errors, final v
 *                      vs 1 + B ok (a mismatch is a lost update: fail).
 *   TD07d-pg-rr        the same with SET TRANSACTION ISOLATION LEVEL
 *                      REPEATABLE READ as A's first statement.
 *
 * Status: pass = the documented behaviour; info = an observation with no
 * documented expectation (TD07d, the pg_cached row); fail = a measured
 * disagreement or a lost/phantom write. Round-robin backend order per row.
 *
 * Not settled by this module: isolation levels beyond Postgres READ COMMITTED
 * and REPEATABLE READ, libSQL read transactions, D1 read replicas with
 * replication enabled (the fixture keeps the default), transactions spanning
 * Worker invocations, and timing: n is small and every number here is one
 * colo's view.
 *
 * DESTRUCTIVE: creates td07_kv on the three fixture backends; dropped in
 * finally. Self-skips without the fixture.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { type Fixture, fixtureOrSkip, type RunResult, runOnWorker } from "../lib/client";
import type { Mode, Param, Stmt, WorkerBackend } from "../lib/contract";
import { roundRobin } from "../lib/stats";
import { dialectOf, firstMeta, scalar, scrub, TD07_SQL, td07Sizes, topErrors, withTursodb } from "../lib/td04-07-plan";
import { sleep } from "../lib/vendors";

const ID = "TD07";
const BASE_BACKENDS: WorkerBackend[] = ["d1", "turso", "pg"];
/** B fires this long after A, so its first write lands while A is between its two reads. */
const B_DELAY_MS = 300;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

type Q = ReturnType<typeof sqlFor>;
function sqlFor(b: WorkerBackend) {
  const s = TD07_SQL[dialectOf(b)];
  const st = (sql: string, ...params: Param[]): Stmt => ({ sql, params });
  return {
    s,
    ins: (k: string, v: number) => st(s.ins, k, v),
    get: (k: string) => st(s.get, k),
    incr: (k: string) => st(s.incr, k),
    count: (like: string) => st(s.count, like),
    del: (): Stmt => ({ sql: s.del }),
  };
}

function dataRegion(fx: Fixture, b: WorkerBackend, r?: RunResult): string {
  if (b === "d1") return (r && firstMeta(r.ops, "served_by_region")) || "?";
  if (b === "turso" || b === "tursodb") return fx.turso?.location ?? "?";
  return fx.supabase?.region ?? "?";
}

const run = (fx: Fixture, backend: WorkerBackend, statements: Stmt[], mode: Mode = "each", extra: Partial<Parameters<typeof runOnWorker>[1]> = {}) =>
  runOnWorker(fx, { backend, statements, mode, returnRows: true, label: "td07", ...extra });

async function readNum(fx: Fixture, b: WorkerBackend, st: Stmt, extra: Partial<Parameters<typeof runOnWorker>[1]> = {}): Promise<number | null> {
  const r = await run(fx, b, [st], "each", extra);
  const v = scalar(r);
  return v === null || v === undefined ? null : Number(v);
}

/** Value of column v in statement `k` of a batch/tx op, or null. */
function vAt(r: RunResult, k: number): number | null {
  const op = r.ops.find((o) => o.stmt === -1);
  const row = op?.out?.[k]?.rows?.[0] as { v?: unknown } | undefined;
  return row?.v === undefined || row.v === null ? null : Number(row.v);
}

const base = (fx: Fixture, b: WorkerBackend, r: RunResult) => ({
  backend: b,
  vantage: "worker",
  colo: r.colos.join("+") || "?",
  data_region: dataRegion(fx, b, r),
  driver: `${r.driver.name} ${r.driver.version}`.trim(),
});

async function reset(fx: Fixture, b: WorkerBackend): Promise<void> {
  const r = await run(fx, b, [sqlFor(b).del()]);
  if (!r.ok || r.errors.length) throw new Error(`reset ${b}: ${r.error ?? topErrors(r.errors)}`);
}

/* ---------------------------------- rows --------------------------------- */

async function rowA(fx: Fixture, b: WorkerBackend, mode: "tx" | "batch", lit: string[]): Promise<TestResult> {
  const q = sqlFor(b);
  await reset(fx, b);
  const r = await run(fx, b, [q.ins("a", 1), q.get("a")], mode);
  const op = r.ops[0];
  const inside = vAt(r, 1);
  const after = await readNum(fx, b, q.get("a"));
  const err = scrub(op?.error ?? r.error ?? "", lit);
  const expectErr = b === "d1" && mode === "tx";
  const okShape = expectErr ? !op?.ok && after === null : !!op?.ok && inside === 1 && after === 1;
  return {
    id: `${ID}a-${b}${mode === "batch" ? "-batch" : ""}`,
    title: `${mode === "tx" ? "interactive transaction" : "batch"} from the Worker, ${b}`,
    status: okShape ? "pass" : "fail",
    detail: op?.ok ? `committed in ${op.ms} ms; read inside ${inside}, next request reads ${after}` : `error after ${op?.ms ?? "?"} ms: ${err}; next request reads ${after}`,
    measurements: { ...base(fx, b, r), mode, n: 1, ok: op?.ok ? 1 : 0, ms: op?.ms ?? -1, read_inside: inside ?? "none", read_after: after ?? "none", error: err ? err.slice(0, 200) : "" },
  };
}

async function rowB(fx: Fixture, b: WorkerBackend, mode: Mode, lit: string[]): Promise<TestResult> {
  const q = sqlFor(b);
  await reset(fx, b);
  const r = await run(fx, b, [q.ins("b1", 1), q.ins("b1", 2)], mode);
  const left = await readNum(fx, b, q.count("b%"));
  const want = mode === "each" ? 1 : 0;
  const errs = scrub(topErrors(r.errors, 2), lit);
  return {
    id: `${ID}b-${b}-${mode}`,
    title: `${mode === "each" ? "autocommit control" : `rollback on error inside ${mode}`}, ${b}`,
    status: left === want && r.errors.length > 0 ? "pass" : "fail",
    detail: `rows left ${left} (want ${want}); error: ${errs || "none"}`,
    measurements: { ...base(fx, b, r), mode, n: 1, rows_left: left ?? "unreadable", rows_expected: want, errors: r.errors.reduce((a, e) => a + e.count, 0) },
    ...(errs ? { evidence: errs } : {}),
  };
}

async function rowCSame(fx: Fixture, b: WorkerBackend, n: number): Promise<TestResult> {
  const q = sqlFor(b);
  await reset(fx, b);
  await run(fx, b, [q.ins("c", 0)]);
  const r = await run(fx, b, [q.incr("c"), q.get("c")], "each", { repeat: n });
  const reads = r.ops.filter((o) => o.stmt === 1);
  let visible = 0;
  for (const o of reads) if (o.ok && Number((o.out?.[0]?.rows?.[0] as { v?: unknown } | undefined)?.v) === o.i + 1) visible++;
  return {
    id: `${ID}c-${b}-same`,
    title: `read-your-write after commit, same invocation and connection, ${b}`,
    status: visible === n ? "pass" : "fail",
    detail: `${visible}/${n} reads saw their own preceding increment${r.errors.length ? `; errors: ${topErrors(r.errors)}` : ""}`,
    measurements: { ...base(fx, b, r), n, visible, stale: n - visible, errors: r.errors.length },
  };
}

interface NextVariant {
  id: string;
  label: string;
  writer: WorkerBackend;
  reader: WorkerBackend;
  readerExtra?: Partial<Parameters<typeof runOnWorker>[1]>;
  /** documented expectation: all visible (pass/fail) or none (info) */
  expect: "visible" | "observe";
}

async function rowCNext(fx: Fixture, v: NextVariant, n: number): Promise<TestResult> {
  const qw = sqlFor(v.writer);
  await reset(fx, v.writer);
  await run(fx, v.writer, [qw.ins("c", 0)]);
  let visible = 0;
  let unreadable = 0;
  const seen: (number | null)[] = [];
  let last: RunResult | undefined;
  let primary = "";
  const colos = new Set<string>();
  for (let k = 1; k <= n; k++) {
    await run(fx, v.writer, [qw.incr("c")]);
    last = await run(fx, v.reader, [sqlFor(v.reader).get("c")], "each", v.readerExtra ?? {});
    const x = scalar(last);
    const val = x === null || x === undefined ? null : Number(x);
    seen.push(val);
    for (const c of last.colos) colos.add(c);
    if (val === null) unreadable++;
    else if (val === k) visible++;
    if (v.reader === "d1") primary ||= firstMeta(last.ops, "served_by_primary");
  }
  const stale = n - visible - unreadable;
  return {
    id: `${ID}c-${v.id}-next`,
    title: `read-your-write in the next request (another invocation), ${v.label}`,
    status: v.expect === "visible" ? (visible === n ? "pass" : "fail") : "info",
    detail: `${visible}/${n} reads saw the preceding write, ${stale} stale, ${unreadable} unreadable; values ${seen.slice(0, 12).join(",")}${seen.length > 12 ? ",..." : ""}`,
    measurements: {
      ...base(fx, v.reader, last!),
      colo: [...colos].join("+") || "?",
      writer: v.writer,
      reader: v.reader,
      ...(v.readerExtra?.d1Session ? { d1_session: v.readerExtra.d1Session } : {}),
      ...(primary ? { served_by_primary: primary } : {}),
      n,
      visible,
      stale,
      unreadable,
    },
  };
}

async function rowD(fx: Fixture, b: WorkerBackend, fillers: number, writerOps: number, lit: string[], rr = false): Promise<TestResult> {
  const q = sqlFor(b);
  await reset(fx, b);
  await run(fx, b, [q.ins("d", 0)]);
  const head: Stmt[] = rr ? [{ sql: "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ" }] : [];
  const aStmts: Stmt[] = [...head, q.get("d"), ...Array.from({ length: fillers }, () => q.get("none")), q.get("d"), q.incr("d")];
  const aMode: Mode = b === "d1" ? "batch" : "tx";
  const aP = run(fx, b, aStmts, aMode);
  await sleep(B_DELAY_MS);
  const bRes = await run(fx, b, [q.incr("d")], "each", { repeat: writerOps });
  const aRes = await aP;
  const aOp = aRes.ops[0];
  const r1 = vAt(aRes, head.length);
  const r2 = vAt(aRes, head.length + 1 + fillers);
  const bOk = bRes.ops.filter((o) => o.ok).length;
  const bMax = bRes.ops.length ? Math.max(...bRes.ops.map((o) => o.ms)) : 0;
  const final = await readNum(fx, b, q.get("d"));
  const expected = (aOp?.ok ? 1 : 0) + bOk;
  const aErr = scrub(aOp?.error ?? aRes.error ?? "", lit);
  const bErr = scrub(topErrors(bRes.errors, 2), lit);
  const reading = !aOp?.ok ? "A failed" : r1 === r2 ? "A's two reads equal" : "A's second read saw B's commit (non-repeatable read)";
  return {
    id: `${ID}d-${b}${rr ? "-rr" : ""}`,
    title: `concurrent writer during a ${aMode}${rr ? " (REPEATABLE READ)" : ""}, ${b}`,
    status: final === expected ? "info" : "fail",
    detail:
      `A ${aOp?.ok ? `committed in ${aOp.ms} ms` : `failed after ${aOp?.ms ?? "?"} ms: ${aErr}`}, reads ${r1} then ${r2}; ` +
      `B ${bOk}/${bRes.ops.length} ok, slowest ${bMax} ms${bErr ? `, errors: ${bErr}` : ""}; final ${final} vs ${expected} expected; ${reading}`,
    measurements: {
      ...base(fx, b, aRes),
      a_mode: aMode,
      isolation: b === "pg" ? (rr ? "repeatable read" : "read committed (default)") : b === "turso" || b === "tursodb" ? "BEGIN IMMEDIATE (client.transaction write)" : "batch",
      fillers,
      a_ok: aOp?.ok ? 1 : 0,
      a_ms: aOp?.ms ?? -1,
      a_read1: r1 ?? "none",
      a_read2: r2 ?? "none",
      b_n: bRes.ops.length,
      b_ok: bOk,
      b_max_ms: bMax,
      b_ms: bRes.ops.map((o) => Math.round(o.ms)).join("/"),
      b_delay_ms: B_DELAY_MS,
      b_colo: bRes.colos.join("+") || "?",
      final: final ?? "unreadable",
      expected,
      a_error: aErr.slice(0, 200),
      b_error: bErr.slice(0, 200),
    },
  };
}

/* --------------------------------- module -------------------------------- */

const mod: TestModule = {
  id: ID,
  title: "Transaction semantics from a Worker: interactive tx, rollback on error, read-your-write after commit, a concurrent writer during a tx",
  where: "local",
  requires: [],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const fx = await fixtureOrSkip(ctx);
    if ("skip" in fx) return [{ id: ID, title: this.title, status: "skip", detail: fx.skip }];
    const BACKENDS = withTursodb(fx, BASE_BACKENDS);
    const sz = td07Sizes();
    const lit = [fx.supabase?.ref, fx.d1?.id, fx.turso?.hostname, fx.tursodb?.hostname, fx.turso?.org].filter((x): x is string => !!x);
    const out: TestResult[] = [];
    const guard = async (id: string, f: () => Promise<TestResult>) => {
      try {
        out.push(await f());
      } catch (e) {
        out.push({ id, title: id, status: "fail", detail: `threw: ${scrub(errMsg(e), lit)}` });
      }
    };
    const ready: WorkerBackend[] = [];
    try {
      for (const b of BACKENDS) {
        const r = await runOnWorker(fx, { backend: b, mode: "batch", statements: sqlFor(b).s.create.map((sql) => ({ sql })), label: "td07-setup" });
        if (r.ok && !r.errors.length) ready.push(b);
        else out.push({ id: `${ID}-${b}-setup`, title: `schema on ${b}`, status: "fail", detail: scrub(r.error ?? topErrors(r.errors), lit) });
      }
      out.push({
        id: `${ID}-plan`,
        title: "sizes and vantage",
        status: "info",
        detail: `${sz.smoke ? "SMOKE" : "full"} sizes: read-your-write n=${sz.ryw}, ${sz.fillers} filler round trips, ${sz.writerOps} concurrent writes; backends ${ready.join(",")}`,
        measurements: { smoke: sz.smoke ? 1 : 0, ryw_n: sz.ryw, fillers: sz.fillers, writer_ops: sz.writerOps, supabase_region: fx.supabase?.region ?? "?", turso_location: fx.turso?.location ?? "?", d1_location_hint: fx.d1?.locationHint ?? "?" },
      });
      const order = (k: number) => roundRobin(ready, k + 1).filter((s) => s.iter === k).map((s) => s.item);

      for (const b of order(0)) await guard(`${ID}a-${b}`, () => rowA(fx, b, "tx", lit));
      if (ready.includes("d1")) await guard(`${ID}a-d1-batch`, () => rowA(fx, "d1", "batch", lit));

      for (const b of order(1)) {
        for (const m of (b === "d1" ? ["each", "batch"] : ["each", "batch", "tx"]) as Mode[]) await guard(`${ID}b-${b}-${m}`, () => rowB(fx, b, m, lit));
      }

      for (const b of order(2)) await guard(`${ID}c-${b}-same`, () => rowCSame(fx, b, sz.ryw));
      const variants: NextVariant[] = [];
      for (const b of order(0)) variants.push({ id: b, label: b, writer: b, reader: b, expect: "visible" });
      if (ready.includes("d1")) variants.push({ id: "d1-session", label: "d1, read via withSession(\"first-unconstrained\")", writer: "d1", reader: "d1", readerExtra: { d1Session: "first-unconstrained" }, expect: "observe" });
      if (ready.includes("pg")) variants.push({ id: "pg_cached", label: "write via pg, read via pg_cached (Hyperdrive caching on)", writer: "pg", reader: "pg_cached", expect: "observe" });
      for (const v of variants) await guard(`${ID}c-${v.id}-next`, () => rowCNext(fx, v, sz.ryw));

      for (const b of order(1)) await guard(`${ID}d-${b}`, () => rowD(fx, b, sz.fillers, sz.writerOps, lit));
      if (ready.includes("pg")) await guard(`${ID}d-pg-rr`, () => rowD(fx, "pg", sz.fillers, sz.writerOps, lit, true));
    } catch (e) {
      out.push({ id: ID, title: this.title, status: "fail", detail: `threw: ${scrub(errMsg(e), lit)}` });
    } finally {
      const notes: string[] = [];
      for (const b of BACKENDS) {
        const d = await runOnWorker(fx, { backend: b, mode: "batch", statements: sqlFor(b).s.drop.map((sql) => ({ sql })), label: "td07-drop" }).catch((e) => ({ ok: false, error: errMsg(e), errors: [] }) as unknown as RunResult);
        notes.push(`${b} ${d.ok && !d.errors.length ? "dropped" : `drop failed: ${scrub(d.error ?? topErrors(d.errors), lit)}`}`);
      }
      out.push({ id: `${ID}z`, title: "cleanup", status: notes.some((n) => n.includes("failed")) ? "fail" : "pass", detail: `td07_kv: ${notes.join("; ")}` });
    }
    return out;
  },
};
export default mod;

export type { Q };
