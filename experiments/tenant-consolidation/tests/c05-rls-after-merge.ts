/**
 * C05 - the isolation the consolidated project now depends on.
 *
 * Before consolidation, isolation was a property of the infrastructure: two
 * customers could not see each other because they were two Postgres
 * instances. Afterwards it is a property of a predicate on a claim, so the
 * ways it can be wrong are worth measuring rather than assuming.
 *
 * Four of them, in the order a migration hits them:
 *
 *   - RLS enabled with no policy denies everything, which is the correct
 *     failure and also the one that gets misread, because the migration
 *     console keeps showing every row;
 *   - the console showing every row is not a bug and not a passing test: the
 *     query endpoint connects as a role RLS does not constrain, so "I checked
 *     and the data is there" says nothing about what a tenant can read;
 *   - a policy with `using` but no `with check` isolates reads and leaves
 *     writes open, so one tenant can insert rows attributed to another;
 *   - a table nobody enabled RLS on is readable by every tenant, which is what
 *     makes "on every table" the load-bearing word in the advice rather than
 *     a flourish.
 *
 * The data here is shaped like the output of C04: rows for two tenants in one
 * table, already merged, tenant_id backfilled.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import {
  PASSWORD,
  adminCreate,
  keys,
  login,
  restRead,
  restWrite,
  sql,
  waitReady,
} from "../lib/consolidate";

const A = "c05-a@lab.invalid";
const B = "c05-b@lab.invalid";

/** PostgREST answers 404/PGRST205 until its schema cache catches up with DDL. */
async function readWhenVisible(
  host: string,
  anon: string,
  bearer: string,
  query: string,
  budgetMs = 30000,
) {
  const t0 = performance.now();
  let last = await restRead(host, anon, bearer, query);
  while (performance.now() - t0 < budgetMs && (last.code === "PGRST205" || last.status === 404)) {
    await new Promise((r) => setTimeout(r, 1500));
    last = await restRead(host, anon, bearer, query);
  }
  return last;
}

const mod: TestModule = {
  id: "C05",
  title: "Row-level isolation on the merged table, and the three ways it is not there",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx) {
    const shared = ctx.ref;
    const results: TestResult[] = [];
    await waitReady(ctx, shared);

    const k = await keys(ctx, shared);
    if (!k.anon || !k.service) {
      return [{ id: "C05z", title: "key fetch", status: "fail", detail: "no API keys" }];
    }

    await sql(
      ctx,
      shared,
      `drop table if exists public.merged_items;
       drop table if exists public.audit_log;
       create table public.merged_items (
         id bigserial primary key, tenant_id text not null, body text not null);
       create table public.audit_log (
         id bigserial primary key, tenant_id text not null, note text not null);
       insert into public.merged_items(tenant_id, body) values
         ('tenant-a','a-row-1'),('tenant-a','a-row-2'),('tenant-b','b-row-1');
       insert into public.audit_log(tenant_id, note) values
         ('tenant-a','a-note'),('tenant-b','b-note');
       grant usage on schema public to authenticated;
       grant select, insert, update, delete on public.merged_items, public.audit_log to authenticated;
       grant usage, select on sequence public.merged_items_id_seq, public.audit_log_id_seq to authenticated;`,
    );

    await sql(ctx, shared, `delete from auth.users where lower(email) like 'c05-%'`);
    for (const [email, tenant] of [
      [A, "tenant-a"],
      [B, "tenant-b"],
    ] as const) {
      await adminCreate(`${shared}.supabase.co`, k.service, {
        email,
        password: PASSWORD,
        email_confirm: true,
        app_metadata: { tenant_id: tenant },
      });
    }
    const tokA = (await login(`${shared}.supabase.co`, k.anon, A)).json.access_token;
    const tokB = (await login(`${shared}.supabase.co`, k.anon, B)).json.access_token;
    if (typeof tokA !== "string" || typeof tokB !== "string") {
      return [{ id: "C05z", title: "tenant login", status: "fail", detail: "could not obtain tokens" }];
    }

    const host = `${shared}.supabase.co`;

    // Step 1: RLS on, no policy. The correct state to be in mid-migration, and
    // the one whose symptom is "the application went blank".
    await sql(ctx, shared, `alter table public.merged_items enable row level security;`);
    const denied = await readWhenVisible(host, k.anon, tokA, "merged_items?select=tenant_id,body");
    results.push({
      id: "C05a",
      title: "RLS enabled with no policy denies every tenant",
      status: denied.rows?.length === 0 ? "pass" : "fail",
      detail: `${denied.rows?.length ?? -1} rows returned (HTTP ${denied.status}) - deny-by-default, not an error`,
      measurements: { rows: denied.rows?.length ?? -1, status: denied.status },
    });

    // Step 2: the same table, read through the migration console. If this
    // returns every row while a tenant sees none, then "I verified the data
    // landed" and "isolation works" are answers to different questions.
    const asOwner = await sql(
      ctx,
      shared,
      `select current_user as role,
              (select count(*)::int from public.merged_items) as visible,
              (select count(*)::int from public.merged_items where true) as total`,
    );
    const visible = Number(asOwner.rows?.[0]?.visible ?? -1);
    results.push({
      id: "C05b",
      title: "The management query endpoint is not constrained by the policy it is testing",
      status: visible === 3 ? "pass" : "info",
      detail: `role=${String(asOwner.rows?.[0]?.role ?? "?")} sees ${visible} rows while the tenant above saw ${denied.rows?.length ?? -1}`,
      measurements: { role: String(asOwner.rows?.[0]?.role ?? "?"), rows_seen: visible },
    });

    // Step 3: a read policy only. Isolation on reads; writes still unscoped.
    await sql(
      ctx,
      shared,
      `drop policy if exists tenant_read on public.merged_items;
       create policy tenant_read on public.merged_items
         using (tenant_id = (auth.jwt() -> 'app_metadata' ->> 'tenant_id'));`,
    );
    const aReads = await readWhenVisible(host, k.anon, tokA, "merged_items?select=tenant_id,body&order=id");
    const bCross = await restRead(
      host,
      k.anon,
      tokB,
      "merged_items?select=tenant_id,body&tenant_id=eq.tenant-a",
    );
    results.push({
      id: "C05c",
      title: "With the policy, each tenant reads only its own merged rows",
      status: aReads.rows?.length === 2 && bCross.rows?.length === 0 ? "pass" : "fail",
      detail: `tenant A sees ${aReads.rows?.length ?? -1} of 3; tenant B filtering for A's rows gets ${bCross.rows?.length ?? -1}`,
      measurements: { a_rows: aReads.rows?.length ?? -1, b_cross_rows: bCross.rows?.length ?? -1 },
    });

    // Step 4: the write half. The advice everyone repeats is that `using`
    // covers reads and `with check` covers writes, from which it follows that
    // omitting the check leaves writes open. That is worth measuring rather
    // than repeating, because the policy above is FOR ALL and Postgres reuses
    // a FOR ALL policy's USING expression as its check when no WITH CHECK is
    // given.
    const forgedRows = async () =>
      Number(
        (
          await sql(
            ctx,
            shared,
            `select count(*)::int as n from public.merged_items where body = 'written-by-b'`,
          )
        ).rows?.[0]?.n ?? -1,
      );

    const forged = await restWrite(
      host,
      k.anon,
      tokB,
      "merged_items",
      { tenant_id: "tenant-a", body: "written-by-b" },
      "minimal",
    );
    const forgedLanded = await forgedRows();
    results.push({
      id: "C05d",
      title: "A FOR ALL policy with only `using` governs writes as well",
      status: forged.status >= 400 && forgedLanded === 0 ? "pass" : "fail",
      detail:
        forged.status >= 400 && forgedLanded === 0
          ? `tenant B's forged insert refused HTTP ${forged.status} ${forged.code ?? ""} and left 0 rows - the USING expression was applied as the check`
          : `HTTP ${forged.status} with ${forgedLanded} row(s) on the table - the omission IS a hole here`,
      measurements: { status: forged.status, code: forged.code ?? "none", rows_landed: forgedLanded },
      evidence: forged.text.slice(0, 200),
    });

    // The write hole that does exist: a check that is written but permissive.
    // `with check (true)` is what people reach for when an insert starts
    // failing and the cause is not obvious.
    await sql(
      ctx,
      shared,
      `drop policy if exists tenant_read on public.merged_items;
       create policy tenant_permissive_write on public.merged_items
         using      (tenant_id = (auth.jwt() -> 'app_metadata' ->> 'tenant_id'))
         with check (true);`,
    );
    const permissive = await restWrite(
      host,
      k.anon,
      tokB,
      "merged_items",
      { tenant_id: "tenant-a", body: "written-by-b" },
      "minimal",
    );
    const permissiveLanded = await forgedRows();
    results.push({
      id: "C05e",
      title: "`with check (true)` is the write hole, and reads stay isolated over it",
      status: permissive.status < 300 && permissiveLanded === 1 ? "pass" : "fail",
      detail:
        permissive.status < 300 && permissiveLanded === 1
          ? "tenant B wrote a row attributed to tenant A; every read test still passes"
          : `HTTP ${permissive.status} ${permissive.code ?? ""}, ${permissiveLanded} row(s) - the hole did not reproduce`,
      measurements: {
        status: permissive.status,
        code: permissive.code ?? "none",
        rows_landed: permissiveLanded,
      },
      evidence: permissive.text.slice(0, 200),
    });

    // The same write, asked for the default way. If this reads as a refusal
    // while the row is on the table, then every RLS write test written against
    // PostgREST defaults reports the hole as closed.
    const repr = await restWrite(host, k.anon, tokB, "merged_items", {
      tenant_id: "tenant-a",
      body: "written-by-b",
    });
    const afterRepr = await forgedRows();
    results.push({
      id: "C05f",
      title: "PostgREST's default return=representation reports an allowed write as 42501",
      status: repr.status >= 400 ? "pass" : "info",
      detail:
        repr.status >= 400
          ? `HTTP ${repr.status} ${repr.code ?? ""} on a policy that permits the write - RETURNING is filtered by the SELECT policy, so the statement fails and rolls back (${afterRepr} row(s) on the table)`
          : `HTTP ${repr.status} - representation mode returned the row`,
      measurements: { status: repr.status, code: repr.code ?? "none", rows_after: afterRepr },
      evidence: repr.text.slice(0, 200),
    });

    await sql(
      ctx,
      shared,
      `drop policy if exists tenant_permissive_write on public.merged_items;
       create policy tenant_rw on public.merged_items
         using      (tenant_id = (auth.jwt() -> 'app_metadata' ->> 'tenant_id'))
         with check (tenant_id = (auth.jwt() -> 'app_metadata' ->> 'tenant_id'));
       delete from public.merged_items where body = 'written-by-b';`,
    );
    const blocked = await restWrite(
      host,
      k.anon,
      tokB,
      "merged_items",
      { tenant_id: "tenant-a", body: "written-by-b" },
      "minimal",
    );
    const blockedLanded = await forgedRows();
    results.push({
      id: "C05g",
      title: "Naming the tenant in `with check` closes it again",
      status: blocked.status >= 400 && blockedLanded === 0 ? "pass" : "fail",
      detail: `HTTP ${blocked.status} ${blocked.code ?? ""}, ${blockedLanded} forged row(s) left`,
      measurements: { status: blocked.status, code: blocked.code ?? "none", rows_landed: blockedLanded },
    });

    // Step 5: the table nobody remembered. Before consolidation this table was
    // isolated by the instance boundary; now it is isolated by nothing.
    const leak = await readWhenVisible(host, k.anon, tokB, "audit_log?select=tenant_id,note&order=id");
    results.push({
      id: "C05h",
      title: "A table left without RLS is readable by every tenant",
      status: (leak.rows?.length ?? 0) === 2 ? "pass" : "fail",
      detail: `tenant B reads ${leak.rows?.length ?? -1} of 2 rows from a table that was never enabled - one missed table is a cross-tenant read`,
      measurements: { rows: leak.rows?.length ?? -1, status: leak.status },
    });

    const unguarded = await sql(
      ctx,
      shared,
      `select count(*)::int as n from pg_tables t
        where t.schemaname = 'public'
          and not exists (select 1 from pg_class c
                           join pg_namespace ns on ns.oid = c.relnamespace
                          where ns.nspname = 'public' and c.relname = t.tablename and c.relrowsecurity)`,
    );
    results.push({
      id: "C05i",
      title: "The query that enumerates what is still unguarded",
      status: "info",
      detail: `${String(unguarded.rows?.[0]?.n ?? "?")} tables in public have RLS disabled - run this before cutover, not after`,
      measurements: { tables_without_rls: Number(unguarded.rows?.[0]?.n ?? -1) },
    });

    return results;
  },
};
export default mod;
