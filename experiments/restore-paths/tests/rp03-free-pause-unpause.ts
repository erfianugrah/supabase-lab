/**
 * RP03 - pause and unpause on a Free-plan project: timing, the db password
 * across the cycle, and Storage afterwards.
 *
 * Pro projects refuse pause (RP01b), so the only pause/unpause path a lab org
 * can run is a Free-plan project. Unpause is the same restore completion path
 * the changelog entry restore-credential-resync (2026-07-30) covers, so this
 * is where "which password works after an unpause" can be read.
 *
 * One throwaway Free project, ap-southeast-1 (Free orgs allow 2 active):
 *
 *   RP03a  seed a row, a bucket and an object; rotate the db password
 *          (p1 -> p2) and read which one the pooler accepts.
 *   RP03b  POST /pause: seconds to INACTIVE (polled at 5 s) and per-path
 *          first-failure times under the sampler (the paths never recover
 *          while parked, so there is no window).
 *   RP03c  while INACTIVE: PATCH database/password (p2 -> p3), GET /restore,
 *          and a Management API SQL call. If the password change is accepted,
 *          the stored snapshot holds p2 and the platform holds p3, which is
 *          the stale-credential condition the changelog describes.
 *   RP03d  POST /restore (unpause): per-path outage windows, status timeline,
 *          and which of p1/p2/p3 the pooler accepts during and after.
 *   RP03e  after: rows kept, Storage list/get/put (incident 4rbrdl79zz9p),
 *          health, verifier fingerprints.
 *   RP03f  a second pause/unpause cycle with no password change, for n=2.
 *
 * Cost: none on the Free plan. The project is deleted in `finally`.
 * Not measured: direct 5432 (IPv6-only), auto-pause (inactivity), a project
 * parked longer than minutes.
 */
import { mgmt } from "../../../harness/src/mgmt";
import { sampleDuring } from "../../../harness/src/sampler";
import { sql } from "../../../harness/src/platform";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import {
  INTERVAL_MS,
  SETTLE_MS,
  addMarker,
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
  seedData,
  seedStorage,
  serviceProbes,
  settledLogin,
  setPassword,
  sleep,
  storageState,
  subjectOf,
  verifierFingerprint,
  waitProjectStatus,
  type Subject,
} from "../lib/rp";

/** Pause, retried while the platform refuses it (a settle period follows a restore). */
async function pauseTimed(s: Subject): Promise<{ http: number; body: string; attempts: number; toInactiveS: number | "never"; windows: ReturnType<typeof flatten> }> {
  let http = 0;
  let body = "";
  let attempts = 0;
  let toInactive: number | "never" = "never";
  const windows = await sampleDuring(
    serviceProbes(s),
    { intervalMs: INTERVAL_MS, maxWaitMs: 150_000, settleMs: SETTLE_MS, log: s.ctx.log },
    async () => {
      const t0 = Date.now();
      let r = await mgmt(s.ctx, "POST", `/projects/${s.ref}/pause`);
      attempts = 1;
      while (r.status >= 300 && Date.now() - t0 < 5 * 60_000) {
        await sleep(30_000);
        r = await mgmt(s.ctx, "POST", `/projects/${s.ref}/pause`);
        attempts += 1;
      }
      http = r.status;
      body = r.text.slice(0, 140);
      if (r.status < 300) {
        const w = await waitProjectStatus(s.ctx, s.ref, "INACTIVE", 5 * 60_000, 5000);
        if (w.ok) toInactive = Math.round((Date.now() - t0) / 1000);
      }
    },
  );
  return { http, body, attempts, toInactiveS: toInactive, windows: flatten(windows) };
}

const mod: TestModule = {
  id: "RP03",
  title: "Free-plan pause/unpause: timing, db password across the cycle, Storage",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];
    const org = ctx.orgs.free ?? "";
    if (!org) return [{ id: "RP03", title: "RP03", status: "skip", detail: "PVLAB_ORG_FREE not set" }];
    const p1 = randomPassword();
    const p2 = randomPassword();
    const p3 = randomPassword();
    let ref = "";
    try {
      const created = await createProject(ctx, org, `rp-rp03-${Date.now().toString(36)}`, p1);
      ref = created.ref;
      if (!ref) return [{ id: "RP03a", title: "create", status: "fail", detail: `HTTP ${created.status} ${created.text}` }];
      const healthy = await waitProjectStatus(ctx, ref, "ACTIVE_HEALTHY", 10 * 60_000);
      if (!healthy.ok) return [{ id: "RP03a", title: "create", status: "fail", detail: `not healthy: ${healthy.last}` }];
      const s = await subjectOf(ctx, ref);

      // ---- RP03a ----
      const seed = await seedData(s);
      const seedSt = await seedStorage(s);
      const fp1 = await verifierFingerprint(s);
      const rot = await setPassword(s, p2);
      await sleep(5000);
      const [newOk, oldOk] = await Promise.all([poolerLogin(s, p2), poolerLogin(s, p1)]);
      const fp2 = await verifierFingerprint(s);
      await addMarker(s, "after-rotation-before-pause");
      out.push({
        id: "RP03a",
        title: "baseline: seed, rotate p1 to p2, which password the pooler accepts",
        status: rot.status < 300 ? "info" : "fail",
        detail: `rotate HTTP ${rot.status}; p2=${newOk.ok ? "ok" : "fail"} p1=${oldOk.ok ? "ok" : "fail"}`,
        measurements: {
          seed_row: seed,
          seed_storage: seedSt,
          rotate_http: rot.status,
          p2_after_rotation: newOk.ok ? "ok" : `fail ${newOk.error}`,
          p1_after_rotation: oldOk.ok ? "ok" : `fail ${oldOk.error}`,
          verifier_fp_before: fp1,
          verifier_fp_after_rotation: fp2,
        },
      });

      // ---- RP03b ----
      const pause = await pauseTimed(s);
      out.push({
        id: "RP03b",
        title: "POST /pause on a Free project",
        status: pause.http < 300 ? "info" : "fail",
        detail: `pause HTTP ${pause.http} (${pause.attempts} attempt(s)); INACTIVE after ${pause.toInactiveS}s`,
        measurements: {
          pause_http: pause.http,
          pause_body: pause.body,
          pause_attempts: pause.attempts,
          pause_to_inactive_s: pause.toInactiveS,
          status_poll_resolution_s: 5,
          ...pause.windows,
        },
      });
      if (pause.http >= 300 || pause.toInactiveS === "never") return out;

      // ---- RP03c ----
      const pwWhilePaused = await setPassword(s, p3);
      const versions = await mgmt(ctx, "GET", `/projects/${ref}/restore`);
      const sqlWhilePaused = await sql(s.ctx, "select 1", 20_000).catch((e) => ({ status: 0, rows: [], error: errText(e) }));
      out.push({
        id: "RP03c",
        title: "while INACTIVE: password change, restorable versions, SQL",
        status: "info",
        detail: `PATCH password HTTP ${pwWhilePaused.status}; GET restore ${versions.status}; SQL ${sqlWhilePaused.status}`,
        measurements: {
          password_patch_http: pwWhilePaused.status,
          password_patch_body: pwWhilePaused.text.slice(0, 140),
          list_restore_versions_http: versions.status,
          list_restore_versions_body: versions.text.slice(0, 120),
          mgmt_sql_http: sqlWhilePaused.status,
          mgmt_sql_error: sqlWhilePaused.error.slice(0, 100) || "none",
        },
      });
      const patchAccepted = pwWhilePaused.status < 300;

      // ---- RP03d/e ----
      const current = patchAccepted ? p3 : p2;
      const previous = patchAccepted ? p2 : p1;
      const run = await measureRestore(s, {
        newPw: current,
        oldPw: previous,
        issue: async () => {
          const r = await mgmt(ctx, "POST", `/projects/${ref}/restore`);
          return { status: r.status, text: r.text };
        },
        maxMs: 15 * 60_000,
      });
      out.push({
        id: "RP03d",
        title: "POST /restore (unpause): status timeline, per-path outage, credentials",
        status: run.http >= 200 && run.http < 300 ? "info" : "fail",
        detail: `restore HTTP ${run.http}; statuses ${run.tl?.seen.join(" -> ") ?? "n/a"}; final current=${run.cred.finalNew} previous=${run.cred.finalOld}`,
        measurements: {
          restore_http: run.http,
          restore_body: run.body,
          current_password_is: patchAccepted ? "p3 (set while paused)" : "p2 (rotated before pause)",
          status_first_off_s: run.tl?.firstOffS ?? "n/a",
          status_back_healthy_s: run.tl?.backHealthyS ?? "n/a",
          status_poll_resolution_s: 10,
          statuses_seen: run.tl?.seen.join(" -> ") ?? "n/a",
          ...flatten(run.windows, run.postOffsetMs),
          ...credentialColumns("cred", run.cred),
          new_fail_mode: run.cred.newFailModes[0] ?? "none",
          old_fail_mode: run.cred.oldFailModes[0] ?? "none",
        },
      });
      // One at a time and breaker-aware: two wrong passwords in parallel is how the pooler's
      // circuit breaker opened in the first run. Order: most likely current first.
      const l3 = await settledLogin(s, p3);
      const l2 = await settledLogin(s, p2);
      const l1 = await settledLogin(s, p1);
      const fp3 = await verifierFingerprint(s);
      const labels = await markerLabels(s);
      const stor = await storageState(s, "rp03");
      out.push({
        id: "RP03e",
        title: "after unpause: which of p1/p2/p3 works, data, Storage, health",
        status: "info",
        detail: `p1=${l1.ok ? "ok" : "fail"} p2=${l2.ok ? "ok" : "fail"} p3=${l3.ok ? "ok" : "fail"}; storage ${stor.line}`,
        measurements: {
          p1_works: l1.ok ? "ok" : `fail ${l1.error}`,
          p2_works: l2.ok ? "ok" : `fail ${l2.error}`,
          p3_works: l3.ok ? "ok" : `fail ${l3.error}`,
          breaker_wait_s_p3_p2_p1: `${l3.blockedS}/${l2.blockedS}/${l1.blockedS}`,
          rows_after: labels,
          storage_all_ok: String(stor.allOk),
          storage_calls: stor.line,
          health: await healthLine(s),
          verifier_fp_after_unpause: fp3,
          fp_equals_before_rotation: String(fp3 === fp1),
          fp_equals_after_rotation: String(fp3 === fp2),
        },
      });

      // ---- RP03f: second cycle, no password change ----
      const pause2 = await pauseTimed(s);
      let r2: Awaited<ReturnType<typeof measureRestore>> | undefined;
      if (pause2.http < 300 && pause2.toInactiveS !== "never") {
        r2 = await measureRestore(s, {
          // Whichever password worked after cycle 1 is the one expected to survive cycle 2.
          newPw: l3.ok ? p3 : l2.ok ? p2 : p1,
          oldPw: l3.ok ? p2 : l2.ok ? p1 : p3,
          issue: async () => {
            const r = await mgmt(ctx, "POST", `/projects/${ref}/restore`);
            return { status: r.status, text: r.text };
          },
          maxMs: 15 * 60_000,
          tailMs: 30_000,
        });
      }
      out.push({
        id: "RP03f",
        title: "second pause/unpause cycle, no password change",
        status: r2 && r2.http < 300 ? "info" : "fail",
        detail: `pause HTTP ${pause2.http}, INACTIVE after ${pause2.toInactiveS}s; unpause ${r2?.http ?? "not issued"}; back healthy ${r2?.tl?.backHealthyS ?? "n/a"}s`,
        measurements: {
          pause_http: pause2.http,
          pause_attempts: pause2.attempts,
          pause_to_inactive_s: pause2.toInactiveS,
          unpause_http: r2?.http ?? "n/a",
          status_first_off_s: r2?.tl?.firstOffS ?? "n/a",
          status_back_healthy_s: r2?.tl?.backHealthyS ?? "n/a",
          statuses_seen: r2?.tl?.seen.join(" -> ") ?? "n/a",
          ...(r2 ? flatten(r2.windows, r2.postOffsetMs) : {}),
          ...(r2 ? credentialColumns("cred", r2.cred) : {}),
          storage_calls: r2 ? (await storageState(s, "rp03f")).line : "n/a",
        },
      });
    } catch (e) {
      out.push({ id: "RP03", title: "RP03 aborted", status: "fail", detail: `threw: ${errText(e)}` });
    } finally {
      if (ref) {
        // A project left INACTIVE may refuse delete; one retry after a restore attempt is not worth it.
        const st = await deleteProject(ctx, ref).catch(() => -1);
        out.push({ id: "RP03g", title: "cleanup: project deleted", status: st >= 200 && st < 300 ? "info" : "fail", detail: `DELETE HTTP ${st}` });
      }
    }
    return out;
  },
};

export default mod;
