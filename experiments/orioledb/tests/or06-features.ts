/**
 * OR06 - what an OrioleDB table accepts and refuses, and how the two table
 * access methods coexist in one project. Runs on an extra OrioleDB project
 * (`scratch`) so a statement that wedges the server cannot take the measured
 * pair with it.
 *
 *   OR06a  a battery of DDL/DML statements against a `USING orioledb` table,
 *          each recorded as `ok` or the server's error text (one measurement
 *          key per probe, `p_<name>`): secondary index types (gin on jsonb and
 *          tsvector, gist on a range and a point, brin, hash), CREATE INDEX
 *          CONCURRENTLY, expression / partial / unique / INCLUDE indexes,
 *          foreign keys in both directions with heap tables, triggers, row
 *          level security, isolation levels (SERIALIZABLE, REPEATABLE READ),
 *          SELECT ... FOR UPDATE SKIP LOCKED, TRUNCATE, UNLOGGED and TEMP
 *          tables, a partition, ADD/DROP COLUMN and ALTER TYPE, REPLICA
 *          IDENTITY FULL, a 1 MB TOASTed value, a table without a primary
 *          key, VACUUM, VACUUM FULL, CLUSTER, REINDEX, ANALYZE, pgvector's
 *          HNSW index, and `ALTER TABLE ... SET ACCESS METHOD heap` on an
 *          OrioleDB table. The heap-to-OrioleDB direction is OR08, not here.
 *   OR06b  both access methods in one project: a join across a heap and an
 *          OrioleDB table, one transaction writing both (commit, then
 *          rollback, row counts read back), and the transaction-id facts
 *          (`orioledb_get_current_oxid()` and its type, `pg_current_xact_id()`
 *          and its type, `age(datfrozenxid)`).
 *
 * Not settled: the 64-bit transaction-id claim itself. OR06b records types and
 * the values seen after a handful of transactions; nothing here runs the
 * counters anywhere near 2^32.
 */
import type { Client } from "pg";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { ensureExtra, skipWithoutOrg, tryQuery, withConn } from "../lib/pair";

const ID = "OR06";

interface Probe {
  name: string;
  sql: string[];
}

const SETUP = [
  "drop table if exists public.f_o, public.f_h, public.f_o2, public.f_part, public.f_u, public.f_nopk, public.f_vec, public.f_toast cascade",
  "create table public.f_o (id bigint primary key, j jsonb, t tsvector, r int4range, pt point, v text, n int) using orioledb",
  "insert into public.f_o values (1, '{\"a\":1}', to_tsvector('hello world'), int4range(1,5), point(1,1), 'x', 1)",
  "create table public.f_h (id bigint primary key, o_id bigint references public.f_o(id)) using heap",
];

const PROBES: Probe[] = [
  { name: "idx_gin_jsonb", sql: ["create index f_o_gin on public.f_o using gin (j)"] },
  { name: "idx_gin_tsvector", sql: ["create index f_o_gin2 on public.f_o using gin (t)"] },
  { name: "idx_gist_range", sql: ["create index f_o_gist on public.f_o using gist (r)"] },
  { name: "idx_gist_point", sql: ["create index f_o_gist2 on public.f_o using gist (pt)"] },
  { name: "idx_brin", sql: ["create index f_o_brin on public.f_o using brin (id)"] },
  { name: "idx_hash", sql: ["create index f_o_hash on public.f_o using hash (v)"] },
  { name: "idx_concurrently", sql: ["create index concurrently f_o_c on public.f_o (v)"] },
  { name: "idx_expression", sql: ["create index f_o_e on public.f_o (lower(v))"] },
  { name: "idx_partial", sql: ["create index f_o_p on public.f_o (n) where n > 0"] },
  { name: "idx_unique_secondary", sql: ["create unique index f_o_u on public.f_o (n)"] },
  { name: "idx_include", sql: ["create index f_o_i on public.f_o (n) include (v)"] },
  { name: "fk_heap_to_oriole", sql: ["insert into public.f_h values (1, 1)", "select 1 from public.f_h where o_id = 1"] },
  {
    name: "fk_oriole_to_heap",
    sql: ["create table public.f_o2 (id bigint primary key, h_id bigint references public.f_h(id)) using orioledb", "insert into public.f_o2 values (1, 1)"],
  },
  {
    name: "fk_violation_enforced",
    sql: ["insert into public.f_o2 values (2, 999)"], // expected to FAIL with a foreign key error; recorded as the error text
  },
  {
    name: "trigger_before_update",
    sql: [
      "create or replace function public.f_trg() returns trigger language plpgsql as $$ begin new.v := new.v || '!'; return new; end $$",
      "create trigger f_o_trg before update on public.f_o for each row execute function public.f_trg()",
      "update public.f_o set v = 'y' where id = 1",
    ],
  },
  { name: "rls_policy", sql: ["alter table public.f_o enable row level security", "create policy f_p on public.f_o for select using (true)", "alter table public.f_o disable row level security"] },
  { name: "isolation_serializable", sql: ["begin isolation level serializable", "select count(*) from public.f_o", "commit"] },
  { name: "isolation_repeatable_read", sql: ["begin isolation level repeatable read", "select count(*) from public.f_o", "update public.f_o set n = n where id = 1", "commit"] },
  { name: "for_update_skip_locked", sql: ["begin", "select id from public.f_o for update skip locked", "commit"] },
  { name: "truncate", sql: ["truncate public.f_o2"] },
  { name: "unlogged_table", sql: ["create unlogged table public.f_u (id int primary key) using orioledb"] },
  { name: "temp_table", sql: ["create temp table f_t (id int primary key) using orioledb"] },
  {
    name: "partition_child",
    sql: [
      "create table public.f_part (id int, d date, primary key (id, d)) partition by range (d)",
      "create table public.f_part_1 partition of public.f_part for values from ('2026-01-01') to ('2027-01-01') using orioledb",
      "insert into public.f_part values (1, '2026-05-05')",
    ],
  },
  { name: "add_column_default", sql: ["alter table public.f_o add column z int default 5"] },
  { name: "drop_column", sql: ["alter table public.f_o drop column z"] },
  { name: "alter_column_type", sql: ["alter table public.f_o alter column v type varchar(200)"] },
  { name: "replica_identity_full", sql: ["alter table public.f_o replica identity full"] },
  { name: "toast_1mb_value", sql: ["create table public.f_toast (id bigint primary key, v text) using orioledb", "insert into public.f_toast select 2, repeat('x', 1000000)", "select length(v) from public.f_toast where id = 2"] },
  { name: "no_primary_key", sql: ["create table public.f_nopk (a int, b text) using orioledb", "insert into public.f_nopk values (1, 'a')", "select count(*) from public.f_nopk"] },
  { name: "vacuum", sql: ["vacuum public.f_o"] },
  { name: "vacuum_full", sql: ["vacuum full public.f_o"] },
  { name: "cluster", sql: ["cluster public.f_o using f_o_pkey"] },
  { name: "reindex", sql: ["reindex table public.f_o"] },
  { name: "analyze", sql: ["analyze public.f_o"] },
  {
    name: "pgvector_hnsw",
    sql: [
      "create extension if not exists vector",
      "create table public.f_vec (id int primary key, e vector(3)) using orioledb",
      "insert into public.f_vec values (1, '[1,2,3]'), (2, '[4,5,6]')",
      "create index f_vec_h on public.f_vec using hnsw (e vector_l2_ops)",
      "select id from public.f_vec order by e <-> '[1,2,3]' limit 1",
    ],
  },
  { name: "set_access_method_to_heap", sql: ["alter table public.f_o set access method heap"] },
  { name: "set_access_method_to_same", sql: ["alter table public.f_o set access method orioledb"] },
];

async function runProbe(c: Client, p: Probe): Promise<string> {
  let last = "ok";
  for (const s of p.sql) {
    const r = await tryQuery(c, s);
    if (!r.ok) {
      last = p.name === "fk_violation_enforced" && /foreign key/.test(r.error) ? `enforced: ${r.error}` : r.error;
      await tryQuery(c, "rollback");
      return last;
    }
  }
  return last;
}

const mod: TestModule = {
  id: ID,
  title: "OrioleDB table feature battery, and heap and OrioleDB tables in one project",
  where: "local",
  requires: ["pat"],
  destructive: true,

  async run(ctx: Ctx): Promise<TestResult[]> {
    const skipped = skipWithoutOrg(ctx, ID, this.title, ["scratch"]);
    if (skipped) return skipped;
    const out: TestResult[] = [];
    const proj = await ensureExtra(ctx, "scratch");

    const m: Record<string, string | number> = {};
    await withConn(proj, async (c) => {
      for (const s of SETUP) await c.query(s);
      for (const p of PROBES) m[`p_${p.name}`] = await runProbe(c, p);
      await tryQuery(c, "drop table if exists public.f_o, public.f_h, public.f_o2, public.f_part, public.f_u, public.f_nopk, public.f_vec, public.f_toast cascade");
    });
    const okN = Object.values(m).filter((v) => v === "ok" || String(v).startsWith("enforced:")).length;
    m.probes = PROBES.length;
    m.probes_ok_or_enforced = okN;
    m.probes_refused = PROBES.length - okN;
    out.push({
      id: `${ID}a`,
      title: "OR06a: statements an OrioleDB table accepts or refuses",
      status: "info",
      detail: `${okN} of ${PROBES.length} probes behaved as expected (ok, or the foreign-key violation refused); the rest carry the server's error text`,
      measurements: m,
      evidence: JSON.stringify(PROBES, null, 1),
    });

    // OR06b - the two access methods in one project.
    const b = await withConn(proj, async (c) => {
      const o: Record<string, string | number> = {};
      await c.query("drop table if exists public.m_o, public.m_h cascade");
      await c.query("create table public.m_o (id bigint primary key, v text) using orioledb");
      await c.query("create table public.m_h (id bigint primary key, v text) using heap");
      await c.query("insert into public.m_o select g, 'o' from generate_series(1, 100) g");
      await c.query("insert into public.m_h select g, 'h' from generate_series(1, 100) g");
      const j = await tryQuery(c, "select count(*)::int as n from public.m_o o join public.m_h h using (id)");
      o.join_rows = j.ok ? Number(j.rows[0]?.n) : j.error;
      await c.query("begin");
      await c.query("insert into public.m_o values (1001, 'o')");
      await c.query("insert into public.m_h values (1001, 'h')");
      await c.query("commit");
      await c.query("begin");
      await c.query("insert into public.m_o values (1002, 'o')");
      await c.query("insert into public.m_h values (1002, 'h')");
      await c.query("rollback");
      const cnt = (await c.query("select (select count(*) from public.m_o where id > 1000)::int as o, (select count(*) from public.m_h where id > 1000)::int as h")).rows[0];
      o.mixed_txn_rows_after_commit_then_rollback_oriole = Number(cnt.o);
      o.mixed_txn_rows_after_commit_then_rollback_heap = Number(cnt.h);
      const x = await tryQuery(c, "begin");
      await c.query("insert into public.m_o values (1003, 'o')");
      const ids = await tryQuery(c, "select orioledb_get_current_oxid()::text as oxid, pg_typeof(orioledb_get_current_oxid())::text as oxid_type, pg_current_xact_id()::text as xid8, pg_typeof(pg_current_xact_id())::text as xid8_type");
      await c.query("rollback");
      void x;
      o.orioledb_current_oxid = ids.ok ? String(ids.rows[0]?.oxid) : ids.error;
      o.orioledb_current_oxid_type = ids.ok ? String(ids.rows[0]?.oxid_type) : "";
      o.pg_current_xact_id = ids.ok ? String(ids.rows[0]?.xid8) : "";
      o.pg_current_xact_id_type = ids.ok ? String(ids.rows[0]?.xid8_type) : "";
      const age = await tryQuery(c, "select age(datfrozenxid)::int as a from pg_database where datname = current_database()");
      o.database_xid_age = age.ok ? Number(age.rows[0]?.a) : age.error;
      await c.query("drop table if exists public.m_o, public.m_h cascade");
      return o;
    });
    out.push({
      id: `${ID}b`,
      title: "OR06b: heap and OrioleDB tables in one project",
      status: b.mixed_txn_rows_after_commit_then_rollback_oriole === 1 && b.mixed_txn_rows_after_commit_then_rollback_heap === 1 ? "pass" : "fail",
      detail: `join rows ${b.join_rows}; after one committed and one rolled-back transaction writing both: oriole ${b.mixed_txn_rows_after_commit_then_rollback_oriole}, heap ${b.mixed_txn_rows_after_commit_then_rollback_heap}`,
      measurements: b,
    });
    return out;
  },
};

export default mod;
