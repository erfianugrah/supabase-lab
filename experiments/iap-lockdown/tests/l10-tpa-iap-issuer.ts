/**
 * L10 - IAP-as-issuer: Cloudflare Access-for-SaaS (OIDC) registered as
 * Supabase third-party auth, RLS keyed on the Access issuer, so the data API
 * serves only requests carrying an Access-issued identity.
 *
 *   L10a - register the Access OIDC issuer (ctx.endpoints["oidc_issuer"],
 *          from the tofu output) via POST /config/auth/third-party-auth
 *          { oidc_issuer_url }; poll until resolved (X01: oidc_issuer_url
 *          resolves in tens of ms to seconds; custom_jwks never resolves).
 *   L10b - fixture table with RLS + a policy that only admits a JWT whose
 *          `iss` is the Access issuer. anon and GoTrue tokens carry a
 *          different iss, so they are filtered out.
 *   L10c - assertions: anon key -> 0 rows; a GoTrue user token -> 0 rows;
 *          a real Access-issued token -> rows. The Access token needs the
 *          interactive OIDC login (chrome), supplied via PVLAB_IAP_TOKEN;
 *          absent it, that one row is recorded as pending, the two denials
 *          still stand.
 *
 * Requires ctx.endpoints["oidc_issuer"]; self-skips with a reason otherwise.
 * DESTRUCTIVE: registers/deletes a TPA integration + a fixture table.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import { fetchKeys, http, sql, waitFor, IAP_USER_PASSWORD } from "../lib/inventory.js";

const T = "l10_docs";

// The gateway routes on a valid `apikey` (anon/publishable); the bearer is the
// identity RLS sees. For anon these are the same key; for a GoTrue or IAP
// token, apikey stays the anon key and only the bearer changes.
async function restCount(ctx: Ctx, bearer: string, apikey = bearer): Promise<{ status: number; n: number; code: string }> {
  const r = await fetch(`https://${ctx.apiHost}/rest/v1/${T}?select=id`, {
    headers: { apikey, Authorization: `Bearer ${bearer}` },
  });
  let n = -1;
  let code = "";
  const text = await r.text();
  if (r.status === 200) {
    try {
      n = (JSON.parse(text) as unknown[]).length;
    } catch {
      n = -1;
    }
  } else {
    try {
      code = String((JSON.parse(text) as { code?: string; message?: string }).code ?? "");
    } catch {
      code = text.slice(0, 60);
    }
  }
  return { status: r.status, n, code };
}

const mod: TestModule = {
  id: "L10",
  title: "IAP-as-issuer: Access OIDC as TPA + issuer-keyed RLS gates the data API",
  where: "local",
  requires: ["pat", "anon-key"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const issuer = ctx.endpoints["oidc_issuer"];
    if (!issuer) {
      return [{ id: "L10", title: this.title, status: "skip", detail: "no ctx.endpoints.oidc_issuer (set PVLAB_ENDPOINT_OIDC_ISSUER from tofu output oidc_issuer_url)" }];
    }
    const keys = await fetchKeys(ctx);
    const results: TestResult[] = [];
    let tpaId: string | undefined;

    try {
      // L10a - register + resolve.
      const reg = await mgmt(ctx, "POST", `/projects/${ctx.ref}/config/auth/third-party-auth`, { oidc_issuer_url: issuer });
      tpaId = typeof (reg.json as { id?: string })?.id === "string" ? (reg.json as { id: string }).id : undefined;
      const resolvedOnCreate = (reg.json as { resolved_jwks?: unknown; resolved_at?: unknown })?.resolved_jwks != null || (reg.json as { resolved_at?: unknown })?.resolved_at != null;
      const resolved = resolvedOnCreate
        ? { ok: true, elapsedS: 0 }
        : await waitFor(async () => {
            const list = await mgmt(ctx, "GET", `/projects/${ctx.ref}/config/auth/third-party-auth`);
            const arr = Array.isArray(list.json) ? (list.json as { id?: string; resolved_jwks?: unknown; resolved_at?: unknown }[]) : [];
            const me = arr.find((t) => t.id === tpaId);
            return me?.resolved_jwks != null || me?.resolved_at != null;
          }, 90_000);
      results.push({
        id: "L10a",
        title: "register the Access OIDC issuer as third-party auth",
        status: reg.status < 300 && tpaId && resolved.ok ? "pass" : "fail",
        detail: `create HTTP ${reg.status}, resolved=${resolved.ok} in ${resolved.elapsedS}s - Supabase fetched the Access issuer's JWKS`,
        measurements: { create_status: reg.status, resolved: String(resolved.ok), resolve_s: resolved.elapsedS },
        evidence: reg.text.slice(0, 200),
      });

      // L10b - RLS keyed on the Access issuer.
      await sql(ctx, `
create table if not exists public.${T} (id bigint generated always as identity primary key, note text default '');
truncate public.${T};
insert into public.${T} (note) values ('iap-only-a'), ('iap-only-b');
grant select on public.${T} to anon, authenticated;
alter table public.${T} enable row level security;
drop policy if exists l10_iap_only on public.${T};
create policy l10_iap_only on public.${T} for select
  using ((auth.jwt() ->> 'iss') = '${issuer.replace(/'/g, "''")}');
`);
      // Wait for PostgREST's schema cache to pick up the fresh table (service
      // bypasses RLS, so it sees the 2 rows once the table is live).
      const ready = await waitFor(async () => (await restCount(ctx, keys.serviceJwt)).status === 200, 60_000);
      results.push({ id: "L10b", title: "RLS policy: only a JWT whose iss = the Access issuer may read", status: ready.ok ? "info" : "fail", detail: `policy keyed on iss='${issuer}'; table live in ${ready.elapsedS}s` });

      // L10c - denials that need no interactive token.
      const anon = await restCount(ctx, keys.anonJwt);
      // A GoTrue user token (iss = the project's own /auth/v1).
      const userEmail = `iap.l10.${Date.now()}@example.com`;
      const mk = await http(`https://${ctx.apiHost}/auth/v1/admin/users`, { method: "POST", key: keys.serviceJwt, body: { email: userEmail, password: IAP_USER_PASSWORD, email_confirm: true } });
      let gotrueToken = "";
      const gotLogin = await waitFor(async () => {
        const login = await fetch(`https://${ctx.apiHost}/auth/v1/token?grant_type=password`, {
          method: "POST",
          headers: { apikey: keys.anonJwt, "Content-Type": "application/json" },
          body: JSON.stringify({ email: userEmail, password: IAP_USER_PASSWORD }),
        });
        if (login.status !== 200) return false;
        gotrueToken = ((await login.json()) as { access_token?: string }).access_token ?? "";
        return Boolean(gotrueToken);
      }, 30_000);
      const gotrue = gotrueToken ? await restCount(ctx, gotrueToken, keys.anonJwt) : { status: 0, n: -1, code: `login-failed(admin ${mk.status})` };

      results.push({
        id: "L10c",
        title: "non-IAP identities are denied by the issuer-keyed RLS",
        status: anon.status === 200 && anon.n === 0 && gotrue.status === 200 && gotrue.n === 0 ? "pass" : "fail",
        detail: `anon-key -> ${anon.status}/rows=${anon.n}; GoTrue-user -> ${gotrue.status}/rows=${gotrue.n} (login ok=${gotLogin.ok}) - both carry a non-Access iss, so issuer-keyed RLS filters them to zero`,
        measurements: { anon_status: anon.status, anon_rows: anon.n, gotrue_status: gotrue.status, gotrue_rows: gotrue.n },
      });

      // The IAP-token-accepted row: needs a real Access-issued token.
      const iapToken = process.env.PVLAB_IAP_TOKEN ?? "";
      if (iapToken) {
        const iap = await restCount(ctx, iapToken, keys.anonJwt);
        results.push({
          id: "L10d",
          title: "a real Access-issued token IS admitted",
          status: iap.n > 0 ? "pass" : "fail",
          detail: `Access token rows=${iap.n} (status ${iap.status}) - the data API serves ONLY the IAP identity`,
          measurements: { iap_rows: iap.n, iap_status: iap.status },
        });
      } else {
        results.push({
          id: "L10d",
          title: "a real Access-issued token IS admitted",
          status: "skip",
          detail: "PVLAB_IAP_TOKEN not set - obtain an Access OIDC token via the chrome login and re-run with it to complete the three-credential proof",
        });
      }
    } catch (e) {
      results.push({ id: "L10err", title: "L10 aborted", status: "fail", detail: e instanceof Error ? e.message : String(e) });
    } finally {
      if (tpaId) await mgmt(ctx, "DELETE", `/projects/${ctx.ref}/config/auth/third-party-auth/${tpaId}`).catch(() => {});
      await sql(ctx, `drop table if exists public.${T} cascade;`).catch(() => {});
    }
    return results;
  },
};
export default mod;
