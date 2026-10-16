import { describe, expect, test } from "bun:test";
import { type DoStubLike, doLane } from "./adapters";
import type { Stmt, StmtOut } from "./contract";

/** A fake ProbeDO: records calls; refuses BEGIN/COMMIT/ROLLBACK the way the Durable Object SQL API documents. */
function fakeStub() {
  const calls: { mode: string; sqls: string[] }[] = [];
  const stub: DoStubLike = {
    async run(stmts: Stmt[], mode: "each" | "batch"): Promise<StmtOut[]> {
      calls.push({ mode, sqls: stmts.map((s) => s.sql ?? "") });
      for (const s of stmts) if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(s.sql ?? "")) throw new Error("not authorized to use BEGIN in sql.exec");
      return stmts.map((s) => ({ rowCount: 1, rows: [{ sql: s.sql }] }));
    },
  };
  return { stub, calls };
}

describe("doLane", () => {
  test("each is one RPC with one statement; batch is one RPC with all of them", async () => {
    const { stub, calls } = fakeStub();
    const lane = doLane(stub);
    expect((await lane.each({ sql: "select 1" })).rows).toEqual([{ sql: "select 1" }]);
    const out = await lane.batch([{ sql: "a" }, { sql: "b" }]);
    expect(out.length).toBe(2);
    expect(calls).toEqual([
      { mode: "each", sqls: ["select 1"] },
      { mode: "batch", sqls: ["a", "b"] },
    ]);
  });
  test("tx sends BEGIN TRANSACTION and surfaces the refusal verbatim", async () => {
    const { stub } = fakeStub();
    await expect(doLane(stub).tx([{ sql: "insert" }])).rejects.toThrow("not authorized to use BEGIN in sql.exec");
  });
});
