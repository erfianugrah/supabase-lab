/**
 * DC13 - With nothing configured, what Data API (PostgREST) pool and what
 * Realtime database connections does a project get at each compute size, on
 * one project resized upward?
 *
 * Measured before (DC01, DC04, DC08): pool 30 on Small, 50 on Large, 70 on
 * 4XL with `db_pool` null; `max_connections` 90 / 160 / 480. Not measured:
 * XL and 2XL. Docs claims tested here: 2XL `max_connections` 380 and XL 240
 * (compute-and-disk page); the Realtime concepts page's table of a
 * subscription-management pool of 7 from XL to 4XL and an authorization pool
 * of 10 (doc-cited-not-tested before this module). Hypotheses: 2XL pool 70
 * with `db_pool` null; Realtime's subscription-manager connections at most 7
 * on 2XL with the Realtime settings as created.
 *
 * Per size (start size, then each of PVLAB_DC13_SIZES, default
 * ci_xlarge,ci_2xlarge):
 *   DC13<x>-pool      GET /postgrest; `pgrst_db_pool_max` scraped every 5 s
 *                     for 90 s (the payload is a stale snapshot, DC05); two
 *                     bursts of PVLAB_DC13_K (150) concurrent 12 s sleeps and
 *                     the mid-burst PgSleep count of `authenticator`;
 *                     `max_connections`; node CPU count from the metrics.
 *   DC13<x>-realtime  GET /config/realtime; one raw-protocol burst of 100
 *                     Postgres Changes joins (realtime-surface lib/burst.ts,
 *                     settings untouched), Realtime's connections by
 *                     usename/application_name sampled each second while it
 *                     settles, then client backends by role/application.
 *
 * Resizes go through the compute add-on PATCH and are waited out as DC08a
 * (any change of `max_connections`, ACTIVE_HEALTHY, 5 pings, 60 s watch).
 *
 * DESTRUCTIVE: creates the shared project (lib/dc.ts) and leaves it at the
 * last size for DC14 (and for RT05 through PVLAB_PEER_RT when PVLAB_DC_DBPASS
 * is set); DC99 deletes it.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { ensureProject, errText, redact, resize, skipWithoutPro, sql } from "../lib/dc.js";
import { RT_SQL, realtimeRow } from "../lib/rt-read.js";
import { poolColumns, poolLine, readPool } from "../lib/tier.js";

const SIZES = (process.env.PVLAB_DC13_SIZES || "ci_xlarge,ci_2xlarge").split(",").filter((x) => x && x !== "none");
const K = Number(process.env.PVLAB_DC13_K || 150);
const mod: TestModule = {
  id: "DC13",
  title: "Data API pool and Realtime connections with nothing configured, per compute size (Small, XL, 2XL)",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const skip = skipWithoutPro(ctx, "DC13");
    if (skip) return skip;
    const out: TestResult[] = [];
    const put = (r: TestResult) => {
      out.push(r);
      ctx.log(`${r.id}: ${r.detail ?? ""}`.slice(0, 500));
    };
    try {
      const p = await ensureProject(ctx);
      ctx.log(`DC13: project ready in ${Math.round(p.createMs / 1000)} s (${p.pgVersion})`);
      const setup = await sql(ctx, p.ref, RT_SQL);
      if (setup.error) throw new Error(`realtime setup: ${setup.error}`);

      const measure = async (tag: string, label: string) => {
        try {
          const r = await readPool(ctx, p, K);
          put({
            id: `DC13${tag}-pool`,
            title: `${label}: Data API pool with db_pool unset`,
            status: r.pools[0]! > 0 && r.pools[0] === r.pools[1] ? "info" : "fail",
            detail: poolLine(r),
            measurements: { size: label, pg_version: p.pgVersion, ...poolColumns(r) },
          });
        } catch (e) {
          put({ id: `DC13${tag}-pool`, title: `${label}: pool`, status: "fail", detail: redact(`threw: ${errText(e)}`) });
        }
        try {
          put(await realtimeRow(ctx, p, `DC13${tag}-realtime`, label));
        } catch (e) {
          put({ id: `DC13${tag}-realtime`, title: `${label}: realtime`, status: "fail", detail: redact(`threw: ${errText(e)}`) });
        }
      };

      await measure("a", process.env.PVLAB_DC_SIZE || "small");
      const tags = "bcdefg";
      for (const [i, size] of SIZES.entries()) {
        const before = await sql(ctx, p.ref, "select current_setting('max_connections')::int as m");
        const fromMax = Number(before.rows?.[0]?.m ?? -1);
        const rz = await resize(ctx, p, size, -1, 25 * 60_000, 60, fromMax);
        put({
          id: `DC13${tags[i]}-resize`,
          title: `Resize to ${size}`,
          status: rz.settledS >= 0 ? "info" : "fail",
          detail: `PATCH ${rz.status} after ${rz.retries429 ?? 0} x 429; settled ${rz.settledS} s; max_connections ${fromMax} -> ${rz.maxConn}; watch failures ${rz.watch?.failed ?? -1} of ${rz.watch?.samples ?? -1}; ${rz.text}`,
          measurements: { resize_status: rz.status, addon_429_retries: rz.retries429 ?? 0, settled_s: rz.settledS, max_connections_from: fromMax, max_connections: rz.maxConn, watch_failed: rz.watch?.failed ?? -1, watch_samples: rz.watch?.samples ?? -1 },
        });
        if (rz.settledS < 0) return out;
        await measure(tags[i]!, size);
      }
    } catch (e) {
      put({ id: "DC13", title: this.title, status: "fail", detail: redact(`threw: ${errText(e)}`) });
    }
    return out;
  },
};
export default mod;
