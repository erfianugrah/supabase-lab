/**
 * D09 - resize up/down durations + client-visible downtime, local vantage.
 *
 * One throwaway Pro project, Micro -> Small -> Large -> Small -> Micro, with
 * three paths sampled continuously for the whole run:
 *
 *   rest_read      anon row read (harness/src/real-probes.ts), every 250 ms
 *   auth_health    GET /auth/v1/health with the anon key, every 250 ms
 *   realtime_join  joined channel + Postgres Changes + own broadcast, every 1 s
 *
 * Rewritten 2026-10-23 (work-supabase-lab#175). The first version (2026-08-19,
 * re-run 2026-10-13) had three defects that shaped its published figures:
 *
 *  - Outage accounting: each phase had its own accumulator that closed an
 *    outage only on a later success in the same phase, so a run of failures
 *    still open at the phase end was dropped and the next phase opened it
 *    again as a shorter outage of its own. lib/outage.ts now keeps one
 *    timeline per path and attributes each outage, at full length, to the
 *    phase it started in (lib/outage.test.ts reproduces the 2026-10-13 case).
 *  - Refused resizes: a PATCH answered `429 We are still processing addon
 *    changes, please try again in N minute(s)` was still timed - the module
 *    waited 60 s for the project to leave ACTIVE_HEALTHY and recorded that
 *    wait as a resize. Now the PATCH is retried after the stated wait and a
 *    phase starts only when a PATCH is accepted; `<op>_addon_429_retries`
 *    counts the refusals.
 *  - The Auth sample sent no apikey; this version sends the anon key, and
 *    records once what the endpoint answers without one
 *    (`auth_health_noapikey_status`).
 *
 * A phase runs from its accepted PATCH to the next accepted PATCH (the last one
 * to the end of sampling). Before the next PATCH the module waits for
 * ACTIVE_HEALTHY and then for every path to stay up for SETTLE_MS, so an
 * outage normally closes inside its own phase; if it does not, the timeline
 * still attributes it to the phase it started in and the later phase reports
 * it as `carried_in_s`.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { mgmt } from "../../../harness/src/mgmt";
import { fetchKeys } from "../../../harness/src/platform";
import { realtimeJoinProbe, restReadProbe, seedProbeTable } from "../../../harness/src/real-probes";
import { withDeadline, type Probe, type ProbeOutcome } from "../../../harness/src/sampler";
import { OutageTimeline } from "../lib/outage";

const REGION = "ap-southeast-1";
const MAX_HEALTHY_MS = 15 * 60_000;
const LEAVE_HEALTHY_MS = 120_000;
const SETTLE_MS = 15_000;
const MAX_SETTLE_MS = 10 * 60_000;
const MAX_429_RETRIES = 8;
const POLL_MS = 3_000;
const BASELINE_MS = 10_000;

const sleep = (ms: number) => Bun.sleep(ms);

/** "please try again in 3 minute(s)" -> 3; anything else -> 1. */
function retryMinutes(body: string): number {
  const m = body.match(/try again in (\d+) minute/);
  const n = m ? Number(m[1]) : 1;
  return Math.min(Math.max(n, 1), 5);
}

function authHealthProbe(apiHost: string, anon: string): Probe {
  const url = `https://${apiHost}/auth/v1/health`;
  return {
    name: "auth_health",
    async run(): Promise<ProbeOutcome> {
      try {
        const r = await fetch(url, { headers: { apikey: anon }, signal: AbortSignal.timeout(5_000) });
        await r.text();
        return r.status === 200 ? { ok: true } : { ok: false, error: `HTTP ${r.status}` };
      } catch (e) {
        const n = e instanceof Error ? e.name : "";
        return { ok: false, error: n === "TimeoutError" ? "timeout" : (e instanceof Error ? e.message : String(e)).slice(0, 80) };
      }
    },
  };
}

interface Path {
  probe: Probe;
  intervalMs: number;
  tl: OutageTimeline;
  modes: string[];
}

async function statusOf(ctx: Ctx, ref: string): Promise<string> {
  const p = await mgmt(ctx, "GET", `/projects/${ref}`).catch(() => null);
  return ((p?.json as { status?: string } | undefined)?.status ?? "") as string;
}

async function computeVariant(ctx: Ctx, ref: string): Promise<string> {
  const r = await mgmt(ctx, "GET", `/projects/${ref}/billing/addons`).catch(() => null);
  if (!r || r.status !== 200) return `unread (HTTP ${r?.status ?? "error"})`;
  const sel = ((r.json ?? {}) as { selected_addons?: { type: string; variant?: { id?: string } }[] }).selected_addons ?? [];
  return sel.find((a) => a.type === "compute_instance")?.variant?.id ?? "none (micro)";
}

const OPS = [
  ["upgrade micro->small", "ci_small"],
  ["upgrade small->large", "ci_large"],
  ["downgrade large->small", "ci_small"],
  ["downgrade small->micro", "ci_micro"],
] as const;

interface OpRecord {
  op: string;
  patchStatus: number;
  retries: number;
  acceptedAt: number;
  leftHealthyS: number;
  healthyS: number;
  dataSettledS: number;
  variantAfter: string;
}

const mod: TestModule = {
  id: "D09",
  title: "resize/downgrade durations + client-visible downtime",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const org = ctx.orgs.pro ?? "";
    if (!org) return [{ id: "D09", title: this.title, status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    let ref = "";
    let stop = false;
    const loops: Promise<void>[] = [];
    try {
      const create = await mgmt(ctx, "POST", "/projects", {
        organization_slug: org,
        name: `d09-resize-${Date.now()}`,
        db_pass: `${crypto.randomUUID()}Aa1!`,
        region: REGION,
      });
      ref = ((create.json as { ref?: string } | undefined)?.ref ?? "") as string;
      if (create.status !== 201 || !ref) return [{ id: "D09", title: "D09", status: "fail", detail: `create: HTTP ${create.status}` }];
      ctx.log(`project created: ${ref}`);
      const deadline = Date.now() + 20 * 60_000;
      let status = "";
      while (Date.now() < deadline && status !== "ACTIVE_HEALTHY") {
        await sleep(10_000);
        status = await statusOf(ctx, ref);
      }
      if (status !== "ACTIVE_HEALTHY") throw new Error(`not healthy: ${status}`);

      const apiHost = `${ref}.supabase.co`;
      const pctx: Ctx = { ...ctx, ref, apiHost };
      let anon = "";
      for (let i = 0; i < 12 && !anon; i += 1) {
        anon = await fetchKeys(pctx).then((k) => k.anon).catch(() => "");
        if (!anon) await sleep(5_000);
      }
      if (!anon) throw new Error("no anon key");
      const seedS = await seedProbeTable(pctx, apiHost, anon, { maxMs: 300_000 });
      const noKey = await fetch(`https://${apiHost}/auth/v1/health`, { signal: AbortSignal.timeout(5_000) })
        .then((r) => r.status)
        .catch(() => -1);
      ctx.log(`probes ready after ${seedS}s; /auth/v1/health without apikey: HTTP ${noKey}`);

      const paths: Path[] = [
        { probe: restReadProbe(apiHost, anon), intervalMs: 250, tl: new OutageTimeline(), modes: [] },
        { probe: authHealthProbe(apiHost, anon), intervalMs: 250, tl: new OutageTimeline(), modes: [] },
        { probe: realtimeJoinProbe(apiHost, anon), intervalMs: 1_000, tl: new OutageTimeline(), modes: [] },
      ];
      const t0 = Date.now();
      for (const p of paths) p.tl.beginPhase("baseline", t0);
      for (const p of paths) {
        loops.push(
          (async () => {
            while (!stop) {
              const cut = Date.now();
              const o = await withDeadline(p.probe.run(), 30_000).catch((e) => ({ ok: false, error: String(e) }) as ProbeOutcome);
              p.tl.add(o.ok, cut);
              if (!o.ok) {
                const m = (o.error ?? "unknown").slice(0, 80);
                if (!p.modes.includes(m)) p.modes.push(m);
              }
              const spent = Date.now() - cut;
              if (spent < p.intervalMs) await sleep(p.intervalMs - spent);
            }
          })(),
        );
      }
      await sleep(BASELINE_MS);

      const settled = (sinceMs: number) =>
        paths.every((p) => {
          const lf = p.tl.lastFailMs();
          return Date.now() - Math.max(lf ?? 0, sinceMs) >= SETTLE_MS;
        });

      const ops: OpRecord[] = [];
      for (const [op, variant] of OPS) {
        let retries = 0;
        let sentAt = Date.now();
        let patch = await mgmt(ctx, "PATCH", `/projects/${ref}/billing/addons`, { addon_type: "compute_instance", addon_variant: variant });
        while (patch.status === 429 && retries < MAX_429_RETRIES) {
          retries += 1;
          const mins = retryMinutes(patch.text);
          ctx.log(`${op}: HTTP 429 (${patch.text.slice(0, 120)}), retry ${retries} in ${mins} min`);
          await sleep(mins * 60_000);
          sentAt = Date.now();
          patch = await mgmt(ctx, "PATCH", `/projects/${ref}/billing/addons`, { addon_type: "compute_instance", addon_variant: variant });
        }
        for (const p of paths) p.tl.beginPhase(op, sentAt);
        const rec: OpRecord = { op, patchStatus: patch.status, retries, acceptedAt: sentAt, leftHealthyS: -1, healthyS: -1, dataSettledS: -1, variantAfter: "" };
        ops.push(rec);
        if (patch.status >= 300) {
          ctx.log(`${op}: PATCH refused HTTP ${patch.status}: ${patch.text.slice(0, 200)}`);
          rec.variantAfter = await computeVariant(ctx, ref);
          continue;
        }
        // Leave ACTIVE_HEALTHY (or not), then come back.
        let st = await statusOf(ctx, ref);
        const leaveBy = Date.now() + LEAVE_HEALTHY_MS;
        while (Date.now() < leaveBy && (st === "" || st === "ACTIVE_HEALTHY")) {
          await sleep(POLL_MS);
          st = await statusOf(ctx, ref);
        }
        if (st !== "" && st !== "ACTIVE_HEALTHY") rec.leftHealthyS = Math.round((Date.now() - sentAt) / 1000);
        const healthyBy = Date.now() + MAX_HEALTHY_MS;
        while (Date.now() < healthyBy && st !== "ACTIVE_HEALTHY") {
          await sleep(POLL_MS);
          st = await statusOf(ctx, ref);
        }
        if (st === "ACTIVE_HEALTHY") rec.healthyS = Math.round((Date.now() - sentAt) / 1000);
        const settleBy = Date.now() + MAX_SETTLE_MS;
        while (Date.now() < settleBy && !settled(sentAt)) await sleep(1_000);
        if (settled(sentAt)) {
          // Every path up for SETTLE_MS: report the last failing sample on any path, from the PATCH (0 = none failed).
          const lastFail = Math.max(...paths.map((p) => p.tl.lastFailMs() ?? 0));
          rec.dataSettledS = lastFail > sentAt ? Math.round((lastFail - sentAt) / 1000) : 0;
        }
        rec.variantAfter = await computeVariant(ctx, ref);
        ctx.log(`${op}: accepted after ${retries} 429s; left healthy ${rec.leftHealthyS}s, healthy ${rec.healthyS}s, last failure on any path ${rec.dataSettledS}s, compute ${rec.variantAfter}`);
      }
      const endMs = Date.now();
      stop = true;
      await Promise.all(loops);

      const meas: Record<string, number | string> = {
        rest_read_interval_ms: 250,
        auth_health_interval_ms: 250,
        realtime_join_interval_ms: 1_000,
        settle_ms: SETTLE_MS,
        auth_health_noapikey_status: noKey,
        seed_s: seedS,
      };
      const lines: string[] = [];
      const stats = paths.map((p) => ({ name: p.probe.name, phases: p.tl.stats(endMs), modes: p.modes }));
      for (const s of stats) {
        const base = s.phases[0];
        meas[`baseline_${s.name}_failed_samples`] = `${base?.failures ?? 0}/${base?.samples ?? 0}`;
        meas[`${s.name}_modes`] = s.modes.slice(0, 6).join("; ") || "none";
      }
      let allOk = true;
      for (const [i, r] of ops.entries()) {
        const key = r.op.replace(/[^a-z0-9]+/g, "_").toLowerCase();
        meas[`${key}_patch_status`] = r.patchStatus;
        meas[`${key}_addon_429_retries`] = r.retries;
        meas[`${key}_left_healthy_s`] = r.leftHealthyS;
        meas[`${key}_s`] = r.healthyS;
        meas[`${key}_last_fail_any_path_s`] = r.dataSettledS;
        meas[`${key}_compute_after`] = r.variantAfter;
        const parts: string[] = [];
        for (const s of stats) {
          const ph = s.phases[i + 1];
          if (!ph) continue;
          meas[`${key}_${s.name}_max_outage_s`] = ph.maxOutageS;
          meas[`${key}_${s.name}_outage_open_at_end`] = ph.maxOutageOpen ? "yes" : "no";
          meas[`${key}_${s.name}_outages`] = ph.outages;
          meas[`${key}_${s.name}_total_outage_s`] = ph.totalOutageS;
          meas[`${key}_${s.name}_failed_samples`] = `${ph.failures}/${ph.samples}`;
          meas[`${key}_${s.name}_first_fail_s`] = ph.firstFailS ?? "n/a";
          meas[`${key}_${s.name}_recovered_s`] = ph.lastRecoveryS ?? "n/a";
          meas[`${key}_${s.name}_carried_in_s`] = ph.carriedInS;
          parts.push(`${s.name} ${ph.maxOutageS}s${ph.maxOutageOpen ? " (open)" : ""}`);
        }
        if (r.patchStatus >= 300 || r.healthyS < 0 || r.dataSettledS < 0) allOk = false;
        lines.push(`${r.op}: PATCH ${r.patchStatus} after ${r.retries} 429s, healthy ${r.healthyS}s, max outage ${parts.join(", ")}`);
      }
      return [
        {
          id: "D09",
          title: "D09: upgrade/downgrade durations + sampled downtime (data-path probes)",
          status: allOk ? "pass" : "fail",
          detail: lines.join(" | "),
          measurements: meas,
        },
      ];
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return [{ id: "D09", title: "D09", status: "fail", detail: `threw: ${msg}` }];
    } finally {
      stop = true;
      await Promise.all(loops).catch(() => null);
      if (ref) {
        const d = await mgmt(ctx, "DELETE", `/projects/${ref}`).catch(() => null);
        ctx.log(`delete project: HTTP ${d?.status ?? "error"}`);
      }
    }
  },
};
export default mod;
