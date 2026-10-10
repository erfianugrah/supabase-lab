/**
 * PL05 - DDL propagation to a DuckLake destination.
 *
 * Docs claim (https://supabase.com/docs/guides/database/replication/pipelines/ducklake):
 * add / rename / drop column, drop NOT NULL, and add/change/remove supported
 * defaults are applied; tightening NOT NULL and unsupported defaults are
 * skipped with a warning; type changes are skipped with a warning in every
 * destination. This module runs each statement on a live table whose pipeline
 * is `ready` and reads the destination's column definitions through the
 * catalog.
 *
 * One table, 1000 seed rows, eleven statements in order. After each statement
 * one row shaped for the new schema is inserted; the step records the seconds
 * until that row is visible at the destination, the destination's definition of
 * the affected column, and the pipeline's table state. The type change and the out-of-range value run
 * last because a failing table would hide everything after it.
 *
 * Entity note: engine, not the managed service (see PL02).
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { beginPipeline, ensureFixture, openDuck, withCleanup } from "../lib/fixture.js";
import { replicatorLogs, replicatorRunning, sleep, tableStates, waitTablesReady, type SrcDb } from "../lib/stack.js";
import { lbl, round } from "../lib/util.js";

interface Step {
  id: string;
  name: string;
  ddl: string;
  /** Column whose destination definition is reported. */
  col: string;
  /** INSERT shaped for the schema after the DDL, with id = rowId. */
  ins: (rowId: number) => string;
  /** Optional extra probe: SQL against the destination, label. */
  probe?: { label: string; sql: string };
}

const T = "public.pl05_ddl";
const steps: Step[] = [
  { id: "PL05a", name: "add nullable column", ddl: `alter table ${T} add column e text`, col: "e", ins: (i) => `insert into ${T}(id,a,b,e) values (${i},'a',1,'e')` },
  {
    id: "PL05b", name: "add column with constant default", ddl: `alter table ${T} add column f int default 42`, col: "f",
    ins: (i) => `insert into ${T}(id,a,b) values (${i},'a',1)`,
    probe: { label: "f_on_old_row_1", sql: "select coalesce(f::text,'NULL') from lake.public.pl05_ddl where id = 1" },
  },
  { id: "PL05c", name: "add column with volatile default (gen_random_uuid())", ddl: `alter table ${T} add column g uuid default gen_random_uuid()`, col: "g", ins: (i) => `insert into ${T}(id,a,b) values (${i},'a',1)` },
  {
    id: "PL05d", name: "add NOT NULL column with default", ddl: `alter table ${T} add column h int not null default 7`, col: "h",
    ins: (i) => `insert into ${T}(id,a,b) values (${i},'a',1)`,
  },
  { id: "PL05e", name: "rename column", ddl: `alter table ${T} rename column c to c2`, col: "c2", ins: (i) => `insert into ${T}(id,a,b,c2) values (${i},'a',1,'renamed')` },
  { id: "PL05f", name: "drop column", ddl: `alter table ${T} drop column d`, col: "d", ins: (i) => `insert into ${T}(id,a,b) values (${i},'a',1)` },
  { id: "PL05g", name: "drop NOT NULL", ddl: `alter table ${T} alter column a drop not null`, col: "a", ins: (i) => `insert into ${T}(id,a,b) values (${i},null,1)` },
  {
    id: "PL05h", name: "set NOT NULL (tighten)", ddl: `update ${T} set e = 'x' where e is null; alter table ${T} alter column e set not null`, col: "e",
    ins: (i) => `insert into ${T}(id,a,b,e) values (${i},'a',1,'e')`,
  },
  { id: "PL05i", name: "set default", ddl: `alter table ${T} alter column b set default 9`, col: "b", ins: (i) => `insert into ${T}(id,a,e) values (${i},'a','e')`, probe: { label: "b_of_new_row_default", sql: "" } },
  { id: "PL05j", name: "drop default", ddl: `alter table ${T} alter column b drop default`, col: "b", ins: (i) => `insert into ${T}(id,a,b,e) values (${i},'a',2,'e')` },
  { id: "PL05k", name: "type change int to bigint, then a row whose value fits INTEGER", ddl: `alter table ${T} alter column b type bigint`, col: "b", ins: (i) => `insert into ${T}(id,a,b,e) values (${i},'a',1,'e')` },
  { id: "PL05l", name: "row with a value outside the INTEGER range, after the type change", ddl: "select 1", col: "b", ins: (i) => `insert into ${T}(id,a,b,e) values (${i},'a',5000000000,'e')` },
];

async function colDef(duck: { rows(sql: string): Promise<string[][]> }, col: string): Promise<string> {
  const rows = await duck.rows("describe lake.public.pl05_ddl");
  const r = rows.find((x) => x[0] === col);
  if (!r) return "absent";
  // column_name, column_type, null, key, default, extra
  return `${r[1]} null=${r[2]} default=${r[4] || "-"}`;
}

async function stateOf(db: SrcDb): Promise<string> {
  return (await tableStates(db, [T]).catch(() => ({}) as Record<string, string>))[T] ?? "?";
}

const mod: TestModule = {
  id: "PL05",
  title: "PL05 - DDL propagation",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const results: TestResult[] = [];
    const fx = await ensureFixture(ctx);
    const { db } = fx;
    await db.q(`drop table if exists ${T} cascade`);
    await db.q(`create table ${T} (id bigint primary key, a text not null, b int not null default 1, c text, d int)`);
    await db.q(`insert into ${T} select g, 'a' || g, 1, 'c' || g, g from generate_series(1, 1000) g`);
    await beginPipeline(fx, { tables: [T], tag: "pl05", maxFillMs: 1000 });
    const w = await waitTablesReady(db, [T], 300_000, 2000, ["sync_done", "ready"]);
    if (!w.ok) return [{ id: "PL05", title: "PL05 setup", status: "fail", detail: `copy: ${JSON.stringify(w.states)}` }];
    for (let i = 0; i < 30 && (await stateOf(db)) !== "ready"; i++) {
      await db.q(`update ${T} set b = b where id = 1`);
      await sleep(2000);
    }
    const duck = await openDuck();
    try {
      // baseline definition of every column
      const base = (await duck.rows("describe lake.public.pl05_ddl")).map((r) => `${r[0]}:${r[1]}:${r[2]}`).join(" ");
      results.push({
        id: "PL05-base",
        title: "PL05 baseline: destination column definitions after the initial copy",
        status: "info",
        measurements: { dest_columns: lbl(base, 200), source_not_null_columns: "id a b" },
      });
      let rowId = 10_000;
      for (const s of steps) {
        rowId += 1;
        const since = new Date(Date.now() - 1000).toISOString();
        const t0 = Date.now();
        let ddlErr = "";
        try {
          for (const stmt of s.ddl.split("; ")) await db.q(stmt);
        } catch (e) {
          ddlErr = e instanceof Error ? e.message : String(e);
        }
        const ddlMs = Date.now() - t0;
        if (!ddlErr) await db.q(s.ins(rowId));
        const t1 = Date.now();
        let visible = -1;
        while (!ddlErr && Date.now() - t1 < 60_000) {
          const n = await duck.scalar(`select count(*) from lake.public.pl05_ddl where id = ${rowId}`);
          if (n === "1") {
            visible = Date.now() - t1;
            break;
          }
          await sleep(700);
        }
        const def = await colDef(duck, s.col);
        let probe = "";
        if (s.probe?.sql) probe = await duck.scalar(s.probe.sql);
        if (s.id === "PL05i" && visible >= 0) {
          probe = await duck.scalar(`select coalesce(b::text,'NULL') from lake.public.pl05_ddl where id = ${rowId}`);
        }
        const st = await stateOf(db);
        const logs = (await replicatorLogs(since))
          .split("\n")
          .filter((l) => /WARN|ERROR/.test(l))
          .map((l) => l.replace(/\s+/g, " "));
        results.push({
          id: s.id,
          title: `${s.id}: ${s.name}`,
          status: "info",
          detail: ddlErr
            ? `source DDL failed: ${ddlErr.slice(0, 120)}`
            : visible >= 0
              ? `row after the statement visible at destination in ${round(visible / 1000, 1)} s`
              : "row after the statement NOT visible within 60 s",
          measurements: {
            source_ddl_ms: ddlMs,
            next_row_visible_s: visible >= 0 ? round(visible / 1000, 1) : -1,
            dest_column_after: lbl(`${s.col}: ${def}`),
            ...(s.probe ? { probe: lbl(`${s.probe.label}=${probe || "n/a"}`) } : {}),
            table_state_after: st,
            replicator_running_after: String(await replicatorRunning()),
            warn_or_error_log_lines: logs.length,
            first_log_line: lbl(logs[0] ?? "none", 200),
          },
        });
        if (st === "errored") {
          results.push({ id: `${s.id}-stop`, title: `${s.id}: table errored; later steps not run`, status: "info" });
          break;
        }
      }
      // after the type change: does anything else get through?
      const lastStep = results.filter((r) => r.id.startsWith("PL05") && /^PL05[a-l]$/.test(r.id)).at(-1);
      if (lastStep?.id === "PL05l") {
        const follow = rowId + 1;
        await db.q(`insert into ${T}(id,a,b,e) values (${follow},'a',1,'e')`);
        const tf = Date.now();
        let seenFollow = -1;
        while (Date.now() - tf < 120_000) {
          const n = await duck.scalar(`select count(*) from lake.public.pl05_ddl where id = ${follow}`);
          if (n === "1") {
            seenFollow = Date.now() - tf;
            break;
          }
          await sleep(1500);
        }
        const overflow = await duck.scalar(`select count(*) from lake.public.pl05_ddl where id = ${rowId}`);
        const lines = (await replicatorLogs(new Date(tf - 120_000).toISOString()))
          .split("\n")
          .filter((l) => /WARN|ERROR/.test(l))
          .map((l) => l.replace(/\s+/g, " "));
        results.push({
          id: "PL05m",
          title: "PL05m: a small-value row inserted after the out-of-range row",
          status: "info",
          detail: seenFollow >= 0 ? `later row visible after ${round(seenFollow / 1000, 1)} s` : "later row NOT visible within 120 s",
          measurements: {
            later_row_visible_s: seenFollow >= 0 ? round(seenFollow / 1000, 1) : -1,
            overflow_row_at_dest: overflow,
            table_state: await stateOf(db),
            replicator_running: String(await replicatorRunning()),
            warn_error_lines_last_2min: lines.length,
            last_line: lbl(lines.at(-1) ?? "none", 240),
          },
        });
      }
      const finalCols = (await duck.rows("describe lake.public.pl05_ddl")).map((r) => `${r[0]}:${r[1]}:${r[2]}`).join(" ");
      const srcCols = await db.q(
        `select column_name || ':' || data_type || ':' || is_nullable as c from information_schema.columns where table_schema='public' and table_name='pl05_ddl' order by ordinal_position`,
      );
      results.push({
        id: "PL05-final",
        title: "PL05 final: source and destination column lists",
        status: "info",
        measurements: { source_columns: lbl(srcCols.map((r) => r.c).join(" "), 220), dest_columns: lbl(finalCols, 220) },
      });
    } finally {
      duck.close();
    }
    return results;
  },
};

export default withCleanup(mod);
