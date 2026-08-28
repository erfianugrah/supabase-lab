/**
 * L22 - Edge Functions under network restrictions.
 *
 * The claim (a support answer, never measured here): with network restrictions
 * applied, Edge Functions lose direct database access and the docs point at
 * supabase-js over HTTP instead - which puts that traffic back on the HTTP
 * surface being locked down.
 *
 *   L22a - deploy one EF that (1) opens a direct pg connection via the
 *          platform-injected SUPABASE_DB_URL and (2) reads a row over
 *          /rest/v1 with the service key. Invoke with no restrictions: record
 *          the direct path working.
 *   L22b - apply restrict-all (TEST-NET CIDR) and re-invoke: record the direct
 *          path's failure mode verbatim (timeout / refusal / allowlist error).
 *   L22c - the same invocation's HTTP-fallback half under restrict-all: if it
 *          still serves, the restriction pushed EF data traffic onto the public
 *          HTTP tier - the surface the operator wanted closed.
 *
 * DESTRUCTIVE: applies network restrictions and deploys an EF; restores
 * restrictions and deletes the EF in finally.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import { fetchKeys, http, sql, TABLE, waitFor } from "../lib/inventory.js";

const EF = "iap-ef-dbtest";
const RESTRICT = { dbAllowedCidrs: ["192.0.2.0/24"], dbAllowedCidrsV6: ["2001:db8::/32"] };
const OPEN = { dbAllowedCidrs: ["0.0.0.0/0"], dbAllowedCidrsV6: ["::/0"] };

const EF_BODY = `
import postgres from "npm:postgres@3";
Deno.serve(async () => {
  const out: Record<string, unknown> = {};
  try {
    const db = postgres(Deno.env.get("SUPABASE_DB_URL"), { ssl: "require", connect_timeout: 8, idle_timeout: 2, max: 1 });
    const r = await db\`select 1 as one\`;
    out.direct = { ok: true, rows: r.length };
    await db.end();
  } catch (e) { out.direct = { ok: false, err: String(e).slice(0, 140) }; }
  try {
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const res = await fetch(Deno.env.get("SUPABASE_URL") + "/rest/v1/${TABLE}?select=id&limit=1", { headers: { apikey: key, Authorization: "Bearer " + key } });
    out.http = { ok: res.ok, status: res.status };
  } catch (e) { out.http = { ok: false, err: String(e).slice(0, 140) }; }
  return Response.json(out);
});
`;

async function invoke(ctx: Ctx, key: string) {
  const res = await fetch(`https://${ctx.apiHost}/functions/v1/${EF}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(30_000),
  });
  const raw = await res.text();
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(raw); } catch { /* non-JSON (e.g. an EF crash) - keep raw */ }
  return { status: res.status, body, raw: raw.slice(0, 200) };
}

const mod: TestModule = {
  id: "L22",
  title: "Edge Functions under restrict-all: direct DB failure mode + HTTP fallback",
  where: "local",
  requires: ["pat", "anon-key"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const keys = await fetchKeys(ctx);
    const results: TestResult[] = [];
    let restricted = false;
    let deployed = false;
    try {
      await sql(ctx, `
create table if not exists public.${TABLE} (id bigint generated always as identity primary key, note text);
insert into public.${TABLE} (note) values ('l22') on conflict do nothing;
grant select on public.${TABLE} to anon, service_role;
notify pgrst, 'reload schema';`);

      const dep = await mgmt(ctx, "POST", `/projects/${ctx.ref}/functions`, { slug: EF, name: EF, verify_jwt: false, body: EF_BODY });
      deployed = dep.status < 300 || /duplicat|already exists/i.test(dep.text);
      if (!deployed) return [{ id: "L22", title: this.title, status: "fail", detail: `deploy EF HTTP ${dep.status}: ${dep.text.slice(0, 160)}` }];
      const ready = await waitFor(async () => (await http(`https://${ctx.apiHost}/functions/v1/${EF}`, { key: keys.anonJwt, timeoutMs: 20_000 })).status === 200, 120_000);
      if (!ready.ok) return [{ id: "L22", title: this.title, status: "fail", detail: "EF never became reachable" }];

      const pre = await invoke(ctx, keys.anonJwt);
      const preDirect = (pre.body.direct as { ok?: boolean }) ?? {};
      results.push({
        id: "L22a",
        title: "EF direct DB connection works with no restrictions",
        status: preDirect.ok ? "pass" : "fail",
        detail: `no restrictions (EF HTTP ${pre.status}): direct pg -> ${JSON.stringify(pre.body.direct) ?? pre.raw}; http-fallback -> ${JSON.stringify(pre.body.http)}`,
        measurements: { pre_direct_ok: String(Boolean(preDirect.ok)), ef_status: pre.status },
      });

      const apply = await mgmt(ctx, "POST", `/projects/${ctx.ref}/network-restrictions/apply`, RESTRICT);
      restricted = apply.status < 300;
      // Let the restriction propagate to the socket enforcement path.
      await new Promise((r) => setTimeout(r, 20_000));

      const post = await invoke(ctx, keys.anonJwt);
      const postDirect = (post.body.direct as { ok?: boolean; err?: string }) ?? {};
      const postHttp = (post.body.http as { ok?: boolean; status?: number }) ?? {};
      results.push({
        id: "L22b",
        title: "EF direct DB path under restrict-all: the measured failure mode",
        status: "info",
        detail: `restrict-all applied (${apply.status}). EF direct pg -> ${JSON.stringify(post.body.direct)}. ${postDirect.ok ? "Direct access SURVIVED - EF egress is not subject to the public allowlist." : "Direct access refused - the claim holds; the EF loses its socket."}`,
        measurements: { post_direct_ok: String(Boolean(postDirect.ok)) },
      });
      results.push({
        id: "L22c",
        title: "the HTTP fallback under restrict-all pushes EF traffic onto the public tier",
        status: postHttp.ok ? "pass" : "info",
        detail: `EF http-fallback under restrict-all -> ${JSON.stringify(post.body.http)}. ${postHttp.ok ? "The documented fallback works, so EF data now transits the public HTTP surface the operator wanted closed." : "Fallback did not serve; record verbatim."}`,
        measurements: { post_http_status: postHttp.status ?? 0 },
      });
    } catch (e) {
      results.push({ id: "L22err", title: "L22 aborted", status: "fail", detail: e instanceof Error ? e.message : String(e) });
    } finally {
      if (restricted) {
        const back = await mgmt(ctx, "POST", `/projects/${ctx.ref}/network-restrictions/apply`, OPEN);
        results.push({ id: "L22z", title: "restore network restrictions (open)", status: back.status < 300 ? "pass" : "fail", detail: back.status < 300 ? "restored to 0.0.0.0/0" : `restore HTTP ${back.status}` });
      }
      if (deployed) await mgmt(ctx, "DELETE", `/projects/${ctx.ref}/functions/${EF}`).catch(() => {});
    }
    return results;
  },
};
export default mod;
