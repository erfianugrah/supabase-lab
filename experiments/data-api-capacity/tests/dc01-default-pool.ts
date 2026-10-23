/**
 * DC01 - How big is the Data API's (PostgREST's) connection pool when
 * `db_pool` is left unset, on Small and on Large, and when does a request that
 * cannot get a pooled connection give up with PGRST003 at the default config?
 *
 * Source claims: the Management API spec describes `db_pool` as "If `null`,
 * the value is automatically configured based on compute size" and
 * `db_pool_acquisition_timeout` as "If `null`, the value is automatically
 * configured to 10". PostgREST's docs: a request waits for a pooled
 * connection until db-pool-acquisition-timeout, then answers 504 PGRST003.
 *
 * One Pro-org project, ap-southeast-1, created Small (lib/dc.ts). Every
 * request uses the legacy service_role key and dc_sleep_xl, a plpgsql
 * function carrying `set statement_timeout = '180s'` so the 8 s login default
 * of `authenticator` does not end the sleep (DC03a).
 *
 *   DC01a  Small: GET /postgrest (db_pool, db_pool_acquisition_timeout),
 *          max_connections, then two bursts of 100 concurrent 12 s sleeps;
 *          mid-burst (6 s) count of `authenticator` backends in PgSleep = the
 *          pool. Request outcomes by status and code.
 *   DC01b  Small, default config: hold the whole pool for 100 s, then send two
 *          single dc_ping requests; time to the client's answer and the
 *          number of PostgREST access-log lines each request caused.
 *   DC01c  resize Small -> Large (compute add-on PATCH); seconds until
 *          max_connections reads 160, ACTIVE_HEALTHY and 5 good pings; then
 *          300 s of 1 s pings for a later disruption (run 2 met one).
 *   DC01d  Large: as DC01a with bursts of 140.
 *
 * Not settled by this module: Medium, XL and above (only two sizes are
 * read); whether the pool follows a formula or a table; other regions.
 *
 * DESTRUCTIVE: creates the shared project (lib/dc.ts) and leaves it on Large
 * for DC02 and DC03; DC99 deletes it.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import {
  authenticatorCounts,
  burst,
  burstColumns,
  ensureProject,
  errText,
  linesForUa,
  postgrestConfig,
  redact,
  resize,
  saturateAndProbe,
  skipWithoutPro,
  sleep,
  state,
  untilHealthy,
} from "../lib/dc.js";

const BURST_SLEEP_S = 12;
const MID_S = 6;

const mod: TestModule = {
  id: "DC01",
  title: "Default PostgREST pool per compute size, and the default time to PGRST003",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const skip = skipWithoutPro(ctx, "DC01");
    if (skip) return skip;
    const out: TestResult[] = [];
    try {
      const p = await ensureProject(ctx);
      ctx.log(`DC01: project ready in ${Math.round(p.createMs / 1000)} s (${p.pgVersion})`);

      const sizeRow = async (id: string, size: string, k: number): Promise<number> => {
        const cfg = await postgrestConfig(ctx, p.ref);
        const idle = await authenticatorCounts(ctx, p.ref);
        const b1 = await burst(ctx, p, k, BURST_SLEEP_S, MID_S);
        await sleep(15_000);
        const b2 = await burst(ctx, p, k, BURST_SLEEP_S, MID_S);
        const pools = [b1.mid?.sleeping ?? -1, b2.mid?.sleeping ?? -1];
        out.push({
          id,
          title: `${size}: pool with db_pool unset (mid-burst PgSleep count, two bursts of ${k})`,
          status: pools[0]! > 0 && pools[0] === pools[1] ? "info" : "fail",
          detail:
            `db_pool=${cfg.dbPool} acquisition_timeout=${cfg.acqTimeout}; max_connections ${idle?.maxConnections}; ` +
            `pool ${pools.join(" / ")}; outcomes ${b1.ok}+${b2.ok} of ${2 * k} answered 200, PGRST003 ${b1.pgrst003}+${b2.pgrst003}` +
            (b1.sampleOther ? `; other: ${redact(b1.sampleOther)}` : ""),
          measurements: {
            config_db_pool: cfg.dbPool,
            config_acquisition_timeout: cfg.acqTimeout,
            max_connections: idle?.maxConnections ?? -1,
            idle_authenticator_backends: idle?.total ?? -1,
            // Runs 1-4 printed these to the console only (RUNLOG); recorded from the next run on.
            pg_version: p.pgVersion,
            postgrest_application_name: idle?.appNames ?? "",
            pool_burst1: pools[0]!,
            pool_burst2: pools[1]!,
            ...burstColumns("burst1", b1),
            ...burstColumns("burst2", b2),
          },
          evidence: b1.sample003 ? redact(b1.sample003) : undefined,
        });
        return pools[0]!;
      };

      // DC01a
      const smallPool = await sizeRow("DC01a", "Small", 100);
      state.smallPool = smallPool;

      // DC01b: default config, a request that never gets a connection.
      if (smallPool > 0) {
        const s = await saturateAndProbe(ctx, p, smallPool, 100, 2, "dc01b");
        const lines: Awaited<ReturnType<typeof linesForUa>>[] = [];
        for (const pr of s.probes) lines.push(await linesForUa(ctx, p.ref, pr.ua));
        const meas: Record<string, number | string> = { pool_held: smallPool, sleeping_at_probe: s.sleepingAtProbe, holders_ok: s.holdersOk };
        s.probes.forEach((pr, i) => {
          meas[`probe${i + 1}_status`] = pr.status;
          meas[`probe${i + 1}_code`] = pr.code || "none";
          meas[`probe${i + 1}_ms`] = pr.ms;
          meas[`probe${i + 1}_postgrest_lines`] = lines[i]!.total;
          meas[`probe${i + 1}_postgrest_lines_by_status`] = lines[i]!.byStatus;
        });
        out.push({
          id: "DC01b",
          title: "Small, default config: pool held 100 s, single request's answer and PostgREST attempts",
          status: "info",
          detail: s.probes.map((pr, i) => `probe ${i + 1}: ${pr.status} ${pr.code || ""} after ${pr.ms} ms, ${lines[i]!.total} PostgREST log lines (${lines[i]!.byStatus})`).join("; "),
          measurements: meas,
          evidence: redact(s.probes[0]?.body ?? ""),
        });
      }

      // DC01c
      const rz = await resize(ctx, p, "ci_large", 160);
      const w = rz.watch;
      const healthyAfterWatchS = rz.settledS > 0 ? await untilHealthy(p, 10, 900) : -1;
      out.push({
        id: "DC01c",
        title: "Resize Small -> Large (compute add-on PATCH), then 300 s of 1 s Data API pings",
        status: rz.settledS > 0 ? "pass" : "fail",
        detail:
          rz.settledS > 0
            ? `PATCH ${rz.status}; settled after ${rz.settledS} s (max_connections ${rz.maxConn}); next 300 s: ${w?.failed}/${w?.samples} pings failed` +
              ` (first ${w?.firstFailS} s, last ${w?.lastFailS} s, longest run ${w?.maxContiguousS} s, ${w?.failStatuses})` +
              (w?.sampleFail ? ` [${redact(w.sampleFail)}]` : "") + `; 10 good pings ${healthyAfterWatchS} s after the watch`
            : `PATCH ${rz.status}: ${redact(rz.text)}`,
        measurements: {
          patch_status: rz.status,
          settled_s: rz.settledS,
          max_connections: rz.maxConn,
          watch_samples: w?.samples ?? -1,
          watch_failed: w?.failed ?? -1,
          watch_first_fail_s: w?.firstFailS ?? -1,
          watch_last_fail_s: w?.lastFailS ?? -1,
          watch_max_contiguous_fail_s: w?.maxContiguousS ?? -1,
          watch_fail_statuses: w?.failStatuses ?? "",
          watch_sample_fail: redact(w?.sampleFail ?? "").slice(0, 200),
          healthy_after_watch_s: healthyAfterWatchS,
        },
      });
      if (rz.settledS < 0 || healthyAfterWatchS < 0) return out;

      // DC01d
      try {
        state.largePool = await sizeRow("DC01d", "Large", 140);
      } catch (e) {
        out.push({ id: "DC01d", title: "Large: pool with db_pool unset", status: "fail", detail: `threw: ${redact(errText(e))}` });
      }
    } catch (e) {
      out.push({ id: "DC01", title: this.title, status: "fail", detail: `threw: ${redact(errText(e))}` });
    }
    return out;
  },
};
export default mod;
