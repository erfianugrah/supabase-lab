/**
 * S03 - for a column that stopped being populated, where did the value go?
 *
 * S02 says `subscriptions.current_period_end` is never populated and
 * `subscription_items.current_period_end` is returned with no column to land
 * in. Those are two rows in two different lists, and a human has to notice the
 * name matches. This does that join: for every typed column that no payload
 * fills, look for the same key in some OTHER table's payloads.
 *
 * A hit is the actionable form of the finding - not "this column is broken"
 * but "this column is broken AND the value is over there, reachable as
 * `<other>._raw_data ->> '<field>'`". That is the difference between a bug
 * report and a workaround, and it is the sentence a deck slide or a support
 * answer actually needs.
 *
 * A name match is a STRONG HINT, not proof of a relocation. Stripe reuses
 * field names across unrelated objects - `created`, `currency`, `metadata`,
 * `object` and `livemode` appear nearly everywhere - so those are excluded as
 * noise rather than reported as thirty spurious relocations. What remains
 * still needs a human to confirm against Stripe's changelog; the value of this
 * test is narrowing "eighty fields moved somewhere" down to a handful worth
 * reading about.
 *
 * Read-only.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { q, stripeSchemaPresent } from "../lib/pg";

/**
 * Field names common enough that a cross-table match carries no information.
 * Not a correctness list - purely a signal-to-noise filter, and deliberately
 * short: over-filtering here hides real relocations.
 */
const UBIQUITOUS = new Set([
  "id", "object", "created", "updated", "livemode", "metadata",
  "currency", "description", "status", "customer", "deleted",
]);

const mod: TestModule = {
  id: "E03",
  title: "Candidate field relocations across tables",
  where: "local",
  requires: ["pooler"],
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!(await stripeSchemaPresent(ctx))) {
      return [
        {
          id: "E03",
          title: mod.title,
          status: "skip",
          detail: "no stripe schema - integration not installed (run 'make gate')",
        },
      ];
    }

    const colsRes = await q(
      ctx,
      `select table_name, column_name from information_schema.columns
        where table_schema='stripe' and column_name not like '\\_%'
          and table_name not like '\\_%'`,
    );
    const tablesRes = await q(
      ctx,
      `select table_name from information_schema.columns
        where table_schema='stripe' and column_name='_raw_data'
          and table_name not like '\\_%'`,
    );
    const tables = tablesRes.rows.map((r) => r[0]).filter(Boolean);

    const countSql = tables
      .map((t) => `select '${t}' as t, count(*) as n from stripe."${t}"`)
      .join(" union all ");
    const countRes = await q(ctx, countSql);
    const populated = countRes.rows.filter(([, n]) => Number(n) > 0).map(([t]) => t).filter((t): t is string => Boolean(t));
    if (populated.length === 0) {
      return [
        { id: "E03", title: mod.title, status: "skip", detail: "no populated stripe tables yet" },
      ];
    }

    const keySql = populated
      .map((t) => `select distinct '${t}' as t, k from stripe."${t}", lateral jsonb_object_keys(_raw_data) k`)
      .join(" union all ");
    const keyRes = await q(ctx, keySql);
    if (!keyRes.ok) {
      return [{ id: "E03", title: mod.title, status: "fail", detail: "payload key scan failed", evidence: keyRes.raw }];
    }

    const typed = new Map<string, Set<string>>();
    for (const [t = "", c = ""] of colsRes.rows) {
      if (!typed.has(t)) typed.set(t, new Set());
      typed.get(t)!.add(c);
    }
    const returned = new Map<string, Set<string>>();
    for (const [t = "", k = ""] of keyRes.rows) {
      if (!returned.has(t)) returned.set(t, new Set());
      returned.get(t)!.add(k);
    }

    // field -> tables whose payloads carry it
    const carriers = new Map<string, string[]>();
    for (const [t, keys] of returned) {
      for (const k of keys) {
        if (!carriers.has(k)) carriers.set(k, []);
        carriers.get(k)!.push(t);
      }
    }

    const hits: string[] = [];
    for (const t of populated) {
      const tset = typed.get(t) ?? new Set<string>();
      const rset = returned.get(t) ?? new Set<string>();
      for (const col of [...tset].sort()) {
        if (rset.has(col)) continue; // populated here, nothing to chase
        if (UBIQUITOUS.has(col)) continue;
        const elsewhere = (carriers.get(col) ?? []).filter((o) => o !== t);
        if (elsewhere.length === 0) continue;
        hits.push(
          `stripe.${t}.${col} is never populated; '${col}' appears in ` +
            elsewhere.map((o) => `${o}._raw_data`).join(", "),
        );
      }
    }

    return [
      {
        id: "E03",
        title: mod.title,
        status: "info",
        detail:
          hits.length === 0
            ? "no cross-table name matches for unpopulated columns"
            : `${hits.length} unpopulated columns whose field name appears in another table's payload - confirm each against Stripe's changelog before calling it a relocation`,
        measurements: { candidate_relocations: hits.length },
        evidence: hits.join("\n"),
      },
    ];
  },
};

export default mod;
