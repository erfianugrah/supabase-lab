/**
 * DD04 - which key gets the PostgREST OpenAPI spec at GET /rest/v1/, and the
 * Management API replacement GET /v1/projects/{ref}/database/openapi.
 *
 * Source claim (public notice, github.com/orgs/supabase/discussions/42949,
 * rollout 2026-03-11 new projects, 2026-04-08 existing): the root path stops
 * answering the anon key with
 *   {"message":"Access to schema is forbidden","hint":"Accessing the schema
 *   via the Data API is only allowed using a secret API key."}
 * while service_role and sb_secret_ keys are unchanged; a Management API
 * endpoint is the replacement.
 *
 *   DD04a  GET /rest/v1/ with no key, anon, publishable, service_role and
 *          sb_secret_ keys, each sent as apikey+Authorization and as apikey
 *          alone: status, message, hint (verbatim) or the spec's title/paths.
 *   DD04b  control: GET /rest/v1/<table> with the same four keys (a granted
 *          table), so the root-path refusals are specific to the root.
 *   DD04c  GET /v1/projects/{ref}/database/openapi with the PAT: status, spec
 *          title, path count, equality of the path set with the root spec from
 *          sb_secret_; ?schema=graphql_public; and without a token.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt, mgmtBase } from "../../../harness/src/mgmt.js";
import { skipWithoutPro, brief, currentProject, dataApi, ensureProject, sql, type DdProject, type RestResult } from "../lib/project.js";

function specSummary(r: RestResult): string {
  const j = r.json as { swagger?: string; openapi?: string; info?: { title?: string }; paths?: Record<string, unknown>; message?: string; hint?: string } | undefined;
  if (j?.swagger || j?.openapi) return `spec ${j.swagger ?? j.openapi} title="${j.info?.title ?? ""}" paths=${Object.keys(j.paths ?? {}).length}`;
  return `message="${j?.message ?? ""}" hint="${j?.hint ?? ""}"`;
}

const mod: TestModule = {
  id: "DD04",
  title: "OpenAPI spec: key matrix on GET /rest/v1/ and /database/openapi",
  where: "local",
  requires: ["pat", "org"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const results: TestResult[] = [];
    const skip = skipWithoutPro(ctx, "DD04");
    if (skip) return skip;
    let p: DdProject;
    try {
      p = await ensureProject(ctx);
    } catch (e) {
      return [{ id: "DD04", title: "DD04", status: "fail", detail: `provision: ${e instanceof Error ? e.message : String(e)}` }];
    }
    const red = (s: string) => brief(currentProject(), s, 300);
    try {
      // A granted table so the spec has a path beyond the root.
      await sql(
        ctx,
        p.ref,
        `create table if not exists public.dd04_t (id int primary key);
         grant select on public.dd04_t to anon, authenticated, service_role;
         insert into public.dd04_t values (1) on conflict do nothing;`,
      );
      await Bun.sleep(5_000);

      const keys: [string, string | null][] = [
        ["nokey", null],
        ["anon", p.keys.anon],
        ["publishable", p.keys.publishable],
        ["service_role", p.keys.service],
        ["sb_secret", p.keys.secret],
      ];
      // ---- DD04a ----
      const am: Record<string, number | string> = {};
      let secretPaths: string[] = [];
      for (const [name, key] of keys) {
        for (const mode of ["both", "apikey"] as const) {
          if (!key && mode === "apikey") continue;
          const r = await dataApi(p.host, "/rest/v1/", key, { mode });
          const label = key ? `${name}_${mode === "both" ? "apikey_bearer" : "apikey_only"}` : name;
          am[`${label}_status`] = r.status;
          am[`${label}_body`] = r.status === 200 ? specSummary(r) : red(r.body);
          if (name === "sb_secret" && mode === "both") secretPaths = Object.keys((r.json as { paths?: object } | undefined)?.paths ?? {}).sort();
        }
      }
      results.push({
        id: "DD04a",
        title: "DD04a: GET /rest/v1/ per key type",
        status: "info",
        detail: `anon ${am.anon_apikey_bearer_status}; publishable ${am.publishable_apikey_bearer_status}; service_role ${am.service_role_apikey_bearer_status}; sb_secret ${am.sb_secret_apikey_bearer_status}`,
        measurements: am,
      });

      // ---- DD04b ----
      const bm: Record<string, number | string> = {};
      for (const [name, key] of keys) {
        const r = await dataApi(p.host, "/rest/v1/dd04_t?select=id", key);
        bm[`${name}_status`] = r.status;
      }
      results.push({
        id: "DD04b",
        title: "DD04b: control - GET /rest/v1/<granted table> per key type",
        status: "info",
        measurements: bm,
      });

      // ---- DD04c ----
      const spec = await mgmt(ctx, "GET", `/projects/${p.ref}/database/openapi`);
      const mgmtPaths = Object.keys(((spec.json as { paths?: object } | undefined)?.paths ?? {}) as object).sort();
      const gp = await mgmt(ctx, "GET", `/projects/${p.ref}/database/openapi?schema=graphql_public`);
      const noTok = await fetch(`${mgmtBase(ctx)}/projects/${p.ref}/database/openapi`, { signal: AbortSignal.timeout(30_000) });
      const noTokBody = await noTok.text();
      const same = secretPaths.length > 0 && JSON.stringify(secretPaths) === JSON.stringify(mgmtPaths) ? 1 : 0;
      results.push({
        id: "DD04c",
        title: "DD04c: GET /v1/projects/{ref}/database/openapi",
        status: spec.status === 200 ? "pass" : "fail",
        detail: `PAT -> ${spec.status} ${specSummary({ status: spec.status, body: spec.text, json: spec.json })}`,
        measurements: {
          pat_status: spec.status,
          pat_spec: specSummary({ status: spec.status, body: spec.text, json: spec.json }),
          pat_paths_equal_root_spec_from_sb_secret: same,
          graphql_public_status: gp.status,
          graphql_public_spec: specSummary({ status: gp.status, body: gp.text, json: gp.json }),
          no_token_status: noTok.status,
          no_token_body: red(noTokBody),
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({ id: "DD04", title: "DD04", status: "fail", detail: `test threw: ${msg}` });
    }
    return results;
  },
};
export default mod;
