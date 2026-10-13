/**
 * DD01S - the DD01 probe against a STANDING project (one that already
 * exists, given by PVLAB_REF), read before and after the 2026-10-30
 * enforcement date.
 *
 * Source claim (public rollout notice, github.com/orgs/supabase/discussions/45329):
 * tables created in `public` stop being exposed to the Data API unless
 * granted; default for new projects from 2026-05-30, applied to existing
 * projects on 2026-10-30. DD01 measured the new-project half on 2026-10-10.
 * This module is the existing-project half: the same reading on a project
 * created before 2026-05-30, taken once before 2026-10-30 and once after, so
 * the two artifacts show the change (`pvlab --diff old.json,new.json`).
 *
 *   DD01Sa  read-only: the reading's date, the project's created_at and
 *           status (Management API), the exposed schemas (GET .../postgrest),
 *           pg_default_acl for schema public (rows verbatim), Postgres version
 *           and the role the query endpoint runs as.
 *   DD01Sb  one uniquely named probe table created in public in SQL (one
 *           row), its relacl, anon (legacy JWT) and publishable GET
 *           /rest/v1/<probe>: status, code, message, hint and body verbatim;
 *           the table is dropped in a finally block and its absence checked.
 *
 * Contract on a project this lab does not own: no ALTER DEFAULT PRIVILEGES,
 * no GRANT/REVOKE, no ALTER of anything, no read or write of an existing
 * table, no restore of a paused project. Every SQL statement passes through
 * `guarded()`, which throws before sending anything that names those verbs.
 * `destructive: true` because it creates (and drops) one table, which the
 * harness contract counts as mutating the environment; the project's
 * privileges and config are untouched. Measurement keys carry no probe name,
 * so a pre/post pair diffs on the values that moved.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import { dataApi, pollApi, sql, type RestResult, type SqlResult } from "../lib/project.js";

/** Dates from the public notice; the reading is labelled against them. */
const NEW_PROJECT_DEFAULT_FROM = "2026-05-30";
const EXISTING_PROJECTS_ON = "2026-10-30";

const ACL_SQL = `select defaclrole::regrole::text as role, defaclobjtype as objtype, defaclacl::text as acl
  from pg_default_acl where defaclnamespace = 'public'::regnamespace order by 1, 2`;

/** Verbs this module must never send to a standing project. */
const FORBIDDEN = /\b(grant|revoke|alter|truncate|policy|owner|delete|update)\b/i;

function guarded(ctx: Ctx, query: string): Promise<SqlResult> {
  if (FORBIDDEN.test(query)) throw new Error(`DD01S refused a privilege-changing statement: ${query.slice(0, 80)}`);
  return sql(ctx, ctx.ref, query);
}

type Row = { role: string; objtype: string; acl: string };
const aclFor = (rows: Row[], role: string, objtype: string) =>
  rows.find((r) => r.role === role && r.objtype === objtype)?.acl ?? "absent";
/** Privilege letters a role holds in an ACL string, e.g. "arwdDxtm"; "none" if the role is absent. */
const privsOf = (acl: string, who: string) => acl.match(new RegExp(`[{,]${who}=([a-zA-Z*]*)/`))?.[1] ?? "none";

function errShape(j: unknown): { code: string; message: string; hint: string } {
  const o = (j ?? {}) as { code?: string; message?: string; hint?: string };
  return { code: o.code ?? "", message: o.message ?? "", hint: o.hint ?? "" };
}

const mod: TestModule = {
  id: "DD01S",
  title: "Data API default privileges on a standing project (pre/post 2026-10-30)",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!ctx.ref) {
      return [{ id: "DD01S", title: this.title, status: "skip", detail: "no project ref (PVLAB_REF): the standing project to read" }];
    }
    const ref = ctx.ref;
    const at = new Date().toISOString();
    const readingDate = at.slice(0, 10);
    const phase = readingDate < EXISTING_PROJECTS_ON ? "before-2026-10-30" : "on-or-after-2026-10-30";
    const results: TestResult[] = [];
    const probe = `dd01s_probe_${Date.now()}`;

    try {
      // ---- DD01Sa: read-only ----
      const proj = await mgmt(ctx, "GET", `/projects/${ref}`);
      const pj = (proj.json ?? {}) as { created_at?: string; status?: string };
      const createdAt = String(pj.created_at ?? "");
      const projStatus = String(pj.status ?? "");
      if (proj.status !== 200 || projStatus !== "ACTIVE_HEALTHY") {
        return [
          {
            id: "DD01S",
            title: this.title,
            status: "fail",
            detail: `GET /projects/<ref> HTTP ${proj.status}, status ${projStatus || "-"}; not ACTIVE_HEALTHY, nothing probed (the module does not restore a project)`,
            measurements: { reading_date: readingDate, project_http: proj.status, project_status: projStatus || "-" },
          },
        ];
      }
      const createdBefore = createdAt ? createdAt.slice(0, 10) < NEW_PROJECT_DEFAULT_FROM : false;
      const pg = await mgmt(ctx, "GET", `/projects/${ref}/postgrest`);
      const dbSchema = String((pg.json as { db_schema?: string } | undefined)?.db_schema ?? "-");
      const acl = await guarded(ctx, ACL_SQL);
      const rows = (acl.rows ?? []) as unknown as Row[];
      const who = await guarded(ctx, "select current_user::text as u, current_setting('server_version') as v");
      const tables = aclFor(rows, "postgres", "r");
      results.push({
        id: "DD01Sa",
        title: "DD01Sa: pg_default_acl (schema public) and created_at on the standing project",
        status: "info",
        detail: `reading ${readingDate} (${phase}); created_at ${createdAt || "-"}; postgres/tables acl=${tables}`,
        measurements: {
          reading_date: readingDate,
          reading_phase: phase,
          created_at: createdAt || "-",
          created_before_2026_05_30: createdBefore ? 1 : 0,
          project_status: projStatus,
          exposed_schemas: dbSchema,
          acl_status: acl.status,
          pg_default_acl_public_rows: JSON.stringify(rows),
          postgres_tables_acl: tables,
          postgres_sequences_acl: aclFor(rows, "postgres", "S"),
          anon_privs_in_tables_acl: privsOf(tables, "anon"),
          authenticated_privs_in_tables_acl: privsOf(tables, "authenticated"),
          service_role_privs_in_tables_acl: privsOf(tables, "service_role"),
          sql_role: String(who.rows?.[0]?.u ?? "-"),
          postgres_version: String(who.rows?.[0]?.v ?? "-"),
        },
        evidence: acl.error ? `acl query error: ${acl.error}` : undefined,
      });

      // ---- DD01Sb: one probe table, created and dropped ----
      const k = await mgmt(ctx, "GET", `/projects/${ref}/api-keys?reveal=true`);
      const keyRows = (Array.isArray(k.json) ? k.json : []) as { name: string; type?: string; api_key?: string }[];
      const anonKey = keyRows.find((x) => x.name === "anon")?.api_key ?? "";
      const pubKey = keyRows.find((x) => x.type === "publishable")?.api_key ?? "";
      const host = ctx.apiHost || `${ref}.supabase.co`;

      const norm = (s: string) => s.replaceAll(probe, "<probe>").replaceAll(ref, "<ref>").replace(/\s+/g, " ").slice(0, 400);
      const read = (key: string) => dataApi(host, `/rest/v1/${probe}?select=id`, key);
      let create: SqlResult | undefined;
      let relacl = "-";
      let anon: { last: RestResult; s: number } | undefined;
      let pub: RestResult | undefined;
      let drop: SqlResult | undefined;
      let gone: unknown = "-";
      try {
        create = await guarded(ctx, `create table public.${probe} (id int primary key, note text);
          insert into public.${probe} values (1, 'dd01s');`);
        if (create.status < 300) {
          const r = await guarded(ctx, `select relacl::text as acl from pg_class where oid = 'public.${probe}'::regclass`);
          relacl = String(r.rows?.[0]?.acl ?? "null");
          // The new table reaches PostgREST's schema cache a moment after CREATE.
          if (anonKey) anon = await pollApi(() => read(anonKey), (x) => x.status !== 404);
          if (pubKey) pub = await read(pubKey);
        }
      } finally {
        drop = await guarded(ctx, `drop table if exists public.${probe}`);
        const g = await guarded(ctx, `select to_regclass('public.${probe}') is null as gone`);
        gone = g.rows?.[0]?.gone ?? "-";
      }

      const an = errShape(anon?.last.json);
      const pu = errShape(pub?.json);
      const cleaned = drop.status < 300 && gone === true;
      results.push({
        id: "DD01Sb",
        title: "DD01Sb: a SQL-created table in public, anon and publishable read, then dropped",
        status: cleaned ? "info" : "fail",
        detail:
          `create HTTP ${create?.status ?? "-"}; anon GET -> ${anon?.last.status ?? "-"} ${anon ? norm(anon.last.body).slice(0, 160) : "(no anon key)"}; ` +
          `drop HTTP ${drop.status}, gone=${String(gone)}`,
        measurements: {
          reading_date: readingDate,
          create_status: create?.status ?? "-",
          create_error: create?.error ? norm(create.error) : "-",
          probe_relacl: relacl,
          anon_key_present: anonKey ? 1 : 0,
          anon_status: anon?.last.status ?? "-",
          anon_code: an.code || "-",
          anon_message: an.message ? norm(an.message) : "-",
          anon_hint: an.hint ? norm(an.hint) : "-",
          anon_body: anon ? norm(anon.last.body) : "-",
          anon_seconds_to_serve: anon?.s ?? "-",
          publishable_key_present: pubKey ? 1 : 0,
          publishable_status: pub?.status ?? "-",
          publishable_code: pu.code || "-",
          publishable_hint: pu.hint ? norm(pu.hint) : "-",
          publishable_body: pub ? norm(pub.body) : "-",
          drop_status: drop.status,
          probe_gone: String(gone),
        },
        evidence: `probe table public.${probe} (created ${at}); anon body: ${anon ? norm(anon.last.body) : "-"}`,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({ id: "DD01S", title: this.title, status: "fail", detail: `test threw: ${msg.replaceAll(ref, "<ref>")} (check public.${probe} is gone if the error came after its create)` });
    }
    return results;
  },
};
export default mod;
