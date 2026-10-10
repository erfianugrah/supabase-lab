/**
 * LO05 - restart envelope: n=5 restarts of ONE Micro project, per connection
 * path, behind the status-page change gate.
 *
 * DESTRUCTIVE and self-provisioning: creates one `lo-` project in
 * the Pro org (PVLAB_ORG_PRO), restarts it five times, deletes it in `finally`.
 * With LO_HANDOFF=1 and LO04 run earlier in the same process, it restarts the
 * project LO04 left running instead of creating one (keeps a full pass at 6
 * creates). A first draft of this module ran as LO02 and failed at readiness
 * because the direct probe's name lookup failed on the vantage (see probes.ts).
 *
 *   LO05a  gate decision (create) and the create: time to ACTIVE_HEALTHY, then
 *          time until all five paths answer (ACTIVE_HEALTHY is not readiness).
 *   LO05b  five restarts. Before each: the gate for `restart`, then a wait for
 *          every path to answer on consecutive samples. During each:
 *          sampleDuring over REST, Auth, Storage, pooler (6543), direct (5432)
 *          at 500 ms, plus a 10 s status poll for the control-plane view.
 *          Report per path: runs that failed, p50 and max of first-failure
 *          and outage window across the five runs.
 *   LO05c  what the API says to a second restart sent while the first is still
 *          in flight (an operation refused or stalled).
 *   LO05d  teardown: DELETE and seconds until the ref leaves the org listing.
 *
 * Same sampler and 500 ms resolution as platform-downtime D01 (n=1 there).
 * Pass = all five restarts produced a usable measurement (paths healthy at
 * start, every failed path recovered). The numbers are data, not pass bands.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { sampleDuring, type PathWindow, type Probe } from "../../../harness/src/sampler";
import { mgmt } from "../../../harness/src/mgmt";
import { restProbe, authProbe, storageProbe, poolerProbe } from "../../platform-downtime/lib/probes";
import { AUTH_PATH, resolvePooler } from "../../platform-downtime/lib/setup";
import { directProbe, p50 } from "../lib/probes";
import { gate } from "../lib/gate";
import {
  POLL_MS,
  createWithFallback,
  deleteOurs,
  fmtTransitions,
  mgmtPatient,
  nameFor,
  pollStatus,
  projectCtx,
  sleep,
  handoff,
  strongPassword,
  waitGone,
  type Transition,
} from "../lib/project";

const REGION = "ap-southeast-1";
const RUNS = 5;
const INTERVAL_MS = 500;
const SETTLE_MS = 5000;
const MAX_WAIT_MS = 600_000;
const EARLY_PROBE_S = 300;
const WINDOW_WAIT_S = 690;

async function allAnswer(probes: Probe[]): Promise<string[]> {
  const bad: string[] = [];
  for (const p of probes) if (!(await p.run().catch(() => ({ ok: false }))).ok) bad.push(p.name);
  return bad;
}

/** Wait until every path answers on `need` consecutive rounds. Returns seconds waited, or -1. */
async function waitReady(probes: Probe[], need = 3, maxMs = 300_000): Promise<{ s: number; last: string[] }> {
  const t0 = Date.now();
  let streak = 0;
  let last: string[] = ["not-run"];
  while (Date.now() - t0 < maxMs) {
    last = await allAnswer(probes);
    streak = last.length === 0 ? streak + 1 : 0;
    if (streak >= need) return { s: Math.round((Date.now() - t0) / 1000), last };
    await sleep(2000);
  }
  return { s: -1, last };
}

interface RunRecord {
  windows: PathWindow[];
  postHttp: number;
  postMs: number;
  transitions: Transition[];
  healthyAgainMs: number;
}

const mod: TestModule = {
  id: "LO05",
  title: "Restart envelope n=5 per connection path, gated",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const org = ctx.orgs.pro ?? "";
    if (!org) return [{ id: "LO05", title: mod.title, status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    const results: TestResult[] = [];
    let ref = "";

    try {
      // ---- a: gate + create + readiness ----
      const g = await gate(REGION, "create");
      if (!g.proceed) {
        return [
          {
            id: "LO05a",
            title: "LO05a: gate refused the create",
            status: "info",
            detail: g.blockers.join(" ; "),
            measurements: { gate_proceed: 0, gate_fetch_ms: g.snapshot.fetchMs },
          },
        ];
      }
      const t0 = Date.now();
      const adopted = handoff.ref && handoff.org === org ? { ...handoff } : null;
      const dbPass = adopted?.dbPass ?? strongPassword();
      const created = adopted
        ? { ref: adopted.ref as string, region: REGION, attempts: [] as { http: number; ms: number }[] }
        : await createWithFallback(ctx, org, nameFor("lo05"), [REGION], dbPass);
      ref = created.ref ?? "";
      if (!ref) {
        return [
          {
            id: "LO05a",
            title: "LO05a: create",
            status: "fail",
            detail: JSON.stringify(created.attempts),
          },
        ];
      }
      const healthy = await pollStatus(ctx, ref, "ACTIVE_HEALTHY", 900_000, t0);
      // Clock for the post-create restart window: when ACTIVE_HEALTHY was first
      // read (for an adopted project, when LO04 sent its first POST, which is earlier).
      const healthyAt = adopted?.createdAtMs ?? Date.now();
      const pctx = await projectCtx(ctx, ref, dbPass);
      const pooler = pctx ? await resolvePooler(pctx) : null;
      if (!pctx || !pooler) {
        results.push({
          id: "LO05a",
          title: "LO05a: create",
          status: "fail",
          detail: `healthy=${healthy.reached} keys=${pctx ? "ok" : "missing"} pooler=${pooler ? "ok" : "missing"}`,
        });
        return results;
      }
      let probes: Probe[] = [
        restProbe(pctx.apiHost, pctx.anonKey as string),
        authProbe(pctx.apiHost, pctx.anonKey as string, AUTH_PATH),
        storageProbe(pctx.apiHost, pctx.anonKey as string),
        poolerProbe(pooler.host, pooler.port, pooler.user, dbPass),
        directProbe(pctx.phzHost, dbPass),
      ];
      let ready = await waitReady(probes);
      let directNote = "direct path included";
      if (ready.s < 0 && ready.last.length === 1 && ready.last[0] === "direct") {
        // One path the vantage cannot reach should cost one column, not the run.
        const why = await probes[4]?.run();
        directNote = `direct EXCLUDED, never answered: ${why && !why.ok ? why.error : "unknown"}`;
        probes = probes.slice(0, 4);
        ready = await waitReady(probes);
      }
      results.push({
        id: "LO05a",
        title: "LO05a: gate, create, readiness",
        status: healthy.reached && ready.s >= 0 ? "pass" : "fail",
        detail: `transitions ${fmtTransitions(healthy.transitions)}; ${directNote}; paths not answering at the end: ${ready.last.join(",") || "none"}`,
        measurements: {
          gate_proceed: 1,
          gate_region_components: g.regionComponentsMatched,
          project_source: adopted ? "adopted from LO04" : "created here",
          create_http: created.attempts.at(-1)?.http ?? 0,
          create_call_ms: created.attempts.at(-1)?.ms ?? -1,
          active_healthy_s: adopted ? "n/a (adopted)" : Math.round(healthy.ms / 1000),
          all_paths_answer_after_healthy_s: ready.s,
          region: REGION,
        },
      });
      if (!healthy.reached || ready.s < 0) return results;

      // ---- f: restart inside the post-create window ----
      // A first attempt 0 s after ACTIVE_HEALTHY was refused with HTTP 400
      // (LO04/LO05 hand-off run). Probe once at +EARLY_PROBE_S to read the full
      // refusal body, then wait out the stated ten minutes plus a margin.
      const sinceHealthy = () => Math.round((Date.now() - healthyAt) / 1000);
      await sleep(Math.max(0, healthyAt + EARLY_PROBE_S * 1000 - Date.now()));
      const early = await mgmt(ctx, "POST", `/projects/${ref}/restart`).catch(
        (e) => ({ status: 0, text: String(e) }) as { status: number; text: string },
      );
      const earlyAt = sinceHealthy();
      results.push({
        id: "LO05f",
        title: "LO05f: restart sent inside the post-create window",
        status: "info",
        detail: `HTTP ${early.status} at +${earlyAt} s after ACTIVE_HEALTHY: ${early.text.slice(0, 400).replace(/\s+/g, " ")}`,
        measurements: { early_probe_at_s: earlyAt, early_probe_http: early.status },
      });
      if (early.status >= 200 && early.status < 300) {
        ctx.log("early restart ACCEPTED: the stated window did not hold; waiting for recovery");
        await sleep(30_000);
      }
      await sleep(Math.max(0, healthyAt + WINDOW_WAIT_S * 1000 - Date.now()));

      // ---- b: five restarts ----
      const runs: RunRecord[] = [];
      const runNotes: string[] = [];
      let windowRefusals = 0;
      let firstAcceptedAfterHealthyS = -1;
      for (let n = 1; n <= RUNS; n++) {
        const rg = await gate(REGION, "restart");
        if (!rg.proceed) {
          runNotes.push(`run ${n}: gate refused: ${rg.blockers.join(" ; ")}`);
          break;
        }
        const rd = await waitReady(probes);
        if (rd.s < 0) {
          runNotes.push(`run ${n}: paths never became ready (${rd.last.join(",")})`);
          break;
        }
        let postHttp = 0;
        let postMs = -1;
        let transitions: Transition[] = [];
        let healthyAgainMs = -1;
        const windows = await sampleDuring(
          probes,
          { intervalMs: INTERVAL_MS, maxWaitMs: MAX_WAIT_MS, settleMs: SETTLE_MS },
          async () => {
            const t = Date.now();
            const r = await mgmt(ctx, "POST", `/projects/${ref}/restart`).catch(
              (e) => ({ status: 0, text: String(e) }) as { status: number; text: string },
            );
            postHttp = r.status;
            postMs = Date.now() - t;
            if (r.status >= 200 && r.status < 300 && firstAcceptedAfterHealthyS < 0) {
              firstAcceptedAfterHealthyS = Math.round((t - healthyAt) / 1000);
            }
            if (r.status >= 300 || r.status === 0) throw new Error(`restart HTTP ${r.status} ${r.text.slice(0, 300)}`);
            // Control-plane view: status transitions every POLL_MS until the
            // project reads ACTIVE_HEALTHY again after having left it.
            const from = Date.now();
            let left = false;
            while (Date.now() - from < 420_000) {
              const s = await mgmtPatient(ctx, "GET", `/projects/${ref}`);
              const st = s.status === 200 ? String((s.json as { status?: string } | undefined)?.status ?? "?") : `HTTP ${s.status}`;
              if (transitions.at(-1)?.status !== st) transitions.push({ atMs: Date.now() - from, status: st });
              if (st !== "ACTIVE_HEALTHY") left = true;
              if (left && st === "ACTIVE_HEALTHY") {
                healthyAgainMs = Date.now() - from;
                break;
              }
              await sleep(POLL_MS);
            }
          },
        ).catch((e) => {
          runNotes.push(`run ${n}: ${e instanceof Error ? e.message : String(e)}`);
          return null;
        });
        if (!windows && postHttp === 400 && windowRefusals < 6) {
          windowRefusals += 1;
          await sleep(60_000);
          n -= 1;
          continue;
        }
        if (!windows) break;
        const unhealthy = windows.filter((w) => !w.healthyAtStart).map((w) => w.name);
        if (unhealthy.length) {
          runNotes.push(`run ${n}: void, already failing at start: ${unhealthy.join(",")}`);
          continue;
        }
        runs.push({ windows, postHttp, postMs, transitions, healthyAgainMs });
        ctx.log(
          `restart ${n}/${RUNS}: ` +
            windows.map((w) => `${w.name}=${w.windowMs === null ? "none" : Math.round(w.windowMs / 1000) + "s"}`).join(" "),
        );
      }

      const names = probes.map((p) => p.name);
      const m: Record<string, number | string> = {
        restarts_measured: runs.length,
        probe_interval_ms: INTERVAL_MS,
        settle_ms: SETTLE_MS,
      };
      const ev: string[] = [];
      for (const name of names) {
        const per = runs.map((r) => r.windows.find((w) => w.name === name) as PathWindow);
        const failed = per.filter((w) => w.firstFailMs !== null);
        const stuck = per.filter((w) => w.firstFailMs !== null && w.recoveredMs === null).length;
        m[`${name}_failed_runs`] = `${failed.length} of ${runs.length}`;
        m[`${name}_unrecovered_runs`] = stuck;
        if (failed.length) {
          const win = failed.filter((w) => w.windowMs !== null).map((w) => (w.windowMs as number) / 1000);
          const ff = failed.map((w) => (w.firstFailMs as number) / 1000);
          m[`${name}_window_p50_s`] = Math.round(p50(win));
          m[`${name}_window_max_s`] = Math.round(Math.max(...win));
          m[`${name}_first_fail_p50_s`] = Math.round(p50(ff));
          m[`${name}_first_fail_max_s`] = Math.round(Math.max(...ff));
          m[`${name}_mode`] = [...new Set(failed.flatMap((w) => w.modes))].join(" | ").slice(0, 160);
          // p50 over ALL runs, a run that never failed counting as 0 s.
          m[`${name}_window_p50_all_runs_s`] = Math.round(
            p50(per.map((w) => (w.windowMs === null ? 0 : w.windowMs / 1000))),
          );
        }
        ev.push(
          `${name}: ` +
            per.map((w) => (w.firstFailMs === null ? "ok" : `${Math.round(w.firstFailMs / 1000)}s+${w.windowMs === null ? "stuck" : Math.round(w.windowMs / 1000) + "s"}`)).join("  "),
        );
      }
      const healthyAgain = runs.map((r) => r.healthyAgainMs / 1000).filter((x) => x >= 0);
      if (healthyAgain.length) {
        m.status_back_to_active_healthy_p50_s = Math.round(p50(healthyAgain));
        m.status_back_to_active_healthy_max_s = Math.round(Math.max(...healthyAgain));
      }
      m.window_refusals_before_first_accept = windowRefusals;
      m.first_restart_accepted_after_healthy_s = firstAcceptedAfterHealthyS;
      m.restart_post_http = [...new Set(runs.map((r) => r.postHttp))].join(",");
      m.restart_post_ms_p50 = Math.round(p50(runs.map((r) => r.postMs)));
      ev.push(...runs.map((r, i) => `run ${i + 1} status: ${fmtTransitions(r.transitions)}`), ...runNotes);
      results.push({
        id: "LO05b",
        title: "LO05b: restart envelope per path (n=5)",
        status: runs.length === RUNS && names.every((n) => m[`${n}_unrecovered_runs`] === 0) ? "pass" : "fail",
        detail: `${runs.length} of ${RUNS} restarts measured${runNotes.length ? "; " + runNotes.join("; ") : ""}`,
        measurements: m,
        evidence: ev.join("\n"),
      });

      // ---- c: second restart while the first is in flight ----
      if (runs.length > 0) {
        await waitReady(probes);
        const first = await mgmt(ctx, "POST", `/projects/${ref}/restart`);
        let seen = "ACTIVE_HEALTHY";
        const tw = Date.now();
        while (seen === "ACTIVE_HEALTHY" && Date.now() - tw < 60_000) {
          await sleep(3000);
          const s = await mgmtPatient(ctx, "GET", `/projects/${ref}`);
          seen = s.status === 200 ? String((s.json as { status?: string } | undefined)?.status ?? "?") : `HTTP ${s.status}`;
        }
        const second = await mgmt(ctx, "POST", `/projects/${ref}/restart`);
        results.push({
          id: "LO05c",
          title: "LO05c: restart sent while a restart is in flight",
          status: "info",
          detail: `first HTTP ${first.status}; status seen before second: ${seen}; second HTTP ${second.status}: ${second.text.slice(0, 200)}`,
          measurements: { first_http: first.status, status_before_second: seen, second_http: second.status },
        });
        await pollStatus(ctx, ref, "ACTIVE_HEALTHY", 420_000);
      }
    } catch (e) {
      results.push({
        id: "LO05x",
        title: "LO05: threw",
        status: "fail",
        detail: e instanceof Error ? e.message : String(e),
      });
    } finally {
      if (ref) {
        const http = await deleteOurs(ctx, ref).catch(() => -2);
        const gone = http >= 200 && http < 300 ? await waitGone(ctx, org, ref).catch(() => -1) : -1;
        results.push({
          id: "LO05d",
          title: "LO05d: teardown",
          status: http >= 200 && http < 300 && gone >= 0 ? "pass" : "fail",
          measurements: { delete_http: http, gone_from_org_listing_s: gone },
        });
      }
    }
    return results;
  },
};
export default mod;
