/**
 * X01 - how much a dashboard Wrappers delete or edit removes.
 *
 * Studio lists one row per foreign SERVER but labels it with the foreign data
 * WRAPPER's name (pg-meta getFDWsSql: `w.fdwname as "name"`). Delete and Edit
 * both run `drop foreign data wrapper if exists <name> cascade`. A connection
 * created in the dashboard gets its own FDW, so that is one connection.
 * Connections created in SQL can share one FDW, and then one row's Delete or
 * Edit takes every server on it, their foreign tables, and anything built on
 * those tables.
 *
 * The Studio SQL is not hand-copied: lib/studio-sql.generated.ts is emitted by
 * scripts/gen-studio-sql.ts from Studio's own pg-meta functions, pinned to a
 * supabase/supabase commit. It runs through the Management API query endpoint;
 * nothing here clicks the dashboard.
 *
 * X01a  dashboard setup (Studio create x5), Studio delete on one row
 * X01b  shared FDW (SQL setup), Studio delete on one row
 * X01c  shared FDW, Studio edit on one row, saved unchanged
 * X01d  shared FDW, the SQL route: catalog queries, RESTRICT refusals, drop table + server
 * X01e  shared FDW, Studio create with the existing FDW's name
 *
 * X01a-d expect what the person acting on one row expects: one connection
 * gone, the other four intact. A fail there is the finding, not a harness bug.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { mgmt } from "../../../harness/src/mgmt";
import { STUDIO_COMMIT, STUDIO_SQL } from "../lib/studio-sql.generated";

const N = 5;

/** The two catalog queries in the removal guidance (RUNLOG, X01d), verbatim. */
export const GUIDE_LIST_CONNECTIONS = `select s.srvname as server, w.fdwname as wrapper
from pg_foreign_server s
join pg_foreign_data_wrapper w on w.oid = s.srvfdw
order by w.fdwname, s.srvname;`;
export const guideListTables = (server: string) => `select ft.ftrelid::regclass as foreign_table
from pg_foreign_table ft
join pg_foreign_server s on s.oid = ft.ftserver
where s.srvname = '${server}';`;

async function q(ctx: Ctx, sql: string): Promise<{ ok: boolean; rows: any[]; text: string }> {
  const res = await mgmt(ctx, "POST", `/projects/${ctx.ref}/database/query`, { query: sql });
  let rows: any[] = [];
  try {
    rows = JSON.parse(res.text);
  } catch {
    /* error bodies are not always JSON */
  }
  return { ok: res.status < 300, rows: Array.isArray(rows) ? rows : [], text: res.text.slice(0, 4000) };
}

async function must(ctx: Ctx, sql: string): Promise<any[]> {
  const r = await q(ctx, sql);
  if (!r.ok) throw new Error(`SQL failed: ${r.text}`);
  return r.rows;
}

/** First line of the Postgres error, out of the Management API's JSON error body. */
function errLine(text: string): string {
  let msg = text;
  try {
    msg = JSON.parse(text).message ?? text;
  } catch {
    /* truncated or non-JSON body: use it raw */
  }
  return (msg.match(/ERROR:[^\n]*/)?.[0] ?? msg).split("\\n")[0]!.trim();
}

/** Clean slate: every FDW with the prefix, its schema, and its Vault secrets. */
async function reset(ctx: Ctx, prefix: string, recreateSchema = true) {
  await must(
    ctx,
    `create extension if not exists wrappers with schema extensions;
     do $$ declare r record; begin
       for r in select fdwname from pg_foreign_data_wrapper where fdwname like '${prefix}%' loop
         execute format('drop foreign data wrapper %I cascade', r.fdwname);
       end loop;
     end $$;
     drop schema if exists "${prefix}ft" cascade;
     delete from vault.secrets where name like '${prefix}%';
     ${recreateSchema ? `create schema "${prefix}ft";` : ""}`,
  );
}

/**
 * Five servers on ONE FDW, the shape SQL setup produces: each server's key in
 * its own Vault secret, one foreign table per server, and on a sibling server
 * a view and a materialized view (with no data, so BigQuery is never queried).
 */
async function buildShared(ctx: Ctx, prefix: string) {
  await reset(ctx, prefix);
  const s = `${prefix}ft`;
  const stmts = [
    `create foreign data wrapper ${prefix}wrapper handler extensions.big_query_fdw_handler validator extensions.big_query_fdw_validator;`,
  ];
  for (let i = 1; i <= N; i++) {
    stmts.push(
      `do $$ declare k uuid; begin
         k := vault.create_secret('{}', '${prefix}server_${i}_key');
         execute format('create server ${prefix}server_${i} foreign data wrapper ${prefix}wrapper options (sa_key_id %L, project_id %L, dataset_id %L)', k, 'lab-project', 'lab_dataset');
       end $$;`,
      `create foreign table ${s}.t_${i} (id bigint, v text) server ${prefix}server_${i} options ("table" 't_${i}');`,
    );
  }
  stmts.push(
    `create view ${s}.v_sibling as select id from ${s}.t_2;`,
    `create materialized view ${s}.mv_sibling as select id from ${s}.t_3 with no data;`,
  );
  await must(ctx, stmts.join("\n"));
}

interface Counts {
  fdws: number;
  servers: number;
  tables: number;
  views: number;
  matviews: number;
  secrets: number;
}

async function count(ctx: Ctx, prefix: string): Promise<Counts> {
  const s = `${prefix}ft`;
  const rows = await must(
    ctx,
    `select
       (select count(*) from pg_foreign_data_wrapper where fdwname like '${prefix}%')::int as fdws,
       (select count(*) from pg_foreign_server where srvname like '${prefix}%')::int as servers,
       (select count(*) from pg_foreign_table ft join pg_class c on c.oid = ft.ftrelid
          join pg_namespace n on n.oid = c.relnamespace where n.nspname = '${s}')::int as tables,
       (select count(*) from pg_views where schemaname = '${s}')::int as views,
       (select count(*) from pg_matviews where schemaname = '${s}')::int as matviews,
       (select count(*) from vault.secrets where name like '${prefix}%')::int as secrets`,
  );
  return rows[0];
}

/** Studio's getFDWsSql, narrowed to this scenario: what the Wrappers list renders. */
async function studioList(ctx: Ctx, prefix: string): Promise<{ name: string; server_name: string }[]> {
  return must(
    ctx,
    `select w.fdwname as name, s.srvname as server_name
       from pg_catalog.pg_foreign_server s
       join pg_catalog.pg_foreign_data_wrapper w on s.srvfdw = w.oid
       join pg_catalog.pg_proc c on w.fdwhandler = c.oid
      where s.srvname like '${prefix}%' order by s.srvname`,
  );
}

const fmtCounts = (c: Counts) =>
  `servers ${c.servers}, foreign tables ${c.tables}, views ${c.views}, matviews ${c.matviews}, vault secrets ${c.secrets}, fdws ${c.fdws}`;

interface Scenario {
  id: string;
  title: string;
  prefix: string;
  build: (ctx: Ctx, prefix: string) => Promise<void>;
  /** Returns evidence lines. */
  act: (ctx: Ctx, row: { name: string; server_name: string }) => Promise<string[]>;
  /** Pass criterion on the after-counts. */
  expect: (before: Counts, after: Counts) => boolean;
}

async function run(ctx: Ctx, sc: Scenario): Promise<TestResult> {
  try {
    await sc.build(ctx, sc.prefix);
    const list = await studioList(ctx, sc.prefix);
    const before = await count(ctx, sc.prefix);
    const target = list[0]!;
    const actEvidence = await sc.act(ctx, target);
    const after = await count(ctx, sc.prefix);
    const survivors = await studioList(ctx, sc.prefix);
    const m: Record<string, number | string> = {
      list_rows: list.length,
      list_distinct_names: new Set(list.map((r) => r.name)).size,
    };
    for (const [k, v] of Object.entries(before)) m[`${k}_before`] = v;
    for (const [k, v] of Object.entries(after)) m[`${k}_after`] = v;
    return {
      id: sc.id,
      title: sc.title,
      status: sc.expect(before, after) ? "pass" : "fail",
      detail: `row "${target.name}" (server ${target.server_name}): ${fmtCounts(before)} -> ${fmtCounts(after)}`,
      measurements: m,
      evidence: [
        `studio sql: supabase/supabase ${STUDIO_COMMIT}`,
        `list before: ${JSON.stringify(list.map((r) => [r.name, r.server_name]))}`,
        `list after:  ${JSON.stringify(survivors.map((r) => [r.name, r.server_name]))}`,
        ...actEvidence,
      ].join("\n"),
    };
  } catch (e) {
    return { id: sc.id, title: sc.title, status: "fail", detail: `harness error: ${(e as Error).message}` };
  } finally {
    await reset(ctx, sc.prefix, false).catch(() => {});
  }
}

const oneGone = (b: Counts, a: Counts) => a.servers === b.servers - 1 && a.tables === b.tables - 1;

const studioAct = (sql: string, label: string) => async (ctx: Ctx) => {
  const r = await q(ctx, sql);
  return [`${label}: ok=${r.ok}${r.ok ? "" : ` ${errLine(r.text)}`}`];
};

const scenarios: Scenario[] = [
  {
    id: "X01a",
    title: "dashboard setup (FDW per connection): Studio delete on one row",
    prefix: "x01a_",
    build: async (ctx, prefix) => {
      await reset(ctx, prefix);
      for (const sql of STUDIO_SQL.a_create) await must(ctx, sql);
    },
    act: studioAct(STUDIO_SQL.a_delete, "studio delete"),
    expect: (b, a) => oneGone(b, a) && a.secrets === b.secrets - 1,
  },
  {
    id: "X01b",
    title: "shared FDW (SQL setup): Studio delete on one row",
    prefix: "x01b_",
    build: buildShared,
    act: studioAct(STUDIO_SQL.b_delete, "studio delete"),
    expect: oneGone,
  },
  {
    id: "X01c",
    title: "shared FDW: Studio edit on one row, saved unchanged",
    prefix: "x01c_",
    build: buildShared,
    act: studioAct(STUDIO_SQL.c_update, "studio edit"),
    expect: (b, a) => a.servers === b.servers && a.tables === b.tables,
  },
  {
    id: "X01d",
    title: "shared FDW: catalog queries, RESTRICT refusals, then drop foreign table + drop server",
    prefix: "x01d_",
    build: async (ctx, prefix) => {
      await buildShared(ctx, prefix);
      // A view on the server being removed, to show RESTRICT guards dependents of the table too.
      await must(ctx, `create view ${prefix}ft.v_target as select id from ${prefix}ft.t_1;`);
    },
    act: async (ctx, row) => {
      const s = "x01d_ft";
      const listed = await q(ctx, GUIDE_LIST_CONNECTIONS);
      const tables = await q(ctx, guideListTables(row.server_name));
      const dropFdw = await q(ctx, `drop foreign data wrapper ${row.name};`);
      const dropServer = await q(ctx, `drop server ${row.server_name};`);
      const dropTableWithView = await q(ctx, `drop foreign table ${s}.t_1;`);
      const ok = await q(ctx, `drop view ${s}.v_target; drop foreign table ${s}.t_1; drop server ${row.server_name};`);
      return [
        `guide step 1 (list connections): ok=${listed.ok} rows=${JSON.stringify(listed.rows.filter((r) => String(r.server).startsWith("x01d_")))}`,
        `guide step 2 (tables on ${row.server_name}): ok=${tables.ok} rows=${JSON.stringify(tables.rows)}`,
        `drop foreign data wrapper (no cascade): ok=${dropFdw.ok} ${errLine(dropFdw.text)}`,
        `drop server while its table exists: ok=${dropServer.ok} ${errLine(dropServer.text)}`,
        `drop foreign table while a view depends on it: ok=${dropTableWithView.ok} ${errLine(dropTableWithView.text)}`,
        `drop view, table, then server: ok=${ok.ok}${ok.ok ? "" : ` ${errLine(ok.text)}`}`,
      ];
    },
    // One connection gone (plus the view built on it), siblings and their views intact, secret left for the user.
    expect: (b, a) => oneGone(b, a) && a.views === b.views - 1 && a.matviews === b.matviews,
  },
  {
    id: "X01e",
    title: "shared FDW: Studio create reusing the existing FDW name",
    prefix: "x01e_",
    build: buildShared,
    act: studioAct(STUDIO_SQL.e_create_existing, "studio create"),
    // Refused and rolled back: nothing added, nothing removed, no Vault secret left behind.
    expect: (b, a) => a.servers === b.servers && a.tables === b.tables && a.secrets === b.secrets,
  },
];

const mod: TestModule = {
  id: "X01",
  title: "scope of a dashboard Wrappers delete / edit",
  where: "local",
  requires: ["pat"],
  destructive: true,

  async run(ctx: Ctx): Promise<TestResult[]> {
    await must(ctx, "create extension if not exists wrappers with schema extensions;");
    const pg = await q(ctx, "select current_setting('server_version') as pg, (select extversion from pg_extension where extname = 'wrappers') as wrappers");
    ctx.log(`postgres ${pg.rows[0]?.pg}, wrappers ${pg.rows[0]?.wrappers}`);
    const results: TestResult[] = [];
    for (const sc of scenarios) results.push(await run(ctx, sc));
    return results;
  },
};

export default mod;
