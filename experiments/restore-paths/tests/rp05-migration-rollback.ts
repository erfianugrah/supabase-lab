/**
 * RP05 - undoing a release through the Management API migrations routes
 * instead of a restore.
 *
 * The published OpenAPI document carries `DELETE database/migrations?gte=<v>`
 * ("Rollback database migrations and remove them from history table") and a
 * `rollback` field on the apply and upsert bodies, with no description of what
 * the DELETE runs. This module reads what it does to the schema, the data and
 * the history on one throwaway Pro project (default compute).
 *
 *   RP05a  apply M1 (create table + rollback `drop table`), insert a row,
 *          apply M2 (add column + rollback `drop column`), apply M3 (create a
 *          second table, NO rollback field). Versions as listed by history.
 *          `GET migrations/{v}` for M2: are `statements` and `rollback` stored?
 *   RP05b  DELETE ?gte=M3 (no rollback stored): HTTP, history after, does
 *          M3's table still exist?
 *   RP05c  DELETE ?gte=M2: HTTP, history after, is M2's column gone, is
 *          M1's table and its row intact?
 *   RP05d  apply M4 (add column + rollback that errors), DELETE ?gte=M4:
 *          HTTP and body, history after, does M4's column survive?
 *   RP05e  a failing apply (second statement errors): HTTP, does the first
 *          statement's table exist, is the version in history? (sfp-platforms
 *          S04 recorded the transactional apply on 2026-08-24.)
 *   RP05g  the same on a git-less preview branch of the project: apply B1-B3
 *          there, DELETE ?gte=B2, read schema, data and history.
 *   RP05h  cleanup: branch deleted, then the project (RP05f).
 *
 * DESTRUCTIVE (creates and deletes a project and a branch). Cost: Micro
 * compute and one preview branch for one to two minutes (R11, R12). Not measured: the CLI's `migration repair`, a branch merge,
 * rollback of a migration other sessions have written to since.
 */
import { mgmt } from "../../../harness/src/mgmt";
import { sql } from "../../../harness/src/platform";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { createProject, deleteProject, errText, randomPassword, sleep, waitProjectStatus } from "../lib/rp";

async function history(ctx: Ctx): Promise<{ version: string; name?: string }[]> {
  const r = await mgmt(ctx, "GET", `/projects/${ctx.ref}/database/migrations`);
  return Array.isArray(r.json) ? (r.json as { version: string; name?: string }[]) : [];
}

const names = (h: { version: string; name?: string }[]) => h.map((x) => x.name ?? x.version).join(",") || "(empty)";

async function apply(ctx: Ctx, name: string, query: string, rollback?: string) {
  // Versions are YYYYMMDDHHMMSS; keep two applies out of the same second.
  await sleep(1500);
  const r = await mgmt(ctx, "POST", `/projects/${ctx.ref}/database/migrations`, { name, query, ...(rollback ? { rollback } : {}) });
  const v = (await history(ctx)).find((x) => x.name === name)?.version ?? "";
  return { status: r.status, text: r.text.slice(0, 200), version: v };
}

async function rollbackGte(ctx: Ctx, version: string) {
  const r = await mgmt(ctx, "DELETE", `/projects/${ctx.ref}/database/migrations?gte=${version}`);
  return { status: r.status, text: r.text.slice(0, 200) };
}

async function exists(ctx: Ctx, q: string): Promise<string> {
  const r = await sql(ctx, q);
  return r.status === 201 ? String(r.rows[0]?.x ?? "?") : `HTTP ${r.status} ${r.error.slice(0, 80)}`;
}
const tableExists = (ctx: Ctx, t: string) => exists(ctx, `select (to_regclass('public.${t}') is not null)::text as x`);
const columnExists = (ctx: Ctx, t: string, c: string) =>
  exists(ctx, `select exists(select 1 from information_schema.columns where table_schema='public' and table_name='${t}' and column_name='${c}')::text as x`);

const mod: TestModule = {
  id: "RP05",
  title: "Migration rollback route: what DELETE database/migrations?gte= does to schema, data and history",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(base: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];
    const org = base.orgs.pro ?? "";
    if (!org) return [{ id: "RP05", title: "RP05", status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    let ref = "";
    let branchRef = "";
    try {
      const created = await createProject(base, org, `rp-rp05-${Date.now().toString(36)}`, randomPassword());
      ref = created.ref;
      if (!ref) return [{ id: "RP05a", title: "create", status: "fail", detail: `HTTP ${created.status} ${created.text}` }];
      const healthy = await waitProjectStatus(base, ref, "ACTIVE_HEALTHY", 10 * 60_000);
      if (!healthy.ok) return [{ id: "RP05a", title: "create", status: "fail", detail: `not healthy: ${healthy.last}` }];
      const ctx: Ctx = { ...base, ref };

      // ---- RP05a ----
      const m1 = await apply(ctx, "rp05_m1", "create table public.rp_m (id int primary key, a text)", "drop table if exists public.rp_m");
      const ins = await sql(ctx, "insert into public.rp_m values (1, 'kept')");
      const m2 = await apply(ctx, "rp05_m2", "alter table public.rp_m add column b text", "alter table public.rp_m drop column if exists b");
      const m3 = await apply(ctx, "rp05_m3", "create table public.rp_m3 (id int)");
      const g2 = await mgmt(ctx, "GET", `/projects/${ref}/database/migrations/${m2.version}`);
      const g3 = await mgmt(ctx, "GET", `/projects/${ref}/database/migrations/${m3.version}`);
      const j2 = (g2.json ?? {}) as { statements?: string[]; rollback?: unknown };
      const j3 = (g3.json ?? {}) as { statements?: string[]; rollback?: unknown };
      out.push({
        id: "RP05a",
        title: "three migrations applied, two with a rollback field",
        status: m1.status < 300 && m2.status < 300 && m3.status < 300 ? "info" : "fail",
        detail: `apply HTTP ${m1.status}/${m2.status}/${m3.status}; history [${names(await history(ctx))}]`,
        measurements: {
          m1_http: m1.status,
          m2_http: m2.status,
          m3_http: m3.status,
          versions: `${m1.version},${m2.version},${m3.version}`,
          seed_row_insert_http: ins.status,
          m2_get_http: g2.status,
          m2_statements: JSON.stringify(j2.statements ?? null).slice(0, 140),
          m2_rollback_stored: JSON.stringify(j2.rollback ?? null).slice(0, 140),
          m3_rollback_stored: JSON.stringify(j3.rollback ?? null).slice(0, 140),
        },
      });
      if (!m3.version || !m2.version) return out;

      // ---- RP05b ----
      const d3 = await rollbackGte(ctx, m3.version);
      out.push({
        id: "RP05b",
        title: "DELETE ?gte=M3 where M3 stored no rollback",
        status: "info",
        detail: `HTTP ${d3.status}; history [${names(await history(ctx))}]; rp_m3 exists ${await tableExists(ctx, "rp_m3")}`,
        measurements: {
          delete_http: d3.status,
          delete_body: d3.text,
          history_after: names(await history(ctx)),
          m3_table_exists_after: await tableExists(ctx, "rp_m3"),
        },
      });

      // ---- RP05c ----
      const d2 = await rollbackGte(ctx, m2.version);
      const row = await sql(ctx, "select a from public.rp_m where id = 1");
      out.push({
        id: "RP05c",
        title: "DELETE ?gte=M2 where M2 stored `drop column`",
        status: "info",
        detail: `HTTP ${d2.status}; history [${names(await history(ctx))}]; column b exists ${await columnExists(ctx, "rp_m", "b")}`,
        measurements: {
          delete_http: d2.status,
          delete_body: d2.text,
          history_after: names(await history(ctx)),
          m2_column_exists_after: await columnExists(ctx, "rp_m", "b"),
          m1_table_exists_after: await tableExists(ctx, "rp_m"),
          m1_row_after: row.status === 201 ? String(row.rows[0]?.a ?? "(no row)") : `HTTP ${row.status} ${row.error.slice(0, 80)}`,
        },
      });

      // ---- RP05d ----
      const m4 = await apply(ctx, "rp05_m4", "alter table public.rp_m add column c text", "alter table public.rp_m drop column c; select 1/0");
      const d4 = m4.version ? await rollbackGte(ctx, m4.version) : { status: -1, text: "no version" };
      out.push({
        id: "RP05d",
        title: "DELETE ?gte=M4 where M4's rollback errors after its first statement",
        status: "info",
        detail: `apply HTTP ${m4.status}; DELETE HTTP ${d4.status}; column c exists ${await columnExists(ctx, "rp_m", "c")}`,
        measurements: {
          m4_http: m4.status,
          delete_http: d4.status,
          delete_body: d4.text,
          history_after: names(await history(ctx)),
          m4_column_exists_after: await columnExists(ctx, "rp_m", "c"),
        },
      });

      // ---- RP05e ----
      const m5 = await apply(ctx, "rp05_m5", "create table public.rp_m5 (id int); select 1/0");
      out.push({
        id: "RP05e",
        title: "failing apply: second statement errors",
        status: "info",
        detail: `apply HTTP ${m5.status}; rp_m5 exists ${await tableExists(ctx, "rp_m5")}; in history ${m5.version ? "yes" : "no"}`,
        measurements: {
          apply_http: m5.status,
          apply_body: m5.text,
          m5_table_exists_after: await tableExists(ctx, "rp_m5"),
          m5_in_history: m5.version ? "yes" : "no",
          history_after: names(await history(ctx)),
        },
      });

      // ---- RP05g: the same rollback on a git-less preview branch ----
      const tb = Date.now();
      const bc = await mgmt(ctx, "POST", `/projects/${ref}/branches`, { branch_name: "rp05-probe", region: "ap-southeast-1", with_data: false }, 180_000);
      branchRef = String((bc.json as { project_ref?: string } | undefined)?.project_ref ?? "");
      if (!branchRef) {
        out.push({ id: "RP05g", title: "branch create", status: "fail", detail: `HTTP ${bc.status} ${bc.text.slice(0, 160)}` });
        return out;
      }
      let bStatus = "";
      let healthyS: number | string = "never";
      while (Date.now() - tb < 15 * 60_000) {
        const g = await mgmt(ctx, "GET", `/branches/${branchRef}`);
        bStatus = String((g.json as { status?: string } | undefined)?.status ?? `HTTP ${g.status}`);
        if (bStatus === "ACTIVE_HEALTHY") {
          healthyS = Math.round((Date.now() - tb) / 1000);
          break;
        }
        await sleep(10_000);
      }
      const bctx: Ctx = { ...base, ref: branchRef };
      // The parent's history is replayed onto the branch; wait for it so the branch's own versions sort after it.
      for (let i = 0; i < 36 && !(await history(bctx)).some((x) => x.name === "rp05_m4"); i++) await sleep(10_000);
      const pulled = names(await history(bctx));
      const b1 = await apply(bctx, "rp05_b1", "create table public.rp_b (id int primary key, a text)", "drop table if exists public.rp_b");
      await sql(bctx, "insert into public.rp_b values (1, 'kept')");
      const b2 = await apply(bctx, "rp05_b2", "alter table public.rp_b add column b text", "alter table public.rp_b drop column if exists b");
      const b3 = await apply(bctx, "rp05_b3", "create table public.rp_b3 (id int)");
      const before = names(await history(bctx));
      const db2 = b2.version ? await rollbackGte(bctx, b2.version) : { status: -1, text: "no version" };
      const brow = await sql(bctx, "select a from public.rp_b where id = 1");
      out.push({
        id: "RP05g",
        title: "DELETE ?gte= on a git-less preview branch: B2 stored `drop column`, B3 stored no rollback",
        status: "info",
        detail: `branch ${bStatus} after ${healthyS}s; DELETE HTTP ${db2.status}; column b exists ${await columnExists(bctx, "rp_b", "b")}; rp_b3 exists ${await tableExists(bctx, "rp_b3")}`,
        measurements: {
          branch_create_http: bc.status,
          branch_status: bStatus,
          branch_healthy_s: healthyS,
          branch_poll_resolution_s: 10,
          history_pulled_from_parent: pulled,
          b_apply_http: `${b1.status}/${b2.status}/${b3.status}`,
          history_before: before,
          delete_http: db2.status,
          delete_body: db2.text,
          history_after: names(await history(bctx)),
          b2_column_exists_after: await columnExists(bctx, "rp_b", "b"),
          b3_table_exists_after: await tableExists(bctx, "rp_b3"),
          b1_table_exists_after: await tableExists(bctx, "rp_b"),
          b1_row_after: brow.status === 201 ? String(brow.rows[0]?.a ?? "(no row)") : `HTTP ${brow.status} ${brow.error.slice(0, 80)}`,
        },
      });
    } catch (e) {
      out.push({ id: "RP05", title: "RP05 aborted", status: "fail", detail: `threw: ${errText(e)}` });
    } finally {
      if (branchRef) {
        const bd = await mgmt(base, "DELETE", `/branches/${branchRef}`).catch(() => ({ status: -1 }));
        out.push({ id: "RP05h", title: "cleanup: branch deleted", status: bd.status >= 200 && bd.status < 300 ? "info" : "fail", detail: `DELETE HTTP ${bd.status}` });
        await sleep(20_000);
      }
      if (ref) {
        const del = await deleteProject(base, ref).catch(() => -1);
        out.push({ id: "RP05f", title: "cleanup: project deleted", status: del >= 200 && del < 300 ? "info" : "fail", detail: `DELETE HTTP ${del}` });
      }
    }
    return out;
  },
};

export default mod;
