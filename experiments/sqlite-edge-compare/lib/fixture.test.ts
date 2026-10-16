import { describe, expect, test } from "bun:test";
import { PREFIX } from "./contract";
import {
  type DownOps,
  downWith,
  emptyFixture,
  exportLines,
  exportsFor,
  type Fixture,
  idsOnly,
  isComplete,
  literalsOf,
  missingEnv,
  names,
  parseFixture,
  renderWrangler,
  scrub,
  workerSecrets,
  workerUrl,
} from "./fixture";
import { assertSec, secOnly } from "./vendors";

// Built at runtime: identifiers.test.ts fails any tracked file holding the 20-letter ref shape.
const REF = "a".repeat(20);
const full = (): Fixture => ({
  ...emptyFixture("abc123"),
  supabase: {
    name: "sec-pg-abc123",
    ref: REF,
    region: "ap-southeast-2",
    org: "org-slug-x",
    dbPass: "pw",
    url: `https://${REF}.supabase.co`,
    directHost: `db.${REF}.supabase.co`,
    poolerHost: "aws-1-ap-southeast-2.pooler.supabase.com",
    poolerUser: `postgres.${REF}`,
    secretKey: "sb_secret_x",
    readyMs: 1,
  },
  turso: { org: "tursoorg", group: "sec-syd", groupCreated: true, location: "aws-ap-southeast-2", db: "sec-td-abc123", hostname: "sec-td-abc123-tursoorg.aws-ap-southeast-2.turso.io", url: "https://sec-td-abc123-tursoorg.aws-ap-southeast-2.turso.io", token: "tok" },
  d1: { name: "sec-d1-abc123", id: "11111111-2222-3333-4444-555555555555", locationHint: "oc" },
  hyperdrive: { nocache: { name: "sec-hd-nc-abc123", id: "0123456789abcdef0123456789abcdef" }, cached: { name: "sec-hd-c-abc123", id: "fedcba9876543210fedcba9876543210" } },
  worker: { name: "sec-probe-abc123", url: "https://sec-probe-abc123.sub.workers.dev", probeKey: "k", compatDate: "2026-09-01", deployedAt: "t" },
});

describe("names", () => {
  test("every resource name carries the sec- prefix", () => {
    for (const n of Object.values(names("abc123"))) expect(n.startsWith(PREFIX)).toBe(true);
  });
  test("worker URL", () => {
    expect(workerUrl("sec-probe-x", "sub")).toBe("https://sec-probe-x.sub.workers.dev");
  });
});

describe("prefix guard", () => {
  test("assertSec refuses anything else", () => {
    expect(() => assertSec("plain")).toThrow();
    expect(() => assertSec("")).toThrow();
    expect(() => assertSec(undefined)).toThrow();
    expect(() => assertSec("SEC-x")).toThrow();
    expect(assertSec("sec-x")).toBe("sec-x");
  });
  test("secOnly keeps sec- names only", () => {
    const xs = [{ n: "sec-a" }, { n: "prod" }, { n: "my-sec-b" }, { n: undefined }, { n: "sec-" }];
    expect(secOnly(xs, (x) => x.n).map((x) => x.n)).toEqual(["sec-a", "sec-"]);
  });
});

describe("fixture file shape", () => {
  test("round trip and completeness", () => {
    const f = full();
    expect(parseFixture(JSON.stringify(f)).stamp).toBe("abc123");
    expect(isComplete(f)).toBe(true);
    expect(isComplete(emptyFixture())).toBe(false);
  });
  test("rejects a wrong version or a non-sec- name", () => {
    expect(() => parseFixture(JSON.stringify({ version: 2, stamp: "x" }))).toThrow();
    const bad = full();
    bad.d1!.name = "prod-d1";
    expect(() => parseFixture(JSON.stringify(bad))).toThrow(/prefix/);
  });
  test("wrangler render binds D1, both Hyperdrives and the vars; no secrets", () => {
    const w = renderWrangler(full(), { pg: "8.22.0", libsql: "0.18.0" }) as Record<string, unknown>;
    expect(w.name).toBe("sec-probe-abc123");
    expect(w.compatibility_flags).toEqual(["nodejs_compat"]);
    expect((w.hyperdrive as { binding: string }[]).map((h) => h.binding)).toEqual(["HD", "HD_CACHED"]);
    expect((w.d1_databases as { binding: string }[])[0]!.binding).toBe("DB");
    expect(w.durable_objects).toEqual({ bindings: [{ name: "PDO", class_name: "ProbeDO" }] });
    expect(w.migrations).toEqual([{ tag: "v1", new_sqlite_classes: ["ProbeDO"] }]);
    const s = JSON.stringify(w);
    expect(s).not.toContain("sb_secret_x");
    expect(s).not.toContain('"tok"');
    expect(s).not.toContain('"pw"');
    expect(Object.keys(workerSecrets(full())).sort()).toEqual(["PROBE_KEY", "SUPABASE_SECRET_KEY", "TURSODB_TOKEN", "TURSO_TOKEN"]);
  });
  test("probe exports carry identifiers and the fixture path, never a secret", () => {
    const e = exportsFor(full(), "/x/.fixture.json", { PVLAB_ORG_PRO: "pro-slug" });
    expect(e.PVLAB_ENDPOINT_PROBE).toBe("https://sec-probe-abc123.sub.workers.dev");
    expect(e.PVLAB_PEER_TURSO_DB).toBe("sec-td-abc123");
    expect(e.PVLAB_ENDPOINT_FIXTURE).toBe("/x/.fixture.json");
    expect(e.PVLAB_ORG_TURSO).toBe("tursoorg");
    expect(e.PVLAB_ORG_PRO).toBe("pro-slug");
    const all = Object.values(e).join(" ");
    for (const secret of ["sb_secret_x", "tok", "pw"]) expect(all.split(/\s+/)).not.toContain(secret);
    expect(exportLines({ A: "it's" })).toBe(`export A='it'\\''s'`);
  });
  test("archived ids drop every secret; literals list the identifiers", () => {
    const ids = JSON.stringify(idsOnly(full()));
    for (const s of ["sb_secret_x", '"tok"', '"pw"', '"k"']) expect(ids).not.toContain(s);
    const l = literalsOf(full(), { CLOUDFLARE_ACCOUNT_ID: "acct123456" });
    expect(l).toContain("tursoorg");
    expect(l).toContain("11111111-2222-3333-4444-555555555555");
    expect(l).toContain("acct123456");
    expect(l).toContain("sec-probe-abc123.sub.workers.dev");
  });
  test("scrub strips DSNs, emails, ids and literals", () => {
    const s = scrub("postgres://u:p@h/db someone@example.com 0123456789abcdef0123456789abcdef host tursoorg", full());
    expect(s).not.toContain("p@h");
    expect(s).not.toContain("someone@example.com");
    expect(s).not.toContain("0123456789abcdef");
    expect(s).not.toContain("tursoorg");
  });
  test("missingEnv names what is absent", () => {
    expect(missingEnv({ SUPABASE_ACCESS_TOKEN: "x" })).toContain("TURSO_API_TOKEN");
  });
});

describe("down", () => {
  const ops = (statuses: Partial<Record<keyof DownOps, number | Error>>, calls: string[]): DownOps => {
    const mk = (k: keyof DownOps) => async (arg: string) => {
      calls.push(`${k}:${arg}`);
      const s = statuses[k] ?? 200;
      if (s instanceof Error) throw s;
      return s;
    };
    return { worker: mk("worker"), hyperdrive: mk("hyperdrive"), d1: mk("d1"), tursoDb: mk("tursoDb"), tursoGroup: mk("tursoGroup"), project: mk("project") };
  };
  test("deletes in dependency order", async () => {
    const calls: string[] = [];
    const r = await downWith(full(), ops({}, calls));
    expect(r.ok).toBe(true);
    expect(calls.map((c) => c.split(":")[0])).toEqual(["worker", "hyperdrive", "hyperdrive", "d1", "tursoDb", "tursoGroup", "project"]);
  });
  test("idempotent: everything already gone (404) is still ok", async () => {
    const calls: string[] = [];
    const r = await downWith(full(), ops({ worker: 404, hyperdrive: 404, d1: 404, tursoDb: 404, tursoGroup: 404, project: 404 }, calls));
    expect(r.ok).toBe(true);
    expect(calls.length).toBe(7);
  });
  test("partial fixture: only what exists is attempted", async () => {
    const calls: string[] = [];
    const f = emptyFixture("p1");
    f.turso = full().turso;
    const r = await downWith(f, ops({}, calls));
    expect(r.ok).toBe(true);
    expect(calls).toEqual(["tursoDb:sec-td-abc123", "tursoGroup:sec-syd"]);
  });
  test("a thrown delete is reported, the rest still run, and ok is false", async () => {
    const calls: string[] = [];
    const r = await downWith(full(), ops({ d1: new Error("boom") }, calls));
    expect(r.ok).toBe(false);
    expect(calls.length).toBe(7);
    expect(String(r.steps.find((s) => s.what === "d1")!.status)).toContain("boom");
  });
  test("a Turso-engine database is deleted before the group; a refused one is skipped", async () => {
    const calls: string[] = [];
    const f = emptyFixture("p2");
    f.turso = full().turso;
    f.tursodb = { db: "sec-tdb-p2", hostname: "h", url: "https://h", token: "t2" };
    await downWith(f, ops({}, calls));
    expect(calls).toEqual(["tursoDb:sec-td-abc123", "tursoDb:sec-tdb-p2", "tursoGroup:sec-syd"]);
    const c2: string[] = [];
    f.tursodb = { db: "sec-tdb-p2", error: "HTTP 400" };
    await downWith(f, ops({}, c2));
    expect(c2).toEqual(["tursoDb:sec-td-abc123", "tursoGroup:sec-syd"]);
  });
  test("a kept (non-empty) Turso group is not a failure", async () => {
    const r = await downWith(full(), ops({ tursoGroup: 0 }, []));
    expect(r.ok).toBe(true);
  });
});
