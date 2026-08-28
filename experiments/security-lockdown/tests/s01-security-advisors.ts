/**
 * S01 - the platform's own security view.
 *
 * Seed a deliberately-exposed fixture, then read the Management API security
 * advisor and record what it flags. The advisor is the first thing to run for
 * any "are we locked down?" question - it names the exposures (RLS-disabled
 * tables, SECURITY DEFINER views, exposed auth) without a pen test.
 *
 * DESTRUCTIVE: creates fixture objects; drops them in finally.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import { sql, waitFor } from "../lib/sec.js";

const mod: TestModule = {
  id: "S01",
  title: "security advisors: the platform's own exposure lints",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const results: TestResult[] = [];
    try {
      // Deliberately-exposed shapes the advisor should catch.
      await sql(ctx, `
create table if not exists public.sec_exposed (id bigint generated always as identity primary key, secret text);
insert into public.sec_exposed (secret) values ('pii-a'), ('pii-b');
grant select on public.sec_exposed to anon, authenticated;
create table if not exists public.sec_protected (id bigint generated always as identity primary key, owner text);
alter table public.sec_protected enable row level security;
create or replace view public.sec_leaky_view as select * from public.sec_protected;
grant select on public.sec_leaky_view to anon;
create or replace function public.sec_def() returns text language sql security definer as $$ select 'x' $$;
`);
      await waitFor(async () => true, 2000);

      const adv = await mgmt(ctx, "GET", `/projects/${ctx.ref}/advisors/security`);
      const lints = (adv.json as { lints?: { name?: string; level?: string; title?: string; categories?: string[] }[] })?.lints ?? [];
      const byLevel: Record<string, number> = {};
      for (const l of lints) byLevel[l.level ?? "?"] = (byLevel[l.level ?? "?"] ?? 0) + 1;

      results.push({
        id: "S01a",
        title: "security advisor reachable + returns lints",
        status: adv.status === 200 ? "pass" : "fail",
        detail: adv.status === 200 ? `${lints.length} lints (${Object.entries(byLevel).map(([k, v]) => `${k}:${v}`).join(" ")})` : `advisor HTTP ${adv.status} ${adv.text.slice(0, 120)}`,
        measurements: { status: adv.status, lint_count: lints.length },
      });

      const names = lints.map((l) => l.name ?? l.title ?? "?");
      const flaggedRls = names.some((n) => /rls|row level/i.test(n));
      const flaggedDef = names.some((n) => /security.?definer|definer/i.test(n));
      results.push({
        id: "S01b",
        title: "advisor catches the seeded exposures",
        status: adv.status === 200 ? "info" : "skip",
        detail: `RLS-related lint present=${flaggedRls}; SECURITY DEFINER lint present=${flaggedDef}. Distinct lint names: ${[...new Set(names)].slice(0, 10).join(", ")}`,
        measurements: { rls_flagged: String(flaggedRls), definer_flagged: String(flaggedDef) },
        evidence: JSON.stringify(lints.slice(0, 8)).slice(0, 1500),
      });
    } catch (e) {
      results.push({ id: "S01err", title: "S01 aborted", status: "fail", detail: e instanceof Error ? e.message : String(e) });
    } finally {
      await sql(ctx, `
drop function if exists public.sec_def();
drop view if exists public.sec_leaky_view;
drop table if exists public.sec_protected cascade;
drop table if exists public.sec_exposed cascade;
`).catch(() => {});
    }
    return results;
  },
};
export default mod;
