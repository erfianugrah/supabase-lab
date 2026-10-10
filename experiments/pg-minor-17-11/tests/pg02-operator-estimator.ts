/**
 * PG02 - CREATE OPERATOR ... RESTRICT / JOIN with a non-built-in selectivity
 * estimator, as the `postgres` role (not superuser on this image) and as
 * `supabase_admin` (superuser), across the minor (public changelog:
 * https://supabase.com/changelog/postgres-15-19-17-11-breaking-changes ; the
 * upstream note is the CVE-2026-2004 entry of the PostgreSQL 18.2 release
 * notes, which says superuser is now required to attach a non-built-in
 * estimator).
 *
 * "Non-built-in" estimators used here (both are functions an extension
 * installs, owned by the superuser that ran CREATE EXTENSION):
 *   restrict: ltree's ltreeparentsel (chosen because planning with it is safe
 *             for any argument types; intarray's _int_matchsel is the
 *             function the CVE is about and is NOT executed here)
 *   join:     intarray's _int_overlap_joinsel (never executed: no join query
 *             is planned with the operators)
 * plus a C-language wrapper function over _int_matchsel created by the
 * superuser in another schema, to ask "a custom function, not an extension's".
 *
 * Per pair:
 *   old image   as postgres: CREATE OPERATOR with eqsel/eqjoinsel (built-in),
 *               with the extension restrict estimator, with the extension
 *               join estimator, ALTER OPERATOR ... SET (RESTRICT = ...) to the
 *               extension estimator, CREATE FUNCTION ... LANGUAGE c. As
 *               supabase_admin: the wrapper function and an operator using it.
 *   new image   (same data directory) the operators made above: still
 *               present, still plannable; the same creations as postgres and
 *               as supabase_admin; ALTER OPERATOR; the detection query;
 *               pg_dump of the schema from the new server restored as postgres
 *               and as supabase_admin into fresh databases (the changelog's
 *               "dump/restore, branching" path).
 *
 * Not measured here: a hosted branch or a platform major-version upgrade
 * (the changelog names both as paths that re-create operators); PostGIS or
 * other extensions' own operators; an estimator written by the customer in C
 * (the postgres role cannot create C functions here, see the measurement).
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { one, outcome, pairs, skipReason, tryq, withRig, type Pair, type Rig } from "../lib/rig";
import type { Client } from "pg";

const ID = "PG02";
const RESTRICT_FN = "extensions.ltreeparentsel";
const JOIN_FN = "extensions._int_overlap_joinsel";

/** Operator names are symbol-only: digits and letters are not allowed in them. */
const createOp = (schema: string, name: string, clause: string) =>
  `create operator ${schema}.${name} (leftarg = int, rightarg = int, function = opt.f, ${clause})`;

/** The detection query used here (the changelog's own query text is not in the page text we could read). */
const DETECT = `
  select o.oid::regoperator::text as op
  from pg_operator o
  where o.oprnamespace <> 'pg_catalog'::regnamespace
    and ((o.oprrest <> 0 and o.oprrest::oid >= 16384) or (o.oprjoin <> 0 and o.oprjoin::oid >= 16384))
    and not exists (select 1 from pg_depend d where d.classid = 'pg_operator'::regclass and d.objid = o.oid and d.deptype = 'e')
  order by 1`;

async function dumpRestore(r: Rig, as: "postgres" | "supabase_admin", db: string): Promise<{ errors: number; first: string }> {
  await r.withClient("supabase_admin", "postgres", async (c) => {
    await c.query(`drop database if exists ${db}`);
    await c.query(`create database ${db} owner postgres`);
  });
  await r.withClient("supabase_admin", db, async (c) => {
    await c.query("create schema if not exists extensions");
    await c.query("create extension ltree with schema extensions");
    await c.query("create extension intarray with schema extensions");
  });
  const o = await r.sh(
    `pg_dump -U supabase_admin -d postgres -s -n opt --no-owner | psql -U ${as} -d ${db} -X -v ON_ERROR_STOP=0 2>&1 | grep -i '^ERROR' || true`,
  );
  const lines = o.out.split("\n").filter(Boolean);
  return { errors: lines.length, first: lines[0] ?? "(none)" };
}

async function runPair(p: Pair): Promise<TestResult> {
  const m: Record<string, string | number> = {};
  const dev: string[] = [];
  const expect = (label: string, cond: boolean) => {
    if (!cond) dev.push(label);
  };
  const isErr = (v: string | number | undefined) => String(v).startsWith("ERR");

  await withRig(p, async (r) => {
    // ---- old image
    await r.start("old");
    await r.withClient("supabase_admin", "postgres", async (c) => {
      m.old_server_version = await one(c, "select current_setting('server_version')");
      await c.query("create schema if not exists extensions");
      await c.query("create extension ltree with schema extensions");
      await c.query("create extension intarray with schema extensions");
      await c.query("create schema opt authorization postgres");
      await c.query("create schema adm authorization postgres");
      await c.query("create schema scratch authorization postgres");
      m.restrict_estimator_owner_is_superuser = await one(
        c,
        "select (select rolsuper from pg_roles where oid = p.proowner)::text from pg_proc p where p.oid = 'extensions.ltreeparentsel(internal,oid,internal,integer)'::regprocedure",
      );
      await c.query(
        "create function adm.my_sel(internal, oid, internal, integer) returns float8 as '$libdir/_int', '_int_matchsel' language c stable strict",
      );
    });
    await r.withClient("postgres", "postgres", async (c) => {
      await c.query("create function opt.f(a int, b int) returns bool language sql immutable as 'select a = b'");
      await c.query("create table opt.t as select g as a from generate_series(1, 1000) g");
      m.old_postgres_create_c_function = outcome(
        await tryq(c, "create function opt.cfn(internal) returns float8 as '$libdir/_int', '_int_matchsel' language c"),
      );
      m.old_postgres_op_builtin = outcome(await tryq(c, createOp("opt", "<=>", "restrict = eqsel, join = eqjoinsel")));
      m.old_postgres_op_ext_restrict = outcome(await tryq(c, createOp("opt", "<==>", `restrict = ${RESTRICT_FN}`)));
      m.old_postgres_op_ext_join = outcome(await tryq(c, createOp("opt", "<===>", `join = ${JOIN_FN}`)));
      m.old_postgres_op_custom_c_wrapper = outcome(await tryq(c, createOp("adm", "<====>", "restrict = adm.my_sel")));
      m.old_postgres_alter_operator_to_ext_restrict = outcome(
        await tryq(c, `alter operator opt.<=> (int, int) set (restrict = ${RESTRICT_FN})`),
      );
      // put the built-in one back so the dump below holds a mix
      await tryq(c, "alter operator opt.<=> (int, int) set (restrict = eqsel)");
    });
    await r.withClient("supabase_admin", "postgres", async (c) => {
      m.old_admin_op_custom_c_wrapper = outcome(await tryq(c, createOp("adm", "<=====>", "restrict = adm.my_sel")));
      m.old_detect_flagged = (await c.query(DETECT)).rows.map((x) => x.op).join(", ") || "(none)";
    });
    for (const k of ["old_postgres_op_builtin", "old_postgres_op_ext_restrict", "old_postgres_op_ext_join", "old_postgres_op_custom_c_wrapper", "old_postgres_alter_operator_to_ext_restrict", "old_admin_op_custom_c_wrapper"]) {
      expect(`${k} accepted on the old image`, m[k] === "ok");
    }
    await r.stop();

    // ---- new image, same data directory
    await r.start("new");
    await r.withClient("supabase_admin", "postgres", async (c) => {
      m.new_server_version = await one(c, "select current_setting('server_version')");
      m.new_existing_operators = (
        await c.query("select oprname || ' rest=' || oprrest::text || ' join=' || oprjoin::text as d from pg_operator where oprnamespace = 'opt'::regnamespace order by oprname")
      ).rows
        .map((x) => x.d)
        .join("; ");
      m.new_detect_flagged = (await c.query(DETECT)).rows.map((x) => x.op).join(", ") || "(none)";
    });
    await r.withClient("postgres", "postgres", async (c) => {
      m.new_postgres_existing_ext_restrict_operator_plans = outcome(
        await tryq(c, "explain select * from opt.t where a operator(opt.<==>) 5"),
        (rows) => `ok (${rows.length} plan lines)`,
      );
      m.new_postgres_existing_ext_restrict_operator_count = outcome(await tryq(c, "select count(*) as n from opt.t where a operator(opt.<==>) 5"), (rows) => `ok (count ${rows[0]?.n})`);
      m.new_postgres_create_c_function = outcome(
        await tryq(c, "create function opt.cfn(internal) returns float8 as '$libdir/_int', '_int_matchsel' language c"),
      );
      m.new_postgres_op_builtin = outcome(await tryq(c, createOp("scratch", "<=>", "restrict = eqsel, join = eqjoinsel")));
      m.new_postgres_op_ext_restrict = outcome(await tryq(c, createOp("scratch", "<==>", `restrict = ${RESTRICT_FN}`)));
      m.new_postgres_op_ext_join = outcome(await tryq(c, createOp("scratch", "<===>", `join = ${JOIN_FN}`)));
      m.new_postgres_op_custom_c_wrapper = outcome(await tryq(c, createOp("scratch", "<====>", "restrict = adm.my_sel")));
      m.new_postgres_alter_operator_to_ext_restrict = outcome(
        await tryq(c, `alter operator opt.<=> (int, int) set (restrict = ${RESTRICT_FN})`),
      );
      m.new_postgres_alter_operator_to_builtin = outcome(await tryq(c, "alter operator opt.<=> (int, int) set (restrict = eqsel)"));
    });
    await r.withClient("supabase_admin", "postgres", async (c) => {
      m.new_admin_op_ext_restrict = outcome(await tryq(c, createOp("scratch", "<>==<", `restrict = ${RESTRICT_FN}`)));
      m.new_admin_op_ext_join = outcome(await tryq(c, createOp("scratch", "<>===<", `join = ${JOIN_FN}`)));
      m.new_admin_op_custom_c_wrapper = outcome(await tryq(c, createOp("scratch", "<>====<", "restrict = adm.my_sel")));
    });

    // dump the schema from the new server, restore as each role into a fresh database
    const asPostgres = await dumpRestore(r, "postgres", "restore_pg");
    m.new_restore_as_postgres_errors = asPostgres.errors;
    m.new_restore_as_postgres_first_error = asPostgres.first;
    const asAdmin = await dumpRestore(r, "supabase_admin", "restore_adm");
    m.new_restore_as_supabase_admin_errors = asAdmin.errors;
    m.new_restore_as_supabase_admin_first_error = asAdmin.first;
    await r.withClient("supabase_admin", "restore_pg", async (c) => {
      m.new_restore_as_postgres_operators_present = (await one<string>(c, "select count(*)::text from pg_operator where oprnamespace = 'opt'::regnamespace")) + " of 3 dumped";
    });
    await r.withClient("supabase_admin", "restore_adm", async (c) => {
      m.new_restore_as_supabase_admin_operators_present = (await one<string>(c, "select count(*)::text from pg_operator where oprnamespace = 'opt'::regnamespace")) + " of 3 dumped";
    });
    await r.stop();
  });

  expect("old: C function creation by postgres refused", isErr(m.old_postgres_create_c_function));
  expect("new: existing operator with extension estimator still plans", String(m.new_postgres_existing_ext_restrict_operator_plans).startsWith("ok"));
  expect("new: built-in estimator accepted for postgres", m.new_postgres_op_builtin === "ok");
  for (const k of ["new_postgres_op_ext_restrict", "new_postgres_op_ext_join", "new_postgres_op_custom_c_wrapper", "new_postgres_alter_operator_to_ext_restrict"]) {
    expect(`${k} refused`, isErr(m[k]));
  }
  for (const k of ["new_admin_op_ext_restrict", "new_admin_op_ext_join", "new_admin_op_custom_c_wrapper"]) {
    expect(`${k} accepted`, m[k] === "ok");
  }
  expect("new: restore as postgres hits errors", Number(m.new_restore_as_postgres_errors) > 0);
  expect("new: restore as supabase_admin clean", Number(m.new_restore_as_supabase_admin_errors) === 0);

  return {
    id: `${ID}-pg${p.major}`,
    title: `CREATE OPERATOR non-built-in estimator (PG ${p.major}: ${p.oldTag} -> ${p.newTag})`,
    status: dev.length ? "fail" : "pass",
    detail: dev.length
      ? `deviations from the changelog's description: ${dev.join("; ")}`
      : "old: postgres attaches extension estimators; new: refused for postgres, accepted for supabase_admin, existing operators keep working, restore as postgres fails",
    measurements: m,
  };
}

const mod: TestModule = {
  id: ID,
  title: "CREATE OPERATOR with a non-built-in estimator, postgres vs supabase_admin",
  where: "local",
  requires: [],
  destructive: true,
  async run(_ctx: Ctx): Promise<TestResult[]> {
    const why = await skipReason();
    if (why) return [{ id: ID, title: this.title, status: "skip", detail: why }];
    const out: TestResult[] = [];
    for (const p of pairs()) {
      try {
        out.push(await runPair(p));
      } catch (e) {
        out.push({ id: `${ID}-pg${p.major}`, title: this.title, status: "fail", detail: `threw: ${(e as Error).message}` });
      }
    }
    return out;
  },
};

export default mod;
