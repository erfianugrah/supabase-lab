/**
 * MS10 - Prisma 6.19 (a current 6.x) on each pooled path, with and
 * without `pgbouncer=true`.
 *
 * Prisma's own guidance: `pgbouncer=true` (which disables prepared statements
 * client-side) for PgBouncer below 1.21; not needed at 1.21+. Supabase's
 * Prisma troubleshooting page still says Supavisor transaction mode does not
 * support prepared statements. privatelink-aws T11 measured `PREPARE`/
 * `EXECUTE` working on both poolers with the `pg` driver - a single named
 * statement. Prisma's engine issues many named statements from many
 * connections concurrently, which is the shape that breaks (`prepared
 * statement "s0" already exists` / `does not exist`). Rows, each the same
 * workload (20 workers x 25 rounds of findMany + count + parameterised
 * $queryRaw + create, `connection_limit=5&pool_timeout=10`):
 *
 *   MS10a  shared 6543 with pgbouncer=true  - the common 6.x configuration
 *   MS10b  shared 6543 without pgbouncer=true
 *   MS10c  dedicated 6543 with pgbouncer=true
 *   MS10d  dedicated 6543 without pgbouncer=true
 *   MS10e  direct 5432 (control)
 *
 * Schema is pushed with `prisma db push` over the session pooler on 5432,
 * which is the IPv4 migration path. DESTRUCTIVE: installs the probe's npm
 * deps, creates and drops `public.ms_record`. Not settled: Prisma 7 with the
 * `pg` adapter (6.x is the common case), and long-running-process behaviour
 * (this is a burst).
 */
import { $ } from "bun";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { sql } from "../../../harness/src/platform";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { dedicatedTarget, directTarget, primaryPooler, sharedTargets, type PgTarget } from "../lib/setup";

// Not import.meta.dir: inside the compiled pvlab binary that resolves into the
// bundle (/$bunfs/...), not the repo. `make probe` runs from the experiment dir.
const DIR = process.env.PVLAB_PRISMA_DIR ?? resolve(process.cwd(), "prisma");

function url(t: PgTarget, pw: string, extra: string): string {
  return `postgres://${encodeURIComponent(t.user)}:${encodeURIComponent(pw)}@${t.host}:${t.port}/postgres?sslmode=require&connection_limit=5&pool_timeout=10${extra}`;
}

interface ProbeOut {
  ok_iterations: number;
  failed_iterations: number;
  p50_ms: number | null;
  p95_ms: number | null;
  wall_ms: number;
  connect_error: string | null;
  errors: { n: number; k: string }[];
}

const mod: TestModule = {
  id: "MS10",
  title: "Prisma 6.19 on each pooled path, with and without pgbouncer=true",
  where: "local",
  requires: ["pat", "db"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const sv = await primaryPooler(ctx);
    if (!sv) return [{ id: "MS10", title: mod.title, status: "skip", detail: "pooler config unreadable" }];
    const shared = sharedTargets(sv);
    const ded = dedicatedTarget(ctx);
    const direct = directTarget(ctx);
    const pw = ctx.dbPassword;
    const env = { ...process.env, DIRECT_URL: url(shared.session, pw, ""), DATABASE_URL: url(shared.txn, pw, "&pgbouncer=true") };

    if (!existsSync(resolve(DIR, "node_modules/.bin/prisma"))) {
      ctx.log("bun install (prisma 6.19.3)");
      const i = await $`bun install`.cwd(DIR).env(env).quiet().nothrow();
      if (i.exitCode !== 0) return [{ id: "MS10", title: mod.title, status: "fail", detail: `bun install failed: ${i.stderr.toString().slice(-300)}` }];
    }
    const gen = await $`bunx prisma generate`.cwd(DIR).env(env).quiet().nothrow();
    if (gen.exitCode !== 0) return [{ id: "MS10", title: mod.title, status: "fail", detail: `prisma generate failed: ${gen.stderr.toString().slice(-300)}` }];
    const t0 = Date.now();
    const push = await $`bunx prisma db push --skip-generate --accept-data-loss`.cwd(DIR).env(env).quiet().nothrow();
    const pushMs = Date.now() - t0;
    const out: TestResult[] = [];
    if (push.exitCode !== 0)
      return [{ id: "MS10", title: mod.title, status: "fail", detail: `prisma db push over session 5432 failed in ${pushMs}ms: ${(push.stderr.toString() + push.stdout.toString()).slice(-400)}` }];
    ctx.log(`db push over session pooler ok in ${pushMs}ms`);

    const rows: [string, string, PgTarget, string][] = [
      ["MS10a", "shared 6543, pgbouncer=true (common 6.x setup)", shared.txn, "&pgbouncer=true"],
      ["MS10b", "shared 6543, no pgbouncer flag", shared.txn, ""],
      ["MS10c", "dedicated 6543, pgbouncer=true", ded, "&pgbouncer=true"],
      ["MS10d", "dedicated 6543, no pgbouncer flag", ded, ""],
      ["MS10e", "direct 5432 (control)", direct, ""],
    ];
    try {
      for (const [id, label, t, extra] of rows) {
        // PVLAB_PRISMA_RUNTIME=node is the fallback if Prisma's engine refuses Bun.
        const runtime = process.env.PVLAB_PRISMA_RUNTIME ?? "bun";
        const p = await $`${runtime} probe.mjs`
          .cwd(DIR)
          .env({ ...env, DATABASE_URL: url(t, pw, extra), LABEL: label, CONCURRENCY: "20", ROUNDS: "25" })
          .quiet()
          .nothrow();
        const line = p.stdout.toString().trim().split("\n").pop() ?? "";
        let r: ProbeOut | null = null;
        try {
          r = JSON.parse(line) as ProbeOut;
        } catch {}
        if (!r) {
          out.push({ id, title: label, status: "fail", detail: `probe emitted no JSON (exit ${p.exitCode}): ${p.stderr.toString().slice(-300)}`, measurements: { path: label } });
          continue;
        }
        const total = r.ok_iterations + r.failed_iterations;
        out.push({
          id,
          title: `${label}: 20 workers x 25 rounds`,
          status: r.connect_error ? "fail" : r.failed_iterations === 0 ? "pass" : "info",
          detail: r.connect_error
            ? `connect failed: ${r.connect_error}`
            : `${r.ok_iterations}/${total} iterations ok, p50 ${r.p50_ms} ms p95 ${r.p95_ms} ms, ${Math.round(r.wall_ms / 1000)}s wall${r.errors.length ? `; top error ${r.errors[0]!.n}x ${r.errors[0]!.k}` : ""}`,
          measurements: {
            path: label,
            ok_iterations: r.ok_iterations,
            failed_iterations: r.failed_iterations,
            p50_ms: r.p50_ms ?? "n/a",
            p95_ms: r.p95_ms ?? "n/a",
            wall_s: Math.round(r.wall_ms / 100) / 10,
            top_error: r.errors[0]?.k ?? "",
          },
          evidence: r.errors.map((e) => `${e.n}x ${e.k}`).join("\n"),
        });
      }
    } finally {
      await sql(ctx, "drop table if exists public.ms_record").catch(() => {});
    }
    out.unshift({ id: "MS10", title: "prisma db push over the session pooler (5432)", status: "pass", detail: `ok in ${pushMs}ms`, measurements: { push_ms: pushMs, prisma: "6.19.3" } });
    return out;
  },
};
export default mod;
