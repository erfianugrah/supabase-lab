/**
 * RP02 - PITR restore on a Pro project: how long until a target is accepted,
 * what the restore costs per path, which db password survives, and whether
 * Storage answers afterwards.
 *
 * One throwaway Pro project (Small compute: PITR needs at least Small),
 * ap-southeast-1, with the `pitr_7` add-on applied by this module and removed
 * in `finally`. PITR is metered per hour; the module's own budget is two
 * hours of add-on time.
 *
 *   RP02a  enable `pitr_7`: HTTP status, seconds until `pitr_enabled` reads
 *          true and until the physical-backup window is populated.
 *   RP02b  baseline: seed row + bucket + object, remember a target instant
 *          T (unix seconds), THEN rotate the db password and insert a second
 *          row. The target predates the rotation, so a replay to T leaves
 *          pg_authid holding the old verifier.
 *   RP02c  `POST database/backups/restore-pitr {recovery_time_target_unix: T}`:
 *          retried every 60 s while refused (the archive may lag the target);
 *          seconds until accepted, the refusal text verbatim, per-path outage
 *          windows, and the status timeline.
 *   RP02d  which password the pooler accepts across and after the restore
 *          (changelog restore-credential-resync, 2026-07-30).
 *   RP02e  after: rows kept, Storage list/get/put (incident 4rbrdl79zz9p),
 *          per-service health, verifier fingerprint.
 *   RP02f  control: rotate again (so the current password postdates the
 *          restore), pick a target AFTER that rotation, restore again. A
 *          replay that includes the rotation carries the new verifier by
 *          itself, so this row separates "WAL replay" from "platform resync".
 *   RP02g  cleanup: pitr_7 removed (status), project deleted.
 *
 * DESTRUCTIVE and BILLABLE. Not measured: direct 5432 (IPv6-only, this vantage
 * is IPv4-only), restore at a target older than the first base backup.
 */
import { mgmt } from "../../../harness/src/mgmt";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import {
  addMarker,
  backups,
  createProject,
  credentialColumns,
  deleteProject,
  errText,
  flatten,
  healthLine,
  markerLabels,
  measureRestore,
  poolerLogin,
  randomPassword,
  dbSizeMb,
  diskLine,
  walMb,
  postTargetState,
  putPostTargetObject,
  seedBulk,
  seedData,
  seedStorage,
  setPassword,
  settledLogin,
  sleep,
  storageState,
  subjectOf,
  verifierFingerprint,
  waitProjectStatus,
  type RestoreRun,
  type Subject,
} from "../lib/rp";

const PITR_READY_MAX_MS = 30 * 60_000;
const ACCEPT_RETRY_MS = 20 * 60_000;

async function applyPitr(ctx: Ctx, ref: string): Promise<{ status: number; text: string }> {
  let r = await mgmt(ctx, "PATCH", `/projects/${ref}/billing/addons`, { addon_type: "pitr", addon_variant: "pitr_7" });
  for (let i = 0; i < 4 && r.status === 429; i++) {
    const m = /try again in (\d+)/.exec(r.text);
    await sleep(((m ? Number(m[1]) : 1) * 60 + 5) * 1000);
    r = await mgmt(ctx, "PATCH", `/projects/${ref}/billing/addons`, { addon_type: "pitr", addon_variant: "pitr_7" });
  }
  return { status: r.status, text: r.text.slice(0, 200) };
}

/**
 * The target instant, and how far it sat past the upper bound the platform
 * quoted in its first refusal ("Recovery time target must be within range:
 * <earliest> <= t <= <latest>"). Negative means the target was already inside.
 */
function targetCols(target: number, run: RestoreRun): Record<string, number | string> {
  const m = /<=\s*t\s*<=\s*(\d+)/.exec(run.attempts[0] ?? "");
  const bound = m ? Number(m[1]) : null;
  return {
    target_unix: target,
    first_attempt_upper_bound_unix: bound ?? "none quoted",
    target_minus_first_bound_s: bound === null ? "n/a" : target - bound,
  };
}

function restoreRows(
  id: string,
  credId: string,
  title: string,
  run: RestoreRun,
  extra: Record<string, number | string>,
): TestResult[] {
  const ok = run.http >= 200 && run.http < 300;
  return [
    {
      id,
      title,
      status: ok ? "info" : "fail",
      detail: `restore-pitr HTTP ${run.http} after ${run.acceptedAfterS}s; statuses ${run.tl?.seen.join(" -> ") ?? "n/a"}`,
      measurements: {
        restore_http: run.http,
        restore_body: run.body,
        accepted_after_s: run.acceptedAfterS,
        attempts: run.attempts.length,
        first_attempt: run.attempts[0] ?? "none",
        last_attempt: run.attempts[run.attempts.length - 1] ?? "none",
        status_first_off_s: run.tl?.firstOffS ?? "n/a",
        status_back_healthy_s: run.tl?.backHealthyS ?? "n/a",
        status_poll_resolution_s: 10,
        statuses_seen: run.tl?.seen.join(" -> ") ?? "n/a",
        ...flatten(run.windows, run.postOffsetMs),
        ...extra,
      },
    },
    {
      id: credId,
      title: `${title}: which db password the pooler accepts`,
      status: "info",
      detail: `final: current=${run.cred.finalNew} replaced=${run.cred.finalOld}`,
      measurements: {
        ...credentialColumns("cred", run.cred),
        new_fail_mode: run.cred.newFailModes[0] ?? "none",
        old_fail_mode: run.cred.oldFailModes[0] ?? "none",
      },
    },
  ];
}

const mod: TestModule = {
  id: "RP02",
  title: "Pro PITR restore: time to accept, per-path outage, db password, Storage",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];
    const org = ctx.orgs.pro ?? "";
    if (!org) return [{ id: "RP02", title: "RP02", status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    const p1 = randomPassword();
    const p2 = randomPassword();
    const p3 = randomPassword();
    let ref = "";
    let pitrOn = false;
    const tPitr = { t0: 0 };
    try {
      const created = await createProject(ctx, org, `rp-rp02-${Date.now().toString(36)}`, p1, "small");
      ref = created.ref;
      if (!ref) return [{ id: "RP02a", title: "create", status: "fail", detail: `HTTP ${created.status} ${created.text}` }];
      const healthy = await waitProjectStatus(ctx, ref, "ACTIVE_HEALTHY", 10 * 60_000);
      if (!healthy.ok) return [{ id: "RP02a", title: "create", status: "fail", detail: `not healthy: ${healthy.last}` }];
      const s: Subject = await subjectOf(ctx, ref);
      await seedData(s);
      const seedSt = await seedStorage(s);

      // ---- RP02a: enable PITR ----
      tPitr.t0 = Date.now();
      const enable = await applyPitr(ctx, ref);
      pitrOn = enable.status < 300;
      let bk = await backups(s);
      let enabledS: number | string = bk.pitr ? 0 : "never";
      let windowS: number | string = bk.windowLatest ? 0 : "never";
      while (pitrOn && (windowS === "never" || enabledS === "never") && Date.now() - tPitr.t0 < PITR_READY_MAX_MS) {
        await sleep(15_000);
        bk = await backups(s);
        const at = Math.round((Date.now() - tPitr.t0) / 1000);
        if (bk.pitr && enabledS === "never") enabledS = at;
        if (bk.windowLatest && windowS === "never") windowS = at;
      }
      out.push({
        id: "RP02a",
        title: "enable pitr_7 on a Small project",
        status: pitrOn && windowS !== "never" ? "info" : "fail",
        detail: `PATCH billing/addons HTTP ${enable.status}; pitr_enabled after ${enabledS}s, window populated after ${windowS}s`,
        measurements: {
          addon_http: enable.status,
          addon_body: enable.text.slice(0, 120),
          pitr_enabled_after_s: enabledS,
          window_populated_after_s: windowS,
          poll_resolution_s: 15,
          window_earliest_unix: bk.windowEarliest ?? "none",
          window_latest_unix: bk.windowLatest ?? "none",
          physical_backups_listed: bk.physicalIds.length,
        },
      });
      if (!pitrOn || windowS === "never") return out;

      // ---- RP02b: target instant, then rotate ----
      // Optional bulk data (RP02_SEED_MB) so a restore time can be tied to a measured size.
      const wantMb = Number(process.env.RP02_SEED_MB ?? 0);
      const bulk = wantMb > 0 ? await seedBulk(s, wantMb) : { dbMb: await dbSizeMb(s), batches: 0, error: "" };
      const fp1 = await verifierFingerprint(s);
      await addMarker(s, "before-target");
      await sleep(15_000);
      const target = Math.floor(Date.now() / 1000);
      await sleep(15_000);
      const rot = await setPassword(s, p2);
      await sleep(5000);
      const [newOk, oldOk] = await Promise.all([poolerLogin(s, p2), poolerLogin(s, p1)]);
      const fp2 = await verifierFingerprint(s);
      await addMarker(s, "after-target-and-rotation");
      const postObj = await putPostTargetObject(s);
      out.push({
        id: "RP02b",
        title: "baseline: target instant, then rotate the db password",
        status: rot.status < 300 ? "info" : "fail",
        detail: `rotate HTTP ${rot.status}; new=${newOk.ok ? "ok" : "fail"} old=${oldOk.ok ? "ok" : "fail"}`,
        measurements: {
          seed_storage: seedSt,
          db_mb_before_restore: bulk.dbMb,
          bulk_seed_target_mb: wantMb,
          bulk_seed_batches: bulk.batches,
          bulk_seed_error: bulk.error || "none",
          wal_mb_after_seed: await walMb(s),
          disk: await diskLine(s),
          target_seconds_before_rotation: 15,
          rotate_http: rot.status,
          after_rotation_new_password: newOk.ok ? "ok" : `fail ${newOk.error}`,
          after_rotation_old_password: oldOk.ok ? "ok" : `fail ${oldOk.error}`,
          verifier_fp_before: fp1,
          verifier_fp_after_rotation: fp2,
        },
      });

      // ---- RP02c-e: restore to the pre-rotation target ----
      const r1 = await measureRestore(s, {
        newPw: p2,
        oldPw: p1,
        issue: async () => {
          const r = await mgmt(ctx, "POST", `/projects/${ref}/database/backups/restore-pitr`, { recovery_time_target_unix: target });
          return { status: r.status, text: r.text };
        },
        retryMs: ACCEPT_RETRY_MS,
      });
      out.push(...restoreRows("RP02c", "RP02d", "PITR restore to an instant before the rotation", r1, targetCols(target, r1)));
      // Explicit end-state logins, breaker-aware, current password first.
      const postNew = await settledLogin(s, p2);
      const postOld = await settledLogin(s, p1);
      const fp3 = await verifierFingerprint(s);
      const labels = await markerLabels(s);
      const postObjState = await postTargetState(s);
      const stor = await storageState(s, "rp02c");
      out.push({
        id: "RP02e",
        title: "after the PITR restore: data, Storage, health",
        status: "info",
        detail: `rows [${labels}]; storage ${stor.line}`,
        measurements: {
          end_state_current_password: postNew.ok ? "ok" : `fail ${postNew.error}`,
          end_state_replaced_password: postOld.ok ? "ok" : `fail ${postOld.error}`,
          breaker_wait_s_current_replaced: `${postNew.blockedS}/${postOld.blockedS}`,
          rows_after: labels,
          storage_all_ok: String(stor.allOk),
          storage_calls: stor.line,
          post_target_object_put_before_restore: postObj,
          post_target_object_after_restore: postObjState,
          health: await healthLine(s),
          db_mb_after_restore: await dbSizeMb(s),
          verifier_fp_after_restore: fp3,
          fp_equals_before_rotation: String(fp3 === fp1),
          fp_equals_after_rotation: String(fp3 === fp2),
        },
      });

      // ---- RP02f: control, target AFTER a rotation ----
      if (r1.http >= 200 && r1.http < 300) {
        const rot2 = await setPassword(s, p3);
        await sleep(5000);
        const fp4 = await verifierFingerprint(s);
        await addMarker(s, "before-control-target");
        await sleep(10_000);
        const target2 = Math.floor(Date.now() / 1000);
        await sleep(10_000);
        const currentOk = await poolerLogin(s, p3);
        const r2 = await measureRestore(s, {
          newPw: p3,
          oldPw: p2,
          issue: async () => {
            const r = await mgmt(ctx, "POST", `/projects/${ref}/database/backups/restore-pitr`, { recovery_time_target_unix: target2 });
            return { status: r.status, text: r.text };
          },
          retryMs: ACCEPT_RETRY_MS,
        });
        const fp5 = await verifierFingerprint(s);
        out.push(
          ...restoreRows("RP02f", "RP02f2", "control: PITR restore to an instant AFTER a second rotation", r2, {
            ...targetCols(target2, r2),
            rotate2_http: rot2.status,
            current_works_before_restore: currentOk.ok ? "ok" : `fail ${currentOk.error}`,
            verifier_fp_after_second_rotation: fp4,
            verifier_fp_after_control_restore: fp5,
            fp_equals_after_second_rotation: String(fp5 === fp4),
            rows_after: await markerLabels(s),
            storage_calls: (await storageState(s, "rp02f")).line,
          }),
        );
      }
    } catch (e) {
      out.push({ id: "RP02", title: "RP02 aborted", status: "fail", detail: `threw: ${errText(e)}` });
    } finally {
      let rm = -2;
      if (ref && pitrOn) {
        rm = (await mgmt(ctx, "DELETE", `/projects/${ref}/billing/addons/pitr_7`).catch(() => ({ status: -1 }))).status;
      }
      const pitrHours = tPitr.t0 ? ((Date.now() - tPitr.t0) / 3_600_000).toFixed(2) : "0";
      let del = -2;
      if (ref) del = await deleteProject(ctx, ref).catch(() => -1);
      out.push({
        id: "RP02g",
        title: "cleanup: pitr_7 removed, project deleted",
        status: del >= 200 && del < 300 ? "info" : "fail",
        detail: `DELETE pitr_7 HTTP ${rm}; DELETE project HTTP ${del}`,
        measurements: { pitr_on_hours: pitrHours },
      });
    }
    return out;
  },
};

export default mod;
