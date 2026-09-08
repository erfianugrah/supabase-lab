/**
 * TPA01 - Supabase trusts an external issuer's token via JWKS, and the two
 * verifiers differ. An in-process ES256 key stands in for the external IdP
 * (Clerk / Auth0 / Firebase / Cognito / a generic OIDC provider): its public
 * JWKS is published from an Edge Function, registered as third-party auth, and
 * a token it mints - with zero calls to GoTrue - is presented to the data API.
 *
 *   TPA01a  register the issuer (POST /config/auth/third-party-auth {jwks_url})
 *           and confirm the JWKS resolves.
 *   TPA01b  the self-minted token reads managed PostgREST (polled: a first-time
 *           issuer kid can take ~30s to propagate to the gateway). PASS if the
 *           data API accepts a token GoTrue never issued.
 *   TPA01c  the SAME token against managed GoTrue `/auth/v1/user` is refused
 *           (`bad_jwt`) - GoTrue and PostgREST are different verifiers, so a
 *           third-party token is a data-plane credential, not a GoTrue session.
 *
 * Not settled by this module: Storage/Realtime acceptance of the same token
 * (self-hosted-auth SH06e covers Storage), and whether the gateway validates
 * `iss` strictly vs resolving purely by `kid` - the token sets iss to the
 * jwks_url, which resolves either way.
 *
 * DESTRUCTIVE: deploys one JWKS function and registers one third-party issuer;
 * both removed in finally. Self-skips without a project ref or anon key.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { fetchKeys, sql } from "../../../harness/src/platform";
import { cleanupPrefix } from "../../edge-function-limits/lib/ef";
import { apiGet, deleteTpa, generateIdp, mint, publishJwks, registerTpa, sleep } from "../lib/idp";

const P = "pvlab-tpa01-";
const TABLE = "public.tpa_probe";

const mod: TestModule = {
  id: "TPA01",
  title: "An external issuer's token is trusted by the data API via JWKS; GoTrue refuses it",
  where: "local",
  requires: ["pat", "anon-key"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!ctx.ref) return [{ id: "TPA01", title: this.title, status: "skip", detail: "no project ref (PVLAB_REF)" }];
    const keys = await fetchKeys(ctx);
    const out: TestResult[] = [];
    const slug = `${P}jwks`;
    let tpaId = "";
    try {
      await cleanupPrefix(ctx, P);
      await sql(ctx, `create table if not exists ${TABLE} (id int primary key, note text)`);
      await sql(ctx, `insert into ${TABLE} values (1, 'row') on conflict do nothing`);
      await sql(ctx, `alter table ${TABLE} enable row level security`);
      await sql(ctx, `drop policy if exists tpa_probe_read on ${TABLE}`);
      await sql(ctx, `create policy tpa_probe_read on ${TABLE} for select to authenticated using (true)`);

      const idp = await generateIdp();
      const pub = await publishJwks(ctx, slug, idp.publicJwk);
      out.push({
        id: "TPA01a-jwks",
        title: "JWKS published from an Edge Function on the project",
        status: pub.ok ? "pass" : "fail",
        detail: `served ${pub.status} at ${pub.url}`,
        measurements: { served_status: pub.status },
      });
      if (!pub.ok) return out;

      const reg = await registerTpa(ctx, pub.url);
      tpaId = reg.id;
      out.push({
        id: "TPA01a",
        title: "third-party auth registration (jwks_url)",
        status: reg.status === 201 && tpaId ? "pass" : "fail",
        detail: `POST /config/auth/third-party-auth -> ${reg.status}${tpaId ? `, id set` : `; ${reg.body}`}`,
        measurements: { status: reg.status },
      });
      if (!tpaId) return out;

      const sub = crypto.randomUUID();
      const token = await mint(idp, { sub, iss: pub.url });

      // TPA01b - poll PostgREST until the gateway resolves the new issuer kid.
      const t0 = Date.now();
      let rest = await apiGet(ctx, `/rest/v1/tpa_probe?select=id`, keys.anon, token);
      let acceptedAfter: number | string = "never";
      while (Date.now() - t0 < 120_000 && rest.status !== 200) {
        await sleep(5_000);
        rest = await apiGet(ctx, `/rest/v1/tpa_probe?select=id`, keys.anon, token);
      }
      const rows = Array.isArray(rest.json) ? (rest.json as unknown[]).length : 0;
      if (rest.status === 200) acceptedAfter = Math.round((Date.now() - t0) / 1000);
      out.push({
        id: "TPA01b",
        title: "self-minted external token reads managed PostgREST (verified via JWKS)",
        status: rest.status === 200 ? "pass" : "fail",
        detail: `PostgREST ${rest.status} rows=${rows}${rest.code ? ` ${rest.code}` : ""}, accepted ${acceptedAfter}s after registration - a token GoTrue never issued`,
        measurements: { rest_status: rest.status, rows, accepted_after_s: acceptedAfter, code: rest.code || "none" },
      });

      // TPA01c - managed GoTrue refuses the same token.
      const gotrue = await apiGet(ctx, `/auth/v1/user`, keys.anon, token);
      out.push({
        id: "TPA01c",
        title: "managed GoTrue /auth/v1/user refuses the third-party token",
        status: gotrue.status >= 400 ? "pass" : "fail",
        detail: `GoTrue /auth/v1/user -> ${gotrue.status}${gotrue.code ? ` ${gotrue.code}` : ""} (data API trusts it, GoTrue does not - different verifiers)`,
        measurements: { gotrue_status: gotrue.status, gotrue_code: gotrue.code || "none" },
      });
    } catch (e) {
      out.push({ id: "TPA01", title: this.title, status: "fail", detail: `threw: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      const notes: string[] = [];
      if (tpaId) notes.push(`tpa delete ${await deleteTpa(ctx, tpaId)}`);
      await sql(ctx, `drop table if exists ${TABLE}`);
      const c = await cleanupPrefix(ctx, P).catch(() => ({ deleted: 0, left: ["threw"] }));
      notes.push(`functions deleted ${c.deleted}${c.left.length ? ` LEFT ${c.left.join(",")}` : ""}`);
      out.push({ id: "TPA01z", title: "cleanup: delete issuer, JWKS function, probe table", status: c.left.length ? "fail" : "pass", detail: notes.join("; ") });
    }
    return out;
  },
};

export default mod;
