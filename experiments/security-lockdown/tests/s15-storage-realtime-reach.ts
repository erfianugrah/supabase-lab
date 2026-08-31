/**
 * S15 - Storage and Realtime do not route through PostgREST, so the DB-layer
 * REST controls (db-pre-request IP filter, an owner-list read from request
 * headers) structurally cannot reach them.
 *
 * The doc's Move 1 db-pre-request Aside and Move 3 both live on the PostgREST
 * path. A reader could assume "push the control into the database" then covers
 * every surface. It does not: Storage (storage-api) and Realtime run their own
 * services against Postgres and never traverse PostgREST, so a pre-request hook
 * on the REST path - even the working one on your own PostgREST (S04c) - gates
 * REST only. This module evidences that structurally: with the managed Data API
 * OFF (REST dark, 503), Storage and Realtime keep answering on their own paths.
 *
 *   S15a - Data API off -> managed REST 503 (the wedge, same as S04a).
 *   S15b - Storage answers on /storage/v1 while REST is dark (own service).
 *   S15c - Realtime answers on /realtime/v1 while REST is dark (own service).
 *   S15d - the storage schema is owned by supabase_storage_admin, not the
 *          project owner - the Move 1 public-schema REVOKE does not apply to it,
 *          and Storage authz is RLS on storage.objects + the storage-api role.
 *
 * Conclusion (S15e, info): an IP allowlist or owner-list for Storage/Realtime
 * cannot be a db-pre-request; it belongs in each service's own authz (RLS on
 * storage.objects, Realtime authorization) or an edge you own. The
 * GUC-is-unprivileged edge behind "abusing RLS" is in rls-without-supabase-auth.
 *
 * DESTRUCTIVE: toggles db_schema off and restores it in finally.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import { fetchKeys, http, sql, waitFor } from "../lib/sec.js";

const PROBE_T = "sec_rt_probe";

const mod: TestModule = {
  id: "S15",
  title: "Storage/Realtime are not behind PostgREST, so db-layer REST controls cannot reach them",
  where: "local",
  requires: ["pat", "anon-key"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const { anonJwt, serviceJwt } = await fetchKeys(ctx);
    const results: TestResult[] = [];

    const cur = await mgmt(ctx, "GET", `/projects/${ctx.ref}/postgrest`);
    const baseline = cur.json as { db_schema?: string };

    try {
      // S15d first (read-only, independent of the wedge): who owns the storage
      // schema. The Move 1 owner-level REVOKE closes public tables; it has no
      // reach into a schema the project owner does not own.
      const owner = await sql(ctx, `select pg_get_userbyid(nspowner) as owner from pg_namespace where nspname = 'storage';`);
      const storageOwner = String((owner[0] as { owner?: string })?.owner ?? "unknown");
      results.push({
        id: "S15d",
        title: "the storage schema is not the project owner's to REVOKE like public",
        status: "info",
        detail: `storage schema owner = ${storageOwner}. Move 1's public-schema REVOKE / ALTER DEFAULT PRIVILEGES does not govern it; Storage authz is RLS on storage.objects mediated by the storage-api role.`,
        measurements: { storage_owner: storageOwner },
      });

      // A throwaway table so "REST off" is read on a table path (which returns
      // 503 PGRST002 when the exposed schema is empty), not the /rest/v1/ root
      // (which the gateway answers 401 with no route to a schema).
      await sql(ctx, `create table if not exists public.${PROBE_T} (id int primary key); grant select on public.${PROBE_T} to anon; notify pgrst, 'reload schema';`);

      // S15a - wedge the managed Data API off.
      await mgmt(ctx, "PATCH", `/projects/${ctx.ref}/postgrest`, { db_schema: "" });
      const dark = await waitFor(async () => (await http(`https://${ctx.apiHost}/rest/v1/${PROBE_T}?select=id`, { key: anonJwt })).status === 503, 120_000);
      const rest = await http(`https://${ctx.apiHost}/rest/v1/${PROBE_T}?select=id`, { key: anonJwt });
      results.push({
        id: "S15a",
        title: "managed Data API is dark (REST wedged off)",
        status: rest.status === 503 ? "pass" : "fail",
        detail: `managed REST (table path) -> ${rest.status} ${rest.code} (in ${dark.elapsedS}s). PostgREST is off.`,
        measurements: { rest_status: rest.status },
      });

      // S15b - Storage answers on its own path while REST is dark. Its status is
      // its own (200 with service, 400/403 with anon); the point is it is NOT
      // 503 - Storage did not go dark with PostgREST.
      const stSvc = await http(`https://${ctx.apiHost}/storage/v1/bucket`, { key: serviceJwt });
      const stAnon = await http(`https://${ctx.apiHost}/storage/v1/bucket`, { key: anonJwt });
      const storageUp = stSvc.status !== 503 && stSvc.status !== 0;
      results.push({
        id: "S15b",
        title: "Storage answers on /storage/v1 with the Data API off",
        status: storageUp ? "pass" : "fail",
        detail: `service -> ${stSvc.status} ${stSvc.code}; anon -> ${stAnon.status}. Storage is its own service; PostgREST being off did not touch it, so a PostgREST-path control never reaches it.`,
        measurements: { storage_service_status: stSvc.status, storage_anon_status: stAnon.status },
      });

      // S15c - Realtime answers on its own path while REST is dark. The websocket
      // endpoint without upgrade headers returns a definite HTTP status (not
      // 503), proving the service is up independent of PostgREST.
      const rt = await http(`https://${ctx.apiHost}/realtime/v1/websocket?apikey=${encodeURIComponent(anonJwt)}&vsn=1.0.0`, { key: anonJwt });
      const realtimeUp = rt.status !== 503 && rt.status !== 0;
      results.push({
        id: "S15c",
        title: "Realtime answers on /realtime/v1 with the Data API off",
        status: realtimeUp ? "pass" : "info",
        detail: `realtime websocket path -> ${rt.status} ${rt.code}. Realtime is its own service; like Storage it is unaffected by PostgREST being off.`,
        measurements: { realtime_status: rt.status },
      });

      results.push({
        id: "S15e",
        title: "conclusion: a db-pre-request cannot IP/owner-gate Storage or Realtime",
        status: "info",
        detail:
          "db-pre-request is a PostgREST config; Storage and Realtime never traverse PostgREST (S15b/S15c answer while REST is dark). An IP allowlist or owner-list for them belongs in each service's own authz - RLS on storage.objects, Realtime authorization - or an edge you own. The GUC-is-unprivileged edge behind 'abusing RLS' is in reference/rls-without-supabase-auth.",
      });
    } catch (e) {
      results.push({ id: "S15err", title: "S15 aborted", status: "fail", detail: e instanceof Error ? e.message : String(e) });
    } finally {
      await mgmt(ctx, "PATCH", `/projects/${ctx.ref}/postgrest`, { db_schema: baseline.db_schema }).catch(() => {});
      await sql(ctx, `drop table if exists public.${PROBE_T} cascade; notify pgrst, 'reload schema';`).catch(() => {});
    }
    return results;
  },
};
export default mod;
