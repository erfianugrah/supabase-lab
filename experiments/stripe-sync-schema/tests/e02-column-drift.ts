/**
 * S02 - where the projected schema and the returned payload disagree.
 *
 * The integration stores every object twice: once shredded into typed columns,
 * and once whole in `_raw_data`. That redundancy is what makes the drift
 * measurable without a spec: compare the typed columns of each table against
 * the keys actually present in its payloads, and the disagreements fall into
 * two buckets.
 *
 *   typed_never_seen  - a typed column whose key appears in no sampled payload.
 *                       Reads NULL forever on this account, at this API
 *                       version. `subscriptions.current_period_end` is the
 *                       one that started this experiment.
 *   returned_untyped  - a key the API returns that has no typed column. The
 *                       data is present but only reachable through
 *                       `_raw_data ->> '...'`, so ordinary SQL misses it.
 *                       `subscription_items.current_period_end` is where that
 *                       first field went.
 *
 * WHAT THIS DOES NOT PROVE. Both buckets are inferred from sampled rows, so
 * "absent" conflates three different things:
 *
 *   1. genuine version drift - the field really did move or get removed
 *   2. an expandable field that only materialises when the request expands it
 *   3. a field legitimately null for the objects that happen to exist here
 *
 * Only (1) is a finding. Separating them is why the experiment seeds a fixture
 * matrix instead of reading whatever a demo account happens to contain, and
 * why tables below MIN_ROWS are reported as `unconfirmed` rather than folded
 * into the count. A single-row table cannot distinguish any of the three.
 *
 * The stronger instrument is a diff of two runs across a deliberate change to
 * the account's API version: a column that moves buckets between runs is drift
 * by construction, with no inference required. That is what `make diff` is for
 * and it is the reason nothing here asserts an expected value.
 *
 * Read-only.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { q, stripeSchemaPresent } from "../lib/pg";

/** Below this many rows, absence is not evidence. */
const MIN_ROWS = 5;

interface TableReport {
  table: string;
  rows: number;
  neverSeen: string[];
  untyped: string[];
  confirmed: boolean;
}

const mod: TestModule = {
  id: "E02",
  title: "Typed columns vs returned payload keys",
  where: "local",
  requires: ["pooler"],
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!(await stripeSchemaPresent(ctx))) {
      return [
        {
          id: "E02",
          title: mod.title,
          status: "skip",
          detail: "no stripe schema - integration not installed (run 'make gate')",
        },
      ];
    }

    // Object tables only: the `_`-prefixed ones are the integration's own
    // bookkeeping and have no Stripe payload to compare against.
    const tablesRes = await q(
      ctx,
      `select table_name from information_schema.columns
        where table_schema='stripe' and column_name='_raw_data'
          and table_name not like '\\_%'
        order by table_name`,
    );
    if (!tablesRes.ok) {
      return [
        { id: "E02", title: mod.title, status: "fail", detail: "table enumeration failed", evidence: tablesRes.raw },
      ];
    }
    const tables = tablesRes.rows.map((r) => r[0]).filter(Boolean);
    if (tables.length === 0) {
      return [{ id: "E02", title: mod.title, status: "fail", detail: "no stripe object tables found" }];
    }

    // Typed columns for every table in one round trip.
    const colsRes = await q(
      ctx,
      `select table_name, column_name from information_schema.columns
        where table_schema='stripe' and column_name not like '\\_%'
        order by table_name, column_name`,
    );
    const typed = new Map<string, Set<string>>();
    for (const [t, c] of colsRes.rows) {
      if (!typed.has(t)) typed.set(t, new Set());
      typed.get(t)!.add(c);
    }

    // Row counts, so absence can be weighted by sample size.
    const countSql = tables
      .map((t) => `select '${t}' as t, count(*) as n from stripe."${t}"`)
      .join(" union all ");
    const countRes = await q(ctx, countSql);
    const counts = new Map<string, number>();
    for (const [t, n] of countRes.rows) counts.set(t, Number(n));

    // Payload keys for every table in one round trip. Table names come from
    // information_schema, not from user input, but they are quoted anyway.
    const keySql = tables
      .filter((t) => (counts.get(t) ?? 0) > 0)
      .map(
        (t) =>
          `select distinct '${t}' as t, k from stripe."${t}", lateral jsonb_object_keys(_raw_data) k`,
      )
      .join(" union all ");
    if (!keySql) {
      return [
        {
          id: "E02",
          title: mod.title,
          status: "skip",
          detail: "stripe schema present but every object table is empty - backfill may still be running",
        },
      ];
    }
    const keyRes = await q(ctx, keySql);
    if (!keyRes.ok) {
      return [{ id: "E02", title: mod.title, status: "fail", detail: "payload key scan failed", evidence: keyRes.raw }];
    }
    const returned = new Map<string, Set<string>>();
    for (const [t, k] of keyRes.rows) {
      if (!returned.has(t)) returned.set(t, new Set());
      returned.get(t)!.add(k);
    }

    const reports: TableReport[] = [];
    for (const t of tables) {
      const rows = counts.get(t) ?? 0;
      if (rows === 0) continue;
      const tset = typed.get(t) ?? new Set<string>();
      const rset = returned.get(t) ?? new Set<string>();
      reports.push({
        table: t,
        rows,
        neverSeen: [...tset].filter((c) => !rset.has(c)).sort(),
        untyped: [...rset].filter((k) => !tset.has(k)).sort(),
        confirmed: rows >= MIN_ROWS,
      });
    }

    const confirmed = reports.filter((r) => r.confirmed);
    const neverSeen = confirmed.reduce((a, r) => a + r.neverSeen.length, 0);
    const untyped = confirmed.reduce((a, r) => a + r.untyped.length, 0);
    const unconfirmedTables = reports.length - confirmed.length;

    const evidence = reports
      .map((r) => {
        const head = `${r.table}  (${r.rows} rows${r.confirmed ? "" : ", UNCONFIRMED - below " + MIN_ROWS})`;
        const a = r.neverSeen.length ? `\n  typed_never_seen: ${r.neverSeen.join(" ")}` : "";
        const b = r.untyped.length ? `\n  returned_untyped: ${r.untyped.join(" ")}` : "";
        return head + a + b;
      })
      .join("\n");

    return [
      {
        id: "E02",
        title: mod.title,
        status: "info",
        detail:
          `${neverSeen} typed columns never populated, ${untyped} returned fields with no column, ` +
          `across ${confirmed.length} tables with >=${MIN_ROWS} rows` +
          (unconfirmedTables ? ` (${unconfirmedTables} tables too small to judge)` : ""),
        measurements: {
          typed_never_seen: neverSeen,
          returned_untyped: untyped,
          tables_confirmed: confirmed.length,
          tables_unconfirmed: unconfirmedTables,
        },
        evidence,
      },
    ];
  },
};

export default mod;
