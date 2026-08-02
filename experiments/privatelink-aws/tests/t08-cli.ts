/**
 * T08/T09/T10 - which CLI migration paths actually traverse the endpoint.
 *
 * The load-bearing fact: a plain `supabase link` stores the SHARED pooler
 * connection, which is public-only and unreachable over PrivateLink, so
 * migrations keep working right up until public access is closed. Both the
 * working alternatives are exercised here.
 */
import { $ } from "bun";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";

const DIR = "/tmp/pvlab-cli";

async function sh(cmd: string, ctx: Ctx, extraEnv: Record<string, string> = {}) {
  const p = await $`bash -lc ${cmd}`
    .cwd(DIR)
    .env({
      ...process.env,
      SUPABASE_ACCESS_TOKEN: ctx.pat ?? "",
      SUPABASE_DB_PASSWORD: ctx.dbPassword,
      ...extraEnv,
    })
    .quiet()
    .nothrow();
  return {
    ok: p.exitCode === 0,
    out: (p.stdout.toString() + p.stderr.toString()).trim(),
  };
}

const mod: TestModule = {
  id: "T08",
  title: "CLI migration paths over the endpoint",
  where: "runner",
  requires: ["db", "pat"],
  async run(ctx) {
    const results: TestResult[] = [];
    await $`rm -rf ${DIR}`.quiet().nothrow();
    await $`mkdir -p ${DIR}`.quiet();
    await sh("supabase init --force --workdir . >/dev/null 2>&1 || supabase init --force", ctx);
    await Bun.write(
      `${DIR}/supabase/migrations/20260802000000_pvlab.sql`,
      "create table if not exists pvlab_probe (id int primary key, at timestamptz default now());\n",
    );

    // T08: default link - expected to resolve to the public shared pooler.
    const link = await sh(`supabase link --project-ref ${ctx.ref} -p "$SUPABASE_DB_PASSWORD"`, ctx);
    const linkedHost =
      (await $`bash -lc "grep -ho 'pooler[^ \"]*' ${DIR}/supabase/.temp/* 2>/dev/null | head -1"`
        .quiet()
        .nothrow()
        .text()).trim() || "unknown";
    results.push({
      id: "T08",
      title: "default `supabase link`",
      status: link.ok ? "info" : "fail",
      detail: link.ok
        ? `linked; stored host looks like ${linkedHost || "the shared pooler"} (public path)`
        : link.out.split("\n").pop() ?? "link failed",
      measurements: { linked_host: linkedHost },
    });

    // T09: the documented fix - link direct, then push over the endpoint.
    const skipPooler = await sh(`supabase link --project-ref ${ctx.ref} --skip-pooler -p "$SUPABASE_DB_PASSWORD"`, ctx);
    const push = skipPooler.ok ? await sh("printf 'y\\n' | supabase db push --include-all", ctx) : null;
    results.push({
      id: "T09",
      title: "`link --skip-pooler` + `db push` over the endpoint",
      status: push?.ok ? "pass" : "fail",
      detail: push?.ok
        ? "migration applied over the private path"
        : (push?.out ?? skipPooler.out).split("\n").filter(Boolean).slice(-4).join(" | ").slice(0, 300),
    });

    // T10: no link at all - explicit db-url through the PHZ.
    const url = `postgresql://postgres:${encodeURIComponent(ctx.dbPassword)}@${ctx.phzHost}:5432/postgres?sslmode=require`;
    const dbUrl = await sh(`printf 'y\\n' | supabase db push --db-url '${url}' --include-all`, ctx);
    results.push({
      id: "T10",
      title: "`db push --db-url` with no link",
      status: dbUrl.ok ? "pass" : "fail",
      detail: dbUrl.ok
        ? "migration applied via an explicit endpoint URL"
        : dbUrl.out.split("\n").filter(Boolean).slice(-4).join(" | ").slice(0, 300),
    });

    return results;
  },
};
export default mod;
