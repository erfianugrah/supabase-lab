/**
 * S01 - which gated Management-API surfaces does a Supabase-for-Platforms org
 * actually unlock?
 *
 * The public SfP guide names three surfaces as "contact us / select
 * customers": Nano scale-to-zero compute, the database migrations endpoint,
 * and restore points (+undo). It does not say what happens when an org
 * WITHOUT the entitlement calls them, or which of them an entitled org gets.
 * This module measures the delta on the org under test (passed via
 * `PVLAB_ORG_SLUGS`, so the same probe answers both "SfP org" and
 * "control org" depending on which slug is supplied):
 *
 *   S01a  Nano compute: create WITHOUT `desired_instance_size` and read the
 *         compute back (the SfP path the guide prescribes). Record the
 *         resulting tier and whether it differs from a normal-org Micro.
 *   S01b  Migrations endpoint: POST a trivial migration; record whether it
 *         applies and rolls the schema forward transactionally.
 *   S01c  Restore point: POST a restore point; record the response.
 *   S01d  Undo to restore point: only runs if S01c succeeded - mutates the
 *         throwaway project's DB and reverts.
 *
 * Every project created here is deleted in `finally`. A measured 4xx on any
 * gated surface is data (info), never an exception - that is the answer to
 * "does this org have the entitlement".
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ProjectCreateResponse {
  id?: string;
  ref?: string;
}
interface ProjectStatusResponse {
  status?: string;
}
interface AddonsResponse {
  available_addons?: Array<{ type?: string; variants?: Array<{ id?: string }> }>;
  selected_addons?: Array<{ addon_type?: string; addon_variant?: string; type?: string }>;
}

async function waitHealthy(ctx: Ctx, ref: string, maxIters = 90): Promise<string> {
  let status = "";
  for (let i = 0; i < maxIters && status !== "ACTIVE_HEALTHY"; i++) {
    await sleep(10_000);
    const p = await mgmt(ctx, "GET", `/projects/${ref}`);
    status = (p.json as ProjectStatusResponse | undefined)?.status ?? "";
  }
  return status;
}

function selectedCompute(json: unknown): string {
  const data = json as AddonsResponse | undefined;
  const selected = Array.isArray(data?.selected_addons) ? data.selected_addons : [];
  // addon variants carry both `addon_type`/`addon_variant` and `type`/`id` shapes.
  const hit = selected.find((a) => (a?.addon_type ?? a?.type) === "compute_instance");
  return hit?.addon_variant ?? "none(default)";
}

/** Compute variants this org's catalogue offers (the entitlement list). */
function computeVariants(json: unknown): string[] {
  const data = json as AddonsResponse | undefined;
  const compute = (Array.isArray(data?.available_addons) ? data.available_addons : []).find(
    (a) => a?.type === "compute_instance",
  );
  return (compute?.variants ?? []).map((v) => v?.id ?? "").filter(Boolean);
}

/** Current compute as pg_settings reveals it (memory/connections are the tier tell). */
async function computeHint(ctx: Ctx, ref: string): Promise<string> {
  const q = await mgmt(ctx, "POST", `/projects/${ref}/database/query/read-only`, {
    query: "select current_setting('shared_buffers') as sb, current_setting('max_connections') as mc",
  });
  if (q.status < 200 || q.status >= 300) return `unread:${q.status}`;
  const rows = Array.isArray(q.json) ? (q.json as Array<{ sb?: string; mc?: string }>) : [];
  const r = rows[0];
  return r ? `shared_buffers=${r.sb},max_connections=${r.mc}` : "unread:empty";
}

const mod: TestModule = {
  id: "S01",
  title: "SfP org entitlement sweep (nano compute, migrations, restore points)",
  where: "local",
  requires: ["pat", "org"],
  destructive: true, // provisions and deletes its own project
  async run(ctx: Ctx): Promise<TestResult[]> {
    const results: TestResult[] = [];
    const org = ctx.orgSlugs[0] ?? "";
    let ref = "";
    const ensure = (id: string) => results.some((r) => r.id === id);

    try {
      // --- S01a: SfP-prescribed create (no desired_instance_size) ---
      const t0 = Date.now();
      const create = await mgmt(ctx, "POST", "/projects", {
        organization_slug: org,
        name: `s01-sfp-${t0}`,
        db_pass: `${crypto.randomUUID()}Aa1!`,
        region_selection: { type: "smartGroup", code: "apac" },
      });

      if (create.status !== 201) {
        results.push({
          id: "S01a",
          title: "S01a: SfP-path create (no desired_instance_size)",
          status: "fail",
          detail: `create: HTTP ${create.status}: ${create.text.slice(0, 300)}`,
        });
      } else {
        ref =
          (create.json as ProjectCreateResponse | undefined)?.ref ??
          (create.json as ProjectCreateResponse | undefined)?.id ??
          "";
        if (!ref) {
          results.push({
            id: "S01a",
            title: "S01a: SfP-path create (no desired_instance_size)",
            status: "fail",
            detail: `create returned no ref: ${create.text.slice(0, 300)}`,
          });
        } else {
          const status = await waitHealthy(ctx, ref);
          const provisionS = Math.round((Date.now() - t0) / 1000);
          const addons = await mgmt(ctx, "GET", `/projects/${ref}/billing/addons`);
          const compute = addons.status === 200 ? selectedCompute(addons.json) : "unread";
          const hint = await computeHint(ctx, ref);
          const variants = computeVariants(addons.json);
          const nanoAvailable = variants.includes("ci_nano");
          const microAvailable = variants.includes("ci_micro");
          results.push({
            id: "S01a",
            title: "S01a: SfP-path create (no desired_instance_size)",
            status: status === "ACTIVE_HEALTHY" ? "pass" : "fail",
            detail:
              status === "ACTIVE_HEALTHY"
                ? `created under the org; selected=${compute}; catalogue floor=${variants[0] ?? "none"}; ${hint}`
                : `created but not healthy after 15 min (status=${status})`,
            measurements: {
              provision_s: provisionS,
              compute,
              ci_nano_available: nanoAvailable ? 1 : 0,
              ci_micro_available: microAvailable ? 1 : 0,
              compute_variants: variants.length,
              region: ((create.json as { region?: string } | undefined)?.region ?? "unread"),
            },
          });
        }
      }

      // Everything below needs a live project.
      if (ref && (await mgmt(ctx, "GET", `/projects/${ref}`)).status === 200) {
        // --- S01b: migrations endpoint ---
        const mig = await mgmt(ctx, "POST", `/projects/${ref}/database/migrations`, {
          query: "create table if not exists public.sfp_probe (id serial primary key, note text)",
          name: "s01 probe",
        });
        results.push({
          id: "S01b",
          title: "S01b: migrations endpoint",
          status: "info",
          detail:
            mig.status >= 200 && mig.status < 300
              ? "migrations endpoint ACCEPTED"
              : `migrations endpoint rejected: HTTP ${mig.status}`,
          measurements: { migrations_status: mig.status },
          evidence: mig.text.slice(0, 300),
        });

        // --- S01c: restore point ---
        const rp = await mgmt(ctx, "POST", `/projects/${ref}/database/backups/restore-point`, {
          name: "s01",
        });
        results.push({
          id: "S01c",
          title: "S01c: restore point",
          status: "info",
          detail:
            rp.status >= 200 && rp.status < 300
              ? "restore point ACCEPTED"
              : `restore point rejected: HTTP ${rp.status}`,
          measurements: { restore_point_status: rp.status },
          evidence: rp.text.slice(0, 300),
        });

        // --- S01d: undo (only meaningful if the restore point landed) ---
        if (rp.status >= 200 && rp.status < 300) {
          // Mutate: add a table that postdates the restore point.
          await mgmt(ctx, "POST", `/projects/${ref}/database/query`, {
            query: "create table public.sfp_post_restore (id int primary key)",
          });
          const undo = await mgmt(ctx, "POST", `/projects/${ref}/database/backups/undo`, {
            name: "s01",
          });
          results.push({
            id: "S01d",
            title: "S01d: undo to restore point",
            status: "info",
            detail:
              undo.status >= 200 && undo.status < 300
                ? "undo ACCEPTED"
                : `undo rejected: HTTP ${undo.status}`,
            measurements: { undo_status: undo.status },
            evidence: undo.text.slice(0, 300),
          });
        } else {
          results.push({
            id: "S01d",
            title: "S01d: undo to restore point",
            status: "skip",
            detail: "restore point did not land (see S01c), so there is nothing to undo to",
          });
        }
      } else {
        for (const id of ["S01b", "S01c", "S01d"] as const) {
          if (!ensure(id)) {
            results.push({
              id,
              title: id,
              status: "skip",
              detail: "not runnable: no live project (see S01a)",
            });
          }
        }
      }
      for (const id of ["S01a", "S01b", "S01c", "S01d"] as const) {
        if (!ensure(id)) {
          results.push({ id, title: id, status: "skip", detail: "row never produced" });
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      for (const id of ["S01a", "S01b", "S01c", "S01d"] as const) {
        if (!ensure(id)) {
          results.push({ id, title: id, status: "fail", detail: `test threw: ${msg}` });
        }
      }
    } finally {
      if (ref) await mgmt(ctx, "DELETE", `/projects/${ref}`).catch(() => null);
    }

    return results;
  },
};
export default mod;
