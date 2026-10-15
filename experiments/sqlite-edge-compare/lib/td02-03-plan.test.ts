import { describe, expect, test } from "bun:test";
import type { OpResult } from "./contract";
import {
  affected,
  blockSamples,
  blocks,
  ceilingHit,
  ceilingStep,
  envInt,
  envList,
  genKv,
  jobPayload,
  jobSamples,
  jobStatements,
  jobStats,
  keySequence,
  kvDdl,
  kvExpected,
  kvInserts,
  metaValues,
  pickTargets,
  pointRead,
  rankBySpread,
  readStats,
  rowMatches,
  STEPS_PER_JOB,
  TARGETS,
} from "./td02-03-plan";

const op = (p: Partial<OpResult>): OpResult => ({ inv: 0, lane: 0, i: 0, stmt: 0, t0: 0, ms: 1, ok: true, ...p });

describe("env sizes", () => {
  test("explicit value beats smoke and full", () => {
    expect(envInt({ X: "7", TD_SMOKE: "1" }, "X", 300, 10)).toBe(7);
    expect(envInt({ TD_SMOKE: "1" }, "X", 300, 10)).toBe(10);
    expect(envInt({}, "X", 300, 10)).toBe(300);
    expect(envInt({ X: "" }, "X", 300, 10)).toBe(300);
  });
  test("garbage throws rather than shrinking a run", () => {
    expect(() => envInt({ X: "abc" }, "X", 1, 1)).toThrow();
    expect(() => envInt({ X: "-1" }, "X", 1, 1)).toThrow();
  });
  test("lists", () => {
    expect(envList({ L: "a, b,,c" }, "L", ["x"], ["y"])).toEqual(["a", "b", "c"]);
    expect(envList({ TD_SMOKE: "1" }, "L", ["x"], ["y"])).toEqual(["y"]);
  });
  test("unknown target names are rejected", () => {
    expect(pickTargets(["d1", "pg"], ["d1", "pg"]).map((t) => t.backend)).toEqual(["d1", "pg"]);
    expect(() => pickTargets(["d2"], ["d1"])).toThrow(/unknown target/);
  });
});

describe("seed data", () => {
  test("deterministic, ids 1..n, values safe for literal SQL", () => {
    const a = genKv(50, 1);
    expect(genKv(50, 1)).toEqual(a);
    expect(genKv(50, 2)).not.toEqual(a);
    expect(a.map((r) => r.id)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    for (const r of a) {
      expect(r.v).toMatch(/^[0-9a-f]{48}$/);
      expect(r.k).toMatch(/^key-\d{6}$/);
    }
  });
  test("inserts chunk and cover every row once", () => {
    const rows = genKv(1201, 3);
    const ins = kvInserts(rows, 500);
    expect(ins.length).toBe(3);
    const tuples = ins.join("").match(/\(\d+,'key-/g) ?? [];
    expect(tuples.length).toBe(1201);
    expect(ins[0]!.length).toBeLessThan(100_000); // D1 statement length limit
  });
  test("expected check and DDL per dialect", () => {
    const rows = genKv(3, 1);
    expect(kvExpected(rows)).toEqual({ c: 3, s: rows[0]!.n + rows[1]!.n + rows[2]!.n, m: 3 });
    expect(kvDdl("sqlite").join(";")).not.toContain("row level security");
    expect(kvDdl("pg").join(";")).toContain("grant select on public.td02_kv to service_role");
  });
  test("point reads use each dialect's placeholder", () => {
    expect(pointRead("sqlite", 5)).toEqual({ sql: "select id, k, v, n from td02_kv where id = ?", params: [5] });
    expect(pointRead("pg", 5).sql).toContain("$1");
    expect(pointRead("http", 5).http?.path).toBe("td02_kv?id=eq.5&select=id,k,v,n");
  });
  test("key sequences: in range, deterministic, hot set small", () => {
    const ks = keySequence(1000, 10_000, 9);
    expect(ks).toEqual(keySequence(1000, 10_000, 9));
    expect(Math.min(...ks)).toBeGreaterThanOrEqual(1);
    expect(Math.max(...ks)).toBeLessThanOrEqual(10_000);
    expect(new Set(keySequence(500, 10_000, 9, 10)).size).toBeLessThanOrEqual(10);
  });
  test("blocks", () => {
    expect(blocks([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});

describe("TD02 samples", () => {
  const rows = genKv(10, 1);
  const good = (id: number) => ({ rows: [{ id, k: rows[id - 1]!.k, v: rows[id - 1]!.v, n: rows[id - 1]!.n }] });
  test("rowMatches accepts string ids (PostgREST / pg bigint) and rejects wrong values", () => {
    expect(rowMatches({ rows: [{ id: "3", v: rows[2]!.v }] }, rows[2])).toBe(true);
    expect(rowMatches({ rows: [{ id: 3, v: "x" }] }, rows[2])).toBe(false);
    expect(rowMatches({ rows: [] }, rows[2])).toBe(false);
  });
  test("missing ops become failed samples with the request error", () => {
    const s = blockSamples([op({ stmt: 0, ms: 5, out: [good(2)] })], [2, 4], rows, "HTTP 500");
    expect(s[0]).toEqual({ ms: 5, ok: true, first: true, match: true });
    expect(s[1]!.ok).toBe(false);
    expect(s[1]!.error).toBe("HTTP 500");
  });
  test("readStats drops warm-up by attempt and splits first-in-invocation", () => {
    const samples = [
      { ms: 100, ok: true, first: true, match: true },
      { ms: 10, ok: true, first: false, match: true },
      { ms: 50, ok: true, first: true, match: true },
      { ms: 12, ok: true, first: false, match: false },
      { ms: Number.NaN, ok: false, first: false, match: false, error: "boom" },
    ];
    const st = readStats(samples, 1);
    expect(st.attempted).toBe(5);
    expect(st.all.n).toBe(3);
    expect(st.all.dropped).toBe(1);
    expect(st.first.n).toBe(1);
    expect(st.first.p50).toBe(50);
    expect(st.errors).toBe(1);
    expect(st.mismatches).toBe(1);
    expect(st.errorTexts).toEqual([{ text: "boom", count: 1 }]);
  });
  test("rankBySpread orders by p50 and marks separation", () => {
    const r = rankBySpread([
      { key: "slow", s: { n: 5, p25: 90, p50: 100, p75: 110 } },
      { key: "fast", s: { n: 5, p25: 1, p50: 2, p75: 3 } },
      { key: "close", s: { n: 5, p25: 95, p50: 101, p75: 120 } },
      { key: "empty", s: { n: 0, p25: Number.NaN, p50: Number.NaN, p75: Number.NaN } },
    ]);
    expect(r).toBe("fast < slow ~ close");
  });
  test("rankBySpread lists non-adjacent separations a '~' chain hides", () => {
    // pooler ~ turso ~ d1 by neighbours, but pooler and d1 do not overlap.
    const r = rankBySpread([
      { key: "pooler", s: { n: 5, p25: 244, p50: 250, p75: 259 } },
      { key: "turso", s: { n: 5, p25: 250, p50: 270, p75: 300 } },
      { key: "d1", s: { n: 5, p25: 279, p50: 300, p75: 332 } },
    ]);
    expect(r).toBe("pooler ~ turso ~ d1 (also pooler < d1)");
  });
});

describe("TD02 ceiling", () => {
  test("no failures, all ops present", () => {
    const s = ceilingStep(3, [op({ i: 0 }), op({ i: 1 }), op({ i: 2 })]);
    expect(ceilingHit(s)).toBe(false);
    expect(s.okOps).toBe(3);
  });
  test("earliest failure by start time is reported", () => {
    const s = ceilingStep(4, [op({ i: 0 }), op({ i: 3, t0: 9, ok: false, error: "late" }), op({ i: 2, t0: 5, ok: false, error: "too many" })]);
    expect(ceilingHit(s)).toBe(true);
    expect(s.firstFailI).toBe(2);
    expect(s.firstError).toBe("too many");
    expect(s.missing).toBe(1);
  });
  test("request-level failure counts as missing", () => {
    const s = ceilingStep(10, [], "fetch: timeout");
    expect(ceilingHit(s)).toBe(true);
    expect(s.firstError).toBe("fetch: timeout");
  });
});

describe("TD03 jobs", () => {
  test("eight statements: insert, read, then update/read x3, placeholders per dialect", () => {
    const { stmts, plan } = jobStatements("sqlite", "j1", 0, "{}", 100);
    expect(stmts.length).toBe(STEPS_PER_JOB);
    expect(plan.map((p) => p.kind).join(",")).toBe("insert,read,update,read,update,read,update,read");
    expect(plan.filter((p) => p.kind === "read").map((p) => `${p.status}/${p.attempts}`)).toEqual(["queued/0", "claimed/1", "running/2", "done/3"]);
    expect(stmts[2]!.params).toEqual(["claimed", 1, 101, "j1", "queued"]);
    const pg = jobStatements("pg", "j1", 0, "{}", 100);
    expect(pg.stmts[2]!.sql).toContain("$5");
    expect(pg.stmts[2]!.sql).not.toContain("?");
    const h = jobStatements("http", "a b", 0, "{}", 100);
    expect(h.stmts[0]!.http?.method).toBe("POST");
    expect(h.stmts[2]!.http?.path).toBe("td03_jobs?id=eq.a%20b&status=eq.queued&select=id");
    expect(h.stmts[2]!.http?.body).toEqual({ status: "claimed", attempts: 1, updated_at: 101 });
  });
  test("payload deterministic per job", () => {
    expect(jobPayload(1, 5)).toBe(jobPayload(1, 5));
    expect(jobPayload(1, 5)).not.toBe(jobPayload(1, 6));
  });
  test("affected reads each driver's field", () => {
    expect(affected(TARGETS.d1, "update", { meta: { changes: 1 } })).toBe(1);
    expect(affected(TARGETS.local_d1_rest, "update", { meta: { changes: 0 } })).toBe(0);
    expect(affected(TARGETS.turso, "insert", { meta: { rowsAffected: 1 } })).toBe(1);
    expect(affected(TARGETS.pg, "update", { rowCount: 1, meta: { command: "UPDATE" } })).toBe(1);
    expect(affected(TARGETS.postgrest, "insert", { rowCount: 0, meta: { status: 201 } })).toBe(1);
    expect(affected(TARGETS.postgrest, "update", { rowCount: 0, meta: { status: 200 } })).toBe(0);
    expect(affected(TARGETS.d1, "update", { meta: {} })).toBeNull();
  });
  test("jobSamples checks read-your-write and single-row writes; jobStats sums whole jobs", () => {
    const mk = (job: number, stale: boolean) => {
      const { plan } = jobStatements("sqlite", `j${job}`, job, "{}", 0);
      const ops = plan.map((p, k) =>
        op({
          stmt: k,
          ms: 2,
          out: [p.kind === "read" ? { rows: [{ status: stale && p.status === "done" ? "running" : p.status, attempts: p.attempts }] } : { meta: { rowsAffected: 1 } }],
        }),
      );
      return jobSamples(TARGETS.turso, ops, plan);
    };
    const samples = [...mk(0, false), ...mk(1, false), ...mk(2, true)];
    const st = jobStats(samples, 1);
    expect(st.jobsAttempted).toBe(3);
    expect(st.jobsMeasured).toBe(2);
    expect(st.jobsDropped).toBe(1);
    expect(st.rywMisses).toBe(1);
    expect(st.writeMisses).toBe(0);
    expect(st.jobsClean).toBe(2);
    expect(st.job.n).toBe(2);
    expect(st.job.p50).toBe(16);
    expect(st.insert.n).toBe(2);
    expect(st.read.n).toBe(8);
  });
  test("a missing op is an error, not a silent gap", () => {
    const { plan } = jobStatements("pg", "j", 0, "{}", 0);
    const st = jobStats(jobSamples(TARGETS.pg, [], plan, "connect: refused"), 0);
    expect(st.errors).toBe(STEPS_PER_JOB);
    expect(st.errorTexts[0]).toEqual({ text: "connect: refused", count: STEPS_PER_JOB });
    expect(st.job.n).toBe(0);
  });
});

describe("metaValues", () => {
  test("distinct values across ops and statements", () => {
    const ops = [op({ out: [{ meta: { served_by_region: "OC" } }, { meta: { served_by_region: "OC" } }] }), op({ out: [{ meta: { served_by_region: "APAC" } }] }), op({})];
    expect(metaValues(ops, "served_by_region")).toBe("OC,APAC");
    expect(metaValues(ops, "nope")).toBe("");
  });
});
