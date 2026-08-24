/**
 * S12 - migration versioning
 *
 * Provision one project:
 *
 *   S12a  control: healthy create.
 *   S12b  create migration: `POST /projects/{ref}/database/migrations` with a
 *         valid DDL (`create table ...`) and a `name`. Record
 *         `migration_status`.
 *   S12c  read version: `GET /projects/{ref}/database/migrations/{version}`.
 *         The version is whatever the create response returned (or `1`). Record
 *         `version_get_status` and whether the body echoes the migration `name`.
 *         `info`.
 *   S12d  patch rollback: `PATCH /projects/{ref}/database/migrations/{version}`
 *         with `{"rollback": "drop table ..."}`. Record `patch_status`. `info`.
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
  id: "S12",
  title: "Migration versioning",
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
        name: `s12-sfp-${t0}`,
        db_pass: `${crypto.randomUUID()}Aa1!`,
        region_selection: { type: "smartGroup", code: "apac" },
      });

      if (create.status !== 201) {
        results.push({
          id: "S12a",
          title: "S12a: control",
          status: "fail",
          detail: `create: HTTP ${create.status}: ${create.text.slice(0, 300)}`,
        });
      } else {
        ref = (create.json as ProjectCreateResponse | undefined)?.ref ?? "";
        if (!ref) {
          results.push({
            id: "S12a",
            title: "S12a: control",
            status: "fail",
            detail: `create returned no ref: ${create.text.slice(0, 300)}`,
          });
        } else {
          const status = await waitHealthy(ctx, ref);
          const provisionS = Math.round((Date.now() - t0) / 1000);
          results.push({
            id: "S12a",
            title: "S12a: control",
            status: status === "ACTIVE_HEALTHY" ? "pass" : "fail",
            detail: status === "ACTIVE_HEALTHY" ? undefined : `not healthy (status=${status})`,
            measurements: { provision_s: provisionS },
          });

          // --- S12b: create migration ---
          const migrationName = "s12-probe-migration";
          const migrate = await mgmt(ctx, "POST", `/projects/${ref}/database/migrations`, {
            query: "create table public.s12_probe (id int primary key)",
            name: migrationName,
          });
          results.push({
            id: "S12b",
            title: "S12b: create migration",
            status: "info",
            detail: migrate.status >= 200 && migrate.status < 300 ? "MIGRATION_ACCEPTED" : "MIGRATION_REJECTED",
            measurements: { migration_status: migrate.status },
            evidence: migrate.text.slice(0, 300),
          });

          // --- S12c: read version ---
          // The create response is `[]` (no version). The version is a
          // timestamp (YYYYMMDDHHMMSS) recorded in
          // supabase_migrations.schema_migrations - read it from there.
          let version = "";
          if (migrate.status >= 200 && migrate.status < 300) {
            const q = await mgmt(ctx, "POST", `/projects/${ref}/database/query/read-only`, {
              query: `select version from supabase_migrations.schema_migrations where name = '${migrationName}' order by version desc limit 1`,
            });
            const rows = Array.isArray(q.json) ? (q.json as Array<{ version?: string }>) : [];
            version = rows[0]?.version ?? "";
          }

          const readMig = version
            ? await mgmt(ctx, "GET", `/projects/${ref}/database/migrations/${version}`)
            : { status: 0, text: "no version discoverable", json: undefined as unknown };
          const echoesName = (readMig.json as { name?: string } | undefined)?.name === migrationName;
          results.push({
            id: "S12c",
            title: "S12c: read version",
            status: "info",
            detail:
              readMig.status >= 200 && readMig.status < 300
                ? `VERSION_READ_SUCCESSFUL (version=${version})`
                : `VERSION_READ_REJECTED (version=${version || "none"}, HTTP ${readMig.status})`,
            measurements: {
              version: version,
              version_get_status: readMig.status,
              echoes_name: echoesName ? 1 : 0,
            },
            evidence: readMig.text?.slice(0, 300) ?? "",
          });

          // --- S12d: patch rollback ---
          const patch = version
            ? await mgmt(ctx, "PATCH", `/projects/${ref}/database/migrations/${version}`, {
                rollback: "drop table public.s12_probe",
              })
            : { status: 0, text: "no version discoverable", json: undefined as unknown };
          results.push({
            id: "S12d",
            title: "S12d: patch rollback",
            status: "info",
            detail: patch.status >= 200 && patch.status < 300 ? "PATCH_ACCEPTED" : `PATCH_REJECTED (HTTP ${patch.status})`,
            measurements: { patch_status: patch.status },
            evidence: patch.text?.slice(0, 300) ?? "",
          });
        }
      }

      for (const id of ["S12a", "S12b", "S12c", "S12d"] as const) {
        if (!ensure(id)) {
          results.push({ id, title: id, status: "skip", detail: "row never produced" });
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      for (const id of ["S12a", "S12b", "S12c", "S12d"] as const) {
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
