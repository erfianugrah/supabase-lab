/**
 * CL03 - what `declarative sync` does with edits, with a hand-written tree, and
 * what pg-delta does not manage.
 *
 *   CL03a  edits to an exported tree: a new column, a dropped policy, a changed
 *          policy predicate, a changed function body, a new table in a new file
 *          whose policy calls a function declared in another file, and a deleted
 *          table file. `sync --no-apply` output is counted by statement kind;
 *          `sync --apply` then applies it and the migration history, the
 *          catalog and a second `sync` are read back.
 *   CL03b  a hand-written tree (no export, no load order file) whose file names
 *          sort in the WRONG dependency order (policies before the table and
 *          function they reference): does `sync` order by dependency or by file
 *          name?
 *   CL03c  object-kind coverage: 22 kinds that Postgres schemas carry beyond
 *          tables and policies, created in one database, then diffed with
 *          `--use-migra`, `--use-pg-delta` and `--use-pg-delta --strict-coverage`
 *          and exported with `declarative generate [--strict-coverage]`. Per
 *          kind: does the kind's marker name appear in each engine's output.
 *   CL03d  engine mixing: with an exported tree present, `db diff --use-migra`.
 *
 * Local vantage, Docker required.
 */
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { cliVersion, dockerReachable, noCli, stamp, saveRaw, scrub, tail } from "../lib/cli";
import { fingerprint } from "../lib/fingerprint";
import { diffSql, pgExec, startFixtureProject, teardown } from "../lib/fixture";

const kinds = (sql: string) => {
  const n = (re: RegExp) => (sql.match(re) ?? []).length;
  return {
    add_column: n(/add column/gi),
    drop_policy: n(/drop policy/gi),
    create_policy: n(/create policy/gi),
    alter_policy: n(/alter policy/gi),
    create_function: n(/create (or replace )?function/gi),
    create_table: n(/^create table/gim),
    drop_table: n(/^drop table/gim),
    drop_other: n(/^drop (?!table|policy)/gim),
  };
};

/** One probe per kind: [marker, sql]. Each runs on its own so a missing extension skips one kind. */
const EXOTIC: Array<[string, string]> = [
  ["domain", `create domain exo.cl03_domain as text check (value <> '')`],
  ["composite", `create type exo.cl03_composite as (a int, b text)`],
  ["range", `create type exo.cl03_range as range (subtype = float8)`],
  ["enum", `create type exo.cl03_enum as enum ('a','b')`],
  ["matview", `create materialized view exo.cl03_matview as select 1 as one`],
  ["partitioned", `create table exo.cl03_part (id int, d date) partition by range (d); create table exo.cl03_part_2026 partition of exo.cl03_part for values from ('2026-01-01') to ('2027-01-01')`],
  ["inherits", `create table exo.cl03_parent (id int); create table exo.cl03_child (extra int) inherits (exo.cl03_parent)`],
  ["unlogged", `create unlogged table exo.cl03_unlogged (id int)`],
  ["storage_params", `create table exo.cl03_fillfactor (id int) with (fillfactor = 70)`],
  ["rule", `create table exo.cl03_rule_t (id int); create rule cl03_rule as on insert to exo.cl03_rule_t do instead nothing`],
  ["statistics", `create table exo.cl03_stats_t (a int, b int); create statistics exo.cl03_stats (dependencies) on a, b from exo.cl03_stats_t`],
  ["aggregate", `create function exo.cl03_sfunc(int, int) returns int language sql immutable as 'select $1 + $2'; create aggregate exo.cl03_agg (int) (sfunc = exo.cl03_sfunc, stype = int)`],
  ["operator", `create function exo.cl03_opf(int, int) returns bool language sql immutable as 'select $1 = $2'; create operator exo.=== (leftarg = int, rightarg = int, function = exo.cl03_opf)`],
  ["cast", `create function exo.cl03_castf(text) returns exo.cl03_composite language sql immutable as $$ select (1, $1)::exo.cl03_composite $$; create cast (text as exo.cl03_composite) with function exo.cl03_castf(text)`],
  ["collation", `create collation exo.cl03_collation (provider = libc, locale = 'C')`],
  ["tsconfig", `create text search configuration exo.cl03_tsconfig (copy = pg_catalog.simple)`],
  ["publication", `create table exo.cl03_pub_t (id int primary key); create publication cl03_publication for table exo.cl03_pub_t`],
  ["event_trigger", `create function exo.cl03_evt() returns event_trigger language plpgsql as 'begin null; end'; create event trigger cl03_event_trigger on ddl_command_end execute function exo.cl03_evt()`],
  ["role", `do $$ begin if not exists (select 1 from pg_roles where rolname = 'cl03_role') then create role cl03_role nologin; end if; end $$; grant usage on schema exo to cl03_role`],
  ["role_setting", `alter role authenticated set statement_timeout = '7s'`],
  ["schema_comment", `comment on schema exo is 'cl03 exotic schema'`],
  ["foreign_table", `create extension if not exists postgres_fdw; create server cl03_server foreign data wrapper postgres_fdw options (host 'localhost', dbname 'postgres'); create foreign table exo.cl03_foreign (id int) server cl03_server options (schema_name 'public', table_name 'nothing')`],
];

const MARK: Record<string, RegExp> = {
  domain: /cl03_domain/i,
  composite: /cl03_composite/i,
  range: /cl03_range/i,
  enum: /cl03_enum/i,
  matview: /cl03_matview/i,
  partitioned: /cl03_part_2026/i,
  inherits: /inherits\s*\(.*cl03_parent/i,
  unlogged: /unlogged/i,
  storage_params: /fillfactor/i,
  rule: /cl03_rule\b/i,
  statistics: /cl03_stats\b/i,
  aggregate: /cl03_agg\b/i,
  operator: /===/,
  cast: /create cast/i,
  collation: /cl03_collation/i,
  tsconfig: /cl03_tsconfig/i,
  publication: /cl03_publication/i,
  event_trigger: /cl03_event_trigger/i,
  role: /cl03_role/i,
  role_setting: /statement_timeout/i,
  schema_comment: /cl03 exotic schema/i,
  foreign_table: /cl03_foreign/i,
};

const mod: TestModule = {
  id: "CL03",
  title: "Declarative sync: edits, hand-written tree order, object-kind coverage, engine mixing",
  where: "local",
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!(await dockerReachable())) return [{ id: "CL03", title: this.title, status: "skip", detail: "no Docker daemon reachable from this vantage" }];
    const ver = await cliVersion();
    if (ver === "absent") return [noCli("CL03", this.title)];
    const out: TestResult[] = [];

    // ======================= CL03a + CL03d: edits on an exported tree =======================
    let a: Awaited<ReturnType<typeof startFixtureProject>> | undefined;
    try {
      a = await startFixtureProject("cl03a", 2);
      const { p } = a;
      const tree = join(p.dir, "supabase", "schemas");
      const migDir = join(p.dir, "supabase", "migrations");
      await p.sb(["db", "schema", "declarative", "generate", "--local", "--output-format", "text"]);

      // CL03d first: the exported tree exists, the migrations baseline is empty
      const mix = await p.sb(["db", "diff", "--use-migra", "--output-format", "text"]);
      const mixPd = await p.sb(["db", "diff", "--use-pg-delta", "--output-format", "json"]);
      out.push({
        id: "CL03d",
        title: "Engine mixing: db diff --use-migra with an exported declarative tree present",
        status: "info",
        detail: `--use-migra exit ${mix.code}${mix.code !== 0 ? `: ${tail(scrub(mix.all), 3).replace(/\n/g, " | ")}` : ""}; --use-pg-delta exit ${mixPd.code}`,
        measurements: {
          migra_exit_with_tree: mix.code,
          migra_error_line: mix.code !== 0 ? (scrub(mix.all).split("\n").find((l) => /^ERROR/i.test(l)) ?? "") : "",
          migra_mentions_declarative: /declarative schemas/i.test(mix.all) ? 1 : 0,
          pgdelta_exit_with_tree: mixPd.code,
        },
        evidence: tail(scrub(mix.all), 8),
      });

      // baseline: migrations + DB agree with the tree
      await p.sb(["db", "schema", "declarative", "sync", "--no-apply", "--name", "baseline", "--output-format", "text"]);
      await p.sb(["db", "reset", "--local", "--yes", "--output-format", "text"]);

      // edits
      const docs = join(tree, "app", "tables", "docs.sql");
      appendFileSync(docs, `\nALTER TABLE "app"."docs"\n  ADD COLUMN "archived_at" timestamp with time zone;\n`);
      let docsSrc = readFileSync(docs, "utf8");
      docsSrc = docsSrc.replace(/CREATE POLICY "docs_anon_live"[\s\S]*?;\n\n/, "");
      docsSrc = docsSrc.replace(/(CREATE POLICY "docs_select"[\s\S]*?USING \()\(owner_id = \( SELECT auth\.uid\(\) AS uid\)\)\)/, "$1(owner_id = ( SELECT auth.uid() AS uid)) OR (status = 'live'::app.status))");
      writeFileSync(docs, docsSrc);
      const fn = join(tree, "app", "functions", "doc_count.sql");
      writeFileSync(fn, readFileSync(fn, "utf8").replace("select count(*) from", "select count(*) + 0 from"));
      writeFileSync(
        join(tree, "aa_tags.sql"),
        `CREATE TABLE app.tags (id int PRIMARY KEY, doc_id bigint NOT NULL REFERENCES app.docs(id), label text);\nALTER TABLE app.tags ENABLE ROW LEVEL SECURITY;\nCREATE POLICY tags_read ON app.tags FOR SELECT TO authenticated USING (app.doc_count('00000000-0000-0000-0000-000000000000') >= 0);\nGRANT SELECT ON app.tags TO authenticated;\n`,
      );
      rmSync(join(tree, "public", "tables", "profiles.sql"));

      const s1 = await p.sb(["db", "schema", "declarative", "sync", "--no-apply", "--name", "edits", "--output-format", "text"]);
      const migsA = readdirSync(migDir).filter((f) => f.endsWith("_edits.sql"));
      const editsSql = migsA[0] ? readFileSync(join(migDir, migsA[0]), "utf8") : "";
      saveRaw("cl03a-edits-migration.sql", editsSql);
      const k = kinds(editsSql);
      const expect = { add_column: 1, drop_policy: 1, create_table: 1, drop_table: 1 };
      out.push({
        id: "CL03a",
        title: "sync --no-apply after edits to the exported tree",
        status: s1.code === 0 && migsA.length === 1 ? "info" : "fail",
        detail: `exit ${s1.code}; migration: ${Object.entries(k).filter(([, v]) => v).map(([n, v]) => `${n}=${v}`).join(", ")}`,
        measurements: {
          exit: s1.code,
          sync_ms: s1.ms,
          edited_tree_files: 5,
          ...Object.fromEntries(Object.entries(k).map(([n, v]) => [`stmt_${n}`, v])),
          expected_add_column: expect.add_column,
          expected_drop_table: expect.drop_table,
          warns_on_destructive: /Found destructive changes/i.test(s1.all) ? 1 : 0,
          destructive_warning_lists: (s1.all.match(/^DROP .*$/gm) ?? []).join(" | ").slice(0, 200),
        },
        evidence: tail(scrub(s1.all), 6),
      });

      // apply path
      if (s1.code === 0 && migsA.length === 1) {
        rmSync(join(migDir, migsA[0]!));
        const s2 = await p.sb(["db", "schema", "declarative", "sync", "--apply", "--name", "edits", "--output-format", "text"]);
        const list = await p.sb(["migration", "list", "--local", "--output-format", "text"]);
        const s3 = await p.sb(["db", "schema", "declarative", "sync", "--no-apply", "--name", "after", "--output-format", "text"]);
        const fp = (await fingerprint(p.dbUrl)).join("\n");
        const historyRows = (list.all.match(/^\s*`?(\d{14})`?\s*\|\s*`?\1`?/gm) ?? []).length;
        out.push({
          id: "CL03a-apply",
          title: "sync --apply: history, catalog and a second sync",
          status: "info",
          detail: `apply exit ${s2.code}; migration list rows with both Local and Remote set: ${historyRows}; second sync: ${/no schema changes/i.test(s3.all) ? "no changes" : "changes"}`,
          measurements: {
            apply_exit: s2.code,
            apply_ms: s2.ms,
            migration_list_rows: historyRows,
            expected_rows_baseline_plus_edits: 2,
            archived_at_column_present: /app\.docs\.archived_at/.test(fp) ? 1 : 0,
            anon_live_policy_present: /docs_anon_live/.test(fp) ? 1 : 0,
            tags_table_present: /rel app\.tags /.test(fp) ? 1 : 0,
            profiles_table_present: /rel public\.profiles /.test(fp) ? 1 : 0,
            second_sync_no_changes: /no schema changes/i.test(s3.all) ? 1 : 0,
          },
          evidence: tail(scrub(list.all), 6),
        });
      }
    } catch (e) {
      out.push({ id: "CL03a", title: "sync after edits", status: "fail", detail: `threw: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      await teardown(a?.p);
    }

    // ======================= CL03b + CL03c: clean project =======================
    let b: Awaited<ReturnType<typeof startFixtureProject>> | undefined;
    try {
      b = await startFixtureProject("cl03b", 3, false);
      const { p } = b;
      const tree = join(p.dir, "supabase", "schemas");
      const migDir = join(p.dir, "supabase", "migrations");

      // ---- CL03b: hand-written tree, file names sort against dependency order ----
      mkdirSync(tree, { recursive: true });
      writeFileSync(join(tree, "01_policies.sql"), `create policy notes_read on public.cl03_notes for select to authenticated using (public.cl03_visible(owner));\ngrant select on public.cl03_notes to authenticated;\n`);
      writeFileSync(join(tree, "02_functions.sql"), `create function public.cl03_visible(o uuid) returns boolean language sql stable as $$ select o = auth.uid() $$;\n`);
      writeFileSync(join(tree, "03_tables.sql"), `create table public.cl03_notes (id int primary key, owner uuid not null);\nalter table public.cl03_notes enable row level security;\n`);
      const hw = await p.sb(["db", "schema", "declarative", "sync", "--no-apply", "--name", "handwritten", "--output-format", "text"]);
      const hwMig = readdirSync(migDir).filter((f) => f.endsWith("_handwritten.sql"))[0];
      const hwSql = hwMig ? readFileSync(join(migDir, hwMig), "utf8") : "";
      saveRaw("cl03b-handwritten-migration.sql", hwSql);
      const pos = (re: RegExp) => hwSql.search(re);
      out.push({
        id: "CL03b",
        title: "Hand-written tree, file names sorted against dependency order",
        status: "info",
        detail: `exit ${hw.code}; ${hwMig ? "migration written" : "no migration"}${hw.code !== 0 ? `: ${tail(scrub(hw.all), 2).replace(/\n/g, " | ")}` : ""}`,
        measurements: {
          exit: hw.code,
          migration_written: hwMig ? 1 : 0,
          table_before_policy: pos(/create table "?public"?\."?cl03_notes/i) >= 0 && pos(/create table "?public"?\."?cl03_notes/i) < pos(/create policy "?notes_read/i) ? 1 : 0,
          function_before_policy: pos(/create (or replace )?function public\.cl03_visible/i) >= 0 && pos(/create (or replace )?function public\.cl03_visible/i) < pos(/create policy "?notes_read/i) ? 1 : 0,
          policy_present: /create policy "notes_read"/i.test(hwSql) ? 1 : 0,
          // the declared `grant select ... to authenticated` is merged into the platform default grant list for the table
          grant_to_authenticated_on_table: /grant [^;]*on table "public"\."cl03_notes" to [^;]*"authenticated"/i.test(hwSql) ? 1 : 0,
          // formatter: a column named `owner` is printed as OWNER inside the policy expression
          policy_expr_uppercases_column: /cl03_visible\(OWNER\)/.test(hwSql) ? 1 : 0,
        },
        evidence: tail(scrub(hw.all), 6),
      });

      // ---- CL03c: object-kind coverage ----
      rmSync(tree, { recursive: true, force: true });
      rmSync(migDir, { recursive: true, force: true });
      await pgExec(p.dbUrl, "create schema exo");
      const created: string[] = [];
      const notCreated: Record<string, string> = {};
      for (const [kind, sqlText] of EXOTIC) {
        try {
          await pgExec(p.dbUrl, sqlText);
          created.push(kind);
        } catch (e) {
          notCreated[kind] = (e instanceof Error ? e.message : String(e)).slice(0, 90);
        }
      }
      const migra = await p.sb(["db", "diff", "--use-migra", "--output-format", "json"]);
      const pgd = await p.sb(["db", "diff", "--use-pg-delta", "--output-format", "json"]);
      const strict = await p.sb(["db", "diff", "--use-pg-delta", "--strict-coverage", "--output-format", "text"]);
      const gen = await p.sb(["db", "schema", "declarative", "generate", "--local", "--output-dir", join(p.dir, "exo-tree"), "--output-format", "text"]);
      const genStrict = await p.sb(["db", "schema", "declarative", "generate", "--local", "--strict-coverage", "--output-dir", join(p.dir, "exo-tree-strict"), "--output-format", "text"]);
      const m = diffSql(migra).sql;
      const g = diffSql(pgd).sql;
      let treeText = "";
      try {
        const walk = (d: string) => {
          for (const e of readdirSync(d, { withFileTypes: true })) {
            const q = join(d, e.name);
            if (e.isDirectory()) walk(q);
            else treeText += readFileSync(q, "utf8") + "\n";
          }
        };
        walk(join(p.dir, "exo-tree"));
      } catch {
        // export may have failed; treeText stays empty
      }
      saveRaw("cl03c-migra.sql", m);
      saveRaw("cl03c-pgdelta.sql", g);
      saveRaw("cl03c-strict-diff.txt", scrub(strict.all));
      saveRaw("cl03c-strict-generate.txt", scrub(genStrict.all));
      const matrix: Record<string, string> = {};
      let inMigra = 0;
      let inPgd = 0;
      let inTree = 0;
      for (const kind of created) {
        const re = MARK[kind]!;
        const a1 = re.test(m);
        const b1 = re.test(g);
        const c1 = re.test(treeText);
        if (a1) inMigra++;
        if (b1) inPgd++;
        if (c1) inTree++;
        matrix[kind] = `${a1 ? "M" : "-"}${b1 ? "D" : "-"}${c1 ? "T" : "-"}`;
      }
      out.push({
        id: "CL03c",
        title: "Object-kind coverage: migra diff (M), pg-delta diff (D), declarative export (T)",
        status: "info",
        detail: `${created.length} of ${EXOTIC.length} kinds created; named in diff: migra ${inMigra}, pg-delta ${inPgd}; in export ${inTree}; --strict-coverage diff exit ${strict.code}, generate exit ${genStrict.code}`,
        measurements: {
          kinds_attempted: EXOTIC.length,
          kinds_created: created.length,
          kinds_not_created: JSON.stringify(notCreated),
          kinds_named_by_migra: inMigra,
          kinds_named_by_pgdelta: inPgd,
          kinds_named_in_export: inTree,
          matrix_MDT: JSON.stringify(matrix),
          pgdelta_diff_exit: pgd.code,
          migra_diff_exit: migra.code,
          export_exit: gen.code,
          strict_diff_exit: strict.code,
          strict_generate_exit: genStrict.code,
          strict_diff_first_error: strict.code !== 0 ? (scrub(strict.all).split("\n").find((l) => /coverage|unmanaged|cannot manage|not manage/i.test(l)) ?? tail(scrub(strict.all), 1)) : "",
        },
        evidence: tail(scrub(strict.all), 10),
      });
    } catch (e) {
      out.push({ id: "CL03b", title: "hand-written tree / coverage", status: "fail", detail: `threw: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      await teardown(b?.p);
    }
    return stamp(out, ver);
  },
};

export default mod;
