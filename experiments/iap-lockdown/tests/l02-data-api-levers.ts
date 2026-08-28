/**
 * L02 - the Data API levers: wedge (db_schema: ""), GraphQL-only-off, and
 * max_rows as an exfil brake.
 *
 * Builds on http-tier-lockdown T22, which measured the wedge in isolation.
 * Here the wedge is measured against the FULL inventory (does Storage,
 * Realtime, EF care that PostgREST is wedged?) plus two narrower levers T22
 * never touched:
 *
 *   L02c - db_schema "public" (dropping graphql_public): GraphQL can be
 *          killed independently of REST. For a operator whose pen test
 *          flagged the GraphQL surface, this is the one-statement fix.
 *   L02d - max_rows 1: caps rows per response without touching authz. An
 *          exfil brake, not a gate - recorded as what it is.
 *
 * DESTRUCTIVE: mutates PostgREST config; restores the baseline in finally.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import {
  fetchKeys,
  inventory,
  toMeasurements,
  waitFor,
} from "../lib/inventory.js";

async function getPostgrest(ctx: Ctx) {
  const r = await mgmt(ctx, "GET", `/projects/${ctx.ref}/postgrest`);
  if (r.status !== 200) throw new Error(`GET postgrest http ${r.status}`);
  return r.json as { db_schema?: string; max_rows?: number; db_extra_search_path?: string };
}

async function patchPostgrest(ctx: Ctx, body: Record<string, unknown>) {
  return mgmt(ctx, "PATCH", `/projects/${ctx.ref}/postgrest`, body);
}

const mod: TestModule = {
  id: "L02",
  title: "Data API levers against the full inventory",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const keys = await fetchKeys(ctx);
    const baseline = await getPostgrest(ctx);
    const results: TestResult[] = [];

    try {
      // --- L02a/b: the wedge, against the whole inventory ---
      const off = await patchPostgrest(ctx, { db_schema: "" });
      results.push({
        id: "L02a",
        title: "PATCH db_schema=\"\" accepted",
        status: off.status === 200 ? "pass" : "fail",
        measurements: { patch_status: off.status },
      });

      const toWedge = await waitFor(async () => {
        const r = await fetch(`https://${ctx.apiHost}/rest/v1/iap_probe?select=id`, {
          headers: { apikey: keys.anonJwt, Authorization: `Bearer ${keys.anonJwt}` },
        });
        return r.status === 503;
      }, 60_000);
      const inv = await inventory(ctx, keys.anonJwt, "");
      results.push({
        id: "L02b",
        title: "wedged PostgREST: full inventory",
        status: "info",
        detail: `wedge in ${toWedge.elapsedS}s. ${inv.map((r) => `${r.surface}=${r.status}`).join(" ")}`,
        measurements: {
          time_to_wedge_s: toWedge.elapsedS,
          ...toMeasurements(inv, "wedged"),
        },
      });

      // Restore before the narrower levers; both need a serving PostgREST.
      await patchPostgrest(ctx, { db_schema: baseline.db_schema });
      await waitFor(async () => {
        const r = await fetch(`https://${ctx.apiHost}/rest/v1/iap_probe?select=id`, {
          headers: { apikey: keys.anonJwt, Authorization: `Bearer ${keys.anonJwt}` },
        });
        return r.status === 200;
      }, 60_000);

      // --- L02c: GraphQL off, REST on ---
      const gOnly = String(baseline.db_schema ?? "")
        .split(",")
        .filter((s) => s.trim() && s.trim() !== "graphql_public")
        .join(",");
      const gPatch = await patchPostgrest(ctx, { db_schema: gOnly });
      if (gPatch.status === 200) {
        await waitFor(async () => {
          const r = await fetch(`https://${ctx.apiHost}/graphql/v1`, {
            method: "POST",
            headers: {
              apikey: keys.anonJwt,
              Authorization: `Bearer ${keys.anonJwt}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ query: "{ __schema { queryType { name } } }" }),
          });
          return r.status !== 200;
        }, 60_000);
        const inv2 = await inventory(ctx, keys.anonJwt, "");
        const g = inv2.find((r) => r.surface === "graphql");
        const rest = inv2.find((r) => r.surface === "rest_table");
        results.push({
          id: "L02c",
          title: "GraphQL-only-off via db_schema (REST kept)",
          status: g && rest && g.status !== 200 && rest.status === 200 ? "pass" : "fail",
          detail: `graphql=${g?.status} ${g?.code} while rest_table=${rest?.status}`,
          measurements: {
            graphql_after: `${g?.status} ${g?.code}`,
            rest_table_after: `${rest?.status} ${rest?.code}`,
          },
        });
      } else {
        results.push({
          id: "L02c",
          title: "GraphQL-only-off via db_schema (REST kept)",
          status: "fail",
          detail: `PATCH http ${gPatch.status}`,
        });
      }

      // --- L02d: max_rows as an exfil brake ---
      // Fixture has 2 rows; cap at 1 and count what anon gets back.
      await patchPostgrest(ctx, { db_schema: baseline.db_schema, max_rows: 1 });
      const capped = await waitFor(async () => {
        const r = await fetch(`https://${ctx.apiHost}/rest/v1/iap_probe?select=id`, {
          headers: { apikey: keys.anonJwt, Authorization: `Bearer ${keys.anonJwt}` },
        });
        if (r.status !== 200) return false;
        return ((await r.json()) as unknown[]).length === 1;
      }, 60_000);
      results.push({
        id: "L02d",
        title: "max_rows=1 caps rows per response",
        status: capped.ok ? "pass" : "fail",
        detail: capped.ok
          ? `anon read of a 2-row table returns 1 row after ${capped.elapsedS}s - a brake on bulk reads, not an authz control`
          : "cap never took effect within 60s",
        measurements: { time_to_cap_s: capped.elapsedS },
      });

      return results;
    } finally {
      // Restore the exact baseline; the Dashboard toggle's lossy round-trip
      // (http-tier-lockdown run 2) is why this goes through the API.
      const back = await patchPostgrest(ctx, {
        db_schema: baseline.db_schema,
        max_rows: baseline.max_rows,
        db_extra_search_path: baseline.db_extra_search_path,
      });
      results.push({
        id: "L02z",
        title: "restore PostgREST config",
        status: back.status === 200 ? "pass" : "fail",
        detail:
          back.status === 200
            ? "restored"
            : `restore HTTP ${back.status} - PROJECT LEFT IN MUTATED POSTGREST CONFIG`,
        measurements: { restore_status: back.status },
      });
    }
  },
};
export default mod;
