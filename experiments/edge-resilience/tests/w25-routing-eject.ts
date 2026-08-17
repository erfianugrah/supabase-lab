/**
 * W25 - tenant routing table with a stale row, and the eject path.
 *
 * Matrix 1.2: a multi-tenant edge worker keeps a tenant->origin routing
 * table (CF KV/D1 in production); when a row points at a dead project,
 * only that tenant's requests fail, and recovery depends on how the row
 * gets ejected. This drill measures both halves:
 *
 * 1. Deploy the drill worker with ROUTE_TABLE={"tenant-a": <live>,
 *    "tenant-b": <unroutable>}. Probe both tenants: tenant-a serves 200,
 *    tenant-b gets 502 with x-drill-tenant tags - tenant isolation.
 * 2. Eject: redeploy with ROUTE_TABLE={"tenant-a": <live>} (tenant-b
 *    removed). Probe tenant-b -> 404 "tenant ejected". Measure the
 *    eject cost: it is a redeploy (~10s), because the drill's routing
 *    table lives in an env var. A production table in KV/D1 ejects
 *    without a redeploy - that difference IS the finding.
 * 3. Restore the default deploy.
 *
 * The worker's /t/<tenant>/rest/v1/* router strip-prefixes the tenant
 * segment before the origin fetch and tags every response x-drill-tenant
 * + x-drill-origin (live tenant name, "<tenant>->dead", or "ejected").
 *
 * Pass criteria: isolation + eject signatures recorded with timings.
 * Any measured behavior passes.
 */
import { $ } from "bun";
import { join } from "node:path";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";

const UNROUTABLE = "https://192.0.2.1";

const mod: TestModule = {
  id: "W25",
  title: "tenant routing table - stale row and the eject path",
  where: "local",
  requires: ["anon-key"],
  destructive: true, // redeploys the worker three times; restores after

  async run(ctx: Ctx): Promise<TestResult> {
    const id = "W25";
    const title = this.title;
    const edgeUrl = ctx.endpoints["edge_url"];
    if (!edgeUrl) {
      return { id, title, status: "skip", detail: "Missing endpoint: edge_url (absent)" };
    }

    const liveUrl = `https://${ctx.ref}.supabase.co`;
    const wranglerConfig = join(process.cwd(), "wrangler.jsonc");
    const headers = { apikey: ctx.anonKey!, Authorization: `Bearer ${ctx.anonKey!}` };
    const measurements: Record<string, number | string> = {};
    const evidence: string[] = [];

    const deploy = async (vars: Record<string, string>): Promise<number> => {
      const t0 = performance.now();
      const varArgs = Object.entries(vars).flatMap(([k, v]) => [`--var`, `${k}:${v}`]);
      const proc = await $`wrangler deploy --config ${wranglerConfig} ${varArgs}`.quiet().nothrow().text();
      const ms = Math.round(performance.now() - t0);
      if (proc.includes("error") || proc.includes("ERROR")) {
        throw new Error(`wrangler deploy failed: ${proc.slice(-400)}`);
      }
      return ms;
    };

    const probeTenant = async (
      tenant: string,
    ): Promise<{ status: number; tenantTag: string | null; origin: string | null }> => {
      const res = await fetch(`${edgeUrl}/t/${tenant}/rest/v1/w_probe?select=id&_w25=${Date.now()}`, {
        headers,
        signal: AbortSignal.timeout(30_000),
      });
      await res.text();
      return {
        status: res.status,
        tenantTag: res.headers.get("x-drill-tenant"),
        origin: res.headers.get("x-drill-origin"),
      };
    };

    /** Deploy propagation varies (a 3s settle measured one deploy behind).
     *  Probe until the expected status shows, up to ~24s. */
    const probeUntil = async (tenant: string, want: number) => {
      let last = await probeTenant(tenant);
      for (let i = 0; i < 8 && last.status !== want; i++) {
        await new Promise((r) => setTimeout(r, 3_000));
        last = await probeTenant(tenant);
      }
      return last;
    };

    let restoredDeployPending = false;
    try {
      // Step 1: routing table with a poisoned row for tenant-b.
      measurements["deploy1_ms"] = await deploy({
        OUTAGE: "false",
        ROUTE_TABLE: JSON.stringify({ "tenant-a": liveUrl, "tenant-b": UNROUTABLE }),
      });
      restoredDeployPending = true;
      await new Promise((r) => setTimeout(r, 3_000));

      const a1 = await probeUntil("tenant-a", 200);
      const b1 = await probeUntil("tenant-b", 502);
      measurements["tenant_a_status"] = a1.status;
      measurements["tenant_b_status"] = b1.status;
      evidence.push(
        `poisoned table: tenant-a ${a1.status} (origin=${a1.origin}), tenant-b ${b1.status} (origin=${b1.origin})`,
      );

      // Step 2: eject tenant-b by redeploying without its row.
      measurements["eject_deploy_ms"] = await deploy({
        OUTAGE: "false",
        ROUTE_TABLE: JSON.stringify({ "tenant-a": liveUrl }),
      });
      await new Promise((r) => setTimeout(r, 3_000));

      const a2 = await probeUntil("tenant-a", 200);
      const b2 = await probeUntil("tenant-b", 404);
      measurements["tenant_a_after_eject"] = a2.status;
      measurements["tenant_b_after_eject"] = b2.status;
      evidence.push(
        `after eject: tenant-a ${a2.status} (unaffected), tenant-b ${b2.status} (${b2.origin ?? "no tag"})`,
      );

      return {
        id,
        title,
        status: "pass",
        detail:
          `isolation: tenant-a ${a1.status} while tenant-b ${b1.status} on the poisoned row; ` +
          `eject = a ${measurements["eject_deploy_ms"]}ms redeploy (tenant-b -> ${b2.status})`,
        measurements,
        evidence: evidence.join("\n"),
      };
    } finally {
      if (restoredDeployPending) {
        try {
          await deploy({ OUTAGE: "false", ROUTE_TABLE: "" });
        } catch (e) {
          evidence.push(`cleanup deploy failed: ${e instanceof Error ? e.message : e}`);
        }
      }
    }
  },
};

export default mod;
