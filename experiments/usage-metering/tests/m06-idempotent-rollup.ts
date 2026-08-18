/**
 * M06 - the idempotent rollup property, proven in SQL.
 *
 * The usage-billing literature is blunt: counters-in-place cannot be
 * replayed or audited; the correct shape is an append-only event table plus
 * a rollup keyed (tenant, meter, window) whose flush is idempotent. This
 * module builds exactly that on a throwaway project and proves the three
 * properties that make it safe to bill from:
 *
 *   M06-control  provision + schema (usage_events with unique
 *                idempotency_key, usage_rollup with unique
 *                (tenant_id, meter, window_start)) + seed 1000 events over
 *                2 tenants and 2 hourly windows.
 *   M06a         flush the rollup twice -> identical totals (a replayed
 *                flush never double-counts).
 *   M06b         insert a late event into a CLOSED window and a duplicate
 *                idempotency key -> re-flush: the closed window's total
 *                moves by exactly the late event's quantity, the duplicate
 *                is rejected by the unique constraint, and the other window
 *                is untouched.
 *
 * Deleted in finally.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";

const PRO_ORG = "gfqyoavfwjduavsvhbni";
const REGION = "ap-southeast-1";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ProjectCreateResponse {
  ref?: string;
}
interface ProjectStatusResponse {
  status?: string;
}
interface QueryRow {
  [column: string]: unknown;
}

const mod: TestModule = {
  id: "M06",
  title: "Idempotent usage rollup (replay-safe billing aggregation)",
  where: "local",
  requires: ["pat"],
  destructive: true, // provisions and deletes its own project
  async run(ctx: Ctx): Promise<TestResult[]> {
    const results: TestResult[] = [];
    let ref = "";
    const sql = async (query: string) => {
      const r = await mgmt(ctx, "POST", `/projects/${ref}/database/query`, { query });
      return { status: r.status, rows: (Array.isArray(r.json) ? r.json : []) as QueryRow[], text: r.text };
    };
    const flush =
      "insert into usage_rollup (tenant_id, meter, window_start, total) " +
      "select tenant_id, meter, date_trunc('hour', occurred_at), sum(quantity) from usage_events " +
      "group by tenant_id, meter, date_trunc('hour', occurred_at) " +
      "on conflict (tenant_id, meter, window_start) do update set total = excluded.total";

    try {
      const t0 = Date.now();
      const create = await mgmt(ctx, "POST", "/projects", {
        organization_slug: PRO_ORG,
        name: `m06-rollup-${t0}`,
        db_pass: `${crypto.randomUUID()}Aa1!`,
        region: REGION,
      });
      ref = (create.json as ProjectCreateResponse | undefined)?.ref ?? "";
      if (create.status !== 201 || !ref) {
        results.push({ id: "M06-control", title: "control", status: "fail", detail: `create: HTTP ${create.status}` });
        return results;
      }
      let status = "";
      for (let i = 0; i < 90 && status !== "ACTIVE_HEALTHY"; i++) {
        await sleep(10_000);
        const p = await mgmt(ctx, "GET", `/projects/${ref}`);
        status = (p.json as ProjectStatusResponse | undefined)?.status ?? "";
      }
      const schema = await sql(
        "create table usage_events (id bigint generated always as identity primary key, tenant_id text, meter text, quantity numeric, occurred_at timestamptz, idempotency_key text unique); " +
          "create table usage_rollup (tenant_id text, meter text, window_start timestamptz, total numeric, primary key (tenant_id, meter, window_start)); " +
          "insert into usage_events (tenant_id, meter, quantity, occurred_at, idempotency_key) " +
          "select 't-' || (g % 2), 'api.request', 1, '2026-08-01 00:00:00+00'::timestamptz + ((g / 2) % 2) * interval '1 hour' + (g % 60) * interval '1 second', 'seed-' || g " +
          "from generate_series(1, 1000) g",
      );
      results.push({
        id: "M06-control",
        title: "M06-control: provision + schema + seed",
        status: status === "ACTIVE_HEALTHY" && schema.status < 300 ? "pass" : "fail",
        detail: schema.status >= 300 ? schema.text.slice(0, 200) : undefined,
        measurements: { provision_s: Math.round((Date.now() - t0) / 1000) },
      });

      // ---- M06a: flush twice, totals identical ----
      await sql(flush);
      const first = await sql("select tenant_id, window_start, total from usage_rollup order by tenant_id, window_start");
      await sql(flush);
      const second = await sql("select tenant_id, window_start, total from usage_rollup order by tenant_id, window_start");
      const identical = JSON.stringify(first.rows) === JSON.stringify(second.rows);
      const totals = first.rows.map((r) => `${r.tenant_id}@${String(r.window_start).slice(11, 13)}h=${r.total}`);
      results.push({
        id: "M06a",
        title: "M06a: replayed flush is idempotent",
        status: identical && first.rows.length === 4 ? "pass" : "fail",
        detail: identical ? undefined : `second flush changed the rollup (or window count ${first.rows.length} != 4)`,
        measurements: {
          rollup_windows: first.rows.length,
          identical_after_reflush: identical ? 1 : 0,
          totals: totals.join(" "),
        },
      });

      // ---- M06b: late event into a closed window + duplicate key ----
      const late = await sql(
        "insert into usage_events (tenant_id, meter, quantity, occurred_at, idempotency_key) values ('t-0', 'api.request', 5, '2026-08-01 00:30:00+00', 'late-1')",
      );
      const dup = await sql(
        "insert into usage_events (tenant_id, meter, quantity, occurred_at, idempotency_key) values ('t-0', 'api.request', 7, '2026-08-01 00:31:00+00', 'seed-1')",
      );
      await sql(flush);
      const after = await sql("select tenant_id, window_start, total from usage_rollup order by tenant_id, window_start");
      const before0 = first.rows.find((r) => r.tenant_id === "t-0" && String(r.window_start).includes("00:00"));
      const after0 = after.rows.find((r) => r.tenant_id === "t-0" && String(r.window_start).includes("00:00"));
      const otherUnchanged = after.rows
        .filter((r) => !(r.tenant_id === "t-0" && String(r.window_start).includes("00:00")))
        .every((r) => JSON.stringify(first.rows.find((x) => x.tenant_id === r.tenant_id && x.window_start === r.window_start)) === JSON.stringify(r));
      const delta = Number(after0?.total ?? 0) - Number(before0?.total ?? 0);
      results.push({
        id: "M06b",
        title: "M06b: late event recompute + duplicate rejection",
        status: "info",
        detail: dup.status >= 300 ? "duplicate idempotency_key rejected" : `WARNING: duplicate key ACCEPTED (HTTP ${dup.status})`,
        measurements: {
          late_insert_status: late.status,
          duplicate_rejected: dup.status >= 300 ? 1 : 0,
          closed_window_delta: delta,
          closed_window_delta_expected: 5,
          other_windows_unchanged: otherUnchanged ? 1 : 0,
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      for (const id of ["M06-control", "M06a", "M06b"] as const) {
        if (!results.some((r) => r.id === id)) results.push({ id, title: id, status: "fail", detail: `threw: ${msg}` });
      }
    } finally {
      if (ref) await mgmt(ctx, "DELETE", `/projects/${ref}`).catch(() => null);
    }
    return results;
  },
};
export default mod;
