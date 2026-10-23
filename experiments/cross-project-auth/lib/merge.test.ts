import { afterEach, describe, expect, test } from "bun:test";
import { seedRows } from "./fanout";
import { cmpExact, cmpMs, type Cursor, exactCursor, fanout, msCursor, pageQuery, tsMicros, type Row } from "./merge";

describe("tsMicros", () => {
  test("keeps microseconds and accepts PostgREST's trimmed fractions", () => {
    expect(tsMicros("2026-10-01T00:00:00.123456+00:00") - tsMicros("2026-10-01T00:00:00.123455+00:00")).toBe(1n);
    expect(tsMicros("2026-10-01T00:00:00.12+00:00")).toBe(tsMicros("2026-10-01T00:00:00.120000+00:00"));
    expect(tsMicros("2026-10-01T00:00:00+00:00") + 500000n).toBe(tsMicros("2026-10-01T00:00:00.5+00:00"));
  });
  test("normalises offsets", () => {
    expect(tsMicros("2026-10-01T08:00:00.000001+08")).toBe(tsMicros("2026-10-01T00:00:00.000001Z"));
    expect(tsMicros("2026-10-01 00:00:00.000001+0000")).toBe(tsMicros("2026-10-01T00:00:00.000001Z"));
  });
  test("throws on garbage rather than sorting it somewhere", () => {
    expect(() => tsMicros("yesterday")).toThrow();
  });
});

const r = (created_at: string, id: string): Row => ({ created_at, id });

describe("comparators", () => {
  const a = r("2026-10-01T00:00:00.123456+00:00", "0000");
  const b = r("2026-10-01T00:00:00.123455+00:00", "ffff");
  test("cmpExact orders by microsecond, newest first", () => {
    expect([b, a].sort(cmpExact)).toEqual([a, b]);
  });
  test("cmpMs sees the two as one millisecond and falls back to id", () => {
    expect([a, b].sort(cmpMs)).toEqual([b, a]);
  });
  test("exact ties break by id descending", () => {
    const t1 = r("2026-10-01T00:00:00.5+00:00", "aaaa");
    const t2 = r("2026-10-01T00:00:00.5+00:00", "bbbb");
    expect([t1, t2].sort(cmpExact)).toEqual([t2, t1]);
  });
});

describe("cursors and page query", () => {
  test("msCursor drops the microseconds, exactCursor keeps the text", () => {
    const row = r("2026-10-01T00:00:00.123456+00:00", "x");
    expect(msCursor(row).created_at).toBe("2026-10-01T00:00:00.123Z");
    expect(exactCursor(row).created_at).toBe("2026-10-01T00:00:00.123456+00:00");
  });
  test("keyset filter is URL-encoded so + survives", () => {
    const q = pageQuery(20, { cursor: { created_at: "2026-10-01T00:00:00.1+00:00", id: "abc" } });
    expect(q).toContain("order=created_at.desc,id.desc&limit=20");
    expect(decodeURIComponent(q.split("&or=")[1] ?? "")).toBe(
      '(created_at.lt."2026-10-01T00:00:00.1+00:00",and(created_at.eq."2026-10-01T00:00:00.1+00:00",id.lt.abc))',
    );
    expect(q).not.toContain("+");
  });
});

describe("fanout policies (stubbed fetch)", () => {
  const real = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = real;
  });
  const stub = (byHost: Record<string, () => Promise<Response>>) => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const host = new URL(String(input)).host;
      const f = byHost[host];
      if (!f) throw new TypeError("fetch failed");
      return f();
    }) as typeof fetch;
  };
  const targets = [
    { name: "a", url: "https://a.test", anon: "k", table: "t" },
    { name: "b", url: "https://b.test", anon: "k", table: "t" },
  ];
  const rowsA = [r("2026-10-01T00:00:03+00:00", "a3"), r("2026-10-01T00:00:01+00:00", "a1")];
  const rowsB = [r("2026-10-01T00:00:02+00:00", "b2")];

  test("both legs answer: merged, sorted, limited", async () => {
    stub({ "a.test": async () => Response.json(rowsA), "b.test": async () => Response.json(rowsB) });
    const res = await fanout(targets, "tok", "q", 2, { policy: "all", timeoutMs: 1000 });
    expect(res.ok).toBe(true);
    expect(res.rows.map((x) => x.id)).toEqual(["a3", "b2"]);
    expect(res.legs.length).toBe(2);
  });
  test("policy all: one 401 fails the whole read", async () => {
    stub({ "a.test": async () => Response.json(rowsA), "b.test": async () => Response.json({ code: "PGRST301" }, { status: 401 }) });
    const res = await fanout(targets, "tok", "q", 10, { policy: "all", timeoutMs: 1000 });
    expect(res.ok).toBe(false);
    expect(res.rows).toEqual([]);
    expect(res.error).toContain("HTTP 401 PGRST301");
  });
  test("policy settled: one leg down returns the other's rows as partial", async () => {
    stub({ "a.test": async () => Response.json(rowsA) });
    const res = await fanout(targets, "tok", "q", 10, { policy: "settled", timeoutMs: 1000 });
    expect(res.ok).toBe(false);
    expect(res.partial).toBe(true);
    expect(res.rows.map((x) => x.id)).toEqual(["a3", "a1"]);
    expect(res.legs.find((l) => l.name === "b")?.status).toBe(0);
  });
  test("a leg that never answers is cut at timeoutMs", async () => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (new URL(String(input)).host === "a.test") return Response.json(rowsA);
      return new Promise<Response>((_, rej) => init?.signal?.addEventListener("abort", () => rej(init.signal?.reason)));
    }) as typeof fetch;
    const res = await fanout(targets, "tok", "q", 10, { policy: "settled", timeoutMs: 150 });
    expect(res.partial).toBe(true);
    expect(res.ms).toBeGreaterThanOrEqual(140);
    expect(res.error).toContain("TimeoutError");
  });
});

/**
 * Offline replay of X06 over the seed layout X04 inserts (lib/fanout.ts
 * seedRows): two in-memory "projects", each leg filtered and ordered the way
 * the per-leg PostgREST query asks (keyset predicate on exact microseconds,
 * order created_at desc, id desc, limit PAGE), merged with the same code the
 * live run uses. This is where the RUNLOG's "the count belongs to this seed
 * layout" comes from: no network, same 39.
 */
describe("X06 replay over the seed layout", () => {
  const PAGE = 20;
  const { rows } = seedRows();
  const toRow = (r: { id: string; ts: string; src: string }): Row => ({ id: r.id, created_at: r.ts.replace(/\+00$/, "+00:00"), src: r.src });
  const legA = rows.filter((r) => r.tenant === "tenant-a" && r.src === "a").map(toRow).sort(cmpExact);
  const legB = rows.filter((r) => r.tenant === "tenant-a" && r.src === "b").map(toRow).sort(cmpExact);
  const truth = [...legA, ...legB].sort(cmpExact).map((r) => r.id);
  const after = (r: Row, c: Cursor) => {
    const x = tsMicros(r.created_at);
    const y = tsMicros(c.created_at);
    return x < y || (x === y && r.id < c.id);
  };
  const walk = (cursorOf: (r: Row) => Cursor, cmp: (a: Row, b: Row) => number) => {
    const seq: string[] = [];
    let c: Cursor | undefined;
    for (let p = 0; p < 400; p++) {
      const page = [legA, legB]
        .flatMap((leg) => (c ? leg.filter((r) => after(r, c as Cursor)) : leg).slice(0, PAGE))
        .sort(cmp)
        .slice(0, PAGE);
      seq.push(...page.map((r) => r.id));
      if (page.length < PAGE) break;
      c = cursorOf(page[page.length - 1] as Row);
    }
    return { seq, missing: truth.filter((id) => !seq.includes(id)).length };
  };

  test("seed layout matches X04a (576 + 664 = 1240 tenant-a rows)", () => {
    expect([legA.length, legB.length, truth.length]).toEqual([576, 664, 1240]);
  });
  test("exact cursor: every row, in truth order", () => {
    expect(walk(exactCursor, cmpExact).seq).toEqual(truth);
  });
  test("Date cursor: 39 rows skipped, no duplicates", () => {
    const r = walk(msCursor, cmpExact);
    expect(r.missing).toBe(39);
    expect(new Set(r.seq).size).toBe(r.seq.length);
  });
  test("Date comparator and Date cursor: the same 39 skipped", () => {
    expect(walk(msCursor, cmpMs).missing).toBe(39);
  });
});
