/**
 * RP10 - PITR on Micro, whether enabling PITR restarts Postgres, and whether a
 * second database survives a PITR restore (work-supabase-lab#329).
 *
 * RP02 created its project at Small because the docs said PITR needs at least
 * Small; that requirement was never tested. Two follow-on questions with no
 * run behind them: whether turning PITR on restarts the database, and whether
 * databases other than `postgres` are covered by backups.
 *
 *   RP10a  pitr_7 on a Micro project: HTTP status and text. If Micro is
 *          refused, resize to Small and record that path instead
 *   RP10b  pg_postmaster_start_time() before the PITR PATCH and after
 *          pitr_enabled reads true; the backups view before and after
 *          (walg_enabled, pitr_enabled, physical backups listed)
 *   RP10c  `create database rp10_extra` with a table, rows written through the
 *          Supavisor session pooler to that database: marker A, target T,
 *          marker B. restore-pitr to T (retried while the archive lags), then
 *          does rp10_extra exist, and which markers are in it; the same for
 *          a marker table in `postgres` as the control
 *
 * DESTRUCTIVE and BILLABLE (pitr_7 for about an hour). pitr_7 removed and the
 * project deleted in finally.
 */
import { Client } from "pg";
import { mgmt } from "../../../harness/src/mgmt";
import { sql } from "../../../harness/src/platform";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import {
  addMarker,
  applyPitr7,
  backups,
  createProject,
  deleteProject,
  errText,
  markerLabels,
  randomPassword,
  seedData,
  sleep,
  subjectOf,
  waitProjectStatus,
  type BackupView,
  type Subject,
} from "../lib/rp";

const PITR_READY_MAX_MS = 30 * 60_000;
const ACCEPT_RETRY_MS = 20 * 60_000;
const EXTRA = "rp10_extra";

const view = (b: BackupView) => `walg ${b.walg}, pitr ${b.pitr}, physical backups ${b.physicalIds.length}, window ${b.windowEarliest ?? "none"}..${b.windowLatest ?? "none"}`;

async function startTime(s: Subject): Promise<string> {
  const r = await sql(s.ctx, "select extract(epoch from pg_postmaster_start_time())::bigint as t");
  return r.status === 201 && r.rows[0] ? String(r.rows[0].t) : `unreadable HTTP ${r.status} ${r.error ?? ""}`.slice(0, 80);
}

async function extraDb(s: Subject, password: string, query: string): Promise<{ ok: boolean; rows: Record<string, unknown>[]; error: string }> {
  const c = new Client({
    host: s.pooler.host, port: 5432, user: s.pooler.user, password, database: EXTRA,
    ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 20_000, query_timeout: 30_000,
  });
  c.on("error", () => {});
  try {
    await c.connect();
    const r = await c.query(query);
    return { ok: true, rows: r.rows as Record<string, unknown>[], error: "" };
  } catch (e) {
    return { ok: false, rows: [], error: errText(e).slice(0, 140) };
  } finally {
    await c.end().catch(() => {});
  }
}

const mod: TestModule = {
  id: "RP10",
  title: "PITR on Micro, the restart question, and a second database across a PITR restore",
  where: "local",
  requires: ["pat"],
  destructive: true,
  timeoutMs: 90 * 60_000,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const org = ctx.orgs.pro;
    if (!org) return [{ id: "RP10", title: this.title, status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    const out: TestResult[] = [];
    const pw = randomPassword();
    let ref = "";
    let pitrOn = false;
    try {
      const created = await createProject(ctx, org, `rp-rp10-${Date.now().toString(36)}`, pw);
      ref = created.ref;
      if (!ref) return [{ id: "RP10a", title: "create", status: "fail", detail: `HTTP ${created.status} ${created.text}` }];
      const healthy = await waitProjectStatus(ctx, ref, "ACTIVE_HEALTHY", 10 * 60_000);
      if (!healthy.ok) throw new Error(`not healthy: ${healthy.last}`);
      const s = await subjectOf(ctx, ref);
      const sizeOf = async () => {
        const a = await mgmt(ctx, "GET", `/projects/${ref}/billing/addons`);
        const sel = ((a.json as { selected_addons?: { type: string; variant?: { id?: string } }[] } | undefined)?.selected_addons ?? []).find((x) => x.type === "compute_instance");
        return sel?.variant?.id ?? `none selected (HTTP ${a.status})`;
      };
      const size = await sizeOf();
      await seedData(s);

      // ---- RP10a/b: PITR on Micro, restart check ----
      const b0 = await backups(s);
      const st0 = await startTime(s);
      const t0 = Date.now();
      let enable = await applyPitr7(ctx, ref);
      let path = `pitr_7 on ${size}`;
      if (enable.status >= 300) {
        const micro = enable;
        const rs = await mgmt(ctx, "PATCH", `/projects/${ref}/billing/addons`, { addon_type: "compute_instance", addon_variant: "ci_small" });
        await sleep(30_000);
        await waitProjectStatus(ctx, ref, "ACTIVE_HEALTHY", 15 * 60_000);
        path = `refused on ${size} (HTTP ${micro.status} ${micro.text.slice(0, 120)}); resized to Small (HTTP ${rs.status}), then pitr_7`;
        enable = await applyPitr7(ctx, ref);
      }
      pitrOn = enable.status < 300;
      const stBeforePatch = path.startsWith("refused") ? await startTime(s) : st0;
      let b1 = await backups(s);
      let enabledS: number | string = b1.pitr ? 0 : "never";
      while (pitrOn && enabledS === "never" && Date.now() - t0 < PITR_READY_MAX_MS) {
        await sleep(15_000);
        b1 = await backups(s);
        if (b1.pitr) enabledS = Math.round((Date.now() - t0) / 1000);
      }
      const st1 = await startTime(s);
      const sizeAfter = await sizeOf();
      out.push({
        id: "RP10a",
        title: "pitr_7 on a Micro project",
        status: "info",
        detail: `Project created with compute add-on ${size} (GET billing/addons). ${path}: HTTP ${enable.status} ${enable.text.slice(0, 120)}; pitr_enabled after ${enabledS} s (15 s poll); compute add-on after ${sizeAfter}.`,
        measurements: { created_size: size, size_after_pitr: sizeAfter, path: path.slice(0, 200), pitr_http: enable.status, pitr_enabled_after_s: enabledS },
      });
      out.push({
        id: "RP10b",
        title: "does enabling PITR restart Postgres, and what the backups view shows",
        status: "info",
        detail: `pg_postmaster_start_time (epoch s) just before the PITR PATCH ${stBeforePatch}, after pitr_enabled ${st1}: ${stBeforePatch === st1 ? "unchanged, no restart" : "changed, Postgres restarted"}. Backups view before: ${view(b0)}; after: ${view(b1)}.`,
        measurements: { start_before: stBeforePatch, start_after: st1, restarted: String(stBeforePatch !== st1), view_before: view(b0), view_after: view(b1) },
      });
      if (!pitrOn || enabledS === "never") return out;

      // ---- RP10c: a second database across a PITR restore ----
      const mk = await sql(s.ctx, `create database ${EXTRA}`);
      await sleep(5_000);
      const t1 = await extraDb(s, pw, "create table rp10_m (label text primary key, at timestamptz default now()); insert into rp10_m(label) values ('A')");
      await addMarker(s, "ctl-A");
      // The target sits 30 s after A; restore-pitr is retried below while the
      // archive has not reached it (RP02's approach).
      await sleep(30_000);
      const target = Math.floor(Date.now() / 1000);
      await sleep(15_000);
      const t2 = await extraDb(s, pw, "insert into rp10_m(label) values ('B')");
      await addMarker(s, "ctl-B");
      const before = await extraDb(s, pw, "select string_agg(label, ',' order by label) as l from rp10_m");

      const tr = Date.now();
      let r = await mgmt(ctx, "POST", `/projects/${ref}/database/backups/restore-pitr`, { recovery_time_target_unix: target });
      const attempts = [`0s HTTP ${r.status} ${r.text.slice(0, 80)}`];
      while ((r.status < 200 || r.status >= 300) && Date.now() - tr < ACCEPT_RETRY_MS) {
        await sleep(60_000);
        r = await mgmt(ctx, "POST", `/projects/${ref}/database/backups/restore-pitr`, { recovery_time_target_unix: target });
        attempts.push(`${Math.round((Date.now() - tr) / 1000)}s HTTP ${r.status} ${r.text.slice(0, 80)}`);
      }
      const accepted = r.status >= 200 && r.status < 300;
      let back = { ok: false, ms: 0, last: "not restored" };
      if (accepted) {
        await sleep(60_000);
        back = await waitProjectStatus(ctx, ref, "ACTIVE_HEALTHY", 40 * 60_000);
      }
      // ACTIVE_HEALTHY is not readiness: retry the reads.
      let after = { ok: false, rows: [] as Record<string, unknown>[], error: "" };
      let exists = "unknown";
      let ctl = "";
      for (let i = 0; i < 20; i++) {
        const e = await sql(s.ctx, `select count(*)::int as n from pg_database where datname = '${EXTRA}'`);
        if (e.status === 201) {
          exists = String(Number(e.rows[0]?.n ?? 0) === 1);
          ctl = await markerLabels(s);
          after = exists === "true" ? await extraDb(s, pw, "select string_agg(label, ',' order by label) as l from rp10_m") : after;
          if (exists === "false" || after.ok) break;
        }
        await sleep(15_000);
      }
      out.push({
        id: "RP10c",
        title: "a second database across a PITR restore",
        status: accepted ? "info" : "fail",
        detail: `create database ${EXTRA} -> ${mk.status === 201 ? "ok" : `HTTP ${mk.status} ${mk.error}`}; table + marker A through the pooler to ${EXTRA} -> ${t1.ok ? "ok" : t1.error}; marker B after the target -> ${t2.ok ? "ok" : t2.error}; ${EXTRA} before the restore [${String(before.rows[0]?.l ?? before.error)}]. restore-pitr to the target: ${attempts.join(" | ")}; healthy after ${Math.round(back.ms / 1000)} s (${back.last}). After: ${EXTRA} exists ${exists}; its markers [${after.ok ? String(after.rows[0]?.l ?? "") : after.error || "-"}]; control rp_marker in postgres [${ctl}].`,
        measurements: {
          create_database: mk.status === 201 ? "ok" : `HTTP ${mk.status}`,
          extra_write_via_pooler: t1.ok ? "ok" : t1.error.slice(0, 80),
          extra_before: String(before.rows[0]?.l ?? before.error).slice(0, 40),
          restore_accepted: String(accepted),
          restore_attempts: attempts.length,
          healthy_after_s: Math.round(back.ms / 1000),
          extra_exists_after: exists,
          extra_markers_after: after.ok ? String(after.rows[0]?.l ?? "") : `error: ${after.error.slice(0, 80)}`,
          control_markers_after: ctl.slice(0, 80),
        },
      });
    } catch (e) {
      out.push({ id: "RP10x", title: "RP10 aborted", status: "fail", detail: errText(e) });
    } finally {
      if (ref) {
        const rm = pitrOn ? (await mgmt(ctx, "DELETE", `/projects/${ref}/billing/addons/pitr_7`).catch(() => ({ status: -1 }))).status : "-";
        const del = await deleteProject(ctx, ref);
        out.push({ id: "RP10z", title: "teardown", status: del >= 200 && del < 300 ? "info" : "fail", detail: `DELETE pitr_7 HTTP ${rm}; DELETE project HTTP ${del}` });
      }
    }
    return out;
  },
};
export default mod;
