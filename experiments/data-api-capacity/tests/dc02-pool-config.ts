/**
 * DC02 - What changing the PostgREST pool settings through the Management
 * API does: when the restart it causes lands, what that restart does to
 * requests, whether the new pool size is the one Postgres then sees, how the
 * acquisition timeout maps to the time a client waits before PGRST003, and
 * which values the API accepts.
 *
 * Runs on the DC01 project after DC01c (Large, max_connections 160). Holder
 * and burst requests use service_role and dc_sleep_xl (180 s function
 * timeout); pings use the anon key and dc_ping. After every accepted PATCH
 * the module waits for the "Starting PostgREST" log line whose event time
 * follows the PATCH and records the delay: the first full run (2026-10-22)
 * did not, and three of its rows met a restart that landed after their
 * sampling window.
 *
 *   DC02a  two PATCHes of db_pool (default pool + 20, then + 40): failed
 *          pings in 90 s sampled every 250 ms, restart delay, readback, and a
 *          burst of (new pool + 40) 12 s sleeps whose mid-burst PgSleep count
 *          is the pool Postgres sees.
 *   DC02b  db_pool_acquisition_timeout 2 and 4: hold the whole pool, send two
 *          single requests each; client time to PGRST003 and PostgREST
 *          access-log lines per request (User-Agent tagged).
 *   DC02c  bounds: db_pool 1001 and -1, acquisition timeout 61 (spec:
 *          0..1000 and 0..60). Control: a burst of 220 at the default pool.
 *          Then db_pool 1000 (above max_connections 160) and the same burst;
 *          then back to the default figure and acquisition timeout 10, and
 *          seconds until 5 consecutive good pings.
 *   DC02d  in-flight requests across a restart, twice: 20 requests sleeping
 *          60 s, then a PATCH of db_pool to its current value (no change);
 *          what the 20 get, failed pings over 120 s, restart delay.
 *   DC02e  "Starting PostgREST" lines since DC02 began vs accepted PATCHes.
 *
 * Not settled by this module: which component sends a request again after
 * a PGRST003 (6 access-log lines per lone request; not identified);
 * whether the attempt count differs by region, plan or size; db_pool 0 (not
 * sent: DC03 still needs the Data API afterwards).
 *
 * DESTRUCTIVE: mutates the PostgREST config of the shared project; DC99
 * deletes the project.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import {
  burst,
  burstColumns,
  ensureProject,
  errText,
  linesForUa,
  patchPostgrest,
  postgrestConfig,
  postgrestStarts,
  redact,
  rpc,
  sampleDuring,
  saturateAndProbe,
  skipWithoutPro,
  sleep,
  state,
  untilHealthy,
  waitRestart,
  fmtCounts,
  type DcProject,
} from "../lib/dc.js";

async function patchSampled(ctx: Ctx, p: DcProject, body: Record<string, unknown>, forS: number) {
  const t = Date.now();
  const { outage, opResult } = await sampleDuring(p, forS, 250, () => patchPostgrest(ctx, p.ref, body));
  const patch = opResult as { status: number; text: string };
  const rs = patch.status < 300 ? await waitRestart(ctx, p.ref, t) : { delayS: -1, waitedS: 0 };
  return { outage, patch, restartDelayS: rs.delayS, patchMs: t };
}

const mod: TestModule = {
  id: "DC02",
  title: "PostgREST pool settings through the Management API: restart, effect, timeout mapping, bounds",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const skip = skipWithoutPro(ctx, "DC02");
    if (skip) return skip;
    const out: TestResult[] = [];
    const since = Date.now() - 5_000;
    let patches = 0;
    try {
      const p = await ensureProject(ctx);
      let base = state.largePool;
      if (base <= 0) {
        const b = await burst(ctx, p, 140, 12, 6);
        base = b.mid?.sleeping ?? -1;
      }
      if (base <= 0) throw new Error("default pool unknown and not measurable");

      // DC02a
      const rows: Record<string, number | string> = { default_pool: base };
      const details: string[] = [];
      let i = 0;
      for (const target of [base + 20, base + 40]) {
        i++;
        const r = await patchSampled(ctx, p, { db_pool: target }, 90);
        patches++;
        await untilHealthy(p);
        const cfg = await postgrestConfig(ctx, p.ref);
        const b = await burst(ctx, p, target + 40, 12, 6);
        rows[`patch${i}_db_pool`] = target;
        rows[`patch${i}_status`] = r.patch.status;
        rows[`patch${i}_restart_delay_s`] = r.restartDelayS;
        rows[`patch${i}_readback_db_pool`] = cfg.dbPool;
        rows[`patch${i}_samples`] = r.outage.samples;
        rows[`patch${i}_failed_samples`] = r.outage.failed;
        rows[`patch${i}_max_contiguous_fail_s`] = r.outage.maxContiguousS;
        rows[`patch${i}_fail_statuses`] = r.outage.failStatuses;
        Object.assign(rows, burstColumns(`patch${i}_burst`, b));
        details.push(
          `db_pool ${target}: PATCH ${r.patch.status}, restart ${r.restartDelayS} s after, readback ${cfg.dbPool}, ` +
            `${r.outage.failed}/${r.outage.samples} pings failed in 90 s (${r.outage.failStatuses}), mid-burst pool ${b.mid?.sleeping}` +
            (r.outage.sampleFail ? ` [${redact(r.outage.sampleFail)}]` : ""),
        );
        await sleep(10_000);
      }
      const newPool = base + 40;
      out.push({
        id: "DC02a",
        title: "db_pool PATCH: restart delay, failed requests while it applies, and the pool Postgres then sees",
        status: rows.patch1_burst_mid_authenticator_sleeping === base + 20 && rows.patch2_burst_mid_authenticator_sleeping === base + 40 ? "pass" : "fail",
        detail: details.join("; "),
        measurements: rows,
      });

      // DC02b
      const meas: Record<string, number | string> = {};
      const bdet: string[] = [];
      for (const acq of [2, 4]) {
        const r = await patchSampled(ctx, p, { db_pool_acquisition_timeout: acq }, 30);
        patches++;
        await untilHealthy(p);
        meas[`acq${acq}_patch_status`] = r.patch.status;
        meas[`acq${acq}_restart_delay_s`] = r.restartDelayS;
        const s = await saturateAndProbe(ctx, p, newPool, 45, 2, `dc02b-acq${acq}`);
        meas[`acq${acq}_sleeping_at_probe`] = s.sleepingAtProbe;
        meas[`acq${acq}_holder_outcomes`] = s.holderOutcomes;
        for (const [j, pr] of s.probes.entries()) {
          const l = await linesForUa(ctx, p.ref, pr.ua);
          meas[`acq${acq}_probe${j + 1}_status`] = pr.status;
          meas[`acq${acq}_probe${j + 1}_code`] = pr.code || "none";
          meas[`acq${acq}_probe${j + 1}_ms`] = pr.ms;
          meas[`acq${acq}_probe${j + 1}_postgrest_lines`] = l.total;
          meas[`acq${acq}_probe${j + 1}_postgrest_lines_by_status`] = l.byStatus;
          bdet.push(`timeout ${acq} s probe ${j + 1}: ${pr.status} ${pr.code} after ${pr.ms} ms, ${l.total} PostgREST lines (${l.byStatus})`);
        }
        bdet.push(`timeout ${acq} s: restart ${r.restartDelayS} s after PATCH, ${s.sleepingAtProbe} holders sleeping at probe time`);
        await sleep(5_000);
      }
      out.push({
        id: "DC02b",
        title: "Acquisition timeout vs the client's wait for PGRST003, attempts per request",
        status: meas.acq2_sleeping_at_probe === newPool && meas.acq4_sleeping_at_probe === newPool ? "info" : "fail",
        detail: bdet.join("; "),
        measurements: meas,
      });

      // DC02c
      const bounds: Record<string, number | string> = {};
      const cdet: string[] = [];
      for (const [label, body] of [
        ["db_pool_1001", { db_pool: 1001 }],
        ["db_pool_neg1", { db_pool: -1 }],
        ["acq_61", { db_pool_acquisition_timeout: 61 }],
      ] as const) {
        const r = await patchPostgrest(ctx, p.ref, body);
        bounds[`${label}_status`] = r.status;
        bounds[`${label}_body`] = redact(r.text).slice(0, 160);
        cdet.push(`${label}: ${r.status}`);
        if (r.status < 300) {
          patches++;
          await waitRestart(ctx, p.ref, Date.now() - 2_000);
        }
      }
      const restoreBase = await patchSampled(ctx, p, { db_pool: base, db_pool_acquisition_timeout: 10 }, 30);
      patches++;
      await untilHealthy(p);
      const control = await burst(ctx, p, 220, 15, 7);
      Object.assign(bounds, burstColumns("control220", control));
      bounds.control220_restart_delay_s = restoreBase.restartDelayS;
      cdet.push(`control at db_pool ${base}: burst of 220 ${fmtCounts(control.byStatus)}, mid-burst ${control.mid?.sleeping} sleeping`);
      await sleep(10_000);
      const big = await patchSampled(ctx, p, { db_pool: 1000 }, 60);
      patches++;
      const healthyAfterBigS = await untilHealthy(p);
      const cfgBig = await postgrestConfig(ctx, p.ref);
      const b220 = await burst(ctx, p, 220, 15, 7);
      const after = await untilHealthy(p, 5, 300);
      bounds.db_pool_1000_status = big.patch.status;
      bounds.db_pool_1000_readback = cfgBig.dbPool;
      bounds.db_pool_1000_restart_delay_s = big.restartDelayS;
      bounds.db_pool_1000_failed_samples = big.outage.failed;
      bounds.db_pool_1000_healthy_before_burst_s = healthyAfterBigS;
      Object.assign(bounds, burstColumns("over220", b220));
      bounds.over220_mid_max_connections = b220.mid?.maxConnections ?? -1;
      bounds.over220_sample_other = redact(b220.sampleOther).slice(0, 200);
      bounds.over220_healthy_after_s = after;
      cdet.push(
        `db_pool 1000: PATCH ${big.patch.status}, restart ${big.restartDelayS} s after, readback ${cfgBig.dbPool}; burst of 220: ` +
          `mid-burst ${b220.mid?.sleeping} sleeping, ${b220.mid?.clients} client backends of max_connections ${b220.mid?.maxConnections}; ` +
          `outcomes ${fmtCounts(b220.byStatus)} codes ${fmtCounts(b220.byCode) || "none"}` +
          (b220.sampleOther ? ` [${redact(b220.sampleOther).slice(0, 160)}]` : "") +
          `; 5 good pings ${after} s after the burst`,
      );
      const restore = await patchSampled(ctx, p, { db_pool: base, db_pool_acquisition_timeout: 10 }, 30);
      patches++;
      bounds.restore_status = restore.patch.status;
      bounds.restore_restart_delay_s = restore.restartDelayS;
      bounds.restore_healthy_s = await untilHealthy(p);
      out.push({
        id: "DC02c",
        title: "Accepted ranges; db_pool above max_connections under 220 concurrent requests, against a control at the default pool",
        status: "info",
        detail: cdet.join("; "),
        measurements: bounds,
      });

      // DC02d
      const d: Record<string, number | string> = {};
      const ddet: string[] = [];
      for (const n of [1, 2]) {
        const holders = Array.from({ length: 20 }, () => rpc(p.host, "dc_sleep_xl", { s: 60 }, p.keys.service, p.keys.service, 150_000));
        await sleep(5_000);
        const r = await patchSampled(ctx, p, { db_pool: base }, 120);
        patches++;
        const hs = await Promise.all(holders);
        const hb: Record<string, number> = {};
        for (const h of hs) hb[`${h.status}${h.code ? `/${h.code}` : ""}`] = (hb[`${h.status}${h.code ? `/${h.code}` : ""}`] ?? 0) + 1;
        const sampleBad = hs.find((h) => h.status !== 200);
        d[`run${n}_patch_status`] = r.patch.status;
        d[`run${n}_restart_delay_s`] = r.restartDelayS;
        d[`run${n}_holders_200`] = hs.filter((h) => h.status === 200).length;
        d[`run${n}_holder_outcomes`] = fmtCounts(hb);
        d[`run${n}_holder_sample_fail`] = sampleBad ? redact(`${sampleBad.status} ${sampleBad.body || sampleBad.message}`).slice(0, 160) : "none";
        d[`run${n}_failed_pings`] = r.outage.failed;
        d[`run${n}_pings`] = r.outage.samples;
        d[`run${n}_ping_first_fail_s`] = r.outage.firstFailS;
        d[`run${n}_ping_max_contiguous_fail_s`] = r.outage.maxContiguousS;
        d[`run${n}_ping_fail_statuses`] = r.outage.failStatuses;
        ddet.push(
          `run ${n}: restart ${r.restartDelayS} s after the PATCH; 20 in-flight 60 s requests ${fmtCounts(hb)}; ` +
            `${r.outage.failed}/${r.outage.samples} pings failed in 120 s (${r.outage.failStatuses})`,
        );
        await untilHealthy(p);
        await sleep(10_000);
      }
      out.push({
        id: "DC02d",
        title: "In-flight requests across the restart a no-change db_pool PATCH causes",
        status: "info",
        detail: ddet.join("; "),
        measurements: d,
      });

      // DC02e
      await sleep(30_000);
      const starts = await postgrestStarts(ctx, p.ref, since);
      out.push({
        id: "DC02e",
        title: "PostgREST restarts logged vs accepted PATCHes",
        status: "info",
        detail: `${starts.count} "Starting PostgREST" lines for ${patches} accepted PATCHes${starts.error ? ` (logs error: ${starts.error})` : ""}`,
        measurements: { accepted_patches: patches, postgrest_start_lines: starts.count },
        evidence: starts.times,
      });
    } catch (e) {
      out.push({ id: "DC02", title: this.title, status: "fail", detail: `threw: ${redact(errText(e))}` });
    }
    return out;
  },
};
export default mod;
