/**
 * RP01 - which restore paths a Pro org can reach through the Management API.
 *
 * One throwaway Pro project (default compute), ap-southeast-1. Every call is a
 * single request whose refusal text is the finding:
 *
 *   RP01a  entitlement flags for pausing, cloning, restore-to-new-project and
 *          PITR on the org; the project's own backup listing.
 *   RP01b  pause and unpause: POST /pause, POST /restore on an active project,
 *          GET /restore (restorable versions).
 *   RP01c  in-place restore routes with no PITR: POST database/backups/restore
 *          {id}, GET database/backups/restore-point, POST
 *          database/backups/restore-pitr.
 *   RP01d  restore-to-new-project (clone): whether the published OpenAPI
 *          document has any clone path, and what the dashboard's clone route
 *          answers to a PAT (an undocumented route, probed read-only).
 *
 * DESTRUCTIVE only in that it creates and deletes a project: a restore call
 * that succeeded would overwrite it, and it holds nothing. The project is
 * deleted in `finally`. The restore paths that did work are RP02 (PITR) and
 * RP03 (free-plan pause and unpause).
 */
import { mgmt } from "../../../harness/src/mgmt";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { backups, createProject, deleteProject, errText, randomPassword, subjectOf, waitProjectStatus } from "../lib/rp";

const mod: TestModule = {
  id: "RP01",
  title: "Pro restore surface: pause, restore, clone, backups/restore, restore-pitr without PITR",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];
    const org = ctx.orgs.pro ?? "";
    if (!org) return [{ id: "RP01", title: "RP01", status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    let ref = "";
    try {
      const created = await createProject(ctx, org, `rp-rp01-${Date.now().toString(36)}`, randomPassword());
      ref = created.ref;
      if (!ref) return [{ id: "RP01a", title: "create", status: "fail", detail: `HTTP ${created.status} ${created.text}` }];
      const healthy = await waitProjectStatus(ctx, ref, "ACTIVE_HEALTHY", 10 * 60_000);
      if (!healthy.ok) return [{ id: "RP01a", title: "create", status: "fail", detail: `not healthy: ${healthy.last}` }];
      const s = await subjectOf(ctx, ref);

      // ---- RP01a ----
      const ent = await mgmt(ctx, "GET", `/organizations/${org}/entitlements`);
      const feats = ((ent.json ?? {}) as { entitlements?: { feature?: { key?: string }; hasAccess?: boolean }[] }).entitlements ?? [];
      const flag = (k: string) => String(feats.find((f) => f.feature?.key === k)?.hasAccess ?? "absent");
      const bk = await backups(s);
      out.push({
        id: "RP01a",
        title: "entitlements and backup listing on a fresh Pro project",
        status: "info",
        detail: `entitlements http ${ent.status}; physical backups listed ${bk.physicalIds.length}`,
        measurements: {
          ent_project_pausing: flag("project_pausing"),
          ent_project_cloning: flag("project_cloning"),
          ent_restore_to_new_project: flag("backup.restore_to_new_project"),
          ent_project_restore_after_expiry: flag("project_restore_after_expiry"),
          ent_pitr_available_variants: flag("pitr.available_variants"),
          ent_backup_schedule: flag("backup.schedule"),
          backups_http: bk.status,
          pitr_enabled: String(bk.pitr),
          walg_enabled: String(bk.walg),
          physical_backups_listed: bk.physicalIds.length,
        },
      });

      // ---- RP01b ----
      const pause = await mgmt(ctx, "POST", `/projects/${ref}/pause`);
      const unpause = await mgmt(ctx, "POST", `/projects/${ref}/restore`);
      const versions = await mgmt(ctx, "GET", `/projects/${ref}/restore`);
      out.push({
        id: "RP01b",
        title: "pause and unpause on an active Pro project",
        status: "info",
        detail: `pause ${pause.status}; restore-on-active ${unpause.status}; list versions ${versions.status}`,
        measurements: {
          pause_http: pause.status,
          pause_body: pause.text.slice(0, 140),
          restore_on_active_http: unpause.status,
          restore_on_active_body: unpause.text.slice(0, 140),
          list_restore_versions_http: versions.status,
          list_restore_versions_body: versions.text.slice(0, 80),
        },
      });

      // ---- RP01c ----
      const sorted = [...bk.physicalIds].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      const id = sorted[0]?.id ?? 1;
      const phys = await mgmt(ctx, "POST", `/projects/${ref}/database/backups/restore`, { id });
      const rp = await mgmt(ctx, "GET", `/projects/${ref}/database/backups/restore-point`);
      const pitr = await mgmt(ctx, "POST", `/projects/${ref}/database/backups/restore-pitr`, {
        recovery_time_target_unix: Math.floor(Date.now() / 1000) - 120,
      });
      out.push({
        id: "RP01c",
        title: "in-place restore routes with no PITR add-on",
        status: "info",
        detail: `backups/restore ${phys.status}; restore-point ${rp.status}; restore-pitr ${pitr.status}`,
        measurements: {
          listed_backup_id_used: sorted[0] ? "yes" : "no listed backup, id 1 sent",
          backups_restore_http: phys.status,
          backups_restore_body: phys.text.slice(0, 140),
          restore_point_get_http: rp.status,
          restore_point_get_body: rp.text.slice(0, 140),
          restore_pitr_http: pitr.status,
          restore_pitr_body: pitr.text.slice(0, 140),
        },
      });

      // ---- RP01d ----
      const doc = await fetch("https://api.supabase.com/api/v1-json", { signal: AbortSignal.timeout(30_000) })
        .then(
          async (r) =>
            (await r.json()) as {
              paths?: Record<string, unknown>;
              components?: { schemas?: { V1CreateProjectBody?: { properties?: Record<string, unknown> } } };
            },
        )
        .catch(() => ({}) as { paths?: Record<string, unknown> });
      const paths = Object.keys(doc.paths ?? {});
      const createFields = Object.keys(
        (doc as { components?: { schemas?: { V1CreateProjectBody?: { properties?: Record<string, unknown> } } } }).components?.schemas
          ?.V1CreateProjectBody?.properties ?? {},
      );
      const restoreish = paths.filter((p) => /restore|clone|pause/i.test(p));
      const platformClone = await fetch(`https://api.supabase.com/platform/database/${ref}/clone`, {
        headers: { Authorization: `Bearer ${ctx.pat}` },
        signal: AbortSignal.timeout(30_000),
      })
        .then(async (r) => `HTTP ${r.status} ${(await r.text()).slice(0, 80)}`)
        .catch((e) => errText(e));
      const v1Clone = await mgmt(ctx, "GET", `/projects/${ref}/clone`);
      out.push({
        id: "RP01d",
        title: "restore-to-new-project (clone): API surface",
        status: "info",
        detail: `openapi clone paths ${paths.filter((p) => /clone/i.test(p)).length}; dashboard route with PAT: ${platformClone}`,
        measurements: {
          openapi_path_count: paths.length,
          openapi_clone_paths: paths.filter((p) => /clone/i.test(p)).length,
          openapi_restore_pause_paths: restoreish.length,
          create_body_fields: createFields.join(","),
          create_body_clone_like_fields: createFields.filter((f) => /clone|restore|source|backup/i.test(f)).length,
          v1_clone_route_http: v1Clone.status,
          dashboard_clone_route_with_pat: platformClone,
        },
      });
    } catch (e) {
      out.push({ id: "RP01", title: "RP01 aborted", status: "fail", detail: `threw: ${errText(e)}` });
    } finally {
      if (ref) {
        const st = await deleteProject(ctx, ref).catch(() => -1);
        out.push({ id: "RP01e", title: "cleanup: project deleted", status: st >= 200 && st < 300 ? "info" : "fail", detail: `DELETE HTTP ${st}` });
      }
    }
    return out;
  },
};

export default mod;
