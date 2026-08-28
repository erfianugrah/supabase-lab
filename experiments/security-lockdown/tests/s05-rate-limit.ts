/**
 * S05 - rate limiting in front of your own PostgREST.
 *
 * The user's point: rate limiting can live on many things (Cloudflare Worker,
 * WAF, nginx, Upstash). Here it's nginx limit_req in front of the self-hosted
 * PostgREST (S04). The only rule that matters: it must front a CLOSED origin,
 * or callers bypass it - which is exactly why the managed Data API can't be
 * rate-limited this way (its endpoint always answers a key-holder) but your
 * own PostgREST can.
 *
 *   S05a - a burst through the rate limiter: some requests get 429.
 *   S05b - the limiter proxies real data (not just blocks) - 200s present.
 *
 * Needs make postgrest-up + ratelimit-up (PVLAB_ENDPOINT_RATELIMIT);
 * self-skips otherwise. DESTRUCTIVE: creates a table; drops it in finally.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { http, sql, waitFor } from "../lib/sec.js";

const T = "sec_rl";

const mod: TestModule = {
  id: "S05",
  title: "rate limiting in front of the self-hosted PostgREST",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const rl = ctx.endpoints["ratelimit"];
    if (!rl) return [{ id: "S05", title: this.title, status: "skip", detail: "no rate-limit endpoint - run `make postgrest-up ratelimit-up` first" }];
    const results: TestResult[] = [];
    try {
      await sql(ctx, `
create table if not exists public.${T} (id bigint generated always as identity primary key, note text);
truncate public.${T};
insert into public.${T} (note) values ('rl-a'), ('rl-b');
grant usage on schema public to anon;
grant select on public.${T} to anon;
-- Ensure the container's pre-request function exists (it references it for its
-- whole life); harmless blocklist that does not touch nginx's private IP.
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
      // Wait for the limiter -> PostgREST path to serve the table.
      const ready = await waitFor(async () => (await http(`${rl}/${T}?select=id`)).status === 200, 60_000);
      if (!ready.ok) {
        return [{ id: "S05", title: this.title, status: "fail", detail: "rate-limit endpoint never served the table (nginx->PostgREST path not wired)" }];
      }

      // Fire a rapid burst (rate=2r/s, burst=2 -> most of a 15-shot burst 429).
      const burst = await Promise.all(
        Array.from({ length: 15 }, () => http(`${rl}/${T}?select=id`)),
      );
      // nginx limit_req rejects with 429 (configured) or 503 (default) - count both.
      const n429 = burst.filter((r) => r.status === 429 || r.status === 503).length;
      const n200 = burst.filter((r) => r.status === 200).length;

      results.push({
        id: "S05a",
        title: "burst is rate-limited (429s present)",
        status: n429 > 0 ? "pass" : "fail",
        detail: `15-request burst -> ${n200}x200, ${n429}x429. Rate limiting in front of your own PostgREST works (nginx limit_req; a CF Worker/WAF/Upstash is interchangeable).`,
        measurements: { burst_429: n429, burst_200: n200 },
      });
      results.push({
        id: "S05b",
        title: "the limiter still proxies real data",
        status: n200 > 0 ? "pass" : "fail",
        detail: `${n200} of 15 served data - the limiter throttles, it does not black-hole.`,
        measurements: { served: n200 },
      });
    } catch (e) {
      results.push({ id: "S05err", title: "S05 aborted", status: "fail", detail: e instanceof Error ? e.message : String(e) });
    } finally {
      await sql(ctx, `drop table if exists public.${T} cascade;`).catch(() => {});
    }
    return results;
  },
};
export default mod;
