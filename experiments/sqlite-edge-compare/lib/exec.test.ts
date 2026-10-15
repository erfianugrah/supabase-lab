import { describe, expect, test } from "bun:test";
import { chunkPlan, mergeRuns } from "./client";
import { OPS_PER_INVOCATION, type Stmt, WORKER_BACKENDS } from "./contract";
import { errText, executeRun, type LaneConn, sequentialTx, validateRunRequest } from "./exec";

const fake = (log: string[], failOn?: string): LaneConn => ({
  each: async (s: Stmt) => {
    log.push(s.sql ?? "");
    if (failOn && s.sql === failOn) throw new Error(`fail ${failOn}`);
    return { rowCount: 1, rows: [{ v: s.sql }], meta: { m: 1 } };
  },
  batch: async (ss) => ss.map((s) => ({ rowCount: 1, rows: [{ v: s.sql }] })),
  tx: (ss) =>
    sequentialTx(async (s) => {
      log.push(s.sql ?? "");
      if (failOn && s.sql === failOn) throw new Error(`fail ${failOn}`);
      return { rowCount: 0 };
    }, ss),
  close: async () => undefined,
});

describe("validateRunRequest", () => {
  const ok = (b: unknown) => validateRunRequest(b, WORKER_BACKENDS);
  test("defaults", () => {
    const v = ok({ backend: "d1", statements: [{ sql: "select 1" }] });
    expect(v.ok && v.req.repeat === 1 && v.req.concurrency === 1 && v.req.mode === "each").toBe(true);
  });
  test("rejects bad shapes", () => {
    expect(ok({ backend: "mysql", statements: [{ sql: "x" }] }).ok).toBe(false);
    expect(ok({ backend: "d1", statements: [] }).ok).toBe(false);
    expect(ok({ backend: "d1", statements: [{}] }).ok).toBe(false);
    expect(ok({ backend: "postgrest", statements: [{ sql: "x" }] }).ok).toBe(false);
    // an empty path is /rest/v1/ itself (the OpenAPI root /meta uses)
    expect(ok({ backend: "postgrest", statements: [{ http: { method: "GET", path: "" } }] }).ok).toBe(true);
    expect(ok({ backend: "postgrest", statements: [{ http: { method: "GET", path: "t" } }], mode: "batch" }).ok).toBe(false);
    expect(ok({ backend: "d1", statements: [{ sql: "x" }], concurrency: 65 }).ok).toBe(false);
    expect(ok({ backend: "d1", statements: [{ sql: "x" }], repeat: 0 }).ok).toBe(false);
  });
  test("the split ceiling, and noSplit lifting it", () => {
    const big = { backend: "d1", statements: [{ sql: "a" }, { sql: "b" }], repeat: OPS_PER_INVOCATION / 2 + 1 };
    expect(ok(big).ok).toBe(false);
    expect(ok({ ...big, noSplit: true }).ok).toBe(true);
    expect(ok({ ...big, repeat: OPS_PER_INVOCATION / 2 }).ok).toBe(true);
  });
});

describe("executeRun", () => {
  const run = async (req: Record<string, unknown>, failOn?: string, log: string[] = []) => {
    const v = validateRunRequest({ backend: "d1", ...req }, WORKER_BACKENDS);
    if (!v.ok) throw new Error(v.error);
    let t = 0;
    return executeRun(v.req, async () => fake(log, failOn), { colo: "SIN", driver: { name: "fake", version: "0" }, now: () => (t += 1) });
  };
  test("each: one op per statement per iteration, sorted, rows off by default", async () => {
    const r = await run({ statements: [{ sql: "a" }, { sql: "b" }], repeat: 3 });
    expect(r.ops.length).toBe(6);
    expect(r.ops.map((o) => `${o.i}.${o.stmt}`)).toEqual(["0.0", "0.1", "1.0", "1.1", "2.0", "2.1"]);
    expect(r.ops[0]!.out![0]!.rows).toBeUndefined();
    expect(r.ops[0]!.out![0]!.meta).toEqual({ m: 1 });
    expect(r.colo).toBe("SIN");
  });
  test("returnRows and rowsLimit", async () => {
    const r = await run({ statements: [{ sql: "a" }], returnRows: true, returnMeta: false });
    expect(r.ops[0]!.out![0]!.rows).toEqual([{ v: "a" }]);
    expect(r.ops[0]!.out![0]!.meta).toBeUndefined();
  });
  test("concurrency: every iteration exactly once across lanes", async () => {
    const r = await run({ statements: [{ sql: "a" }], repeat: 50, concurrency: 8 });
    expect(r.lanes.length).toBe(8);
    expect(r.ops.map((o) => o.i)).toEqual(Array.from({ length: 50 }, (_, i) => i));
  });
  test("errors are recorded and the run carries on", async () => {
    const r = await run({ statements: [{ sql: "a" }, { sql: "bad" }], repeat: 2 }, "bad");
    expect(r.ops.filter((o) => !o.ok).length).toBe(2);
    expect(r.errors).toEqual([{ text: "fail bad", count: 2 }]);
  });
  test("batch and tx are one op per iteration; tx rolls back on error", async () => {
    const b = await run({ statements: [{ sql: "a" }, { sql: "b" }], repeat: 2, mode: "batch" });
    expect(b.ops.map((o) => o.stmt)).toEqual([-1, -1]);
    expect(b.ops[0]!.out!.length).toBe(2);
    const log: string[] = [];
    const t = await run({ statements: [{ sql: "a" }, { sql: "bad" }, { sql: "c" }], mode: "tx" }, "bad", log);
    expect(t.ops[0]!.ok).toBe(false);
    expect(log).toEqual(["BEGIN", "a", "bad", "ROLLBACK"]);
  });
  test("a lane that cannot connect is reported, not thrown", async () => {
    const v = validateRunRequest({ backend: "pg", statements: [{ sql: "a" }] }, WORKER_BACKENDS);
    if (!v.ok) throw new Error(v.error);
    const r = await executeRun(v.req, async () => Promise.reject(new Error("refused")), { colo: "x", driver: { name: "f", version: "0" } });
    expect(r.ops.length).toBe(0);
    expect(r.lanes[0]!.error).toBe("refused");
    expect(r.errors[0]!.text).toBe("connect: refused");
  });
  test("iOffset keeps indices global", async () => {
    const v = validateRunRequest({ backend: "d1", statements: [{ sql: "a" }], repeat: 2 }, WORKER_BACKENDS);
    if (!v.ok) throw new Error(v.error);
    const r = await executeRun(v.req, async () => fake([]), { colo: "x", driver: { name: "f", version: "0" }, iOffset: 250 });
    expect(r.ops.map((o) => o.i)).toEqual([250, 251]);
  });
  test("errText keeps a code", () => {
    const e = Object.assign(new Error("boom"), { code: "SQLITE_BUSY" });
    expect(errText(e)).toBe("[SQLITE_BUSY] boom");
  });
});

describe("client split/merge", () => {
  test("chunkPlan respects iterations x statements <= cap", () => {
    expect(chunkPlan(1200, 1)).toEqual([500, 500, 200]);
    expect(chunkPlan(300, 3)).toEqual([166, 134]);
    expect(chunkPlan(10, 1000)).toEqual(Array(10).fill(1));
    expect(chunkPlan(500, 1).length).toBe(1);
  });
  test("mergeRuns stamps inv, unions colos, summarises ok ops", async () => {
    const v = validateRunRequest({ backend: "d1", statements: [{ sql: "a" }], repeat: 2 }, WORKER_BACKENDS);
    if (!v.ok) throw new Error(v.error);
    const a = await executeRun(v.req, async () => fake([]), { colo: "SIN", driver: { name: "f", version: "0" } });
    const b = await executeRun(v.req, async () => fake([]), { colo: "SYD", driver: { name: "f", version: "0" }, iOffset: 2 });
    const m = mergeRuns([a, b], [10, 11]);
    expect(m.invocations).toBe(2);
    expect(m.colos).toEqual(["SIN", "SYD"]);
    expect(m.ops.map((o) => `${o.inv}:${o.i}`)).toEqual(["0:0", "0:1", "1:2", "1:3"]);
    expect(m.repeat).toBe(4);
    expect(m.summary.n).toBe(4);
    expect(m.httpMs).toEqual([10, 11]);
  });
});
