/**
 * S13 - column-level grants (the write-column trap Move 1 raises but does not
 * close).
 *
 * The doc's Move 1 says "an UPDATE policy gates which rows change but not which
 * columns". That is the trap; the fix is a column privilege, not a policy. RLS
 * decides the rows, the GRANT decides the columns, and an UPDATE policy with no
 * matching column grant is a hole a pen test walks through. This module proves
 * the pair on the wire, through the managed Data API as the anon role:
 *
 *   S13a - TRAP: with a permissive UPDATE policy and a table-level UPDATE grant,
 *          anon writes a sensitive column (balance) -> success. The policy did
 *          not gate the column.
 *   S13b - FIX: REVOKE UPDATE ON <table>, then GRANT UPDATE (<safe columns>).
 *          anon writing balance now -> 403 / 42501 (permission denied for
 *          column), the row policy unchanged.
 *   S13c - CONTROL: anon writing an allowed column (note) still succeeds, so the
 *          fix is column-scoped, not block-all.
 *
 * DESTRUCTIVE: creates and drops a throwaway table in public. The table dies
 * with the project at teardown even if the drop is skipped.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { fetchKeys, http, sql, waitFor } from "../lib/sec.js";

const T = "sec_col_t";

/** PATCH one row via the Data API as the anon role. */
async function patch(apiHost: string, anon: string, body: Record<string, unknown>) {
  return http(`https://${apiHost}/rest/v1/${T}?id=eq.1`, {
    method: "PATCH",
    key: anon,
    headers: { Prefer: "return=minimal" },
    body,
  });
}

const mod: TestModule = {
  id: "S13",
  title: "column-level grant closes the column an UPDATE policy leaves open",
  where: "local",
  requires: ["pat", "anon-key"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const { anonJwt } = await fetchKeys(ctx);
    const results: TestResult[] = [];

    try {
      // Seed: a table with RLS, a permissive UPDATE policy for anon, and a
      // table-level UPDATE grant (every column writable). This is the "we added
      // RLS" state before anyone thinks about columns.
      await sql(
        ctx,
        `drop table if exists public.${T} cascade;
         create table public.${T} (id int primary key, note text, balance numeric not null default 0);
         insert into public.${T} (id, note, balance) values (1, 'seed', 0);
         alter table public.${T} enable row level security;
         create policy ${T}_sel on public.${T} for select to anon using (true);
         create policy ${T}_upd on public.${T} for update to anon using (true) with check (true);
         grant select, update on public.${T} to anon;
         notify pgrst, 'reload schema';`,
      );

      // Wait for PostgREST to expose the new table to the anon role.
      const visible = await waitFor(async () => (await patch(ctx.apiHost, anonJwt, { note: "warm" })).status !== 404, 30_000, 2000);
      if (!visible.ok) return [{ id: "S13", title: this.title, status: "fail", detail: "table not exposed on the Data API within 30s (PGRST schema cache)" }];

      const trap = await patch(ctx.apiHost, anonJwt, { balance: 999 });
      results.push({
        id: "S13a",
        title: "TRAP: a row UPDATE policy does not gate which columns change",
        status: trap.status < 300 ? "info" : "fail",
        detail: `permissive UPDATE policy + table-level UPDATE grant, anon writes balance -> ${trap.status} ${trap.code || "ok"}. The policy filtered rows, not columns; the sensitive column was writable.`,
        measurements: { trap_status: trap.status },
      });

      // Fix: drop the table-level UPDATE grant, re-grant UPDATE only on the safe
      // column. Column privileges and RLS are orthogonal - this changes no
      // policy.
      await sql(
        ctx,
        `revoke update on public.${T} from anon;
         grant update (note) on public.${T} to anon;
         notify pgrst, 'reload schema';`,
      );
      await new Promise((r) => setTimeout(r, 3000));

      const fixed = await patch(ctx.apiHost, anonJwt, { balance: 1000 });
      // PostgREST maps a column-privilege denial (SQLSTATE 42501) to 401 for the
      // unauthenticated anon role and 403 for an authenticated one - the
      // load-bearing signal is the 42501, not the HTTP status.
      const denied = (fixed.status === 401 || fixed.status === 403) && /42501|permission denied/i.test(fixed.code);
      results.push({
        id: "S13b",
        title: "FIX: a column grant refuses the write the policy admitted",
        status: denied ? "pass" : "fail",
        detail: `after REVOKE UPDATE + GRANT UPDATE (note), anon writes balance -> ${fixed.status} ${fixed.code}. ${denied ? "Refused for the column (42501), row policy unchanged." : "Expected 401/403 with 42501."}`,
        measurements: { fixed_status: fixed.status },
      });

      const control = await patch(ctx.apiHost, anonJwt, { note: "changed" });
      results.push({
        id: "S13c",
        title: "CONTROL: the granted column still writes (fix is column-scoped)",
        status: control.status < 300 ? "pass" : "fail",
        detail: `anon writes note -> ${control.status} ${control.code || "ok"}. The grant admits its column, so S13b is the column privilege filtering, not a broken write path.`,
        measurements: { control_status: control.status },
      });
    } catch (e) {
      results.push({ id: "S13err", title: "S13 aborted", status: "fail", detail: e instanceof Error ? e.message : String(e) });
    } finally {
      try {
        await sql(ctx, `drop table if exists public.${T} cascade; notify pgrst, 'reload schema';`);
        results.push({ id: "S13z", title: "drop throwaway table", status: "pass", detail: "dropped" });
      } catch (e) {
        results.push({ id: "S13z", title: "drop throwaway table", status: "fail", detail: e instanceof Error ? e.message : String(e) });
      }
    }
    return results;
  },
};
export default mod;
