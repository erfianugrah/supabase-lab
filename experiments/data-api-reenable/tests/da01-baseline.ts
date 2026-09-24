/**
 * DA01 - seed the fixture and record what every readiness candidate says on a
 * healthy project. The destructive modules compare against this: a candidate
 * that is not green HERE cannot be a readiness signal, whatever it does later.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { fetchKeys } from "../../../harness/src/platform.js";
import { dataApiProbes, getPostgrest, seedFixture, snapshot } from "../lib/reenable.js";

const mod: TestModule = {
  id: "DA01",
  title: "Baseline: fixture seeded, readiness candidates on a healthy project",
  where: "local",
  requires: ["pat"],
  async run(ctx: Ctx): Promise<TestResult[]> {
    const seedErr = await seedFixture(ctx);
    if (seedErr) return [{ id: "DA01", title: this.title, status: "fail", detail: `seed: ${seedErr}` }];
    const keys = await fetchKeys(ctx);
    const probes = dataApiProbes(ctx, keys);
    const cfg = await getPostgrest(ctx);

    // The fixture needs a schema reload; poll the table rather than sleep.
    const t0 = Date.now();
    let snap: Record<string, string> = {};
    while (Date.now() - t0 < 60_000) {
      snap = await snapshot(probes);
      if (snap.rest_table === "200" && snap.rest_rpc === "200") break;
      await Bun.sleep(1000);
    }
    const green = snap.rest_table === "200" && snap.rest_rpc === "200";
    return [
      {
        id: "DA01",
        title: this.title,
        status: green ? "pass" : "fail",
        detail: Object.entries(snap).map(([k, v]) => `${k}=${v}`).join(" "),
        measurements: { db_schema: cfg.db_schema, ...Object.fromEntries(Object.entries(snap).map(([k, v]) => [`base_${k}`, v])) },
      },
    ];
  },
};
export default mod;
