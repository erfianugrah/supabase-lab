/**
 * TPA03 - GoTrue and its migrations stay on the project under third-party auth.
 * This is the non-obvious line in the email: turning on an external IdP does
 * NOT remove Supabase Auth or its schema-migration behaviour, so the
 * migration-lock guidance still applies even to a customer who signs users in
 * elsewhere.
 *
 *   TPA03a  with a third-party issuer registered, auth.schema_migrations still
 *           holds the platform's migration rows (the migration machinery is
 *           present and owned by Auth). PASS if the count is non-trivial.
 *   TPA03b  managed GoTrue is still live: GET /auth/v1/health answers 200 while
 *           the external issuer is registered.
 *   TPA03c  native GoTrue still issues and the data API honours ITS tokens too:
 *           admin-create a user, password-grant a GoTrue token, read PostgREST
 *           with it. So GoTrue tokens and third-party tokens are both valid data
 *           credentials on the same project - TPA is additive, not a swap.
 *
 * Together with auth-users-locks (migrations take ACCESS EXCLUSIVE and run on
 * every Auth version start), TPA03 is why the lock guidance holds under TPA:
 * Auth still runs and still migrates here.
 *
 * Not settled by this module: forcing a GoTrue VERSION upgrade to watch a
 * migration run (no lever on a managed project); TPA03a shows the machinery is
 * present, auth-users-locks shows what a migration does when it runs.
 *
 * DESTRUCTIVE: registers one issuer and creates one user; both removed in
 * finally. Self-skips without a ref or anon key.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { fetchKeys, sql } from "../../../harness/src/platform";
import { cleanupPrefix } from "../../edge-function-limits/lib/ef";
import { adminCreateUser, apiGet, deleteTpa, generateIdp, passwordGrant, publishJwks, registerTpa } from "../lib/idp";

const P = "pvlab-tpa03-";
const TABLE = "public.tpa_native";

const mod: TestModule = {
  id: "TPA03",
  title: "GoTrue and its migrations persist on the project under third-party auth",
  where: "local",
  requires: ["pat", "anon-key"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!ctx.ref) return [{ id: "TPA03", title: this.title, status: "skip", detail: "no project ref (PVLAB_REF)" }];
    const keys = await fetchKeys(ctx);
    const out: TestResult[] = [];
    const slug = `${P}jwks`;
    let tpaId = "";
    let userId = "";
    const email = `tpa03.${Date.now()}@example.com`;
    const password = "supabase-lab-test-password"; // synthetic, low entropy on purpose
    try {
      await cleanupPrefix(ctx, P);
      // Register an external issuer so the whole module runs WITH TPA active.
      const idp = await generateIdp();
      const pub = await publishJwks(ctx, slug, idp.publicJwk);
      if (pub.ok) {
        const reg = await registerTpa(ctx, pub.url);
        tpaId = reg.id;
      }
      out.push({
        id: "TPA03-setup",
        title: "external issuer registered (context for the checks below)",
        status: tpaId ? "pass" : "fail",
        detail: tpaId ? "third-party auth active" : `could not register issuer (jwks ${pub.status})`,
        measurements: { tpa_active: tpaId ? 1 : 0 },
      });

      // TPA03a - migration machinery present under TPA.
      const mig = await sql(ctx, `select count(*)::int as n from auth.schema_migrations`);
      const n = Number((mig.rows[0]?.n as number | undefined) ?? 0);
      out.push({
        id: "TPA03a",
        title: "auth.schema_migrations still populated under third-party auth",
        status: n > 10 ? "pass" : "fail",
        detail: `auth.schema_migrations rows = ${n} (Auth owns and runs these regardless of TPA)`,
        measurements: { migration_rows: n },
      });

      // TPA03b - managed GoTrue health.
      const health = await apiGet(ctx, `/auth/v1/health`, keys.anon);
      out.push({
        id: "TPA03b",
        title: "managed GoTrue is live while the external issuer is registered",
        status: health.status === 200 ? "pass" : "fail",
        detail: `GET /auth/v1/health -> ${health.status} ${health.text.slice(0, 80)}`,
        measurements: { health_status: health.status },
      });

      // TPA03c - native GoTrue still issues, and PostgREST honours its token too.
      await sql(ctx, `create table if not exists ${TABLE} (id int primary key)`);
      await sql(ctx, `insert into ${TABLE} values (1) on conflict do nothing`);
      await sql(ctx, `alter table ${TABLE} enable row level security`);
      await sql(ctx, `drop policy if exists tpa_native_read on ${TABLE}`);
      await sql(ctx, `create policy tpa_native_read on ${TABLE} for select to authenticated using (true)`);
      const created = await adminCreateUser(ctx, keys.service, email, password);
      const u = await sql(ctx, `select id from auth.users where email = '${email}' limit 1`);
      userId = (u.rows[0]?.id as string | undefined) ?? "";
      const grant = await passwordGrant(ctx, keys.anon, email, password);
      const nativeRead = grant.token ? await apiGet(ctx, `/rest/v1/tpa_native?select=id`, keys.anon, grant.token) : { status: 0, code: "no-token", json: [], text: "" };
      out.push({
        id: "TPA03c",
        title: "native GoTrue still issues, and the data API honours its token too",
        status: grant.status === 200 && nativeRead.status === 200 ? "pass" : "fail",
        detail: `admin-create ${created}; password grant ${grant.status}; native token -> PostgREST ${nativeRead.status}${nativeRead.code ? ` ${nativeRead.code}` : ""} - TPA is additive, GoTrue tokens still work`,
        measurements: { grant_status: grant.status, native_rest_status: nativeRead.status },
      });
    } catch (e) {
      out.push({ id: "TPA03", title: this.title, status: "fail", detail: `threw: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      const notes: string[] = [];
      if (tpaId) notes.push(`tpa delete ${await deleteTpa(ctx, tpaId)}`);
      if (userId) {
        const st = await fetch(`https://${ctx.apiHost}/auth/v1/admin/users/${userId}`, { method: "DELETE", headers: { apikey: keys.service, Authorization: `Bearer ${keys.service}` } }).then((r) => r.status).catch(() => 0);
        notes.push(`user delete ${st}`);
      }
      await sql(ctx, `drop table if exists ${TABLE}`);
      const c = await cleanupPrefix(ctx, P).catch(() => ({ deleted: 0, left: ["threw"] }));
      notes.push(`functions deleted ${c.deleted}${c.left.length ? ` LEFT ${c.left.join(",")}` : ""}`);
      out.push({ id: "TPA03z", title: "cleanup: delete issuer, user, native table, JWKS", status: c.left.length ? "fail" : "pass", detail: notes.join("; ") });
    }
    return out;
  },
};

export default mod;
