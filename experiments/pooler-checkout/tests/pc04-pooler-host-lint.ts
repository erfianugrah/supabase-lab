/**
 * PC04 - hard-coded `aws-<n>-<region>.pooler.supabase.com` hosts.
 *
 *   PC04a  which prefix the Management API reports for a fresh Pro project in
 *          this region (GET /config/database/pooler `db_host`).
 *   PC04b  the same tenant dialled on aws-0 and on aws-1, ports 5432 and 6543:
 *          which answer and which refuse, with the server's wording. This is
 *          the failure a literal host in source produces the day the project's
 *          cluster differs from the literal.
 *   PC04c  the lint (lib/lint-pooler-hosts.ts) on fixtures with a known number
 *          of aws-0 literals, then over this repository's tracked source: how
 *          many it flags (the lint's own test fixtures are built at run time
 *          so they do not count).
 *
 * Not settled: other regions, and whether any project is moved between
 * prefixes over its life (one project, one day here).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { Resolver, lookup } from "node:dns/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { lintPaths } from "../lib/lint-pooler-hosts";
import { timedQuery, type Target } from "../lib/pg";
import { acquireProject } from "../lib/project";

const mod: TestModule = {
  id: "PC04",
  title: "Pooler host prefix: API-reported host, the other prefix's answer, and the aws-0 lint",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!ctx.orgs.pro) return [{ id: "PC04", title: this.title, status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    const out: TestResult[] = [];
    const p = await acquireProject(ctx);
    const m = /^aws-(\d+)-(.+?)\.pooler\.supabase\.com$/.exec(p.poolerHost);
    const prefix = m ? `aws-${m[1]}` : "unparsed";
    const region = m?.[2] ?? p.region;

    out.push({
      id: "PC04a",
      title: "PC04a: pooler host the API reports for a fresh project",
      status: "info",
      detail: `db_host prefix ${prefix}, region ${region}, port ${p.poolerEntry.db_port}, user shape postgres.<ref>`,
      measurements: { api_prefix: prefix, region, api_db_port: p.poolerEntry.db_port },
    });

    const rows: string[] = [];
    const meas: Record<string, string | number> = {};
    for (const n of [0, 1]) {
      for (const port of [5432, 6543]) {
        const t: Target = { label: `aws-${n}:${port}`, host: `aws-${n}-${region}.pooler.supabase.com`, port, user: p.poolerUser };
        const r = await timedQuery(t, p.password, "select 1", 10_000, 10_000);
        const res = r.ok ? `ok ${r.totalMs} ms` : `${r.code} after ${r.totalMs} ms: ${r.error}`;
        rows.push(`aws-${n} :${port} -> ${res}`);
        meas[`aws${n}_${port}`] = res;
      }
    }
    const apiOk = meas[`aws${m?.[1] ?? "0"}_6543`] !== undefined && String(meas[`aws${m?.[1] ?? "0"}_6543`]).startsWith("ok");
    out.push({
      id: "PC04b",
      title: "PC04b: the same tenant on aws-0 and aws-1 hosts",
      status: apiOk ? "info" : "fail",
      detail: rows.join("; "),
      measurements: { ...meas, api_prefix_answers: apiOk ? "yes" : "no" },
    });

    // ---- PC04d: DNS view of the direct host, no IPv4 add-on. PC02b's `direct_host_*_addresses` come from the
    // OS resolver and read 0 for AAAA on an IPv4-only vantage; this row asks a public resolver as well.
    const dhost = `db.${p.ref}.supabase.co`;
    const pub = new Resolver();
    pub.setServers(["1.1.1.1"]);
    const nAddr = async (f: () => Promise<unknown[]>) => (await f().catch(() => [])).length;
    const [pub4, pub6, os4, os6] = await Promise.all([
      nAddr(() => pub.resolve4(dhost)),
      nAddr(() => pub.resolve6(dhost)),
      nAddr(() => lookup(dhost, { family: 4, all: true })),
      nAddr(() => lookup(dhost, { family: 6, all: true })),
    ]);
    out.push({
      id: "PC04d",
      title: "PC04d: addresses for the direct host without the IPv4 add-on, public resolver vs this machine's resolver",
      status: "info",
      detail: `public resolver (1.1.1.1): ${pub4} A, ${pub6} AAAA; OS resolver on this IPv4-only vantage: ${os4} IPv4, ${os6} IPv6`,
      measurements: { public_resolver_a: pub4, public_resolver_aaaa: pub6, os_resolver_ipv4: os4, os_resolver_ipv6: os6 },
    });

    // ---- PC04c: lint
    const dir = mkdtempSync(join(tmpdir(), "pc04-"));
    try {
      const lit = (n: number, r: string) => `${["aws", String(n), r].join("-")}.pooler.supabase.com`;
      writeFileSync(join(dir, "a.env"), `DATABASE_URL=postgres://postgres.x:y@${lit(0, "us-east-1")}:6543/postgres\n`);
      writeFileSync(join(dir, "b.ts"), `const h = "${lit(0, "ap-southeast-1")}";\nconst ok = "${lit(1, "ap-southeast-1")}";\n`);
      writeFileSync(join(dir, "c.yaml"), "host: db.abcdefghijklmnopqrst.supabase.co\n");
      const fixture = lintPaths([dir]);
      const fixtureAll = lintPaths([dir], true);
      const repo = lintPaths([resolve(process.cwd(), "../..")]);
      const repoFiles = new Set(repo.map((h) => h.file)).size;
      out.push({
        id: "PC04c",
        title: "PC04c: lint-pooler-hosts on fixtures and on this repository",
        status: fixture.length === 2 && fixtureAll.length === 3 ? "pass" : "fail",
        detail: `fixtures: 2 aws-0 literals expected, ${fixture.length} flagged (${fixtureAll.length} with --all-prefixes, 3 expected); this repo's tree: ${repo.length} aws-0 literal(s) in ${repoFiles} file(s)`,
        measurements: {
          fixture_flagged: fixture.length,
          fixture_flagged_all_prefixes: fixtureAll.length,
          repo_literals: repo.length,
          repo_files: repoFiles,
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    return out;
  },
};

export default mod;
