/**
 * S12 - rate limiting via a Cloudflare Worker (the S05 variant).
 *
 * S05 proved the pattern with nginx; S12 proves it is edge-agnostic by doing
 * the same burst against a Worker using the native Rate Limiting binding, run
 * locally with `wrangler dev` in front of the same self-hosted PostgREST. Same
 * finding: throttles without black-holing, and only because it fronts a closed
 * origin.
 *
 *   S12a - a burst through the Worker gets 429s.
 *   S12b - the Worker still proxies real data (200s present).
 *
 * Needs `make postgrest-up` + the Worker running (PVLAB_ENDPOINT_RATELIMIT_WORKER);
 * self-skips otherwise. DESTRUCTIVE: creates a table; drops it in finally.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { http, sql, waitFor } from "../lib/sec.js";

const T = "sec_rlw";

const mod: TestModule = {
  id: "S12",
  title: "rate limiting via a Cloudflare Worker (edge-agnostic variant of S05)",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const rl = ctx.endpoints["ratelimit_worker"];
    if (!rl) return [{ id: "S12", title: this.title, status: "skip", detail: "no worker endpoint - run `make postgrest-up ratelimit-worker-up` first" }];
    const results: TestResult[] = [];
    try {
      await sql(ctx, `
create table if not exists public.${T} (id bigint generated always as identity primary key, note text);
truncate public.${T};
insert into public.${T} (note) values ('rlw-a'), ('rlw-b');
grant usage on schema public to anon;
grant select on public.${T} to anon;
create or replace function public.sec_ip_filter() returns void language plpgsql as $$
declare xff text := current_setting('request.headers', true)::json ->> 'x-forwarded-for';
begin
  if xff is not null and xff like '%203.0.113.9%' then
    raise sqlstate 'PT403' using message = 'ip banned';
  end if;
end$$;
grant execute on function public.sec_ip_filter() to anon;
notify pgrst, 'reload schema';
`);
      const ready = await waitFor(async () => (await http(`${rl}/${T}?select=id`)).status === 200, 60_000);
      if (!ready.ok) return [{ id: "S12", title: this.title, status: "fail", detail: "worker never served the table (worker->PostgREST path not wired)" }];

      // The readiness polls consume the limiter's per-window budget; wait past
      // one window (period=10s) so the burst starts on a fresh allowance and
      // some requests get through before the limit bites.
      await new Promise((r) => setTimeout(r, 12_000));

      const burst = await Promise.all(Array.from({ length: 15 }, () => http(`${rl}/${T}?select=id`)));
      const n429 = burst.filter((r) => r.status === 429).length;
      const n200 = burst.filter((r) => r.status === 200).length;

      results.push({
        id: "S12a",
        title: "burst through the Worker is rate-limited (429s present)",
        status: n429 > 0 ? "pass" : "fail",
        detail: `15-request burst -> ${n200}x200, ${n429}x429 via the Worker's Rate Limiting binding. Same result as nginx (S05); the edge is interchangeable.`,
        measurements: { burst_429: n429, burst_200: n200 },
      });
      results.push({
        id: "S12b",
        title: "the Worker still proxies real data",
        status: n200 > 0 ? "pass" : "fail",
        detail: `${n200} of 15 served data - throttle, not black-hole. Works because it fronts a closed origin (managed Data API off).`,
        measurements: { served: n200 },
      });
    } catch (e) {
      results.push({ id: "S12err", title: "S12 aborted", status: "fail", detail: e instanceof Error ? e.message : String(e) });
    } finally {
      await sql(ctx, `drop table if exists public.${T} cascade;`).catch(() => {});
    }
    return results;
  },
};
export default mod;
