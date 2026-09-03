/**
 * S20 - the trust boundary of a db-pre-request IP filter on your own
 * PostgREST: whose x-forwarded-for does the function see?
 *
 * Self-hosted PostgREST v16.2 (make postgrest-up: session pooler, anon role,
 * PGRST_DB_PRE_REQUEST=public.sec_ip_filter) and an nginx edge (make edge-up)
 * that sets X-Forwarded-For to $remote_addr. S04 proved the filter fires on a
 * client-supplied header; that is not an allowlist unless the client cannot
 * set the header. The managed project only hosts the Postgres here.
 *
 *   S20a  an RPC returning request.headers->>'x-forwarded-for', called DIRECT
 *         on PostgREST with x-forwarded-for=198.51.100.7 (a value the filter
 *         lets through): the client value is what SQL sees
 *   S20b  the same call THROUGH the edge: the edge's peer address, spoof gone
 *   S20c  the S04 filter (bans 203.0.113.9): direct spoof -> 403; via edge
 *         spoof -> 200 (the filter now judges the edge's view)
 *
 * Not settled by this module: append-vs-overwrite at the HOSTED edge (S16a
 * measures that); a multi-hop chain (edge behind a CDN), where the rightmost
 * trusted hop rule applies.
 *
 * DESTRUCTIVE: creates a table and an RPC (dropped); (re)creates
 * sec_ip_filter with the S04 body, kept for the container's life. Self-skips
 * without both endpoints.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { http, httpBody, sql, waitFor } from "../lib/sec.js";

const T = "sec_own20";
const SPOOF = "203.0.113.9";
// A second TEST-NET address for the visibility rows: the filter bans SPOOF on
// every request, RPCs included, so the "what does SQL see" probe must send a
// value the filter lets through.
const SEEN = "198.51.100.7";
const RFC1918 = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/;

const mod: TestModule = {
  id: "S20",
  title: "own PostgREST: x-forwarded-for is client-controlled direct, edge-controlled through an overwriting proxy",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const own = ctx.endpoints["selfhosted_postgrest"];
    const edge = ctx.endpoints["edge"];
    if (!own || !edge) return [{ id: "S20", title: this.title, status: "skip", detail: "needs `make postgrest-up` and `make edge-up` (PVLAB_ENDPOINT_SELFHOSTED_POSTGREST + PVLAB_ENDPOINT_EDGE)" }];
    const out: TestResult[] = [];
    const xffVia = async (baseUrl: string) => {
      const r = await httpBody(`${baseUrl}/rpc/sec20_xff`, { method: "POST", body: {}, headers: { "x-forwarded-for": SEEN } });
      const v = typeof r.json === "string" ? r.json : r.text.replace(/^"|"$/g, "");
      return { status: r.status, value: v, parts: v.split(",").map((s) => s.trim()).filter(Boolean) };
    };
    try {
      await sql(ctx, `
create table if not exists public.${T} (id bigint generated always as identity primary key, note text);
truncate public.${T};
insert into public.${T} (note) values ('x');
grant usage on schema public to anon;
grant select on public.${T} to anon;
create or replace function public.sec20_xff() returns text language sql stable as $$
  select current_setting('request.headers', true)::json ->> 'x-forwarded-for'
$$;
grant execute on function public.sec20_xff() to anon;
create or replace function public.sec_ip_filter() returns void language plpgsql as $$
declare xff text := current_setting('request.headers', true)::json ->> 'x-forwarded-for';
begin
  if xff is not null and xff like '%${SPOOF}%' then
    raise sqlstate 'PT403' using message = 'ip banned: ' || xff;
  end if;
end$$;
grant execute on function public.sec_ip_filter() to anon;
notify pgrst, 'reload schema';
`);
      const ready = await waitFor(async () => (await http(`${own}/${T}?select=id`)).status === 200, 90_000);
      if (!ready.ok) throw new Error(`self-hosted PostgREST at ${own} not serving ${T} after ${ready.elapsedS}s`);

      const direct = await xffVia(own);
      out.push({
        id: "S20a",
        title: "direct to PostgREST: SQL sees the client-supplied x-forwarded-for",
        status: direct.status === 200 && direct.parts.includes(SEEN) ? "pass" : "fail",
        detail: `POST ${own}/rpc/sec20_xff with x-forwarded-for=${SEEN} -> ${direct.status}; SQL saw ${direct.parts.length} address(es), client value present: ${direct.parts.includes(SEEN)}. A filter fed this way is client-controlled.`,
        measurements: { direct_status: direct.status, direct_addrs: direct.parts.length, direct_spoof_visible: String(direct.parts.includes(SEEN)) },
      });

      const viaEdge = await xffVia(edge);
      const edgePeerPrivate = viaEdge.parts.length === 1 && RFC1918.test(viaEdge.parts[0] ?? "");
      out.push({
        id: "S20b",
        title: "through the overwriting edge: SQL sees the edge's peer address, spoof gone",
        status: viaEdge.status === 200 && !viaEdge.parts.includes(SEEN) ? "pass" : "fail",
        detail: `POST ${edge}/rpc/sec20_xff with the same client header -> ${viaEdge.status}; SQL saw ${viaEdge.parts.length} address(es), client value present: ${viaEdge.parts.includes(SEEN)}; the single value is a private (RFC 1918) address, i.e. the edge's view of its peer: ${edgePeerPrivate}.`,
        measurements: { edge_status: viaEdge.status, edge_addrs: viaEdge.parts.length, edge_spoof_visible: String(viaEdge.parts.includes(SEEN)), edge_value_rfc1918: String(edgePeerPrivate) },
      });

      const directBan = await http(`${own}/${T}?select=id`, { headers: { "x-forwarded-for": SPOOF } });
      const edgeBan = await http(`${edge}/${T}?select=id`, { headers: { "x-forwarded-for": SPOOF } });
      out.push({
        id: "S20c",
        title: "the S04 filter: 403 on the direct spoof, 200 through the edge",
        status: directBan.status === 403 && edgeBan.status === 200 ? "pass" : "fail",
        detail: `GET ${T} with x-forwarded-for=${SPOOF}: direct -> ${directBan.status} ${directBan.code}; via edge -> ${edgeBan.status}. The filter is only an allowlist when PostgREST is reachable from nowhere but the edge - a deployment property, not the function's.`,
        measurements: { direct_spoof_status: directBan.status, edge_spoof_status: edgeBan.status },
      });
    } catch (e) {
      out.push({ id: "S20err", title: "S20 aborted", status: "fail", detail: e instanceof Error ? e.message : String(e) });
    } finally {
      await sql(ctx, `drop table if exists public.${T} cascade; drop function if exists public.sec20_xff(); notify pgrst, 'reload schema';`).catch(() => {});
      out.push({ id: "S20z", title: "cleanup", status: "pass", detail: "table + RPC dropped; sec_ip_filter kept (the container references it for its life)" });
    }
    return out;
  },
};
export default mod;
