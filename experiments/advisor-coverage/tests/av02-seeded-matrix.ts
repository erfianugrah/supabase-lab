/**
 * AV02 - seed one deliberate issue per fixture (lib/fixtures.ts), run
 * audit.sql read-only, poll the advisors until their answer settles, and
 * classify every fixture: caught by both, the audit only, the advisors only,
 * or neither. The cell is decided by the category's own checks and lints;
 * any other finding on the same object is listed beside it.
 *
 *   AV02s     seeding: per-fixture SQL errors, the Data API schema PATCH that
 *             exposes av_api (F03), the exposed-schema setting read back as
 *             postgres and on authenticator, and whether anon can EXECUTE the
 *             F09 function after REVOKE ... FROM PUBLIC
 *   AV02a     audit.sql after seeding: rows, rows per check, every row
 *   AV02b     advisors after seeding: polls until two consecutive answers
 *             match (30 s apart, at most 12 polls), seconds until the first
 *             seeded object appeared and until settled, every lint. Both
 *             timings count from the first advisor poll, which follows the
 *             setting poll and the audit: they are not latency from the DDL.
 *   AV02-Fxx  one row per fixture: observed cell, predicted cell, the audit
 *             rows and lints that decided it, incidental findings
 *   AV02      totals per observed cell and prediction hits
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import { brief, currentProject, ensureProject, redact, skipWithoutPro, sql, type DdProject } from "../../data-api-defaults/lib/project.js";
import { EXTRA_EXPOSED_SCHEMA, FIXTURES } from "../lib/fixtures.js";
import { classify, lintHits } from "../lib/matrix.js";
import { auditLines, auditOnce, fetchAdvisors, keySet, lintLines, tally, type Advisors } from "../lib/run.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const mod: TestModule = {
  id: "AV02",
  title: "Seeded fixtures: audit.sql vs the advisors, per fixture",
  where: "local",
  requires: ["pat", "org"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const skip = skipWithoutPro(ctx, "AV02");
    if (skip) return skip;
    let p: DdProject;
    try {
      p = await ensureProject(ctx);
    } catch (e) {
      return [{ id: "AV02", title: "AV02", status: "fail", detail: `provision: ${e instanceof Error ? e.message : String(e)}` }];
    }
    const red = (s: string, n = 6000) => brief(currentProject(), s, n);
    const results: TestResult[] = [];

    // ---- AV02s seeding ----
    const seedErr: Record<string, string> = {};
    for (const f of FIXTURES) {
      const r = await sql(ctx, p.ref, f.sql);
      if (r.error) seedErr[f.id] = red(r.error, 200);
    }
    const pg0 = await mgmt(ctx, "GET", `/projects/${p.ref}/postgrest`);
    const before = String((pg0.json as { db_schema?: string } | undefined)?.db_schema ?? "");
    const want = before.split(",").map((s) => s.trim()).filter(Boolean);
    if (!want.includes(EXTRA_EXPOSED_SCHEMA)) want.push(EXTRA_EXPOSED_SCHEMA);
    const patch = await mgmt(ctx, "PATCH", `/projects/${p.ref}/postgrest`, { db_schema: want.join(",") });
    let settingNow = "";
    let authNow = "";
    const tPatch = Date.now();
    for (let i = 0; i < 12; i++) {
      const s = await sql(
        ctx,
        p.ref,
        `select current_setting('pgrst.db_schemas', true) as pg,
                (select string_agg(x, ' | ') from pg_db_role_setting s join pg_roles r on r.oid = s.setrole, unnest(s.setconfig) x
                  where r.rolname = 'authenticator' and x like 'pgrst.db_schemas=%') as auth`,
      );
      settingNow = String(s.rows?.[0]?.pg ?? "(unset)");
      authNow = String(s.rows?.[0]?.auth ?? "(not set on the role)");
      if (settingNow.includes(EXTRA_EXPOSED_SCHEMA) || authNow.includes(EXTRA_EXPOSED_SCHEMA)) break;
      await sleep(5_000);
    }
    await sql(ctx, p.ref, "notify pgrst, 'reload schema'");
    const f09 = await sql(
      ctx,
      p.ref,
      `select has_function_privilege('anon', 'public.av_f09_definer_revoked_public()', 'EXECUTE') as anon_exec,
              has_function_privilege('authenticated', 'public.av_f09_definer_revoked_public()', 'EXECUTE') as auth_exec,
              (select array_to_string(proacl, ',') from pg_proc where proname = 'av_f09_definer_revoked_public') as acl`,
    );
    const f09r = f09.rows?.[0] ?? {};
    results.push({
      id: "AV02s",
      title: "AV02s: seeding, exposed schemas, F09 privileges",
      status: Object.keys(seedErr).length === 0 && patch.status < 300 ? "info" : "fail",
      detail: `${FIXTURES.length - Object.keys(seedErr).length}/${FIXTURES.length} fixtures seeded; PATCH /postgrest ${patch.status}`,
      measurements: {
        fixtures: FIXTURES.length,
        seed_errors: Object.keys(seedErr).length,
        db_schema_before: before,
        db_schema_patched: want.join(","),
        patch_status: patch.status,
        pgrst_db_schemas_as_postgres_after: settingNow,
        authenticator_pgrst_db_schemas_after: authNow,
        setting_poll_s: Math.round((Date.now() - tPatch) / 1000),
        f09_anon_execute: String(f09r.anon_exec ?? f09.error ?? ""),
        f09_authenticated_execute: String(f09r.auth_exec ?? ""),
        f09_proacl: red(String(f09r.acl ?? ""), 300),
      },
      evidence: Object.entries(seedErr).map(([k, v]) => `${k}: ${v}`).join("\n") || "(no seed errors)",
    });
    await sleep(10_000);

    // ---- AV02a audit ----
    let a;
    try {
      a = await auditOnce(p);
    } catch (e) {
      a = { rows: [], readOnly: false, error: e instanceof Error ? e.message : String(e), ms: 0 };
    }
    results.push({
      id: "AV02a",
      title: "AV02a: audit.sql after seeding (read-only transaction)",
      status: a.error ? "fail" : "info",
      detail: a.error ? red(a.error, 300) : `${a.rows.length} rows; read-only txn ${a.readOnly}; ${a.ms} ms`,
      measurements: {
        read_only_txn: a.readOnly ? "yes" : "no",
        rows: a.rows.length,
        ...Object.fromEntries(Object.entries(tally(a.rows.map((r) => r.check))).map(([k, v]) => [`check: ${k}`, v])),
      },
      evidence: redact(currentProject(), auditLines(a) || "(no rows)"),
    });

    // ---- AV02b advisors, polled until settled ----
    const tFirstPoll = Date.now();
    const anyFixture = (adv: Advisors) => FIXTURES.some((f) => lintHits(f.marker, adv.lints).length > 0);
    let prev: Advisors | null = null;
    let cur: Advisors = await fetchAdvisors(ctx, p.ref);
    let firstSeenS = anyFixture(cur) ? 0 : -1;
    let polls = 1;
    let settled = false;
    while (polls < 12) {
      if (prev && anyFixture(cur) && keySet(prev) === keySet(cur)) {
        settled = true;
        break;
      }
      await sleep(30_000);
      prev = cur;
      cur = await fetchAdvisors(ctx, p.ref);
      polls++;
      if (firstSeenS < 0 && anyFixture(cur)) firstSeenS = Math.round((Date.now() - tFirstPoll) / 1000);
    }
    const settledS = Math.round((Date.now() - tFirstPoll) / 1000);
    results.push({
      id: "AV02b",
      title: "AV02b: advisors after seeding, polled until two answers match",
      status: cur.securityStatus === 200 && cur.performanceStatus === 200 && settled ? "info" : "fail",
      detail: `${cur.lints.length} lints after ${polls} polls (${settledS} s); first seeded object at ${firstSeenS} s; settled ${settled}`,
      measurements: {
        security_status: cur.securityStatus,
        performance_status: cur.performanceStatus,
        lints: cur.lints.length,
        polls,
        settled: settled ? "yes" : "no",
        first_seeded_lint_s: firstSeenS,
        settled_s: settledS,
        ...Object.fromEntries(Object.entries(tally(cur.lints.map((l) => `${l.level} ${l.name}`))).map(([k, v]) => [`lint: ${k}`, v])),
      },
      evidence: redact(currentProject(), lintLines(cur.lints) || "(no lints)"),
    });

    // ---- AV02-Fxx per fixture ----
    const cells: string[] = [];
    let hits = 0;
    for (const f of FIXTURES) {
      const c = classify(f.marker, f.auditChecks, f.advisorLints, a.rows, cur.lints);
      cells.push(c.cell);
      const match = c.cell === f.predicted;
      if (match) hits++;
      results.push({
        id: `AV02-${f.id}`,
        title: `AV02-${f.id}: ${f.category}`,
        status: seedErr[f.id] ? "fail" : "info",
        detail: `${c.cell}${match ? "" : ` (predicted ${f.predicted})`}${seedErr[f.id] ? `; seed error: ${seedErr[f.id]}` : ""}`,
        measurements: {
          object: f.marker,
          audit_check_no: f.auditNo,
          observed: c.cell,
          predicted: f.predicted,
          prediction_hit: match ? "yes" : "no",
          audit: c.audit.join("; ") || "-",
          advisors: c.advisors.join("; ") || "-",
          other_audit: c.otherAudit.join("; ") || "-",
          other_advisors: c.otherAdvisors.join("; ") || "-",
        },
        evidence: `why predicted: ${f.why}`,
      });
    }
    const t = tally(cells);
    results.push({
      id: "AV02",
      title: "AV02: totals per observed cell",
      status: "info",
      detail: `both ${t.both ?? 0}, tool only ${t["tool only"] ?? 0}, advisors only ${t["advisors only"] ?? 0}, neither ${t.neither ?? 0}; predictions hit ${hits}/${FIXTURES.length}`,
      measurements: {
        fixtures: FIXTURES.length,
        both: t.both ?? 0,
        tool_only: t["tool only"] ?? 0,
        advisors_only: t["advisors only"] ?? 0,
        neither: t.neither ?? 0,
        prediction_hits: hits,
      },
    });
    return results;
  },
};
export default mod;
