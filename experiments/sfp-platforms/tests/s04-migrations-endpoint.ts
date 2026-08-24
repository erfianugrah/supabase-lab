/**
 * S04 - migrations endpoint transactional semantics
 *
 * Provisions one project, then:
 *
 *   S04a  control: healthy create. `pass` only when healthy.
 *   S04b  happy path: `POST /projects/{ref}/database/migrations` with a valid
 *         DDL (`create table ...`), then confirm the table exists via
 *         `database/query/read-only`. Record `migration_status` and
 *         `table_present` (1|0).
 *   S04c  rollback: POST a migration whose SQL is guaranteed to FAIL partway
 *         (e.g. two statements where the second references a nonexistent object), then
 *         confirm via `database/query/read-only` that the FIRST statement's object was
 *         NOT left behind (transactional rollback, per the guide's claim). Record
 *         `failing_migration_status` and `rollback_left_no_artifact` (1|0).
 *   S04d  bookkeeping: query `supabase_migrations.schema_migrations` (or the
 *         platform's recorded-migrations relation) and confirm the happy-path
 *         migration is recorded there. Record `recorded` (1|0) or a skip reason if
 *         S04b failed.
 *
 * Every project created here is deleted in `finally`. A measured 4xx on any
 * gated surface is data (info), never an exception.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ProjectCreateResponse {
  ref?: string;
}
interface ProjectStatusResponse {
  status?: string;
}

async function waitHealthy(ctx: Ctx, ref: string, maxIters = 90): Promise<string> {
  let status = "";
  for (let i = 0; i < maxIters && status !== "ACTIVE_HEALTHY"; i++) {
    await sleep(10_000);
    const p = await mgmt(ctx, "GET", `/projects/${ref}`);
    status = (p.json as ProjectStatusResponse | undefined)?.status ?? "";
  }
  return status;
}

const mod: TestModule = {
  id: "S04",
  title: "Migrations endpoint transactional semantics",
  where: "local",
  requires: ["pat", "org"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const results: TestResult[] = [];
    const org = ctx.orgSlugs[0] ?? "";
    let ref = "";
    const ensure = (id: string) => results.some((r) => r.id === id);

    try {
      const t0 = Date.now();
      const create = await mgmt(ctx, "POST", "/projects", {
        organization_slug: org,
        name: `s04-sfp-${t0}`,
        db_pass: `${crypto.randomUUID()}Aa1!`,
        region_selection: { type: "smartGroup", code: "apac" },
      });

      if (create.status !== 201) {
        results.push({
          id: "S04a",
          title: "S04a: control",
          status: "fail",
          detail: `create: HTTP ${create.status}: ${create.text.slice(0, 300)}`,
        });
      } else {
        ref = (create.json as ProjectCreateResponse | undefined)?.ref ?? "";
        if (!ref) {
          results.push({
            id: "S04a",
            title: "S04a: control",
            status: "fail",
            detail: `create returned no ref: ${create.text.slice(0, 300)}`,
          });
        } else {
          const status = await waitHealthy(ctx, ref);
          const provisionS = Math.round((Date.now() - t0) / 1000);
          results.push({
            id: "S04a",
            title: "S04a: control",
            status: status === "ACTIVE_HEALTHY" ? "pass" : "fail",
            detail: status === "ACTIVE_HEALTHY" ? undefined : `not healthy (status=${status})`,
            measurements: { provision_s: provisionS },
          });

          // --- S04b: happy path ---
          const mig = await mgmt(ctx, "POST", `/projects/${ref}/database/migrations`, {
            query: "create table if not exists public.s04b_happy (id int primary key)",
            name: "s04b probe",
          });
          let tablePresent = 0;
          if (mig.status >= 200 && mig.status < 300) {
            const happyChk = await mgmt(ctx, "POST", `/projects/${ref}/database/query/read-only`, {
              query:
                "select exists (select 1 from information_schema.tables where table_schema='public' and table_name='s04b_happy') as present",
            });
            const hrow = Array.isArray(happyChk.json)
              ? (happyChk.json[0] as { present?: boolean })
              : undefined;
            tablePresent = happyChk.status >= 200 && happyChk.status < 300 && hrow?.present === true ? 1 : 0;
          }

          results.push({
            id: "S04b",
            title: "S04b: happy path",
            status: "info",
            detail: mig.status >= 200 && mig.status < 300 ? "migrations endpoint ACCEPTED" : "migrations endpoint REJECTED",
            measurements: { migration_status: mig.status, table_present: tablePresent },
          });

          // --- S04c: rollback ---
          if (mig.status >= 200 && mig.status < 300) {
            const rollback = await mgmt(ctx, "POST", `/projects/${ref}/database/migrations`, {
              query: "create table public.s04c_fail (id int primary key); select error_trigger_me_to_fail_this_statement_partway_through_the_query_so_it_fails_on_the_second_statement_with_a_nonexistent_object_reference",
              name: "s04c rollback",
            });
            // Robust existence check via information_schema (never a status-code
            // heuristic for "table gone").
            const chk = await mgmt(ctx, "POST", `/projects/${ref}/database/query/read-only`, {
              query:
                "select exists (select 1 from information_schema.tables where table_schema='public' and table_name='s04c_fail') as present",
            });
            const chkRow = Array.isArray(chk.json) ? (chk.json[0] as { present?: boolean }) : undefined;
            // 1 = no artifact left behind (the first statement rolled back with the
            // failing second); 0 = the create survived (no transactional rollback).
            const rollbackLeftNoArtifact =
              chk.status >= 200 && chk.status < 300 && chkRow && typeof chkRow.present === "boolean" && !chkRow.present
                ? 1
                : 0;

            results.push({
              id: "S04c",
              title: "S04c: rollback",
              status: "info",
              detail: rollback.status >= 200 && rollback.status < 300 ? "rollback ACCEPTED" : "rollback REJECTED",
              measurements: { failing_migration_status: rollback.status, rollback_left_no_artifact: rollbackLeftNoArtifact },
            });
          } else {
            results.push({
              id: "S04c",
              title: "S04c: rollback",
              status: "skip",
              detail: "S04b failed, cannot test rollback",
            });
          }

          // --- S04d: bookkeeping ---
          const checkMig = await mgmt(ctx, "POST", `/projects/${ref}/database/query/read-only`, {
            query: "select count(*) as cnt from supabase_migrations.schema_migrations where name = 's04b probe'",
          });
          if (checkMig.status >= 200 && checkMig.status < 300) {
            const rows = checkMig.json as Array<{ cnt?: string | number }> | undefined;
            const count = Number(rows?.[0]?.cnt ?? 0);
            results.push({
              id: "S04d",
              title: "S04d: bookkeeping",
              status: "info",
              measurements: { recorded: count > 0 ? 1 : 0 },
            });
          } else {
            results.push({
              id: "S04d",
              title: "S04d: bookkeeping",
              status: "skip",
              detail: `S04b failed or query failed: HTTP ${checkMig.status}`,
            });
          }
        }
      }

      for (const id of ["S04a", "S04b", "S04c", "S04d"] as const) {
        if (!ensure(id)) {
          results.push({ id, title: id, status: "skip", detail: "row never produced" });
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      for (const id of ["S04a", "S04b", "S04c", "S04d"] as const) {
        if (!ensure(id)) {
          results.push({ id, title: id, status: "fail", detail: `test threw: ${msg}` });
        }
      }
    } finally {
      if (ref) await mgmt(ctx, "DELETE", `/projects/${ref}`).catch(() => null);
    }

    return results;
  },
};
export default mod;
