/**
 * S01 - which Stripe OpenAPI spec did this install project its schema from?
 *
 * `stripe._migrations` carries a row shaped `openapi:stripe:<date>:<hash>`.
 * That date is the spec the Postgres schema was generated from, and it is the
 * top of the causal chain for every column-level surprise this experiment
 * measures: a projection older than a field relocation cannot have a column
 * for where the field went.
 *
 * Recorded as a measurement rather than asserted against an expected value.
 * The pin is a property of the integration on the day you install, not
 * something this repo gets to have an opinion about, and the useful signal is
 * whether it MOVES between runs - which `make diff` answers and a hardcoded
 * expectation would not.
 *
 * Read-only.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { q, scalar, stripeSchemaPresent } from "../lib/pg";

const mod: TestModule = {
  id: "E01",
  title: "Schema projection pin recorded by the install",
  where: "local",
  requires: ["pooler"],
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!(await stripeSchemaPresent(ctx))) {
      return [
        {
          id: "E01",
          title: mod.title,
          status: "skip",
          detail: "no stripe schema - integration not installed (run 'make gate')",
        },
      ];
    }

    const pin = await scalar(
      ctx,
      "select name from stripe._migrations where name like 'openapi:%' limit 1",
    );
    const tables = await scalar(
      ctx,
      "select count(*) from information_schema.tables where table_schema='stripe' and table_type='BASE TABLE'",
    );

    // The webhook's own version pin is the other half of the pair. Null means
    // it follows the Stripe account default, so the data side floats while the
    // schema side is frozen at `pin`.
    const wh = await q(
      ctx,
      "select coalesce(api_version::text,'null') from stripe._managed_webhooks",
    );
    const webhookVersion = wh.ok && wh.rows.length > 0 ? wh.rows[0][0] : "unknown";

    const specDate = pin?.split(":")[2] ?? "unknown";

    return [
      {
        id: "E01",
        title: mod.title,
        status: "info",
        detail:
          `schema projected from Stripe OpenAPI ${specDate}; ` +
          `webhook api_version=${webhookVersion}` +
          (webhookVersion === "null" ? " (follows account default)" : ""),
        measurements: {
          spec_pin: pin ?? "absent",
          spec_date: specDate,
          webhook_api_version: webhookVersion,
          stripe_tables: Number(tables ?? 0),
        },
      },
    ];
  },
};

export default mod;
