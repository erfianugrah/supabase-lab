/**
 * M05 - one project meters the fleet, including itself.
 *
 * The control-plane pattern: a dedicated project holds the tenant->ref map
 * and the usage rollups; a poller writes one row per project into it -
 * the store project included, tracked like any other ref. This module
 * proves the pattern end to end on a throwaway store:
 *
 *   M05-control  provision the store project; install the rollups schema
 *                (public.metering_hourly - a custom schema needs db-schemas config; public is exposed by default).
 *   M05a         one poller pass: enumerate the org's projects, compute SKU
 *                cost for each (the M03 rate card), and insert rows into
 *                the store - via the store's own PostgREST with its secret
 *                key, NOT the Management API. Self-inclusion: the store's
 *                own row is present on read-back.
 *   M05b         the in-DB half: on a shared schema, per-tenant attribution
 *                is only visible from inside the database. Prove it: a demo
                `items(tenant_id, payload)` table with two tenants, then
 *                per-tenant row counts and exact per-tenant byte estimates
 *                via pg_column_size, read back through PostgREST.
 *
 * The store is deleted in finally. No key values in output.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";

let PRO_ORG = ""; // from PVLAB_ORG_PRO via ctx.orgs.pro; set in run()
const REGION = "ap-southeast-1";
const COMPUTE_RATE_PER_HOUR: Record<string, number> = {
  "none(micro)": 0.01344,
  ci_micro: 0.01344,
  ci_small: 0.0206,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ProjectCreateResponse {
  ref?: string;
}
interface ProjectStatusResponse {
  status?: string;
}
interface ProjectRow {
  id?: string;
  ref?: string;
  name?: string;
  status?: string;
}
interface AddonsResponse {
  selected_addons?: Array<{ addon_type?: string; addon_variant?: string }>;
}
interface ApiKeyRow {
  name?: string;
  type?: string;
  api_key?: string;
}

const mod: TestModule = {
  id: "M05",
  title: "Control-plane metering store, incl. itself + in-DB per-tenant attribution",
  where: "local",
  requires: ["pat"],
  destructive: true, // provisions and deletes the store project
  async run(ctx: Ctx): Promise<TestResult[]> {
    PRO_ORG = ctx.orgs.pro ?? "";
    if (!PRO_ORG) return [{ id: "M05", title: this.title, status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    const results: TestResult[] = [];
    let ref = "";
    try {
      // ---- control: provision + schema ----
      const t0 = Date.now();
      const create = await mgmt(ctx, "POST", "/projects", {
        organization_slug: PRO_ORG,
        name: `m05-store-${t0}`,
        db_pass: `${crypto.randomUUID()}Aa1!`,
        region: REGION,
      });
      ref = (create.json as ProjectCreateResponse | undefined)?.ref ?? "";
      if (create.status !== 201 || !ref) {
        results.push({ id: "M05-control", title: "control", status: "fail", detail: `create: HTTP ${create.status}` });
        return results;
      }
      let status = "";
      for (let i = 0; i < 90 && status !== "ACTIVE_HEALTHY"; i++) {
        await sleep(10_000);
        const p = await mgmt(ctx, "GET", `/projects/${ref}`);
        status = (p.json as ProjectStatusResponse | undefined)?.status ?? "";
      }
      // schema install in separate calls, verbatim errors recorded
      const stmts = [
        "select 1",
        "create table if not exists public.metering_hourly (ts timestamptz default now(), project_ref text, name text, status text, sku text, monthly_usd numeric)",
        "create table if not exists public.items (id bigint generated always as identity primary key, tenant_id text, payload text)",
        "insert into public.items (tenant_id, payload) select 't-a', repeat('a', 1000) from generate_series(1, 100)",
        "insert into public.items (tenant_id, payload) select 't-b', repeat('b', 1000) from generate_series(1, 25)",
        "select pg_notify('pgrst', 'reload schema')",
      ];
      let schemaStatus = 0;
      let schemaError = "";
      for (const q of stmts) {
        const r = await mgmt(ctx, "POST", `/projects/${ref}/database/query`, { query: q });
        schemaStatus = r.status;
        if (r.status >= 300) {
          schemaError = `${q.split(" ")[0]} ${q.split(" ")[1]} -> HTTP ${r.status}: ${r.text.slice(0, 200)}`;
          break;
        }
      }
      const keysRes = await mgmt(ctx, "GET", `/projects/${ref}/api-keys?reveal=true`);
      const keys = Array.isArray(keysRes.json) ? (keysRes.json as ApiKeyRow[]) : [];
      const secret = keys.find((k) => k.name === "service_role" || k.type === "secret")?.api_key ?? "";
      const base = `https://${ref}.supabase.co`;
      results.push({
        id: "M05-control",
        title: "M05-control: provision store + install schema",
        status: status === "ACTIVE_HEALTHY" && schemaStatus < 300 && !schemaError && secret ? "pass" : "fail",
        detail: schemaError || (status !== "ACTIVE_HEALTHY" ? `not healthy (status=${status})` : undefined),
        measurements: { provision_s: Math.round((Date.now() - t0) / 1000), schema_status: schemaStatus },
      });

      // ---- M05a: one poller pass, written into the store via its own PostgREST ----
      const list = await mgmt(ctx, "GET", "/projects");
      const projects = (Array.isArray(list.json) ? list.json : []) as ProjectRow[];
      let inserted = 0;
      for (const p of projects) {
        const pref = p.ref ?? p.id ?? "";
        if (!pref) continue;
        const addons = await mgmt(ctx, "GET", `/projects/${pref}/billing/addons`);
        const data = addons.json as AddonsResponse | undefined;
        const selected = Array.isArray(data?.selected_addons) ? data.selected_addons : [];
        const sku = selected.find((a) => a?.addon_type === "compute_instance")?.addon_variant ?? "none(micro)";
        const rate = COMPUTE_RATE_PER_HOUR[sku];
        const ins = await fetch(`${base}/rest/v1/metering_hourly`, {
          method: "POST",
          headers: {
            apikey: secret,
            Authorization: `Bearer ${secret}`,
            "Content-Type": "application/json",
            
          },
          body: JSON.stringify({
            project_ref: pref,
            name: p.name ?? "",
            status: p.status ?? "unknown",
            sku,
            monthly_usd: rate === undefined ? null : Math.round(rate * 730 * 100) / 100,
          }),
          signal: AbortSignal.timeout(15_000),
        });
        await ins.text();
        if (ins.status === 201) inserted++;
      }
      // read back: is the store's own row there?
      const readback = await fetch(`${base}/rest/v1/metering_hourly?select=project_ref,name,monthly_usd`, {
        headers: { apikey: secret, Authorization: `Bearer ${secret}` },
        signal: AbortSignal.timeout(15_000),
      });
      let rows: Array<{ project_ref?: string; monthly_usd?: number }> = [];
      try {
        const parsed: unknown = JSON.parse(await readback.text());
        if (Array.isArray(parsed)) rows = parsed as typeof rows;
      } catch {
        rows = [];
      }
      const selfRow = rows.find((r) => r.project_ref === ref);
      results.push({
        id: "M05a",
        title: "M05a: poller pass into the store, self-inclusion",
        status: "info",
        measurements: {
          org_projects: projects.length,
          rows_inserted: inserted,
          self_row_present: selfRow ? 1 : 0,
          readback_rows: rows.length,
        },
        evidence: rows.map((r) => `${r.project_ref} $${r.monthly_usd}/mo`).join("\n").slice(0, 400),
      });

      // ---- M05b: per-tenant attribution from inside the DB ----
      const perTenant = await mgmt(ctx, "POST", `/projects/${ref}/database/query`, {
        query:
          "select tenant_id, count(*) as rows, sum(pg_column_size(payload)) as payload_bytes " +
          "from public.items group by tenant_id order by tenant_id",
      });
      const breakdown = (Array.isArray(perTenant.json) ? perTenant.json : []) as Array<{
        tenant_id?: string;
        rows?: number;
        payload_bytes?: number;
      }>;
      const tA = breakdown.find((b) => b.tenant_id === "t-a");
      const tB = breakdown.find((b) => b.tenant_id === "t-b");
      results.push({
        id: "M05b",
        title: "M05b: per-tenant attribution inside a shared schema",
        status: "info",
        detail:
          "per-tenant rows exact; payload_bytes exact for variable-width columns via pg_column_size - an estimate for fixed-width, but the API can see NEITHER",
        measurements: {
          t_a_rows: tA?.rows ?? -1,
          t_b_rows: tB?.rows ?? -1,
          t_a_payload_bytes: tA?.payload_bytes ?? -1,
          t_b_payload_bytes: tB?.payload_bytes ?? -1,
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      for (const id of ["M05-control", "M05a", "M05b"] as const) {
        if (!results.some((r) => r.id === id)) results.push({ id, title: id, status: "fail", detail: `threw: ${msg}` });
      }
    } finally {
      if (ref) await mgmt(ctx, "DELETE", `/projects/${ref}`).catch(() => null);
    }
    return results;
  },
};
export default mod;
