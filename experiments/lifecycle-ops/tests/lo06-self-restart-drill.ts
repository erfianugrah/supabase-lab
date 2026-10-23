/**
 * LO06 - cluster B drill: the detect-then-self-restart runbook
 * (lib/runbook.ts, RUNBOOK-cluster-b.md) run end to end against one Micro
 * project with an induced fault.
 *
 * DESTRUCTIVE and self-provisioning: creates one `lo-` project in the Pro org
 * (PVLAB_ORG_PRO), restarts it at most twice, deletes it in `finally`.
 *
 * The fault: one session holds an ACCESS EXCLUSIVE lock on the probe table and
 * sleeps (lib/probes.ts holdLock). Reads of that table stop answering while
 * the server, its sockets and the control-plane status stay healthy, which is
 * the client-side shape of a cluster B incident; a restart clears it because
 * it ends the session. It is a stand-in: the real cluster B causes (a hang on
 * Nano compute, a stale JWT time cache in PostgREST) cannot be induced from a
 * client, and for a known lock pg_terminate_backend is the cheaper fix.
 *
 *   LO06a  gate (create), create, ACTIVE_HEALTHY, probe table, readiness.
 *   LO06b  baseline: the runbook watches the healthy project until the
 *          ten-minute post-create restart window has passed. Expect no
 *          detection; failed samples are the false-positive budget, n=1.
 *   LO06c  drill 1: induce, then the runbook detects, decides, restarts and
 *          verifies on the data path. Timings from the moment the lock is held.
 *   LO06d  drill 2: induce again at once. The cooldown must hold the restart
 *          until minIntervalMs after drill 1's POST, then restart and verify.
 *   LO06e  drill 3: induce a third time. Two restarts inside the window: the
 *          runbook must escalate without a POST. The lock is then released
 *          with pg_terminate_backend.
 *   LO06f  teardown.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { withDeadline, type Probe } from "../../../harness/src/sampler";
import { mgmt } from "../../../harness/src/mgmt";
import { sql } from "../../../harness/src/platform";
import { restReadProbe, seedProbeTable, PROBE_TABLE } from "../../../harness/src/real-probes";
import { poolerProbe } from "../../platform-downtime/lib/probes";
import { resolvePooler } from "../../platform-downtime/lib/setup";
import { directProbe, holdLock, LOCK_TAG } from "../lib/probes";
import { fetchStatus, gate } from "../lib/gate";
import { DEFAULT_RUNBOOK_POLICY, gateView, secs, supervise, type Episode, type RunbookIO } from "../lib/runbook";
import {
  createWithFallback,
  deleteOurs,
  fmtTransitions,
  mgmtPatient,
  nameFor,
  pollStatus,
  projectCtx,
  sleep,
  strongPassword,
  waitGone,
} from "../lib/project";
import { resolve6 } from "node:dns/promises";

const REGION = "ap-southeast-1";
const POLICY = DEFAULT_RUNBOOK_POLICY;
/** Watch past the post-create restart window by this margin before the first drill. */
const BASELINE_UNTIL_MS = 11 * 60_000;

async function waitReady(probes: Probe[], need = 3, maxMs = 300_000): Promise<{ s: number; bad: string[] }> {
  const t0 = Date.now();
  let streak = 0;
  let bad: string[] = ["not-run"];
  while (Date.now() - t0 < maxMs) {
    const outs = await Promise.all(probes.map((p) => withDeadline(p.run())));
    bad = probes.filter((_, i) => !outs[i]?.ok).map((p) => p.name);
    streak = bad.length === 0 ? streak + 1 : 0;
    if (streak >= need) return { s: Math.round((Date.now() - t0) / 1000), bad };
    await sleep(2000);
  }
  return { s: -1, bad };
}

function episodeMeasurements(ep: Episode, t0: number): Record<string, number | string> {
  const rel = (x: number | null) => secs(t0, x);
  return {
    outcome: ep.outcome,
    rounds: ep.rounds,
    first_fail_after_induce_s: rel(ep.firstFailAtMs),
    detected_after_induce_s: rel(ep.detectedAtMs),
    detect_after_first_fail_s: secs(ep.firstFailAtMs, ep.detectedAtMs),
    restart_post_after_detect_s: secs(ep.detectedAtMs, ep.postAtMs),
    restart_post_http: ep.postHttp ?? "none",
    status_healthy_again_after_post_s: secs(ep.postAtMs, ep.statusHealthyAgainAtMs),
    recovered_after_post_s: secs(ep.postAtMs, ep.recoveredAtMs),
    detect_to_recovered_s: secs(ep.detectedAtMs, ep.recoveredAtMs),
    induce_to_recovered_s: rel(ep.recoveredAtMs),
    decisions: ep.decisions.map((d) => d.action).join(">"),
    ...Object.fromEntries(Object.entries(ep.failedSamples).map(([k, v]) => [`${k}_failed_samples`, v])),
    ...Object.fromEntries(Object.entries(ep.modes).map(([k, v]) => [`${k}_modes`, v.join(" | ").slice(0, 160)])),
  };
}

function episodeEvidence(ep: Episode, t0: number): string {
  const r = (x: number) => `+${Math.round((x - t0) / 1000)}s`;
  return [
    ...ep.decisions.map((d) => `${r(d.atMs)} decide ${d.action}: ${d.reasons.join("; ")}`),
    ep.postAtMs !== null ? `${r(ep.postAtMs)} POST /restart HTTP ${ep.postHttp} ${ep.postBody}` : "no POST",
    `status after POST: ${ep.statusTransitions.map((s) => `${s.status}${r(s.atMs)}`).join(" > ") || "-"}`,
  ].join("\n");
}

const mod: TestModule = {
  id: "LO06",
  title: "Cluster B drill: detect-then-self-restart runbook on an induced lock",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const org = ctx.orgs.pro ?? "";
    if (!org) return [{ id: "LO06", title: mod.title, status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    const results: TestResult[] = [];
    let ref = "";
    try {
      // ---- a ----
      const g = await gate(REGION, "create");
      if (!g.proceed) {
        return [{ id: "LO06a", title: "LO06a: gate refused the create", status: "info", detail: g.blockers.join(" ; ") }];
      }
      const t0 = Date.now();
      const dbPass = strongPassword();
      const created = await createWithFallback(ctx, org, nameFor("lo06"), [REGION], dbPass);
      ref = created.ref ?? "";
      if (!ref) return [{ id: "LO06a", title: "LO06a: create", status: "fail", detail: JSON.stringify(created.attempts) }];
      ctx.log(`created ${ref}`);
      const healthy = await pollStatus(ctx, ref, "ACTIVE_HEALTHY", 900_000, t0);
      const healthyAt = Date.now();
      const pctx = await projectCtx(ctx, ref, dbPass);
      const pooler = pctx ? await resolvePooler(pctx) : null;
      if (!healthy.reached || !pctx || !pooler) {
        results.push({ id: "LO06a", title: "LO06a: create", status: "fail", detail: `healthy=${healthy.reached} keys=${!!pctx} pooler=${!!pooler}` });
        return results;
      }
      const seedS = await seedProbeTable(pctx, pctx.apiHost, pctx.anonKey as string);
      let probes: Probe[] = [
        restReadProbe(pctx.apiHost, pctx.anonKey as string),
        directProbe(pctx.phzHost, dbPass),
        poolerProbe(pooler.host, pooler.port, pooler.user, dbPass),
      ];
      let ready = await waitReady(probes);
      const dropped: string[] = [];
      if (ready.s < 0 && !ready.bad.includes("rest_read")) {
        // A context path the vantage cannot reach costs that column, not the run.
        dropped.push(...ready.bad);
        probes = probes.filter((p) => !ready.bad.includes(p.name));
        ready = await waitReady(probes);
      }
      const anonTimeout = await sql(
        pctx,
        "select coalesce((select array_to_string(s.setconfig, ',') from pg_db_role_setting s join pg_roles r on r.oid = s.setrole where r.rolname = 'anon' limit 1), 'none') as v",
      ).catch(() => null);
      results.push({
        id: "LO06a",
        title: "LO06a: gate, create, readiness",
        status: ready.s >= 0 ? "pass" : "fail",
        detail: `transitions ${fmtTransitions(healthy.transitions)}; probes ${probes.map((p) => p.name).join(",")}${dropped.length ? `; dropped (never answered): ${dropped.join(",")}` : ""}`,
        measurements: {
          region: REGION,
          size_requested: "micro",
          active_healthy_s: Math.round(healthy.ms / 1000),
          probe_table_ready_s: seedS,
          all_probes_ready_s: ready.s,
          anon_statement_timeout: String(anonTimeout?.rows?.[0]?.v ?? "unread"),
        },
      });
      if (ready.s < 0) return results;

      const restarts: number[] = [];
      const io: RunbookIO = {
        now: () => Date.now(),
        sleep: async (ms) => {
          await sleep(ms);
        },
        probes,
        runProbe: (p) => withDeadline(p.run()),
        controlStatus: async () => {
          const s = await mgmtPatient(ctx, "GET", `/projects/${ref}`);
          return s.status === 200 ? String((s.json as { status?: string } | undefined)?.status ?? "?") : `HTTP ${s.status}`;
        },
        gate: async () => {
          const snap = await fetchStatus();
          return snap.error ? { unreadable: snap.error } : gateView(REGION, snap.components, snap.incidents);
        },
        restart: async () => {
          const r = await mgmt(ctx, "POST", `/projects/${ref}/restart`).catch((e) => ({ status: 0, text: String(e) }) as { status: number; text: string });
          return { http: r.status, body: r.text };
        },
        log: (m) => ctx.log(m),
      };

      // ---- b: baseline on the healthy project ----
      const bStart = Date.now();
      const base = await supervise(io, {
        policy: POLICY,
        restartsAtMs: restarts,
        createdAtMs: healthyAt,
        maxWatchMs: Math.max(60_000, healthyAt + BASELINE_UNTIL_MS - Date.now()),
      });
      results.push({
        id: "LO06b",
        title: "LO06b: baseline, runbook watching a healthy project",
        status: base.outcome === "no-fault" && restarts.length === 0 ? "pass" : "fail",
        detail: `${base.outcome} over ${secs(bStart, Date.now())} s, ${base.rounds} rounds at ${POLICY.intervalMs} ms`,
        measurements: {
          ...episodeMeasurements(base, bStart),
          watched_s: secs(bStart, Date.now()),
          detect_after_ms: POLICY.detectAfterMs,
        },
        evidence: episodeEvidence(base, bStart),
      });
      if (base.outcome !== "no-fault") return results;

      // Lock holder over the direct path (IPv6 literal, as directProbe), else the pooler.
      let holderVia = "direct";
      const induce = async () => {
        try {
          const addr = (await resolve6(pctx.phzHost))[0] ?? pctx.phzHost;
          return await holdLock({ host: addr, servername: pctx.phzHost, port: 5432, user: "postgres", password: dbPass, table: `public.${PROBE_TABLE}` });
        } catch {
          holderVia = "pooler";
          return await holdLock({ host: pooler.host, port: pooler.port, user: pooler.user, password: dbPass, table: `public.${PROBE_TABLE}` });
        }
      };
      const holders = async () => {
        const r = await sql(pctx, `select count(*)::int as n from pg_stat_activity where query like '%${LOCK_TAG}%' and pid <> pg_backend_pid()`);
        return r.status < 300 ? Number(r.rows[0]?.n ?? -1) : -1;
      };

      const drill = async (id: string, title: string, expect: (ep: Episode) => boolean) => {
        const ready2 = await waitReady(probes);
        const h = await induce();
        const tInduce = Date.now();
        let endedAt = -1;
        let endedText = "";
        void h.ended.then((t) => {
          endedAt = Date.now();
          endedText = t;
        });
        const holdersAtStart = await holders();
        const ep = await supervise(io, { policy: POLICY, restartsAtMs: restarts, createdAtMs: healthyAt, maxWatchMs: 300_000, hardStopMs: 2_400_000 });
        await sleep(1000);
        const holdersAfter = await holders();
        const m: Record<string, number | string> = {
          ...episodeMeasurements(ep, tInduce),
          ready_before_induce_s: ready2.s,
          holder_via: holderVia,
          holder_sessions_at_induce: holdersAtStart,
          holder_sessions_after_episode: holdersAfter,
          holder_ended_after_post_s: ep.postAtMs !== null && endedAt > 0 ? secs(ep.postAtMs, endedAt) : -1,
          holder_end_text: endedText.slice(0, 120) || "still running",
          restarts_in_history: restarts.length,
        };
        results.push({
          id,
          title,
          status: expect(ep) ? "pass" : "fail",
          detail: `${ep.outcome}; ${ep.decisions.map((d) => `${d.action} (${d.reasons.slice(1).join("; ")})`).join(" > ")}`.slice(0, 600),
          measurements: m,
          evidence: episodeEvidence(ep, tInduce),
        });
        return { ep, h };
      };

      // ---- c: drill 1 ----
      const d1 = await drill("LO06c", "LO06c: drill 1, induced lock, runbook restarts and verifies", (ep) => ep.outcome === "recovered" && ep.postHttp === 200);
      await d1.h.release();
      if (d1.ep.outcome !== "recovered") return results;

      // ---- d: drill 2, cooldown ----
      const d2 = await drill("LO06d", "LO06d: drill 2 right after drill 1, cooldown holds then restarts", (ep) =>
        ep.outcome === "recovered" && ep.decisions[0]?.action === "hold" && ep.decisions.some((d) => d.action === "restart"),
      );
      await d2.h.release();
      if (d2.ep.outcome !== "recovered") return results;

      // ---- e: drill 3, window cap escalates ----
      const d3 = await drill("LO06e", "LO06e: drill 3, two restarts in the window, runbook escalates without a POST", (ep) =>
        ep.outcome === "escalated" && ep.postAtMs === null,
      );
      const term = await sql(pctx, `select count(pg_terminate_backend(pid))::int as n from pg_stat_activity where query like '%${LOCK_TAG}%' and pid <> pg_backend_pid()`);
      await d3.h.release();
      const after = await waitReady(probes, 3, 120_000);
      const last = results.at(-1);
      if (last?.measurements) {
        last.measurements.terminated_sessions = term.status < 300 ? Number(term.rows[0]?.n ?? -1) : `HTTP ${term.status}`;
        last.measurements.reads_back_after_terminate_s = after.s;
      }
    } catch (e) {
      results.push({ id: "LO06x", title: "LO06: threw", status: "fail", detail: e instanceof Error ? e.message : String(e) });
    } finally {
      if (ref) {
        const http = await deleteOurs(ctx, ref).catch(() => -2);
        const gone = http >= 200 && http < 300 ? await waitGone(ctx, org, ref).catch(() => -1) : -1;
        results.push({
          id: "LO06f",
          title: "LO06f: teardown",
          status: http >= 200 && http < 300 && gone >= 0 ? "pass" : "fail",
          measurements: { delete_http: http, gone_from_org_listing_s: gone },
        });
      }
    }
    return results;
  },
};
export default mod;
