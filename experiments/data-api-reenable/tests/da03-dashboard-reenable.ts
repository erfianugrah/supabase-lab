/**
 * DA03 - re-enable the way the Dashboard does, on a project that exposes more
 * than `public`.
 *
 * Studio's DataApiEnableSwitch writes `getDefaultSchemas(config.db_schema)` on
 * enable, and with the API off `db_schema` is "", so it writes `public` alone
 * (apps/studio/components/interfaces/Settings/API/DataApiEnableSwitch.utils.ts,
 * read 2026-09-24). http-tier-lockdown run 2 saw that from the Dashboard on
 * 2026-08-07. This replays Studio's exact write through the API and records
 * what a client of an extra schema and of GraphQL sees afterwards - a failure
 * that does not heal on its own, which a caller can mistake for "still coming
 * back".
 *
 * DESTRUCTIVE: switches the Data API off. Restores the exact baseline config.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { fetchKeys } from "../../../harness/src/platform.js";
import {
  EXTRA_SCHEMA,
  TABLE,
  dataApiProbes,
  fmtTransitions,
  getPostgrest,
  setSchemas,
  snapshot,
  timeline,
  type PathProbe,
} from "../lib/reenable.js";

const mod: TestModule = {
  id: "DA03",
  title: "Dashboard-equivalent re-enable on a project exposing an extra schema",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const keys = await fetchKeys(ctx);
    const base = await getPostgrest(ctx);
    const anon = { apikey: keys.anon, Authorization: `Bearer ${keys.anon}` };
    const extra: PathProbe = {
      name: "extra_schema",
      intervalMs: 250,
      run: async () => {
        try {
          const r = await fetch(`https://${ctx.apiHost}/rest/v1/${TABLE}?select=id`, {
            headers: { ...anon, "Accept-Profile": EXTRA_SCHEMA },
            signal: AbortSignal.timeout(10_000),
          });
          const b = await r.text();
          let code = "";
          try {
            code = String(JSON.parse(b).code ?? "");
          } catch {
            /* non-JSON body */
          }
          return { ok: r.status === 200, state: r.status === 200 ? "200" : `${r.status} ${code}` };
        } catch (e) {
          return { ok: false, state: e instanceof Error ? e.name : "error" };
        }
      },
    };
    const probes = [
      ...dataApiProbes(ctx, keys).filter((p) => ["rest_table", "graphql"].includes(p.name)),
      extra,
    ];
    const withExtra = [
      ...base.db_schema.split(",").map((s) => s.trim()).filter(Boolean),
      EXTRA_SCHEMA,
    ].join(",");
    const out: TestResult[] = [];

    try {
      await setSchemas(ctx, base, withExtra);
      const t0 = Date.now();
      let pre: Record<string, string> = {};
      while (Date.now() - t0 < 60_000) {
        pre = await snapshot(probes);
        if (Object.values(pre).every((v) => v === "200")) break;
        await Bun.sleep(1000);
      }

      await setSchemas(ctx, base, "");
      const t1 = Date.now();
      while (Date.now() - t1 < 60_000 && (await snapshot(probes)).rest_table === "200") {
        await Bun.sleep(500);
      }

      // What Studio writes on enable when db_schema is "".
      const studioValue = ["public"].join(", ");
      const on = await timeline(
        probes,
        { maxWaitMs: 120_000, settleMs: 10_000, stopOn: ["rest_table"], log: ctx.log },
        async () => {
          await setSchemas(ctx, base, studioValue);
        },
      );
      // A full minute past rest_table, so "not back yet" and "never coming
      // back" are distinguishable.
      await Bun.sleep(60_000);
      const after = await snapshot(probes);
      const cfg = await getPostgrest(ctx);
      out.push({
        id: "DA03",
        title: this.title,
        status: "info",
        detail: `before off: ${JSON.stringify(pre)}; 60s after rest_table settled (enable + settle + 60s): ${JSON.stringify(after)}; db_schema now "${cfg.db_schema}"`,
        measurements: {
          db_schema_before: withExtra,
          db_schema_after: cfg.db_schema,
          ...Object.fromEntries(Object.entries(after).map(([k, v]) => [`after_${k}`, v])),
        },
        evidence: on.paths.map(fmtTransitions).join("\n"),
      });
    } finally {
      const back = await setSchemas(ctx, base, base.db_schema);
      out.push({
        id: "DA03z",
        title: "restore PostgREST config",
        status: back.status === 200 ? "pass" : "fail",
        detail: back.status === 200 ? "restored" : `restore HTTP ${back.status}`,
      });
    }
    return out;
  },
};
export default mod;
