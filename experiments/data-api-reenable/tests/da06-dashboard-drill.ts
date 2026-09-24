/**
 * DA06 - MANUAL DRILL: time the Dashboard toggle itself.
 *
 * Studio's switch calls `PATCH /platform/projects/{ref}/config/postgrest`
 * (project-postgrest-config-update-mutation.ts, read 2026-09-24), a route PATs
 * cannot reach, with the same body DA02 sends to `/v1/projects/{ref}/postgrest`.
 * Same payload, different route, so "the toggle recovers like the API" is an
 * inference until this runs. It drives nothing: it samples every path for
 * PVLAB_DA_DRILL_S seconds (default 600) while an operator flips the toggle
 * off, waits, and flips it on. The click reference is the first 1 s poll at
 * which `GET /v1/projects/{ref}/postgrest` shows `db_schema` changed - the
 * config write, not the observer's start (http-tier-lockdown run 2 lesson).
 *
 * Opt-in: skips unless PVLAB_DA_DRILL=1, so a battery run never sits waiting
 * for a human. Afterwards `db_schema` will read `public` alone - that is the
 * DA03 finding; the module restores the baseline it read at start.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { fetchKeys } from "../../../harness/src/platform.js";
import { dataApiProbes, fmtTransitions, getPostgrest, setSchemas, timeline } from "../lib/reenable.js";

const mod: TestModule = {
  id: "DA06",
  title: "Manual drill: Dashboard toggle off/on, timed from the config write",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (process.env.PVLAB_DA_DRILL !== "1") {
      return [{ id: "DA06", title: this.title, status: "skip", detail: "set PVLAB_DA_DRILL=1 and flip the Dashboard toggle during the run" }];
    }
    const seconds = Number(process.env.PVLAB_DA_DRILL_S ?? 600);
    const keys = await fetchKeys(ctx);
    const base = await getPostgrest(ctx);
    const writes: [number, string][] = [];
    let last = base.db_schema;
    const configProbe = {
      name: "config_db_schema",
      intervalMs: 1000,
      run: async () => {
        const c = await getPostgrest(ctx).catch(() => null);
        if (!c) return { ok: false, state: "read-failed" };
        return { ok: c.db_schema !== "", state: `"${c.db_schema}"` };
      },
    };
    ctx.log(`DA06: flip the Data API toggle OFF, wait, then ON, within ${seconds}s`);
    const tl = await timeline(
      [...dataApiProbes(ctx, keys), configProbe],
      { maxWaitMs: seconds * 1000, settleMs: 0, stopOn: [], log: ctx.log },
      async () => undefined,
    );
    const cfg = tl.paths.find((p) => p.name === "config_db_schema");
    for (const [t, s] of cfg?.transitions ?? []) {
      if (s !== `"${last}"`) writes.push([t, s]);
      last = s.replace(/"/g, "");
    }
    const rest = tl.paths.find((p) => p.name === "rest_table");
    const enableAt = writes.find(([, s]) => s !== '""')?.[0];
    const restOkAfter = enableAt !== undefined
      ? rest?.transitions.find(([t, s]) => t >= enableAt - 1000 && s === "200")?.[0]
      : undefined;

    const back = await setSchemas(ctx, base, base.db_schema).catch((e) => ({ status: String(e) }));
    return [
      {
        id: "DA06",
        title: this.title,
        status: writes.length >= 2 ? "info" : "fail",
        detail:
          writes.length >= 2
            ? `config writes ${writes.map(([t, s]) => `${t}ms=${s}`).join(", ")}; rest_table 200 at ${restOkAfter ?? "never"} ms (config write seen at ${enableAt} ms, 1 s poll)`
            : "saw fewer than two config writes - was the toggle flipped?",
        measurements: {
          enable_write_ms: enableAt ?? "none",
          rest_table_ok_ms: restOkAfter ?? "never",
          restore: String(back.status),
        },
        evidence: tl.paths.map(fmtTransitions).join("\n"),
      },
    ];
  },
};
export default mod;
