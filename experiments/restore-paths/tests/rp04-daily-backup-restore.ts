/**
 * RP04 - daily (physical) backup restore without PITR, on a Team org.
 *
 * RP01 found `POST database/backups/restore` answering "unavailable" on one
 * fresh Pro project. This module asks the same question on the Team plan (or
 * the plan named by RP04_ORG_ROLE: team | pro), on default Micro compute, the
 * configuration a project with no PITR add-on runs. If the restore is
 * accepted, it is measured the way RP02 measures a PITR restore.
 *
 *   RP04a  create on the org, entitlements, and seconds until the first
 *          COMPLETED physical backup is listed (30 s polling, 15 min budget).
 *   RP04b  after the backup: insert a marker, rotate the db password, upload
 *          an object. A restore to the backup should roll all three back.
 *   RP04c  `GET database/backups/restore-point`, then `POST
 *          database/backups/restore {id}` with the newest listed backup,
 *          retried every 60 s for 3 minutes while refused. If accepted:
 *          per-path outage windows and the status timeline.
 *   RP04d  which db password the pooler accepts across and after it.
 *   RP04e  after: rows kept, Storage, the post-backup object, health,
 *          verifier fingerprint.
 *   RP04f  cleanup: project deleted.
 *
 * DESTRUCTIVE (creates and deletes a project). Cost: Micro compute for the
 * run: about 4 minutes while `backups/restore` refuses, up to ~30 if it runs. Not measured: a backup more than minutes old, a
 * database over a few MB, direct 5432 (IPv6-only from this vantage), the
 * Dashboard restore button, restore to a new project.
 */
import { mgmt } from "../../../harness/src/mgmt";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import {
  addMarker,
  backups,
  createProject,
  credentialColumns,
  dbSizeMb,
  deleteProject,
  errText,
  flatten,
  healthLine,
  markerLabels,
  measureRestore,
  poolerLogin,
  postTargetState,
  putPostTargetObject,
  randomPassword,
  seedData,
  seedStorage,
  setPassword,
  settledLogin,
  sleep,
  storageState,
  subjectOf,
  verifierFingerprint,
  waitProjectStatus,
  type Subject,
} from "../lib/rp";

const BACKUP_WAIT_MS = 15 * 60_000;
const ACCEPT_RETRY_MS = 3 * 60_000;

const mod: TestModule = {
  id: "RP04",
  title: "Daily-backup restore without PITR (Team org, Micro): route, per-path outage, db password, Storage",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];
    const role = (process.env.RP04_ORG_ROLE ?? "team") as keyof typeof ctx.orgs;
    const org = ctx.orgs[role] ?? "";
    if (!org) return [{ id: "RP04", title: "RP04", status: "skip", detail: `PVLAB_ORG_${String(role).toUpperCase()} not set` }];
    const p1 = randomPassword();
    const p2 = randomPassword();
    let ref = "";
    try {
      const created = await createProject(ctx, org, `rp-rp04-${Date.now().toString(36)}`, p1);
      ref = created.ref;
      if (!ref) return [{ id: "RP04a", title: "create", status: "fail", detail: `HTTP ${created.status} ${created.text}` }];
      const healthy = await waitProjectStatus(ctx, ref, "ACTIVE_HEALTHY", 10 * 60_000);
      if (!healthy.ok) return [{ id: "RP04a", title: "create", status: "fail", detail: `not healthy: ${healthy.last}` }];
      const s: Subject = await subjectOf(ctx, ref);
      await seedData(s);
      const seedSt = await seedStorage(s);

      // ---- RP04a ----
      const ent = await mgmt(ctx, "GET", `/organizations/${org}/entitlements`);
      const feats = ((ent.json ?? {}) as { entitlements?: { feature?: { key?: string }; hasAccess?: boolean; config?: { value?: number } }[] })
        .entitlements ?? [];
      const flag = (k: string) => String(feats.find((f) => f.feature?.key === k)?.hasAccess ?? "absent");
      const retentionDays = String(feats.find((f) => f.feature?.key === "backup.retention_days")?.config?.value ?? "absent");
      const t0 = Date.now();
      let bk = await backups(s);
      while (bk.physicalIds.length === 0 && Date.now() - t0 < BACKUP_WAIT_MS) {
        await sleep(30_000);
        bk = await backups(s);
      }
      const backupListedS = bk.physicalIds.length ? Math.round((Date.now() - t0) / 1000) : "never";
      const newest = [...bk.physicalIds].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
      out.push({
        id: "RP04a",
        title: `fresh ${String(role)} project on default compute: entitlements and first physical backup`,
        status: newest ? "info" : "fail",
        detail: `org role ${String(role)}; physical backups listed ${bk.physicalIds.length} after ${backupListedS}s of polling`,
        measurements: {
          org_role: String(role),
          ent_project_cloning: flag("project_cloning"),
          ent_restore_to_new_project: flag("backup.restore_to_new_project"),
          ent_pitr_available_variants: flag("pitr.available_variants"),
          ent_backup_schedule: flag("backup.schedule"),
          ent_backup_retention_days: retentionDays,
          backups_http: bk.status,
          walg_enabled: String(bk.walg),
          pitr_enabled: String(bk.pitr),
          physical_backups_listed: bk.physicalIds.length,
          backup_listed_after_s: backupListedS,
          newest_backup_inserted_at: newest?.at ?? "none",
          poll_resolution_s: 30,
          seed_storage: seedSt,
        },
      });
      if (!newest) return out;

      // ---- RP04b ----
      const fp1 = await verifierFingerprint(s);
      await addMarker(s, "after-backup");
      const rot = await setPassword(s, p2);
      await sleep(5000);
      const [newOk, oldOk] = await Promise.all([poolerLogin(s, p2), poolerLogin(s, p1)]);
      const fp2 = await verifierFingerprint(s);
      const postObj = await putPostTargetObject(s);
      out.push({
        id: "RP04b",
        title: "after the backup: marker row, db password rotation, object upload",
        status: rot.status < 300 ? "info" : "fail",
        detail: `rotate HTTP ${rot.status}; new=${newOk.ok ? "ok" : "fail"} old=${oldOk.ok ? "ok" : "fail"}; rows [${await markerLabels(s)}]`,
        measurements: {
          db_mb_before_restore: await dbSizeMb(s),
          rotate_http: rot.status,
          after_rotation_new_password: newOk.ok ? "ok" : `fail ${newOk.error}`,
          after_rotation_old_password: oldOk.ok ? "ok" : `fail ${oldOk.error}`,
          verifier_fp_before: fp1,
          verifier_fp_after_rotation: fp2,
          post_backup_object_put: postObj,
        },
      });

      // ---- RP04c-d ----
      const rp = await mgmt(ctx, "GET", `/projects/${ref}/database/backups/restore-point`);
      const run = await measureRestore(s, {
        newPw: p2,
        oldPw: p1,
        issue: async () => {
          const r = await mgmt(ctx, "POST", `/projects/${ref}/database/backups/restore`, { id: newest.id });
          return { status: r.status, text: r.text };
        },
        retryMs: ACCEPT_RETRY_MS,
      });
      const ok = run.http >= 200 && run.http < 300;
      out.push({
        id: "RP04c",
        title: "in-place restore from the newest physical backup (no PITR)",
        // A refusal is the finding RP01 recorded on Pro, so it is info, not fail.
        status: "info",
        detail: `backups/restore HTTP ${run.http}${ok ? ` after ${run.acceptedAfterS}s; statuses ${run.tl?.seen.join(" -> ") ?? "n/a"}` : `: ${run.body.slice(0, 100)}`}`,
        measurements: {
          restore_point_get_http: rp.status,
          restore_point_get_body: rp.text.slice(0, 140),
          restore_http: run.http,
          restore_body: run.body,
          attempts: run.attempts.length,
          first_attempt: run.attempts[0] ?? "none",
          last_attempt: run.attempts[run.attempts.length - 1] ?? "none",
          accepted_after_s: run.acceptedAfterS,
          status_first_off_s: run.tl?.firstOffS ?? "n/a",
          status_back_healthy_s: run.tl?.backHealthyS ?? "n/a",
          status_poll_resolution_s: 10,
          statuses_seen: run.tl?.seen.join(" -> ") ?? "n/a",
          ...(ok ? flatten(run.windows, run.postOffsetMs) : {}),
        },
      });
      if (!ok) return out;
      out.push({
        id: "RP04d",
        title: "daily-backup restore: which db password the pooler accepts",
        status: "info",
        detail: `final: current=${run.cred.finalNew} replaced=${run.cred.finalOld}`,
        measurements: {
          ...credentialColumns("cred", run.cred),
          new_fail_mode: run.cred.newFailModes[0] ?? "none",
          old_fail_mode: run.cred.oldFailModes[0] ?? "none",
        },
      });

      // ---- RP04e ----
      const postNew = await settledLogin(s, p2);
      const postOld = await settledLogin(s, p1);
      const fp3 = await verifierFingerprint(s);
      const stor = await storageState(s, "rp04");
      out.push({
        id: "RP04e",
        title: "after the daily-backup restore: data, Storage, health",
        status: "info",
        detail: `rows [${await markerLabels(s)}]; storage ${stor.line}`,
        measurements: {
          end_state_current_password: postNew.ok ? "ok" : `fail ${postNew.error}`,
          end_state_replaced_password: postOld.ok ? "ok" : `fail ${postOld.error}`,
          breaker_wait_s_current_replaced: `${postNew.blockedS}/${postOld.blockedS}`,
          rows_after: await markerLabels(s),
          storage_all_ok: String(stor.allOk),
          storage_calls: stor.line,
          post_backup_object_after_restore: await postTargetState(s),
          health: await healthLine(s),
          verifier_fp_after_restore: fp3,
          fp_equals_before_rotation: String(fp3 === fp1),
          fp_equals_after_rotation: String(fp3 === fp2),
        },
      });
    } catch (e) {
      out.push({ id: "RP04", title: "RP04 aborted", status: "fail", detail: `threw: ${errText(e)}` });
    } finally {
      if (ref) {
        const del = await deleteProject(ctx, ref).catch(() => -1);
        out.push({ id: "RP04f", title: "cleanup: project deleted", status: del >= 200 && del < 300 ? "info" : "fail", detail: `DELETE HTTP ${del}` });
      }
    }
    return out;
  },
};

export default mod;
