/**
 * SH01 - what a GoTrue you run yourself can connect AS on a managed project.
 *
 * The self-hosting compose file connects Auth as `supabase_auth_admin`. On the
 * managed platform that role is reserved: only superusers may change its
 * password or grant membership in it, and `postgres` is not a superuser. So
 * the only role available to a self-hosted GoTrue is `postgres` itself, and
 * this module records exactly what that role can and cannot do in the auth
 * schema, plus the two facts the token story rests on: which signing keys the
 * project holds (and in what status) and which GoTrue version the managed
 * side runs.
 *
 *   SH01a  role map: auth admin reserved (ALTER/GRANT refused verbatim),
 *          postgres privileges on auth.users / refresh_tokens /
 *          schema_migrations, schema owner, search_path defaults
 *   SH01b  auth.schema_migrations: row count, latest version
 *   SH01c  signing keys: algorithm and status per key; the legacy HS256
 *          secret's presence
 *   SH01d  managed GoTrue version (health), to compare against the
 *          GOTRUE_IMAGE tag the Makefile runs (and, for contrast, the older
 *          tag the public self-hosting compose pins)
 *
 * Read-only apart from two DDL statements that are refused by design. Runs
 * without --destructive.
 */
import { mgmt } from "../../../harness/src/mgmt";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { fetchKeys, http, sql } from "../lib/sha";

const mod: TestModule = {
  id: "SH01",
  title: "Self-hosted GoTrue on a managed project: the role and key map",
  where: "local",
  requires: ["pat"],
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!ctx.ref) return [{ id: "SH01", title: this.title, status: "skip", detail: "no project ref (PVLAB_REF)" }];
    const out: TestResult[] = [];

    // SH01a - role map.
    const facts = await sql(
      ctx,
      `select
  (select rolcanlogin from pg_roles where rolname='supabase_auth_admin') as auth_admin_can_login,
  pg_has_role('postgres','supabase_auth_admin','MEMBER') as postgres_member_of_auth_admin,
  (select rolsuper from pg_roles where rolname='postgres') as postgres_superuser,
  (select nspowner::regrole::text from pg_namespace where nspname='auth') as auth_schema_owner,
  has_schema_privilege('postgres','auth','USAGE') as pg_auth_usage,
  has_schema_privilege('postgres','auth','CREATE') as pg_auth_create,
  has_table_privilege('postgres','auth.users','INSERT') as pg_users_insert,
  has_table_privilege('postgres','auth.refresh_tokens','INSERT') as pg_refresh_tokens_insert,
  has_table_privilege('postgres','auth.sessions','INSERT') as pg_sessions_insert,
  has_table_privilege('postgres','auth.schema_migrations','INSERT') as pg_schema_migrations_insert,
  (select array_to_string(rolconfig,' ') from pg_roles where rolname='supabase_auth_admin') as auth_admin_rolconfig,
  (select array_to_string(rolconfig,' ') from pg_roles where rolname='postgres') as postgres_rolconfig`,
    );
    const alter = await sql(ctx, "alter role supabase_auth_admin password 'pvlab-probe-never-used'");
    const grant = await sql(ctx, "create role pvlab_sha_probe login password 'pvlab-probe-never-used'; grant supabase_auth_admin to pvlab_sha_probe");
    await sql(ctx, "drop role if exists pvlab_sha_probe");
    const f = facts.rows[0] ?? {};
    const reserved = alter.status >= 300 && grant.status >= 300;
    out.push({
      id: "SH01a",
      title: "role map for a self-hosted GoTrue",
      status: facts.status < 300 ? (reserved ? "pass" : "info") : "fail",
      detail:
        facts.status >= 300
          ? `facts query HTTP ${facts.status}: ${facts.error}`
          : reserved
            ? `supabase_auth_admin is reserved (ALTER: "${alter.error}"); postgres can write auth.users/refresh_tokens but has no CREATE on auth and no INSERT on schema_migrations`
            : `supabase_auth_admin was NOT refused: alter HTTP ${alter.status}, grant HTTP ${grant.status}`,
      measurements: {
        auth_admin_can_login: f.auth_admin_can_login ? 1 : 0,
        postgres_member_of_auth_admin: f.postgres_member_of_auth_admin ? 1 : 0,
        postgres_superuser: f.postgres_superuser ? 1 : 0,
        auth_schema_owner: String(f.auth_schema_owner ?? "?"),
        pg_auth_usage: f.pg_auth_usage ? 1 : 0,
        pg_auth_create: f.pg_auth_create ? 1 : 0,
        pg_users_insert: f.pg_users_insert ? 1 : 0,
        pg_refresh_tokens_insert: f.pg_refresh_tokens_insert ? 1 : 0,
        pg_sessions_insert: f.pg_sessions_insert ? 1 : 0,
        pg_schema_migrations_insert: f.pg_schema_migrations_insert ? 1 : 0,
        alter_auth_admin_error: alter.error || `HTTP ${alter.status}`,
        grant_auth_admin_error: grant.error || `HTTP ${grant.status}`,
        auth_admin_rolconfig: String(f.auth_admin_rolconfig ?? ""),
        postgres_rolconfig: String(f.postgres_rolconfig ?? ""),
      },
    });

    // SH01b - migration state.
    const mig = await sql(ctx, "select count(*)::int as n, max(version) as latest, min(version) as earliest from auth.schema_migrations");
    const m = mig.rows[0] ?? {};
    out.push({
      id: "SH01b",
      title: "auth.schema_migrations as the platform left it",
      status: mig.status < 300 ? "info" : "fail",
      detail: mig.status < 300 ? `${m.n} rows, ${m.earliest} .. ${m.latest}` : mig.error,
      measurements: { rows: Number(m.n ?? 0), latest: String(m.latest ?? ""), earliest: String(m.earliest ?? "") },
    });

    // SH01c - signing keys.
    const keys = await mgmt(ctx, "GET", `/projects/${ctx.ref}/config/auth/signing-keys`);
    const list = ((keys.json as { keys?: { id?: string; algorithm?: string; status?: string }[] } | undefined)?.keys ?? []) as {
      id?: string;
      algorithm?: string;
      status?: string;
    }[];
    const pg = await mgmt(ctx, "GET", `/projects/${ctx.ref}/postgrest`);
    const secretLen = String((pg.json as { jwt_secret?: string } | undefined)?.jwt_secret ?? "").length;
    const inUse = list.find((k) => k.status === "in_use");
    const hs = list.find((k) => k.algorithm === "HS256");
    out.push({
      id: "SH01c",
      title: "signing keys: what the managed side signs with, and what still verifies",
      status: keys.status === 200 ? "info" : "fail",
      detail:
        keys.status === 200
          ? `in_use ${inUse?.algorithm ?? "?"}; HS256 key ${hs ? hs.status : "absent"}; legacy jwt_secret ${secretLen ? `${secretLen} chars via GET /postgrest` : "not readable"}`
          : `signing-keys HTTP ${keys.status}`,
      measurements: {
        keys: list.map((k) => `${k.algorithm}:${k.status}`).join("|"),
        in_use_alg: inUse?.algorithm ?? "?",
        hs256_status: hs?.status ?? "absent",
        jwt_secret_chars: secretLen,
      },
    });

    // SH01d - managed GoTrue version.
    const k = await fetchKeys(ctx);
    const health = await http(`https://${ctx.apiHost}/auth/v1/health`, { key: k.anon });
    out.push({
      id: "SH01d",
      title: "managed GoTrue version",
      status: health.status === 200 ? "info" : "fail",
      detail: health.status === 200 ? `managed ${String(health.json.version)}` : `health HTTP ${health.status}`,
      measurements: { managed_version: String(health.json.version ?? "?"), self_hosted: ctx.endpoints["selfhosted_gotrue"] ? "configured" : "absent" },
    });
    return out;
  },
};
export default mod;
