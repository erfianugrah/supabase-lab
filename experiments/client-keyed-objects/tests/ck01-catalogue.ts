/**
 * CK01 - Do the same migrations leave an identical catalogue on every target,
 * and does the client carry no branch on target identity?
 *
 * SIDE: every target in the run (managed projects and/or the self-hosted
 * stack), read as `postgres` (Management API query endpoint on managed, psql
 * in the db container on self-hosted). No API key involved.
 *
 *   CK01-<target>  section fingerprints (sha256 of the canonical JSON) of:
 *                  policies on app.* and the ck_* storage policies, functions
 *                  in schema app (name, args, security definer, volatility,
 *                  md5 of the body), triggers on app tables, tables with RLS
 *                  flags, table grants, the hook's execute grant, the bucket
 *                  row. Pass = every section present with the expected counts;
 *                  equality across targets is reported in-run (`same_as_first`)
 *                  and across runs by scripts/parity.ts.
 *   CK01-code      the client sources and migrations contain none of the
 *                  target names, hostnames or deployment-kind switches
 *                  (comments stripped).
 *
 * Not settled: byte-identical function bodies after a Postgres major upgrade;
 * policy text is compared as pg_policies renders it on each server.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { EXP_DIR, errMsg, loadRun, row, scrub, sqlRows } from "../lib/ckrun";

const SECTIONS: Record<string, string> = {
  policies: `select schemaname, tablename, policyname, permissive, cmd, roles::text as roles, qual, with_check from pg_policies
             where schemaname = 'app' or (schemaname = 'storage' and policyname like 'ck\\_%') order by 1, 2, 3`,
  functions: `select p.proname, pg_get_function_identity_arguments(p.oid) as args, p.prosecdef, p.provolatile, md5(p.prosrc) as src
              from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' order by 1, 2`,
  triggers: `select c.relname, t.tgname, pg_get_triggerdef(t.oid) as def from pg_trigger t join pg_class c on c.oid = t.tgrelid
             join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'app' and not t.tgisinternal order by 1, 2`,
  tables: `select c.relname, c.relrowsecurity, c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'app' and c.relkind = 'r' order by 1`,
  grants: `select table_name, grantee, string_agg(privilege_type, ',' order by privilege_type) as privs from information_schema.role_table_grants
           where table_schema = 'app' and grantee in ('anon', 'authenticated', 'service_role', 'supabase_auth_admin') group by 1, 2 order by 1, 2`,
  hook: `select has_function_privilege('supabase_auth_admin', 'app.custom_access_token_hook(jsonb)', 'execute') as auth_admin_exec,
                has_function_privilege('authenticated', 'app.custom_access_token_hook(jsonb)', 'execute') as authenticated_exec,
                has_function_privilege('anon', 'app.custom_access_token_hook(jsonb)', 'execute') as anon_exec`,
  bucket: `select id, name, public, file_size_limit, allowed_mime_types from storage.buckets where id = 'assets'`,
};
const EXPECT: Record<string, number> = { policies: 22, functions: 6, triggers: 4, tables: 6, hook: 1, bucket: 1 };

const sha = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 16);

/** Tokens that would mean the client or a migration knows which target it is on. */
const FORBIDDEN = /\b(onprem(-file)?|region-[ab]|managed|self-?hosted|supabase\.co|localhost|127\.0\.0\.1|host\.docker\.internal)\b|\.kind\b|\bisManaged\b|\.name\s*[!=]==?/;
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/--.*$/gm, "");

const mod: TestModule = {
  id: "CK01",
  title: "Migrations leave an identical catalogue; no target branch in client or migrations",
  where: "local",
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const l = loadRun(ctx);
    if ("skip" in l) return [{ id: "CK01", title: this.title, status: "skip", detail: l.skip }];
    const out: TestResult[] = [];
    let first: Record<string, string> | null = null;
    for (const t of l.targets) {
      try {
        const m: Record<string, string | number> = {};
        const fp: Record<string, string> = {};
        const short: string[] = [];
        for (const [k, q] of Object.entries(SECTIONS)) {
          const rows = await sqlRows(ctx, t, q);
          fp[k] = sha(rows);
          m[`${k}_rows`] = rows.length;
          m[`${k}_sha`] = fp[k]!;
          if (EXPECT[k] !== undefined && rows.length !== EXPECT[k]) short.push(`${k} ${rows.length}/${EXPECT[k]}`);
          if (k === "hook") {
            const h = rows[0] ?? {};
            m.hook_auth_admin_exec = String(h.auth_admin_exec);
            m.hook_authenticated_exec = String(h.authenticated_exec);
            if (h.auth_admin_exec !== true || h.authenticated_exec !== false) short.push("hook grants");
          }
        }
        m.catalogue_sha = sha(fp);
        const same = first ? Object.keys(fp).filter((k) => fp[k] !== first![k]) : [];
        if (!first) first = fp;
        m.same_as_first = same.length ? `differs: ${same.join(",")}` : first === fp ? "first" : "same";
        out.push(row("CK01", t, "catalogue after migrations", short.length || same.length ? "fail" : "pass", short.length ? `unexpected: ${short.join("; ")}` : `catalogue ${m.catalogue_sha}; ${m.same_as_first}`, m));
      } catch (e) {
        out.push(row("CK01", t, "catalogue after migrations", "fail", `threw: ${scrub(l, errMsg(e))}`));
      }
    }
    // Code scan, once per run.
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d, { withFileTypes: true })) {
        if (f.name === "node_modules" || f.name.endsWith(".test.ts")) continue;
        const p = join(d, f.name);
        if (f.isDirectory()) walk(p);
        else if (/\.(ts|sql|html)$/.test(f.name)) files.push(p);
      }
    };
    walk(join(EXP_DIR, "client", "src"));
    walk(join(EXP_DIR, "client", "browser"));
    walk(join(EXP_DIR, "supabase", "migrations"));
    files.push(join(EXP_DIR, "client", "cli.ts"));
    const hits: string[] = [];
    for (const f of files) {
      stripComments(readFileSync(f, "utf8"))
        .split("\n")
        .forEach((line, i) => {
          const m = FORBIDDEN.exec(line);
          if (m) hits.push(`${f.slice(EXP_DIR.length + 1)}:${i + 1} ${m[0]}`);
        });
    }
    out.push({
      id: "CK01-code",
      title: "no target branch in client sources or migrations",
      status: hits.length ? "fail" : "pass",
      detail: hits.length ? `found: ${hits.slice(0, 8).join("; ")}` : `${files.length} files scanned, no target name, host or kind switch`,
      measurements: { files_scanned: files.length, hits: hits.length },
    });
    return out;
  },
};
export default mod;
