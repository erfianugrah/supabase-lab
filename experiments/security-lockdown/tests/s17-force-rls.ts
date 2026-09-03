/**
 * S17 - FORCE ROW LEVEL SECURITY: who does it bind on a managed project, and
 * how does a backend role get RLS applied to it?
 *
 * Managed project. SQL through the Management query endpoint (the role S17a
 * reports as current_user, the table owner). REST with the legacy service_role
 * JWT, and with an HS256 JWT minted here for a custom role, signed with the
 * secret GET /projects/{ref}/postgrest returns.
 *
 *   S17a  role attributes: rolsuper / rolbypassrls for postgres, service_role,
 *         authenticator, anon, authenticated, supabase_admin,
 *         supabase_auth_admin; current_user of the query endpoint
 *   S17b  RLS enabled, no policy: postgres (the default owner, BYPASSRLS on
 *         this platform) reads every row before AND after FORCE; a table owned
 *         by a lab role without BYPASSRLS reads every row before FORCE and 0
 *         after - FORCE binds an owner only if the owner cannot bypass
 *   S17c  service_role via REST under FORCE: rows read (BYPASSRLS ignores FORCE)
 *   S17d  ALTER ROLE service_role NOBYPASSRLS as the project owner: status and
 *         error text verbatim; if it lands, the REST read under it, restored
 *   S17e  a NOBYPASSRLS backend role, member of authenticator, reached through
 *         the Data API with a minted JWT (role claim): 0 rows with no policy,
 *         the policy's rows once one exists
 *
 * Not settled by this module: whether GoTrue can issue a token with a custom
 * role claim (it issues `authenticated`); S17e mints its own.
 *
 * DESTRUCTIVE: creates a table, a role, a policy; may toggle a role attribute
 * (restored); all dropped in finally.
 */
import { createHmac } from "node:crypto";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import { sql as sqlStatus } from "../../../harness/src/platform.js";
import { fetchKeys, httpBody, errCode, sql, waitFor } from "../lib/sec.js";

const T = "sec17_force";
const ROLE = "sec17_backend";
const OWNER = "sec17_owner";
const ROLES = ["postgres", "service_role", "authenticator", "anon", "authenticated", "supabase_admin", "supabase_auth_admin"];

function b64url(b: Buffer | string): string {
  return Buffer.from(b).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function mintHs256(secret: string, payload: Record<string, unknown>): string {
  const h = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const p = b64url(JSON.stringify(payload));
  const sig = createHmac("sha256", secret).update(`${h}.${p}`).digest();
  return `${h}.${p}.${b64url(sig)}`;
}
const count = (json: unknown) => (Array.isArray(json) ? json.length : -1);
/** Drop the lab roles if a previous run left them (DROP OWNED errors on a missing role, hence the guard). */
const DROP_ROLES = `
do $$ begin
  -- postgres created these with CREATEROLE (ADMIN OPTION, no membership), and
  -- DROP OWNED needs the privileges of the role: grant it to ourselves first.
  if exists (select 1 from pg_roles where rolname = '${ROLE}') then
    execute 'grant ${ROLE} to postgres';
    execute 'revoke ${ROLE} from authenticator';
    execute 'drop owned by ${ROLE}';
    execute 'drop role ${ROLE}';
  end if;
  if exists (select 1 from pg_roles where rolname = '${OWNER}') then
    execute 'grant ${OWNER} to postgres';
    execute 'drop owned by ${OWNER}';
    execute 'drop role ${OWNER}';
  end if;
end $$;`;

const mod: TestModule = {
  id: "S17",
  title: "FORCE ROW LEVEL SECURITY: owner bound, service_role not; a NOBYPASSRLS backend role via the Data API",
  where: "local",
  requires: ["pat", "anon-key"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const keys = await fetchKeys(ctx);
    const out: TestResult[] = [];
    const url = `https://${ctx.apiHost}/rest/v1/${T}?select=id,tenant`;
    let bypassChanged = false;
    try {
      await sql(ctx, `drop table if exists public.${T} cascade; ${DROP_ROLES}`);
      const attrs = (await sql(ctx, `select rolname, rolsuper, rolbypassrls, rolcreaterole from pg_roles where rolname in (${ROLES.map((r) => `'${r}'`).join(",")}) order by rolname;`)) as { rolname: string; rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean }[];
      const cu = (await sql(ctx, `select current_user as u;`)) as { u: string }[];
      const m: Record<string, string | number> = { query_endpoint_role: cu[0]?.u ?? "" };
      for (const a of attrs) m[`${a.rolname}_bypassrls`] = String(a.rolbypassrls);
      out.push({
        id: "S17a",
        title: "role attributes: who bypasses RLS",
        status: "info",
        detail: `query endpoint runs as ${cu[0]?.u}. ${attrs.map((a) => `${a.rolname}: super=${a.rolsuper} bypassrls=${a.rolbypassrls}`).join("; ")}.`,
        measurements: m,
      });

      await sql(ctx, `
create table if not exists public.${T} (id bigint generated always as identity primary key, tenant text);
truncate public.${T};
insert into public.${T} (tenant) values ('a'), ('b');
alter table public.${T} enable row level security;
grant select on public.${T} to service_role;
notify pgrst, 'reload schema';
`);
      const pgBefore = (await sql(ctx, `select count(*)::int as n from public.${T};`)) as { n: number }[];
      await sql(ctx, `alter table public.${T} force row level security;`);
      const pgAfter = (await sql(ctx, `select count(*)::int as n from public.${T};`)) as { n: number }[];
      const pgBypass = attrs.find((a) => a.rolname === "postgres")?.rolbypassrls;
      out.push({
        id: "S17b-postgres",
        title: "FORCE on a postgres-owned table: postgres still reads (BYPASSRLS)",
        status: "info",
        detail: `postgres (owner, bypassrls=${pgBypass}) read ${pgBefore[0]?.n} rows with RLS on and no policy, and ${pgAfter[0]?.n} after FORCE ROW LEVEL SECURITY. On this platform the default owner bypasses RLS, so FORCE changes nothing for a backend that connects as postgres.`,
        measurements: { postgres_bypassrls: String(pgBypass), postgres_rows_before_force: pgBefore[0]?.n ?? -1, postgres_rows_after_force: pgAfter[0]?.n ?? -1 },
      });
      await sql(ctx, `
create role ${OWNER} nologin nobypassrls;
grant ${OWNER} to postgres;
grant usage, create on schema public to ${OWNER};
alter table public.${T} owner to ${OWNER};
alter table public.${T} no force row level security;
`);
      const ownerBefore = (await sql(ctx, `set local role ${OWNER}; select count(*)::int as n from public.${T};`)) as { n: number }[];
      await sql(ctx, `alter table public.${T} force row level security;`);
      const ownerAfter = (await sql(ctx, `set local role ${OWNER}; select count(*)::int as n from public.${T};`)) as { n: number }[];
      out.push({
        id: "S17b",
        title: "FORCE binds a table owner that cannot bypass RLS",
        status: ownerBefore[0]?.n === 2 && ownerAfter[0]?.n === 0 ? "pass" : "fail",
        detail: `owner ${OWNER} (NOBYPASSRLS) read ${ownerBefore[0]?.n} rows with RLS on and no policy; ${ownerAfter[0]?.n} after FORCE ROW LEVEL SECURITY.`,
        measurements: { owner_rows_before_force: ownerBefore[0]?.n ?? -1, owner_rows_after_force: ownerAfter[0]?.n ?? -1 },
      });

      await waitFor(async () => (await httpBody(url, { key: keys.serviceJwt })).status === 200, 60_000);
      const svc = await httpBody(url, { key: keys.serviceJwt });
      out.push({
        id: "S17c",
        title: "service_role via REST under FORCE still reads every row",
        status: svc.status === 200 && count(svc.json) === 2 ? "pass" : "fail",
        detail: `service_role GET -> ${svc.status}, ${count(svc.json)} rows. FORCE has no effect on a BYPASSRLS role.`,
        measurements: { service_status: svc.status, service_rows: count(svc.json) },
      });

      const strip = await sqlStatus(ctx, `alter role service_role nobypassrls;`);
      if (strip.status < 300) {
        bypassChanged = true;
        const svc2 = await httpBody(url, { key: keys.serviceJwt });
        out.push({
          id: "S17d",
          title: "the project owner CAN strip BYPASSRLS from service_role",
          status: "pass",
          detail: `ALTER ROLE service_role NOBYPASSRLS -> HTTP ${strip.status}. service_role GET now -> ${svc2.status}, ${count(svc2.json)} rows (RLS applies to the backend key). Restored.`,
          measurements: { alter_status: strip.status, service_rows_nobypass: count(svc2.json) },
        });
        await sql(ctx, `alter role service_role bypassrls;`);
        bypassChanged = false;
      } else {
        out.push({
          id: "S17d",
          title: "the project owner cannot strip BYPASSRLS from service_role",
          status: "info",
          detail: `ALTER ROLE service_role NOBYPASSRLS -> HTTP ${strip.status}: ${strip.error}`,
          measurements: { alter_status: strip.status, alter_error: strip.error.slice(0, 80) },
        });
      }

      await sql(ctx, `
create role ${ROLE} nologin nobypassrls noinherit;
grant ${ROLE} to authenticator;
grant usage on schema public to ${ROLE};
grant select on public.${T} to ${ROLE};
notify pgrst, 'reload schema';
`);
      const pg = await mgmt(ctx, "GET", `/projects/${ctx.ref}/postgrest`);
      const secret = String((pg.json as { jwt_secret?: string })?.jwt_secret ?? "");
      if (!secret) throw new Error(`no jwt_secret in GET /postgrest (HTTP ${pg.status})`);
      const now = Math.floor(Date.now() / 1000);
      const token = mintHs256(secret, { role: ROLE, iss: "supabase", iat: now, exp: now + 3600 });
      const asBackend = () => httpBody(url, { headers: { apikey: keys.anonJwt, Authorization: `Bearer ${token}` } });
      await waitFor(async () => (await asBackend()).status === 200, 60_000);
      const noPolicy = await asBackend();
      await sql(ctx, `create policy sec17_a on public.${T} for select to ${ROLE} using (tenant = 'a');`);
      const withPolicy = await asBackend();
      out.push({
        id: "S17e",
        title: "a NOBYPASSRLS backend role through the Data API: RLS applies",
        status: noPolicy.status === 200 && count(noPolicy.json) === 0 && withPolicy.status === 200 && count(withPolicy.json) === 1 ? "pass" : "fail",
        detail: `minted JWT role=${ROLE} (member of authenticator, NOBYPASSRLS): no policy -> ${noPolicy.status}, ${count(noPolicy.json)} rows${noPolicy.status !== 200 ? ` (${errCode(noPolicy.json, noPolicy.text)})` : ""}; policy tenant='a' -> ${withPolicy.status}, ${count(withPolicy.json)} rows. The backend gets RLS by connecting as a role without BYPASSRLS, not by FORCE.`,
        measurements: { backend_status_no_policy: noPolicy.status, backend_rows_no_policy: count(noPolicy.json), backend_rows_with_policy: count(withPolicy.json) },
      });
    } catch (e) {
      out.push({ id: "S17err", title: "S17 aborted", status: "fail", detail: e instanceof Error ? e.message : String(e) });
    } finally {
      if (bypassChanged) await sql(ctx, `alter role service_role bypassrls;`).catch(() => {});
      const cleaned = await sql(ctx, `drop table if exists public.${T} cascade; ${DROP_ROLES} notify pgrst, 'reload schema';`).then(() => "", (e) => (e instanceof Error ? e.message : String(e)));
      out.push({ id: "S17z", title: "cleanup", status: cleaned ? "fail" : "pass", detail: cleaned ? `cleanup error: ${cleaned}` : "table, policy, owner and backend roles dropped; service_role attributes as found" });
    }
    return out;
  },
};
export default mod;
