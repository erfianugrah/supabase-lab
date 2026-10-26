/**
 * DC16 - Is Realtime's authorisation pool (`connection_pool`) set from the
 * size a project is created at, or does the Realtime concepts table not
 * describe it?
 *
 * DC13 (2026-10-26) created a project Small and resized it to XL and 2XL:
 * `connection_pool` read 5 and `realtime_connect` held 5 at every size. The
 * concepts page (https://supabase.com/docs/guides/realtime/concepts, table
 * of default pool sizes) gives an Authorization Pool Size of 2 for Nano and
 * Micro, 5 for Small to Large, 10 for XL to 4XL, 15 from 8XL, "If not
 * specified". Readings DC13 could not separate:
 *   H1  the value is written once at creation from the creation size and not
 *       re-derived on a resize: a project created at 2XL reads 10;
 *   H2  the table does not describe these projects: a project created at
 *       2XL reads 5 (or anything other than 10).
 * A Small project created in the same window is the control (table: 5).
 *
 * One project per process, at PVLAB_DC_SIZE (`desired_instance_size` of
 * POST /v1/projects: `2xlarge`, or `small` for the control):
 *   DC16a  as soon as the project answers: GET /config/realtime (before any
 *          Realtime client has connected), `max_connections`, node CPUs.
 *   DC16b  Data API pool with `db_pool` unset (lib/tier.ts readPool, one
 *          burst of PVLAB_DC16_K, default 150).
 *   DC16c  DC13's Realtime row (lib/rt-read.ts): config again, a 100-join
 *          Postgres Changes burst, Realtime's connections by name.
 *
 * Not settled by this module: sizes other than the two run; whether the
 * value changes later in a project's life (DC13's project read 5 throughout).
 *
 * DESTRUCTIVE: creates the shared project (lib/dc.ts); DC99 deletes it. Run
 * with DC99 in the same process so a 2XL project lives only for the reads.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import { ensureProject, errText, redact, skipWithoutPro, sql, START_SIZE } from "../lib/dc.js";
import { scrapeMetrics } from "../lib/metrics.js";
import { RT_FIELDS, RT_SQL, realtimeRow } from "../lib/rt-read.js";
import { poolColumns, poolLine, readPool } from "../lib/tier.js";

const K = Number(process.env.PVLAB_DC16_K || 150);

const mod: TestModule = {
  id: "DC16",
  title: "Realtime authorization pool and Data API pool on a project created at a given size",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const skip = skipWithoutPro(ctx, "DC16");
    if (skip) return skip;
    const out: TestResult[] = [];
    const put = (r: TestResult) => {
      out.push(r);
      ctx.log(`${r.id}: ${r.detail ?? ""}`.slice(0, 500));
    };
    try {
      const p = await ensureProject(ctx);
      const cfgR = await mgmt(ctx, "GET", `/projects/${p.ref}/config/realtime`);
      const cfg = (cfgR.json ?? {}) as Record<string, unknown>;
      const mc = await sql(ctx, p.ref, "select current_setting('max_connections')::int as m");
      const m = await scrapeMetrics(p);
      put({
        id: "DC16a-config",
        title: `Created ${START_SIZE}: GET /config/realtime before any Realtime client`,
        status: "info",
        detail:
          `config ${RT_FIELDS.map((f) => `${f}=${JSON.stringify(cfg[f] ?? null)}`).join(" ")}; max_connections ${mc.rows?.[0]?.m ?? -1}; ` +
          `node CPUs ${m.s?.cpus ?? -1}; ready ${Math.round(p.createMs / 1000)} s after the POST`,
        measurements: {
          created_size: START_SIZE,
          pg_version: p.pgVersion,
          config_http: cfgR.status,
          ...Object.fromEntries(RT_FIELDS.map((f) => [`config_${f}`, String(cfg[f] ?? "null")])),
          max_connections: Number(mc.rows?.[0]?.m ?? -1),
          node_cpus: m.s?.cpus ?? -1,
          ready_after_post_s: Math.round(p.createMs / 1000),
        },
      });
      try {
        const r = await readPool(ctx, p, K, 1, 60);
        put({ id: "DC16b-pool", title: `Created ${START_SIZE}: Data API pool with db_pool unset`, status: "info", detail: poolLine(r), measurements: { created_size: START_SIZE, ...poolColumns(r) } });
      } catch (e) {
        put({ id: "DC16b-pool", title: "pool", status: "fail", detail: redact(`threw: ${errText(e)}`) });
      }
      const setup = await sql(ctx, p.ref, RT_SQL);
      if (setup.error) throw new Error(`realtime setup: ${setup.error}`);
      put(await realtimeRow(ctx, p, "DC16c-realtime", `created ${START_SIZE}`));
    } catch (e) {
      put({ id: "DC16", title: this.title, status: "fail", detail: redact(`threw: ${errText(e)}`) });
    }
    return out;
  },
};
export default mod;
