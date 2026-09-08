/**
 * A00 - control: the project this run measured, and that it was ready.
 *
 * Everything else in this experiment asserts a PLATFORM DEFAULT, which only
 * holds if the project is fresh and healthy when the first probe lands. This
 * module records the version and the readiness path so a later reader can tell
 * a platform default from a project that drifted.
 *
 *   A00  per-service health (auth, rest, db), Postgres version, project age
 *
 * A red A00 invalidates the run rather than producing a finding.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import { fetchKeys } from "../../../harness/src/platform.js";
import { sqlRows, waitHealthy } from "../lib/audit.js";

const mod: TestModule = {
  id: "A00",
  title: "control: fresh project healthy, keys present, version recorded",
  where: "local",
  requires: ["pat"],
  async run(ctx: Ctx): Promise<TestResult> {
    const health = await waitHealthy(ctx);
    const keys = await fetchKeys(ctx).then(
      (k) => ({ ok: Boolean(k.anon && k.service), gens: [k.anon ? "anon" : "", k.service ? "service_role" : "", k.publishable ? "publishable" : "", k.secret ? "secret" : ""].filter(Boolean) }),
      (e) => ({ ok: false, gens: [String(e).slice(0, 80)] }),
    );
    const proj = await mgmt(ctx, "GET", `/projects/${ctx.ref}`);
    const created = String((proj.json as { created_at?: string })?.created_at ?? "");
    const ageMin = created ? Math.round((Date.now() - new Date(created).getTime()) / 60_000) : -1;
    const ver = await sqlRows(ctx, "select version() as v, current_setting('server_version') as sv");
    return {
      id: "A00",
      title: "control: fresh project healthy, keys present, version recorded",
      status: health.ok && keys.ok ? "pass" : "fail",
      detail: `health: ${health.last} after ${health.elapsedS}s. Keys: ${keys.gens.join(", ")}. Postgres ${String((ver[0] as { sv?: string })?.sv ?? "?")}, project ${ageMin} min old at first probe.`,
      measurements: {
        healthy: String(health.ok),
        health_wait_s: health.elapsedS,
        pg_version: String((ver[0] as { sv?: string })?.sv ?? "?"),
        project_age_min: ageMin,
        key_generations: keys.gens.length,
      },
    };
  },
};
export default mod;
