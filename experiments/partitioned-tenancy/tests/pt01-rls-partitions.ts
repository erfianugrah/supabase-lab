/**
 * PT01 - Does a tenant RLS policy on a partitioned parent also protect its
 * partitions when the Data API exposes the schema?
 *
 * SIDE: managed Pro-org Micro project (lib/project.ts), Data API (PostgREST)
 * at https://<ref>.supabase.co/rest/v1. KEYS: legacy anon JWT for anon rows;
 * a password-grant user access token (apikey = anon) for tenant rows, tenant
 * taken from app_metadata.tenant_id; legacy service_role for OpenAPI and
 * schema-cache polling. SQL setup runs as postgres through the Management
 * query endpoint.
 *
 * Table: public.pt_audit (id identity, tenant_id int, created_at timestamptz,
 * payload jsonb, primary key (created_at, id)) partition by range
 * (created_at), three monthly partitions created with `create table ...
 * partition of`. RLS enabled on the PARENT only, policies `to authenticated`:
 * select using / insert with check tenant_id = (select app_metadata
 * tenant_id). Seed: tenant 1 = 5 rows, tenant 2 = 7 rows across partitions.
 *
 *   PT01a  pg_default_acl for postgres in public on the fresh project.
 *   PT01b  via the parent: anon, tenant 1, tenant 2 - rows and tenants seen.
 *          Expected (Postgres docs on partitioned-table RLS: only the
 *          queried table's policies apply): 0 / 5 (t1) / 7 (t2).
 *   PT01c  each partition directly at /rest/v1/<partition>: exposed?
 *          relrowsecurity; anon and tenant 1 rows and tenants seen.
 *   PT01d  OpenAPI (service_role GET /rest/v1/): are partitions listed?
 *   PT01e  GET /v1/projects/{ref}/advisors/security: lint names, and whether
 *          any lint names a partition.
 *   PT01f  write path: tenant 1 inserts a tenant-2 row via the parent, then
 *          directly into a partition.
 *   PT01g  mitigation 1: enable RLS on one partition (no policy): direct
 *          reads; parent reads unchanged?
 *   PT01h  mitigation 2: revoke all on another partition from anon,
 *          authenticated: direct reads; parent reads unchanged?
 *   PT01i  after the default-privilege revoke (data-api-defaults DD01c
 *          statements), a NEW partition with 2 tenant-1 rows: direct reads
 *          and parent reads.
 *   PT01j  advisors re-read after the mitigations.
 *
 * Pass/fail is used only where an expectation is stated (PT01b isolation via
 * the parent); exposure rows are `info` - there is no "correct" value, the
 * reading is the finding.
 *
 * DESTRUCTIVE: creates tables and users on the shared PT project; PT99
 * deletes the project.
 *
 * Not settled by this module: other partitioning schemes (PT03), pg_partman
 * created children (PT02), detached partitions (PT04), views, or the
 * GraphQL endpoint.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import {
  awaitExposed,
  brief,
  codeOf,
  currentProject,
  ensureProject,
  rest,
  rowCount,
  skipWithoutPro,
  sql,
  sqlOk,
  tenantsSeen,
  tenantUser,
  type PtProject,
} from "../lib/project.js";

const PARTS = ["pt_audit_2026_09", "pt_audit_2026_10", "pt_audit_2026_11"] as const;

const SETUP = `
create table public.pt_audit (
  id bigint generated always as identity,
  tenant_id int not null,
  created_at timestamptz not null,
  payload jsonb,
  primary key (created_at, id)
) partition by range (created_at);
create table public.pt_audit_2026_09 partition of public.pt_audit for values from ('2026-09-01') to ('2026-10-01');
create table public.pt_audit_2026_10 partition of public.pt_audit for values from ('2026-10-01') to ('2026-11-01');
create table public.pt_audit_2026_11 partition of public.pt_audit for values from ('2026-11-01') to ('2026-12-01');
alter table public.pt_audit enable row level security;
create policy tenant_read on public.pt_audit for select to authenticated
  using (tenant_id = (select (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::int));
create policy tenant_insert on public.pt_audit for insert to authenticated
  with check (tenant_id = (select (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::int));
insert into public.pt_audit (tenant_id, created_at, payload)
select t, ts, jsonb_build_object('n', g)
from (values
  (1, '2026-09-05'::timestamptz, 1), (1, '2026-10-05', 2), (1, '2026-10-06', 3), (1, '2026-11-05', 4), (1, '2026-11-06', 5),
  (2, '2026-09-07', 1), (2, '2026-09-08', 2), (2, '2026-10-07', 3), (2, '2026-10-08', 4), (2, '2026-10-09', 5), (2, '2026-11-07', 6), (2, '2026-11-08', 7)
) v(t, ts, g);`;

const REVOKE_DEFAULTS = `
alter default privileges for role postgres in schema public
  revoke select, insert, update, delete on tables from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke usage, select on sequences from anon, authenticated, service_role;`;

interface Lint {
  name?: string;
  title?: string;
  detail?: string;
  metadata?: { name?: string; schema?: string };
}

async function advisors(ctx: Ctx, p: PtProject): Promise<{ status: number; lints: Lint[] }> {
  const r = await mgmt(ctx, "GET", `/projects/${p.ref}/advisors/security`);
  const lints = ((r.json as { lints?: Lint[] } | undefined)?.lints ?? []) as Lint[];
  return { status: r.status, lints };
}

function lintSummary(lints: Lint[], tables: readonly string[]) {
  const names = [...new Set(lints.map((l) => l.name ?? "?"))].sort().join(",");
  // Exact table match: metadata.name, else `public.<t>` as a whole word in the
  // detail (run 1 matched the parent's name inside its partitions' names).
  const hits = (l: Lint, t: string) =>
    l.metadata?.name !== undefined ? l.metadata.name === t : new RegExp(`public\\.${t}\\b`).test(l.detail ?? "");
  const flagged = tables.filter((t) => lints.some((l) => hits(l, t)));
  const byTable = (t: string) =>
    lints
      .filter((l) => hits(l, t))
      .map((l) => l.name)
      .sort()
      .join("+") || "none";
  return { names: names || "none", flagged, byTable };
}

const mod: TestModule = {
  id: "PT01",
  title: "Tenant RLS on a partitioned parent vs direct access to its partitions",
  where: "local",
  requires: ["pat", "org"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const skip = skipWithoutPro(ctx, "PT01");
    if (skip) return skip;
    const results: TestResult[] = [];
    let p: PtProject;
    try {
      p = await ensureProject(ctx);
    } catch (e) {
      return [{ id: "PT01", title: "PT01", status: "fail", detail: `provision: ${e instanceof Error ? e.message : String(e)}` }];
    }
    const red = (s: string) => brief(currentProject(), s, 300);
    try {
      // ---- PT01a ----
      const acl = await sqlOk(
        ctx,
        p.ref,
        `select coalesce((select defaclacl::text from pg_default_acl where defaclnamespace = 'public'::regnamespace
           and defaclrole = 'postgres'::regrole and defaclobjtype = 'r'), 'absent') as acl`,
      );
      const tablesAcl = String(acl[0]?.acl ?? "");
      results.push({
        id: "PT01a",
        title: "PT01a: default table privileges (postgres, schema public) on the fresh project",
        status: "info",
        detail: `pg_default_acl tables = ${tablesAcl}`,
        measurements: { default_acl_tables: tablesAcl, anon_in_default_acl: /[{,]anon=/.test(tablesAcl) ? 1 : 0 },
      });

      await sqlOk(ctx, p.ref, SETUP);
      const exposeS = await awaitExposed(ctx, p, "/rest/v1/pt_audit?select=id&limit=1");
      for (const t of PARTS) await awaitExposed(ctx, p, `/rest/v1/${t}?select=id&limit=1`, 30_000);
      const t1 = await tenantUser(p, 1);
      const t2 = await tenantUser(p, 2);
      const sel = "select=id,tenant_id,created_at";

      // ---- PT01b ----
      const pa = await rest(p.host, `/rest/v1/pt_audit?${sel}`, p.keys.anon);
      const p1 = await rest(p.host, `/rest/v1/pt_audit?${sel}`, p.keys.anon, { bearer: t1.token });
      const p2 = await rest(p.host, `/rest/v1/pt_audit?${sel}`, p.keys.anon, { bearer: t2.token });
      const isolated = rowCount(pa) === 0 && rowCount(p1) === 5 && tenantsSeen(p1) === "1" && rowCount(p2) === 7 && tenantsSeen(p2) === "2";
      results.push({
        id: "PT01b",
        title: "PT01b: reads through the partitioned parent (policy on parent only)",
        status: isolated ? "pass" : "fail",
        detail: `anon ${pa.status} rows=${rowCount(pa)}; tenant1 ${p1.status} rows=${rowCount(p1)} tenants=${tenantsSeen(p1)}; tenant2 ${p2.status} rows=${rowCount(p2)} tenants=${tenantsSeen(p2)}; schema cache ${exposeS}s`,
        measurements: {
          parent_anon_status: pa.status,
          parent_anon_rows: rowCount(pa),
          parent_t1_rows: rowCount(p1),
          parent_t1_tenants: tenantsSeen(p1),
          parent_t2_rows: rowCount(p2),
          parent_t2_tenants: tenantsSeen(p2),
          schema_cache_wait_s: exposeS,
        },
      });

      // ---- PT01c ----
      const rls = await sqlOk(
        ctx,
        p.ref,
        `select c.relname, c.relrowsecurity, coalesce(c.relacl::text, '') as relacl,
           (select count(*) from pg_policy pol where pol.polrelid = c.oid) as policies
         from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname like 'pt_audit%' order by 1`,
      );
      const meta = (t: string) => rls.find((r) => r.relname === t) ?? {};
      const m: Record<string, number | string> = {};
      const parts: string[] = [];
      for (const t of PARTS) {
        const a = await rest(p.host, `/rest/v1/${t}?${sel}`, p.keys.anon);
        const u = await rest(p.host, `/rest/v1/${t}?${sel}`, p.keys.anon, { bearer: t1.token });
        const k = t.replace("pt_audit_", "p");
        m[`${k}_relrowsecurity`] = String(meta(t).relrowsecurity);
        m[`${k}_policies`] = Number(meta(t).policies ?? -1);
        m[`${k}_anon_status`] = a.status;
        m[`${k}_anon_code`] = codeOf(a);
        m[`${k}_anon_rows`] = rowCount(a);
        m[`${k}_anon_tenants`] = tenantsSeen(a);
        m[`${k}_t1_rows`] = rowCount(u);
        m[`${k}_t1_tenants`] = tenantsSeen(u);
        parts.push(`${t}: rls=${meta(t).relrowsecurity} anon ${a.status} rows=${rowCount(a)} [${tenantsSeen(a)}] t1 ${u.status} rows=${rowCount(u)} [${tenantsSeen(u)}]`);
      }
      m.partition_acl_sample = String(meta(PARTS[1]).relacl ?? "");
      results.push({
        id: "PT01c",
        title: "PT01c: each partition read directly through the Data API",
        status: "info",
        detail: parts.join("; "),
        measurements: m,
      });

      // ---- PT01d ----
      const oa = await rest(p.host, "/rest/v1/", p.keys.service);
      const paths = Object.keys(((oa.json as { paths?: Record<string, unknown> } | undefined)?.paths ?? {}) as Record<string, unknown>);
      const listed = PARTS.filter((t) => paths.includes(`/${t}`));
      results.push({
        id: "PT01d",
        title: "PT01d: partitions in the OpenAPI document (service_role)",
        status: "info",
        detail: `HTTP ${oa.status}; parent listed=${paths.includes("/pt_audit")}; partitions listed ${listed.length}/${PARTS.length}`,
        measurements: { openapi_status: oa.status, openapi_parent_listed: paths.includes("/pt_audit") ? 1 : 0, openapi_partitions_listed: listed.length },
      });

      // ---- PT01e ----
      const adv = await advisors(ctx, p);
      const s1 = lintSummary(adv.lints, ["pt_audit", ...PARTS]);
      results.push({
        id: "PT01e",
        title: "PT01e: security advisors on the unmitigated layout",
        status: "info",
        detail: `HTTP ${adv.status}; lint names: ${s1.names}; tables flagged: ${s1.flagged.join(",") || "none"}; ${["pt_audit", ...PARTS].map((t) => `${t}=${s1.byTable(t)}`).join(" ")}`,
        measurements: {
          advisors_status: adv.status,
          advisors_lint_names: s1.names,
          advisors_parent: s1.byTable("pt_audit"),
          advisors_partitions_flagged: s1.flagged.filter((t) => t !== "pt_audit").length,
          advisors_partition_lints: s1.byTable(PARTS[1]),
        },
      });

      // ---- PT01f ----
      const viaParent = await rest(p.host, "/rest/v1/pt_audit", p.keys.anon, {
        bearer: t1.token,
        method: "POST",
        body: { tenant_id: 2, created_at: "2026-10-20T00:00:00Z", payload: { forged: "parent" } },
        headers: { Prefer: "return=minimal" },
      });
      const viaPart = await rest(p.host, `/rest/v1/${PARTS[1]}`, p.keys.anon, {
        bearer: t1.token,
        method: "POST",
        body: { tenant_id: 2, created_at: "2026-10-21T00:00:00Z", payload: { forged: "partition" } },
        headers: { Prefer: "return=minimal" },
      });
      const anonPart = await rest(p.host, `/rest/v1/${PARTS[1]}`, p.keys.anon, {
        method: "POST",
        body: { tenant_id: 2, created_at: "2026-10-22T00:00:00Z", payload: { forged: "anon" } },
        headers: { Prefer: "return=minimal" },
      });
      const forged = await sqlOk(ctx, p.ref, `select payload->>'forged' as f, count(*)::int as n from public.pt_audit where payload ? 'forged' group by 1 order by 1`);
      const nForged = (k: string) => Number(forged.find((r) => r.f === k)?.n ?? 0);
      results.push({
        id: "PT01f",
        title: "PT01f: tenant 1 writes a tenant-2 row via the parent, via a partition; anon via a partition",
        status: "info",
        detail: `parent ${viaParent.status} ${codeOf(viaParent)} landed=${nForged("parent")}; partition(t1) ${viaPart.status} ${codeOf(viaPart)} landed=${nForged("partition")}; partition(anon) ${anonPart.status} ${codeOf(anonPart)} landed=${nForged("anon")}`,
        measurements: {
          write_parent_status: viaParent.status,
          write_parent_landed: nForged("parent"),
          write_partition_t1_status: viaPart.status,
          write_partition_t1_landed: nForged("partition"),
          write_partition_anon_status: anonPart.status,
          write_partition_anon_landed: nForged("anon"),
        },
      });
      await sqlOk(ctx, p.ref, "delete from public.pt_audit where payload ? 'forged'");

      // ---- PT01g: RLS on one partition, no policy ----
      await sqlOk(ctx, p.ref, `alter table public.${PARTS[0]} enable row level security`);
      await sql(ctx, p.ref, "notify pgrst, 'reload schema'");
      const ga = await rest(p.host, `/rest/v1/${PARTS[0]}?${sel}`, p.keys.anon);
      const gu = await rest(p.host, `/rest/v1/${PARTS[0]}?${sel}`, p.keys.anon, { bearer: t1.token });
      const gp1 = await rest(p.host, `/rest/v1/pt_audit?${sel}`, p.keys.anon, { bearer: t1.token });
      const gp2 = await rest(p.host, `/rest/v1/pt_audit?${sel}`, p.keys.anon, { bearer: t2.token });
      results.push({
        id: "PT01g",
        title: "PT01g: RLS enabled on one partition with no policy",
        // Pass = reads through the parent are unchanged; the direct reads are recorded, not judged.
        status: rowCount(gp1) === 5 && rowCount(gp2) === 7 ? "pass" : "fail",
        detail: `${PARTS[0]} direct: anon ${ga.status} ${codeOf(ga)} rows=${rowCount(ga)}, t1 ${gu.status} ${codeOf(gu)} rows=${rowCount(gu)}; parent: t1 rows=${rowCount(gp1)} t2 rows=${rowCount(gp2)}`,
        measurements: {
          rlsonpart_direct_anon_status: ga.status,
          rlsonpart_direct_anon_rows: rowCount(ga),
          rlsonpart_direct_t1_rows: rowCount(gu),
          rlsonpart_parent_t1_rows: rowCount(gp1),
          rlsonpart_parent_t2_rows: rowCount(gp2),
        },
      });

      // ---- PT01h: revoke on one partition ----
      await sqlOk(ctx, p.ref, `revoke all on public.${PARTS[2]} from anon, authenticated`);
      await sql(ctx, p.ref, "notify pgrst, 'reload schema'");
      await Bun.sleep(3_000);
      const ha = await rest(p.host, `/rest/v1/${PARTS[2]}?${sel}`, p.keys.anon);
      const hu = await rest(p.host, `/rest/v1/${PARTS[2]}?${sel}`, p.keys.anon, { bearer: t1.token });
      const hp1 = await rest(p.host, `/rest/v1/pt_audit?${sel}`, p.keys.anon, { bearer: t1.token });
      const hp2 = await rest(p.host, `/rest/v1/pt_audit?${sel}`, p.keys.anon, { bearer: t2.token });
      const hw = await rest(p.host, "/rest/v1/pt_audit", p.keys.anon, {
        bearer: t1.token,
        method: "POST",
        body: { tenant_id: 1, created_at: "2026-11-20T00:00:00Z", payload: { probe: "routed" } },
        headers: { Prefer: "return=minimal" },
      });
      results.push({
        id: "PT01h",
        title: "PT01h: privileges revoked on one partition (anon, authenticated)",
        status: rowCount(hp1) === 5 && rowCount(hp2) === 7 && hw.status === 201 ? "pass" : "fail",
        detail: `${PARTS[2]} direct: anon ${ha.status} ${codeOf(ha)}, t1 ${hu.status} ${codeOf(hu)}; parent: t1 rows=${rowCount(hp1)} t2 rows=${rowCount(hp2)}; t1 insert routed into the revoked partition via parent ${hw.status} ${codeOf(hw)}`,
        measurements: {
          revoked_direct_anon_status: ha.status,
          revoked_direct_anon_code: codeOf(ha),
          revoked_direct_t1_status: hu.status,
          revoked_parent_t1_rows: rowCount(hp1),
          revoked_parent_t2_rows: rowCount(hp2),
          revoked_parent_insert_status: hw.status,
        },
      });
      await sqlOk(ctx, p.ref, "delete from public.pt_audit where payload ? 'probe'");

      // ---- PT01i: default privileges revoked, new partition ----
      await sqlOk(ctx, p.ref, REVOKE_DEFAULTS);
      await sqlOk(
        ctx,
        p.ref,
        `create table public.pt_audit_2026_12 partition of public.pt_audit for values from ('2026-12-01') to ('2027-01-01');
         insert into public.pt_audit (tenant_id, created_at, payload) values (1, '2026-12-05', '{"n":6}'), (1, '2026-12-06', '{"n":7}');`,
      );
      const newExposeS = await awaitExposed(ctx, p, "/rest/v1/pt_audit_2026_12?select=id&limit=1", 30_000);
      const newAcl = await sqlOk(ctx, p.ref, `select coalesce(relacl::text, 'null') as acl from pg_class where oid = 'public.pt_audit_2026_12'::regclass`);
      const ia = await rest(p.host, `/rest/v1/pt_audit_2026_12?${sel}`, p.keys.anon);
      const iu = await rest(p.host, `/rest/v1/pt_audit_2026_12?${sel}`, p.keys.anon, { bearer: t1.token });
      const ip1 = await rest(p.host, `/rest/v1/pt_audit?${sel}`, p.keys.anon, { bearer: t1.token });
      results.push({
        id: "PT01i",
        title: "PT01i: new partition after the default-privilege revoke",
        status: "info",
        detail: `acl=${String(newAcl[0]?.acl)}; direct: anon ${ia.status} ${codeOf(ia)} rows=${rowCount(ia)}, t1 ${iu.status} ${codeOf(iu)} rows=${rowCount(iu)}; parent t1 rows=${rowCount(ip1)} (expected 7); schema cache ${newExposeS}s`,
        measurements: {
          newpart_acl: String(newAcl[0]?.acl),
          newpart_direct_anon_status: ia.status,
          newpart_direct_anon_code: codeOf(ia),
          newpart_direct_t1_status: iu.status,
          newpart_parent_t1_rows: rowCount(ip1),
        },
      });

      // ---- PT01j ----
      const adv2 = await advisors(ctx, p);
      const s2 = lintSummary(adv2.lints, ["pt_audit", ...PARTS, "pt_audit_2026_12"]);
      results.push({
        id: "PT01j",
        title: "PT01j: security advisors after the mitigations",
        status: "info",
        detail: `HTTP ${adv2.status}; ${["pt_audit", ...PARTS, "pt_audit_2026_12"].map((t) => `${t}=${s2.byTable(t)}`).join(" ")}`,
        measurements: Object.fromEntries(["pt_audit", ...PARTS, "pt_audit_2026_12"].map((t) => [`advisors_after_${t}`, s2.byTable(t)])),
      });

      // Put the default privileges back so PT02-PT04 start from the fresh-project state PT01a read.
      await sqlOk(
        ctx,
        p.ref,
        `alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
         alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;`,
      );
      const back = await sqlOk(
        ctx,
        p.ref,
        `select coalesce((select defaclacl::text from pg_default_acl where defaclnamespace = 'public'::regnamespace
           and defaclrole = 'postgres'::regrole and defaclobjtype = 'r'), 'absent') as acl`,
      );
      results.push({
        id: "PT01z",
        title: "PT01z: default privileges restored for the later modules",
        status: String(back[0]?.acl) === tablesAcl ? "pass" : "fail",
        detail: `restored=${String(back[0]?.acl)} original=${tablesAcl}`,
      });
    } catch (e) {
      results.push({ id: "PT01", title: "PT01", status: "fail", detail: red(e instanceof Error ? e.message : String(e)) });
    }
    return results;
  },
};
export default mod;
