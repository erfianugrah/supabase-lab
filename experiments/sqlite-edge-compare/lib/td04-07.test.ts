import { describe, expect, test } from "bun:test";
import type { OpResult, WorkerBackend } from "./contract";
import { fromHrana, HranaStream, runTx, toHrana } from "./td04-07-hrana";
import { dialectOf, firstMeta, isConflict, laneSplit, perInvocation, scalar, scrub, TD04_SQL, td04Sizes, td07Sizes, throughput, topErrors, tursoEngineOf, withTursodb } from "./td04-07-plan";

const op = (p: Partial<OpResult>): OpResult => ({ inv: 0, lane: 0, i: 0, stmt: 0, t0: 0, ms: 1, ok: true, ...p });

describe("sizes", () => {
  test("full by default, smoke with TD_SMOKE=1, env overrides win", () => {
    expect(td04Sizes({}).levels).toEqual([1, 4, 16, 64]);
    expect(td04Sizes({}).opsPerCell).toBe(256);
    expect(td04Sizes({ TD_SMOKE: "1" }).levels).toEqual([1, 4]);
    expect(td04Sizes({ TD_SMOKE: "1", TD04_LEVELS: "2, 8", TD04_OPS: "10" })).toMatchObject({ levels: [2, 8], opsPerCell: 10 });
    expect(td04Sizes({ TD04_LEVELS: "x,0" }).levels).toEqual([1, 4, 16, 64]);
    expect(td07Sizes({}).ryw).toBe(30);
    expect(td07Sizes({ TD_SMOKE: "1" }).ryw).toBe(5);
  });
  test("256 divides by every full level and stays under the 500-op split", () => {
    for (const c of td04Sizes({}).levels) {
      const { invocations } = laneSplit(c);
      expect(256 % c).toBe(0);
      expect(perInvocation(256, invocations)).toBeLessThanOrEqual(500);
    }
  });
});

describe("laneSplit", () => {
  test("at most 4 lanes per invocation", () => {
    expect(laneSplit(1)).toEqual({ invocations: 1, lanes: 1 });
    expect(laneSplit(4)).toEqual({ invocations: 1, lanes: 4 });
    expect(laneSplit(16)).toEqual({ invocations: 4, lanes: 4 });
    expect(laneSplit(64)).toEqual({ invocations: 16, lanes: 4 });
    expect(laneSplit(6)).toEqual({ invocations: 2, lanes: 4 });
    expect(laneSplit(0)).toEqual({ invocations: 1, lanes: 1 });
  });
  test("perInvocation rounds up", () => {
    expect(perInvocation(448, 16)).toBe(28);
    expect(perInvocation(10, 4)).toBe(3);
    expect(perInvocation(0, 4)).toBe(1);
  });
});

describe("throughput", () => {
  test("span is the longest invocation, ops/s counts ok ops only", () => {
    const ops = [op({ inv: 0, t0: 0, ms: 100 }), op({ inv: 0, t0: 100, ms: 100, ok: false, error: "x" }), op({ inv: 1, t0: 0, ms: 400 })];
    const t = throughput(ops, [{ lane: 0, connectMs: 1 }, { lane: 1, connectMs: 1, error: "boom" }]);
    expect(t).toMatchObject({ attempted: 3, ok: 2, failed: 1, laneErrors: 1, spanMs: 400, opsPerSec: 5 });
    expect(t.errorRate).toBe(0.33);
  });
  test("empty", () => {
    expect(throughput([])).toMatchObject({ attempted: 0, opsPerSec: 0, errorRate: 0, spanMs: 0 });
  });
});

describe("result readers", () => {
  test("firstMeta and scalar", () => {
    const ops = [op({ out: [{ meta: {} }] }), op({ out: [{ meta: { served_by_region: "OC" }, rows: [{ n: 7 }] }] })];
    expect(firstMeta(ops, "served_by_region")).toBe("OC");
    expect(firstMeta(ops, "nope")).toBe("");
    expect(scalar({ ops: [op({ out: [{ rows: [{ n: 7 }] }] })] })).toBe(7);
    expect(scalar({ ops: [op({ stmt: -1, out: [{ rows: [] }, { rows: [{ v: 3 }] }] })] }, 1)).toBe(3);
    expect(scalar({ ops: [op({ ok: false })] })).toBeNull();
  });
  test("topErrors truncates", () => {
    expect(topErrors([{ text: "a".repeat(10), count: 2 }, { text: "b", count: 1 }], 1, 4)).toBe("2x aaaa...");
  });
});

describe("dialect and SQL", () => {
  test("placeholders match the dialect", () => {
    expect(dialectOf("d1")).toBe("sqlite");
    expect(dialectOf("turso")).toBe("sqlite");
    expect(dialectOf("pg")).toBe("pg");
    expect(dialectOf("pg_pooler")).toBe("pg");
    expect(TD04_SQL.sqlite.insert).toContain("?");
    expect(TD04_SQL.pg.insert).toContain("$1");
  });
});

describe("turso engine and scrub", () => {
  test("byte 5 of the DbId decides", () => {
    expect(tursoEngineOf("01234567-89ab-10cd-8000-000000000000")).toBe("libsql"); // byte 5 = 0xab
    expect(tursoEngineOf("01234567-8910-4000-8000-000000000000")).toBe("tursodb"); // byte 5 = 0x10
    expect(tursoEngineOf("nope")).toBeNull();
    expect(tursoEngineOf(undefined)).toBeNull();
  });
  test("conflict classifier", () => {
    expect(isConflict("SQLITE_BUSY: database is locked")).toBe(true);
    expect(isConflict("Write-write conflict")).toBe(true);
    expect(isConflict("no such table: x")).toBe(false);
  });
  test("scrub hides hosts, jwts and literals", () => {
    const s = scrub("at sec-x-myorg.aws-ap-southeast-2.turso.io token eyJabcdefghijkl.eyJpayload.sig org myorg", ["myorg"]);
    expect(s).not.toContain("turso.io");
    expect(s).not.toContain("eyJ");
    expect(s).not.toContain("myorg");
  });
});

describe("hrana", () => {
  test("value round trip", () => {
    expect(toHrana(5)).toEqual({ type: "integer", value: "5" });
    expect(toHrana(1.5)).toEqual({ type: "float", value: 1.5 });
    expect(toHrana(null)).toEqual({ type: "null" });
    expect(toHrana(true)).toEqual({ type: "integer", value: "1" });
    expect(fromHrana({ type: "integer", value: "42" })).toBe(42);
    expect(fromHrana({ type: "text", value: "a" })).toBe("a");
  });

  /** A fake server: records bodies, answers in order. */
  function fake(answers: unknown[]) {
    const bodies: { baton: string | null; requests: { type: string; stmt?: { sql: string } }[] }[] = [];
    const urls: string[] = [];
    const fn = async (url: string, init: RequestInit) => {
      urls.push(url);
      bodies.push(JSON.parse(String(init.body)));
      const a = answers.shift();
      if (a instanceof Response) return a;
      return new Response(JSON.stringify(a), { status: 200 });
    };
    return { fn, bodies, urls };
  }
  const ok = (baton: string | null, rows: unknown[][] = []) => ({
    baton,
    base_url: null,
    results: [{ type: "ok", response: { type: "execute", result: { cols: [{ name: "n" }], rows, affected_row_count: 1 } } }],
  });

  test("carries the baton and parses rows", async () => {
    const f = fake([ok("b1"), ok("b2", [[{ type: "integer", value: "9" }]]), { baton: null, results: [{ type: "ok" }] }]);
    const s = new HranaStream("libsql://h.example", "tok", f.fn);
    await s.exec("BEGIN CONCURRENT");
    const r = await s.exec("SELECT n FROM c WHERE id = ?", [1]);
    expect(r.rows).toEqual([[9]]);
    await s.close();
    expect(f.urls[0]).toBe("https://h.example/v2/pipeline");
    expect(f.bodies.map((b) => b.baton)).toEqual([null, "b1", "b2"]);
    expect(f.bodies[2]!.requests[0]!.type).toBe("close");
    expect(s.closed).toBe(true);
  });

  test("server error becomes HranaError with code", async () => {
    const f = fake([{ baton: "b", results: [{ type: "error", error: { message: "conflict!", code: "SQLITE_BUSY" } }] }]);
    const s = new HranaStream("https://h", "t", f.fn);
    await expect(s.exec("COMMIT")).rejects.toThrow("conflict!");
  });

  test("runTx retries conflicts, stops on others", async () => {
    let n = 0;
    const fakeStream = () =>
      ({
        closed: false,
        exec: async (sql: string) => {
          if (sql === "COMMIT" && n++ < 2) throw new Error("write-write conflict");
          return { cols: [], rows: [], affected: 0 };
        },
        close: async () => undefined,
      }) as unknown as HranaStream;
    const r = await runTx(fakeStream, "BEGIN CONCURRENT", async () => undefined, isConflict, 5);
    expect(r).toMatchObject({ ok: true, attempts: 3, conflicts: 2 });
    expect(r.errors).toHaveLength(2);

    const bad = () =>
      ({
        closed: false,
        exec: async () => {
          throw new Error("no such table: c");
        },
        close: async () => undefined,
      }) as unknown as HranaStream;
    const r2 = await runTx(bad, "BEGIN", async () => undefined, isConflict, 5);
    expect(r2).toMatchObject({ ok: false, attempts: 1, conflicts: 0 });
    const r3 = await runTx(fakeStream, "BEGIN", async () => {
      throw new Error("busy");
    }, isConflict, 3);
    expect(r3).toMatchObject({ ok: false, attempts: 3, conflicts: 3 });
  });
});

describe("withTursodb", () => {
  const on = { tursodb: { url: "https://x" } };
  const W = (...b: WorkerBackend[]) => b;
  test("adds tursodb after turso when the fixture has a Turso-engine database", () => {
    expect(withTursodb(on, W("d1", "turso", "pg"))).toEqual(["d1", "turso", "tursodb", "pg"]);
    expect(withTursodb(on, [{ b: "turso", d: "sqlite" }, { b: "pg", d: "pg" }] as { b: WorkerBackend; d: string }[])).toEqual([
      { b: "turso", d: "sqlite" },
      { b: "tursodb", d: "sqlite" },
      { b: "pg", d: "pg" },
    ]);
  });
  test("unchanged without one (refused create, old fixture) or without a turso entry", () => {
    expect(withTursodb({}, W("d1", "turso", "pg"))).toEqual(["d1", "turso", "pg"]);
    expect(withTursodb({ tursodb: { error: "HTTP 400" } }, W("d1", "turso"))).toEqual(["d1", "turso"]);
    expect(withTursodb(on, W("d1", "pg"))).toEqual(["d1", "pg"]);
  });
  test("tursodb is a SQLite dialect", () => {
    expect(dialectOf("tursodb")).toBe("sqlite");
  });
});
