/**
 * PL04 - row level security and the replication path.
 *
 * Claim under test (Pipelines docs): RLS does not apply to replicated data;
 * publication row filters and column lists are the filtering tools.
 *
 * Source table with RLS enabled and FORCEd, one policy that grants nothing to
 * `authenticated` (using false). 1000 rows exist before the pipeline starts
 * (initial copy path); 200 more are inserted, 50 updated and 20 deleted after
 * (WAL path).
 *
 *   PL04a  control: as `authenticated` on the source the table reads 0 rows,
 *          so the policy is in force.
 *   PL04b  with the engine connecting as `postgres` (BYPASSRLS on Supabase),
 *          the destination holds every row and the updates and deletes
 *          arrived.
 *   PL04c  a publication column list and row filter DO filter: the same table
 *          republished with `(id, owner) where (owner = 'keep')`.
 *   PL04d  the engine connecting as a role WITHOUT BYPASSRLS, whose only
 *          policy exposes 100 of the 1000 rows: how many rows the initial
 *          copy delivers. The source objects are installed first by the
 *          postgres run; the role needs REPLICATION and SELECT only.
 *
 * Entity note: engine, not the managed service (see PL02). Which database role
 * the managed service connects as is not observable here.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { beginPipeline, ensureFixture, openDuck, withCleanup } from "../lib/fixture.js";
import { replicatorLogs, sleep, waitTablesReady, type SrcDb } from "../lib/stack.js";

async function catchUp(
  duck: { scalar(sql: string): Promise<string> },
  sql: string,
  want: string,
  maxMs = 90_000,
): Promise<{ ok: boolean; got: string; ms: number }> {
  const t0 = Date.now();
  let got = "";
  while (Date.now() - t0 < maxMs) {
    got = await duck.scalar(sql);
    if (got === want) return { ok: true, got, ms: Date.now() - t0 };
    await sleep(1500);
  }
  return { ok: false, got, ms: Date.now() - t0 };
}

const SEED = (from: number, to: number) =>
  `insert into public.pl04_rls select g, case when g % 2 = 0 then 'keep' else 'drop' end, 'secret-' || g from generate_series(${from}, ${to}) g`;

async function freshTable(db: SrcDb): Promise<void> {
  await db.q("drop table if exists public.pl04_rls cascade");
  await db.q("create table public.pl04_rls (id bigint primary key, owner text not null, secret text not null)");
}

const mod: TestModule = {
  id: "PL04",
  title: "PL04 - RLS and the replication path",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const results: TestResult[] = [];
    const fx = await ensureFixture(ctx);
    const { db, state } = fx;

    await freshTable(db);
    await db.q("alter table public.pl04_rls enable row level security");
    await db.q("alter table public.pl04_rls force row level security");
    await db.q("create policy pl04_none on public.pl04_rls for all to authenticated using (false) with check (false)");
    await db.q("grant select on public.pl04_rls to authenticated");
    await db.q(SEED(1, 1000));

    // ---- PL04a: control
    const rows = await db.q(
      "begin; set local role authenticated; select count(*)::text as n from public.pl04_rls; commit",
    );
    const n = rows[0]?.n ?? "?";
    results.push({
      id: "PL04a",
      title: "PL04a: control - the policy is in force for `authenticated` on the source",
      status: n === "0" ? "pass" : "fail",
      detail: `as authenticated the source table reads ${n} of 1000 rows`,
      measurements: { rows_visible_to_authenticated: n },
    });

    // ---- PL04b: engine as postgres
    await beginPipeline(fx, { tables: ["public.pl04_rls"], tag: "pl04" });
    const w = await waitTablesReady(db, ["public.pl04_rls"], 300_000, 2000, ["sync_done", "ready"]);
    const duck = await openDuck();
    try {
      const copy = await catchUp(duck, "select count(*) from lake.public.pl04_rls", "1000");
      await db.q(SEED(1001, 1200));
      await db.q("update public.pl04_rls set secret = 'changed' where id between 1 and 50");
      await db.q("delete from public.pl04_rls where id between 1101 and 1120");
      const want = "1180";
      const cdc = await catchUp(duck, "select count(*) from lake.public.pl04_rls", want);
      const upd = await catchUp(
        duck,
        "select count(*) from lake.public.pl04_rls where id between 1 and 50 and secret = 'changed'",
        "50",
      );
      const bypass = await db.scalar("select rolbypassrls::text from pg_roles where rolname = 'postgres'");
      results.push({
        id: "PL04b",
        title: "PL04b: destination holds RLS-hidden rows (copy path and change path)",
        status: w.ok && copy.ok && cdc.ok && upd.ok ? "pass" : "fail",
        detail: `initial copy ${copy.got} of 1000 rows; after 200 inserts and 20 deletes ${cdc.got} of ${want}; 50 updates seen ${upd.got} of 50`,
        measurements: {
          engine_role: "postgres",
          engine_role_bypassrls: bypass,
          copy_rows_at_dest: copy.got,
          after_changes_rows_at_dest: cdc.got,
          after_changes_expected: want,
          updates_seen: upd.got,
        },
      });
    } finally {
      duck.close();
    }

    // ---- PL04c: column list + row filter
    await freshTable(db);
    await db.q(SEED(1, 1000));
    await beginPipeline(fx, { tables: ["public.pl04_rls (id, owner) where (owner = 'keep')"], tag: "pl04c" });
    const w2 = await waitTablesReady(db, ["public.pl04_rls"], 300_000, 2000, ["sync_done", "ready"]);
    const duck2 = await openDuck();
    try {
      const cnt = await catchUp(duck2, "select count(*) from lake.public.pl04_rls", "500");
      const cols = (await duck2.rows("select column_name from (describe lake.public.pl04_rls) order by 1")).map((r) => r[0]).join(" ");
      const owners = await duck2.scalar("select string_agg(distinct owner, '|') from lake.public.pl04_rls");
      results.push({
        id: "PL04c",
        title: "PL04c: publication column list and row filter filter the destination",
        status: w2.ok && cnt.ok && !cols.includes("secret") && owners === "keep" ? "pass" : "fail",
        detail: `rows ${cnt.got} of 500, columns [${cols}], owner values [${owners}]`,
        measurements: { dest_rows: cnt.got, dest_columns: cols, dest_owner_values: owners },
      });
    } finally {
      duck2.close();
    }

    // ---- PL04d: engine as a role without BYPASSRLS
    const pw = `pl${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
    results.push(await asLimitedRole(fx, db, state.host, pw));
    await dropLimitedRole(db).catch(() => undefined);
    return results;
  },
};

/**
 * `postgres` is not a member of a role it creates (PostgreSQL 16 and later), so
 * `DROP OWNED BY` is refused; revoke each grant the lab made instead.
 */
async function dropLimitedRole(db: SrcDb): Promise<void> {
  const exists = await db.scalar("select count(*) from pg_roles where rolname = 'pl_norls'");
  if (exists === "0") return;
  // a policy that names the role is a dependency of the role
  await db.q("drop table if exists public.pl04_rls cascade").catch(() => undefined);
  for (const stmt of [
    "revoke all on all tables in schema public from pl_norls",
    "revoke all on schema public from pl_norls",
    "revoke all on all functions in schema etl from pl_norls",
    "revoke all on all tables in schema etl from pl_norls",
    "revoke all on schema etl from pl_norls",
  ]) {
    await db.q(stmt).catch(() => undefined);
  }
  await db.q("drop role if exists pl_norls");
}

async function asLimitedRole(
  fx: Awaited<ReturnType<typeof ensureFixture>>,
  db: SrcDb,
  _host: string,
  pw: string,
): Promise<TestResult> {
  const id = "PL04d";
  const title = "PL04d: initial copy as a role without BYPASSRLS, policy exposes 100 of 1000 rows";
  await dropLimitedRole(db);
  await freshTable(db);
  await db.q("alter table public.pl04_rls enable row level security");
  await db.q("alter table public.pl04_rls force row level security");
  await db.q(SEED(1, 1000));
  try {
    await db.q(`create role pl_norls login replication nobypassrls password '${pw}'`);
  } catch (e) {
    return { id, title, status: "info", detail: `could not create a REPLICATION role: ${e instanceof Error ? e.message : e}` };
  }
  await db.q("grant usage on schema public to pl_norls");
  await db.q("grant select on public.pl04_rls to pl_norls");
  await db.q("create policy pl04_norls on public.pl04_rls for select to pl_norls using (id <= 100)");
  // First run as postgres to install the source objects the role cannot create, then reuse them.
  await beginPipeline(fx, { tables: ["public.pl04_rls"], tag: "pl04d0" });
  await waitTablesReady(db, ["public.pl04_rls"], 300_000, 2000, ["sync_done", "ready"]);
  await db.q("grant usage on schema etl to pl_norls").catch(() => undefined);
  await db.q("grant execute on all functions in schema etl to pl_norls").catch(() => undefined);
  await db.q("grant select on all tables in schema etl to pl_norls").catch(() => undefined);
  // A second pipeline id with the limited role; state, slots and destination are separate.
  await beginPipeline(
    fx,
    { tables: ["public.pl04_rls"], tag: "pl04d", id: 2, replUser: { name: "pl_norls", password: pw } },
    true,
  );
  const w = await waitTablesReady(db, ["public.pl04_rls"], 180_000, 2000, ["sync_done", "ready"]);
  const states = JSON.stringify(w.states);
  const logs = (await replicatorLogs()).split("\n").filter((l) => /error|permission|denied|ERROR/i.test(l)).slice(-3).join(" | ");
  let dest = "n/a";
  if (w.ok) {
    const duck = await openDuck();
    try {
      await sleep(3000);
      dest = await duck.scalar("select count(*) from lake.public.pl04_rls");
    } finally {
      duck.close();
    }
  }
  return {
    id,
    title,
    status: "info",
    detail: w.ok ? `destination holds ${dest} of 1000 rows` : `pipeline did not reach sync_done: ${states}; log: ${logs.slice(0, 200)}`,
    measurements: {
      engine_role: "pl_norls (REPLICATION, NOBYPASSRLS, SELECT only)",
      policy_visible_rows: 100,
      source_rows: 1000,
      dest_rows: dest,
      table_state: states,
      log_errors: logs.slice(0, 160),
    },
  };
}

export default withCleanup(mod);
