/**
 * MS15 - a Supabase preview branch as a staging environment for a schema that
 * Prisma owns (`prisma db push`), with no `supabase/migrations`.
 *
 * Branching applies the repository's migration files; a Prisma-managed
 * schema has none. Rows:
 *
 *   MS15a  `POST /projects/{ref}/branches {branch_name, persistent: true}`
 *          with no git integration: status, then time to `ACTIVE_HEALTHY` and
 *          the branch's own connection facts (host, port, user, Postgres
 *          version, compute).
 *   MS15b  `prisma db push` (6.19) against the branch's connection string,
 *          one row inserted on the branch; the parent's `public.ms_record`
 *          resolves to null (isolation).
 *   MS15c  `GET /branches/{id}/diff` against the parent: what the platform
 *          reports for a schema that arrived by `db push`.
 *   MS15d  `POST /branches/{id}/merge`: status and body, i.e. what merging a
 *          branch with no migration files does.
 *   MS15e  branch deleted; seconds until it leaves the list.
 *
 * DESTRUCTIVE and BILLABLE: a branch is a project and bills its compute while
 * it exists (bounded here). Not settled: GitHub-connected branches (the
 * github-branching experiment), and data seeding.
 */
import { $ } from "bun";
import { resolve } from "node:path";
import { mgmt } from "../../../harness/src/mgmt";
import { sql } from "../../../harness/src/platform";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { errText, pgClient, primaryPooler, sleep } from "../lib/setup";

const DIR = process.env.PVLAB_PRISMA_DIR ?? resolve(process.cwd(), "prisma");
const NAME = "ms15-staging";
const HEALTHY_MAX_MS = 12 * 60_000;

interface BranchDetail {
  ref?: string;
  postgres_version?: string;
  status?: string;
  db_host?: string;
  db_port?: number;
  db_user?: string;
  db_pass?: string;
}

const mod: TestModule = {
  id: "MS15",
  title: "Preview branch as staging with a Prisma-pushed schema: create, push, isolation, diff, merge, delete",
  where: "local",
  requires: ["pat", "db"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];
    let branchId = "";
    try {
      const t0 = Date.now();
      let tCreated = t0;
      // The create call itself took longer than the harness default of 30 s on
      // the first run (2026-09-30) and the branch was created anyway, so: a
      // long timeout, and adopt a branch of this name if one already exists.
      // The poll budget counts from NOW; only healthy_s counts from created_at
      // (the second run set the budget from created_at and never polled).
      const existing = await mgmt(ctx, "GET", `/projects/${ctx.ref}/branches`, undefined, 120_000);
      const prior = (Array.isArray(existing.json) ? (existing.json as { id?: string; name?: string; created_at?: string }[]) : []).find((b) => b.name === NAME);
      let cr: { status: number; json?: unknown; text: string };
      let adopted = false;
      if (prior?.id) {
        adopted = true;
        cr = { status: 200, json: prior, text: "adopted existing branch" };
        if (prior.created_at) tCreated = Date.parse(prior.created_at);
      } else {
        cr = await mgmt(ctx, "POST", `/projects/${ctx.ref}/branches`, { branch_name: NAME, persistent: true }, 180_000);
      }
      const cj = (cr.json ?? {}) as { id?: string; project_ref?: string; status?: string };
      branchId = cj.id ?? "";
      let det: BranchDetail = {};
      let healthyS: number | string = "never";
      if (branchId) {
        while (Date.now() - t0 < HEALTHY_MAX_MS) {
          const g = await mgmt(ctx, "GET", `/branches/${branchId}`, undefined, 120_000).catch(() => ({ status: 0, json: undefined, text: "" }));
          det = (g.json ?? {}) as BranchDetail;
          if (det.status === "ACTIVE_HEALTHY" && det.db_host) {
            healthyS = Math.round((Date.now() - tCreated) / 1000);
            break;
          }
          await sleep(10_000);
        }
      }
      const addons = branchId && det.ref ? await mgmt(ctx, "GET", `/projects/${det.ref}/billing/addons`, undefined, 60_000).catch(() => null) : null;
      const compute = ((addons?.json ?? {}) as { selected_addons?: { type: string; variant?: { id?: string } }[] }).selected_addons?.find((a) => a.type === "compute_instance")?.variant?.id ?? (addons ? "none (micro)" : "unread");
      out.push({
        id: "MS15a",
        title: "create a persistent branch without git; time to ACTIVE_HEALTHY; its connection facts",
        status: cr.status < 300 && healthyS !== "never" ? "pass" : "fail",
        detail: cr.status >= 300 ? `create refused HTTP ${cr.status}: ${cr.text.slice(0, 200)}` : `${adopted ? "adopted the branch left by the previous run (healthy_s counted from its created_at)" : `HTTP ${cr.status}`}; healthy after ${healthyS}s; Postgres ${det.postgres_version ?? "?"}; db ${det.db_host ? "host returned" : "no host"}:${det.db_port ?? "?"} user ${det.db_user ? "returned" : "?"}; compute ${compute}`,
        measurements: { create_http: cr.status, adopted: String(adopted), healthy_s: healthyS, postgres_version: det.postgres_version ?? "", db_port: det.db_port ?? "", db_user_shape: (det.db_user ?? "").replace(/\.[a-z]{20}$/, ".<branch-ref>"), compute, status: det.status ?? "" },
        evidence: cr.status >= 300 ? cr.text.slice(0, 500) : "",
      });
      if (!branchId || healthyS === "never") return out;

      // MS15b - prisma db push against the branch, isolation from the parent
      // The branch's `db_host` is `db.<branch-ref>.supabase.co`, IPv6-only from
      // this vantage (no IPv4 add-on on a branch). Its Supavisor tenant on the
      // regional shared pooler, session mode, is the IPv4 path: user
      // `postgres.<branch-ref>`, same password.
      const parentPooler = await primaryPooler(ctx);
      const branchRef = det.ref ?? "";
      const poolerHost = parentPooler?.db_host ?? `aws-0-${ctx.region}.pooler.supabase.com`;
      const branchTarget = { name: "branch_pooler_5432", host: poolerHost, port: 5432, user: `postgres.${branchRef}` };
      const url = `postgres://${encodeURIComponent(branchTarget.user)}:${encodeURIComponent(det.db_pass ?? "")}@${branchTarget.host}:${branchTarget.port}/postgres?sslmode=require`;
      const t1 = Date.now();
      const push = await $`bunx prisma db push --skip-generate --accept-data-loss`.cwd(DIR).env({ ...process.env, DATABASE_URL: url, DIRECT_URL: url }).quiet().nothrow();
      const pushMs = Date.now() - t1;
      let inserted = "";
      const c = pgClient(branchTarget, det.db_pass ?? "", 15_000);
      try {
        await c.connect();
        const r = await c.query<{ id: number }>("insert into ms_record(tenant_id, name) values ('tenant-a','on-branch') returning id");
        inserted = `row ${r.rows[0]?.id}`;
      } catch (e) {
        inserted = `insert failed: ${errText(e)}`;
      } finally {
        await c.end().catch(() => {});
      }
      const parent = await sql(ctx, "select to_regclass('public.ms_record')::text as t");
      const parentHas = parent.rows[0]?.t != null;
      out.push({
        id: "MS15b",
        title: "prisma db push on the branch; a row on the branch; the parent has no such table",
        status: push.exitCode === 0 && !parentHas ? "pass" : "fail",
        detail: `db push exit ${push.exitCode} in ${pushMs} ms; ${inserted}; parent public.ms_record: ${parentHas ? "EXISTS (isolation broken)" : "absent"}${push.exitCode ? ` - ${(push.stderr.toString() + push.stdout.toString()).slice(-200)}` : ""}`,
        measurements: { push_exit: push.exitCode, push_ms: pushMs, branch_insert: inserted, parent_table: parentHas ? "present" : "absent" },
      });

      // MS15c - diff
      const diff = await mgmt(ctx, "GET", `/branches/${branchId}/diff`, undefined, 180_000).catch((e) => ({ status: 0, text: `ERR ${errText(e)}` }));
      out.push({
        id: "MS15c",
        title: "GET /branches/{id}/diff for a db-push schema",
        status: "info",
        detail: `HTTP ${diff.status}, ${diff.text.length} chars${diff.text.length ? `: ${diff.text.replace(/\s+/g, " ").slice(0, 200)}` : ""}`,
        measurements: { diff_http: diff.status, diff_chars: diff.text.length, mentions_ms_record: String(diff.text.includes("ms_record")) },
        evidence: diff.text.slice(0, 1500),
      });

      // MS15d - merge
      const merge = await mgmt(ctx, "POST", `/branches/${branchId}/merge`, {}, 180_000).catch((e) => ({ status: 0, text: `ERR ${errText(e)}` }));
      out.push({
        id: "MS15d",
        title: "POST /branches/{id}/merge with no migration files",
        status: "info",
        detail: `HTTP ${merge.status}: ${merge.text.replace(/\s+/g, " ").slice(0, 250)}`,
        measurements: { merge_http: merge.status },
        evidence: merge.text.slice(0, 800),
      });
      await sleep(20_000);
      const parentAfter = await sql(ctx, "select to_regclass('public.ms_record')::text as t");
      out.push({
        id: "MS15d2",
        title: "parent schema after merge",
        status: "info",
        detail: `parent public.ms_record: ${parentAfter.rows[0]?.t != null ? "present" : "absent"} 20 s after the merge call`,
        measurements: { parent_table_after_merge: parentAfter.rows[0]?.t != null ? "present" : "absent" },
      });
    } finally {
      if (branchId) {
        const t2 = Date.now();
        let del = await mgmt(ctx, "DELETE", `/branches/${branchId}`).catch(() => ({ status: 0, text: "" }));
        let delNote = `DELETE HTTP ${del.status}`;
        if (del.status === 422) {
          // The second run got 422 on a persistent branch; try un-persisting first.
          const un = await mgmt(ctx, "PATCH", `/branches/${branchId}`, { persistent: false }).catch(() => ({ status: 0, text: "" }));
          del = await mgmt(ctx, "DELETE", `/branches/${branchId}`).catch(() => ({ status: 0, text: "" }));
          delNote = `first DELETE 422 (${("text" in del ? "" : "")}${String((del as { text?: string }).text ?? "").slice(0, 120)}); PATCH persistent=false HTTP ${un.status}; second DELETE HTTP ${del.status}`;
        }
        let goneS: number | string = "never";
        while (Date.now() - t2 < 5 * 60_000) {
          const l = await mgmt(ctx, "GET", `/projects/${ctx.ref}/branches`, undefined, 120_000).catch(() => ({ status: 0, json: undefined }));
          const still = Array.isArray(l.json) && (l.json as { id?: string }[]).some((b) => b.id === branchId);
          if (!still) {
            goneS = Math.round((Date.now() - t2) / 1000);
            break;
          }
          await sleep(10_000);
        }
        out.push({ id: "MS15e", title: "branch deleted", status: goneS !== "never" ? "pass" : "fail", detail: `${delNote}; gone from the list after ${goneS}s`, measurements: { delete_http: del.status, gone_s: goneS, delete_note: delNote.slice(0, 200) } });
      }
      await sql(ctx, "drop table if exists public.ms_record").catch(() => {});
    }
    return out;
  },
};
export default mod;
