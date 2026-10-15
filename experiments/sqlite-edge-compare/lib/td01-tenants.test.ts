import { describe, expect, test } from "bun:test";
import { burstColumns, burstSize, deleteColumns, errorSummary, firstQuerySql, pgIdent, redact, TD01_PREFIX, tenantNames, untilOk } from "./td01-tenants";

describe("burstSize", () => {
  test("20 by default, 2 under TD_SMOKE=1, TD01_BURST overrides and is capped", () => {
    expect(burstSize({})).toBe(20);
    expect(burstSize({ TD_SMOKE: "1" })).toBe(2);
    expect(burstSize({ TD_SMOKE: "1", TD01_BURST: "5" })).toBe(5);
    expect(burstSize({ TD01_BURST: "500" })).toBe(50);
    expect(burstSize({ TD01_BURST: "x" })).toBe(20);
    expect(burstSize({ TD01_BURST: "0", TD_SMOKE: "1" })).toBe(2);
  });
});

describe("tenantNames", () => {
  test("every name carries the sec-td01-<stamp>- run prefix and the tenant alphabet", () => {
    const n = tenantNames("mgr5abcd", 20);
    expect(n.runPrefix).toBe("sec-td01-mgr5abcd-");
    expect(n.single).toBe("sec-td01-mgr5abcd-s");
    expect(n.burst).toHaveLength(20);
    for (const x of [n.single, ...n.burst]) {
      expect(x.startsWith("sec-")).toBe(true);
      expect(x.startsWith(TD01_PREFIX)).toBe(true);
      expect(x).toMatch(/^[a-z0-9-]+$/);
      expect(x.length).toBeLessThanOrEqual(32);
    }
    expect(new Set(n.burst).size).toBe(20);
  });
  test("refuses a stamp outside the alphabet", () => {
    expect(() => tenantNames("Bad_Stamp", 1)).toThrow();
    expect(() => tenantNames("", 1)).toThrow();
  });
});

describe("pgIdent / firstQuerySql", () => {
  test("quotes tenant names, refuses injection", () => {
    expect(pgIdent("sec-td01-x-s")).toBe('"sec-td01-x-s"');
    expect(() => pgIdent('a"; drop schema public; --')).toThrow();
    expect(() => pgIdent("Upper")).toThrow();
  });
  test("pg statements are schema-qualified, sqlite ones are not", () => {
    const p = firstQuerySql("pg", "sec-td01-x-s");
    for (const s of Object.values(p)) expect(s).toContain('"sec-td01-x-s".t');
    const q = firstQuerySql("sqlite");
    expect(q.select).toBe("SELECT v FROM t WHERE id = 1");
    expect(() => firstQuerySql("pg")).toThrow();
  });
});

describe("untilOk", () => {
  const noWait = async () => undefined;
  test("returns the value and attempt count; keeps the first error", async () => {
    let k = 0;
    const r = await untilOk(
      async () => {
        k++;
        if (k < 3) throw new Error(`not yet ${k}`);
        return "ok";
      },
      { deadlineMs: 10_000, wait: noWait },
    );
    expect(r.ok).toBe(true);
    expect(r.value).toBe("ok");
    expect(r.attempts).toBe(3);
    expect(r.firstError).toBe("not yet 1");
    expect(r.lastError).toBe("not yet 2");
  });
  test("first-try success carries no error fields", async () => {
    const r = await untilOk(async () => 1, { deadlineMs: 10, wait: noWait });
    expect(r).toMatchObject({ ok: true, attempts: 1 });
    expect(r.firstError).toBeUndefined();
  });
  test("gives up after the deadline without throwing", async () => {
    const r = await untilOk(
      async () => {
        throw new Error("never");
      },
      { deadlineMs: 0, wait: noWait },
    );
    expect(r.ok).toBe(false);
    expect(r.attempts).toBe(1);
    expect(r.lastError).toBe("never");
  });
});

// Built at runtime so the source carries no JWT-shaped literal (secret scanners flag it).
const FAKE_JWT = ["eyJhbGciOiJFZERTQSJ9", "eyJhIjoxfQ", "c2lnbmF0dXJl"].join(".");

describe("redact", () => {
  test("strips Turso hosts, UUIDs, JWTs, emails and literals", () => {
    const s = redact(
      `fetch https://sec-td01-a-s-someorg.aws-ap-southeast-2.turso.io failed; db 0f8b2c1e-1234-4abc-8def-0123456789ab; tok ${FAKE_JWT}; probe@lab.invalid; acct 0123456789abcdef0123456789abcdef; org someorg`,
      ["someorg"],
    );
    expect(s).not.toContain("turso.io");
    expect(s).not.toContain("0f8b2c1e");
    expect(s).not.toContain("eyJ");
    expect(s).not.toContain("probe@lab.invalid");
    expect(s).not.toContain("someorg");
    expect(s).not.toContain("0123456789abcdef0123456789abcdef");
  });
  test("truncates to 300 chars and ignores short literals", () => {
    expect(redact("x".repeat(400))).toHaveLength(300);
    expect(redact("abc", ["ab"])).toBe("abc");
  });
});

describe("burstColumns / errorSummary / deleteColumns", () => {
  test("counts, percentiles and distinct errors", () => {
    const cols = burstColumns([
      { name: "a", created: true, createMs: 100, ready: true, createToFirstQueryMs: 300, attempts: 1, tokenMs: 50 },
      { name: "b", created: true, createMs: 200, ready: true, createToFirstQueryMs: 500, attempts: 3, tokenMs: 70 },
      { name: "c", created: false, ready: false, error: "HTTP 429 slow down" },
      { name: "d", created: false, ready: false, error: "HTTP 429 slow down" },
    ]);
    expect(cols).toMatchObject({ n_requested: 4, n_created: 2, n_ready: 2, n_refused: 2, create_ms_p50: 150, create_ms_max: 200, create_to_first_query_ms_max: 500, first_query_attempts_max: 3, token_ms_max: 70 });
    expect(cols.errors).toBe("2x HTTP 429 slow down");
  });
  test("empty samples become empty cells, not NaN", () => {
    const cols = burstColumns([{ name: "a", created: false, ready: false, error: "e" }]);
    expect(cols.create_ms_p50).toBe("");
    expect(cols.token_ms_p50).toBeUndefined();
    const d = deleteColumns(undefined, [], 1);
    expect(d).toMatchObject({ delete_single_ms: "", n_burst_deleted: 0, delete_burst_ms_p50: "", n_delete_failed: 1 });
  });
  test("errorSummary orders by count", () => {
    expect(errorSummary(["a", "b", "b", undefined])).toBe("2x b | 1x a");
  });
});
