/**
 * L01 - baseline HTTP-tier inventory.
 *
 * Seeds the shared fixture (probe table, auth user, public bucket, open edge
 * function) and records what every surface answers to three credential
 * classes: anonymous (no key), anon JWT, service_role JWT. Every later
 * module re-runs this inventory after its lever and the report diffs
 * surface-by-surface.
 *
 * Read-only in effect, but marked destructive so it sorts FIRST in a run:
 * test ids sort within the destructive tier and L02.. must not execute
 * against an unseeded project. Same ordering mechanism the AGENTS.md
 * negative-control rule prescribes.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import {
  fetchKeys,
  inventory,
  seedFixture,
  toMeasurements,
} from "../lib/inventory.js";

const mod: TestModule = {
  id: "L01",
  title: "baseline inventory: what each surface answers anon / anon-key / service-key",
  where: "local",
  requires: ["pat"],
  destructive: true, // seeds fixture; also forces first-in-tier ordering
  async run(ctx: Ctx): Promise<TestResult[]> {
    const keys = await fetchKeys(ctx);
    const { userEmail } = await seedFixture(ctx, keys);

    const rows: TestResult[] = [];
    for (const [label, key] of [
      ["none", ""],
      ["anon", keys.anonJwt],
      ["service", keys.serviceJwt],
    ] as const) {
      const inv = await inventory(ctx, key, label === "none" ? "" : userEmail);
      rows.push({
        id: "L01",
        title: `${mod.title} [${label}]`,
        status: "info",
        detail: inv.map((r) => `${r.surface}=${r.status}`).join(" "),
        measurements: toMeasurements(inv, label),
      });
    }

    // The baseline claims that later modules lean on. anon reads the probe
    // table (default privileges, no RLS) and logs in; nothing else here is
    // asserted - an inventory records, it does not judge.
    const anon = rows[1];
    const table = String(anon?.measurements?.rest_table_anon ?? "");
    const login = String(anon?.measurements?.auth_login_anon ?? "");
    rows.push({
      id: "L01b",
      title: "baseline gate: anon can read the probe table and log in",
      status: table.startsWith("200") && login.startsWith("200") ? "pass" : "fail",
      detail: `rest_table_anon="${table}" auth_login_anon="${login}" - a baseline that is already closed makes every later lever unmeasurable`,
    });
    return rows;
  },
};
export default mod;
