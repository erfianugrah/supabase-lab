/**
 * L10E - IAP-as-issuer, the admit half, proven WITHOUT a browser.
 *
 * L10a-c registered the REAL Cloudflare Access OIDC issuer and showed it
 * resolves + that non-IAP identities are denied. The remaining row ("a valid
 * IAP token IS admitted") needs a token minted by a trusted issuer. Rather
 * than drive the interactive Access login, we use the lab ES256 issuer we
 * control (jwks/, the plan's stand-in for the IAP's IdP): mint an identity
 * token ourselves and show the data API admits only it.
 *
 * A Supabase PAT cannot stand in here - it is a control-plane admin
 * credential, not the RLS-evaluated end-user JWT. Only a token signed by a
 * registered third-party-auth key is admitted.
 *
 * Self-contained: serves the JWKS from the project's own Edge Function (no
 * external host), registers it as third-party auth (jwks_url shape - X01
 * measured custom_jwks never resolves), keys RLS on the issuer, mints, probes.
 *
 * DESTRUCTIVE: EF + TPA + table; all removed in finally.
 */
import { createPrivateKey, createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import { fetchKeys, http, sql, waitFor } from "../lib/inventory.js";

const ISS = "lab-iap-issuer";
const JWKS_FN = "lab-jwks";
const T = "l10e_docs";

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

function mint(privJwk: Record<string, unknown>): string {
  const header = { alg: "ES256", typ: "JWT", kid: privJwk.kid };
  const now = Math.floor(Date.now() / 1000);
  const payload = { role: "authenticated", iss: ISS, sub: "lab-user-1", aud: "authenticated", iat: now, exp: now + 3600 };
  const input = `${b64url(Buffer.from(JSON.stringify(header)))}.${b64url(Buffer.from(JSON.stringify(payload)))}`;
  const key = createPrivateKey({ key: privJwk as never, format: "jwk" });
  const sig = createSign("sha256").update(input).sign({ key, dsaEncoding: "ieee-p1363" });
  return `${input}.${b64url(sig)}`;
}

async function restCount(ctx: Ctx, bearer: string, apikey: string) {
  const r = await fetch(`https://${ctx.apiHost}/rest/v1/${T}?select=id`, { headers: { apikey, Authorization: `Bearer ${bearer}` } });
  const t = await r.text();
  let n = -1;
  try { n = (JSON.parse(t) as unknown[]).length; } catch {}
  return { status: r.status, n };
}

const mod: TestModule = {
  id: "L10E",
  title: "IAP-as-issuer admitted: a minted lab-issuer identity token is served, anon denied",
  where: "local",
  requires: ["pat", "anon-key"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    // The compiled binary cannot resolve import.meta.url to the source tree,
    // so the jwks dir comes from the Makefile (PVLAB_JWKS_DIR).
    const jwksDir = process.env.PVLAB_JWKS_DIR;
    let priv: Record<string, unknown>;
    let pub: Record<string, unknown>;
    try {
      if (!jwksDir) throw new Error("PVLAB_JWKS_DIR unset");
      priv = JSON.parse(readFileSync(`${jwksDir}/private.json`, "utf8"));
      pub = JSON.parse(readFileSync(`${jwksDir}/public.json`, "utf8"));
    } catch (e) {
      return [{ id: "L10E", title: this.title, status: "skip", detail: `no jwks/ keypair (${e instanceof Error ? e.message : e}) - set PVLAB_JWKS_DIR / run keygen` }];
    }
    const keys = await fetchKeys(ctx);
    const results: TestResult[] = [];
    let tpaId: string | undefined;
    let efDeployed = false;

    try {
      const efBody = `Deno.serve(()=>new Response(JSON.stringify({keys:[${JSON.stringify(pub)}]}),{headers:{'content-type':'application/json'}}))`;
      const ef = await mgmt(ctx, "POST", `/projects/${ctx.ref}/functions`, { slug: JWKS_FN, name: JWKS_FN, verify_jwt: false, body: efBody });
      efDeployed = ef.status < 300;
      const jwksUrl = `https://${ctx.apiHost}/functions/v1/${JWKS_FN}`;
      await waitFor(async () => (await http(jwksUrl)).status === 200, 60_000);

      const reg = await mgmt(ctx, "POST", `/projects/${ctx.ref}/config/auth/third-party-auth`, { jwks_url: jwksUrl });
      tpaId = (reg.json as { id?: string })?.id;
      const resolved = await waitFor(async () => {
        const list = await mgmt(ctx, "GET", `/projects/${ctx.ref}/config/auth/third-party-auth`);
        const me = (Array.isArray(list.json) ? (list.json as { id?: string; resolved_jwks?: unknown; resolved_at?: unknown }[]) : []).find((t) => t.id === tpaId);
        return me?.resolved_jwks != null || me?.resolved_at != null;
      }, 90_000);
      results.push({
        id: "L10E-a",
        title: "lab issuer registered as third-party auth (JWKS served by an Edge Function)",
        status: reg.status < 300 && resolved.ok ? "pass" : "fail",
        detail: `EF ${ef.status}, TPA ${reg.status}, resolved=${resolved.ok} in ${resolved.elapsedS}s`,
      });

      await sql(ctx, `
create table if not exists public.${T} (id bigint generated always as identity primary key, note text);
truncate public.${T};
insert into public.${T} (note) values ('iap-a'),('iap-b');
grant select on public.${T} to anon, authenticated;
alter table public.${T} enable row level security;
drop policy if exists l10e_iap on public.${T};
create policy l10e_iap on public.${T} for select using ((auth.jwt()->>'iss') = '${ISS}');
`);
      await waitFor(async () => (await restCount(ctx, keys.serviceJwt, keys.serviceJwt)).status === 200, 60_000);

      const token = mint(priv);
      let iap = { status: 0, n: -1 };
      await waitFor(async () => { iap = await restCount(ctx, token, keys.anonJwt); return iap.status === 200 && iap.n > 0; }, 30_000);
      const anon = await restCount(ctx, keys.anonJwt, keys.anonJwt);
      results.push({
        id: "L10E-b",
        title: "minted IAP identity token IS admitted; anon is denied",
        status: iap.status === 200 && iap.n > 0 && anon.status === 200 && anon.n === 0 ? "pass" : "fail",
        detail: `minted lab-IAP token -> ${iap.status}/rows=${iap.n} (admitted); anon-key -> ${anon.status}/rows=${anon.n} (denied). The data API serves ONLY the IAP identity - no browser, no real Access token needed; the lab issuer stands in for the IdP.`,
        measurements: { iap_status: iap.status, iap_rows: iap.n, anon_rows: anon.n },
      });
    } catch (e) {
      results.push({ id: "L10E-err", title: "L10E aborted", status: "fail", detail: e instanceof Error ? e.message : String(e) });
    } finally {
      if (tpaId) await mgmt(ctx, "DELETE", `/projects/${ctx.ref}/config/auth/third-party-auth/${tpaId}`).catch(() => {});
      await sql(ctx, `drop table if exists public.${T} cascade;`).catch(() => {});
      if (efDeployed) await mgmt(ctx, "DELETE", `/projects/${ctx.ref}/functions/${JWKS_FN}`).catch(() => {});
    }
    return results;
  },
};
export default mod;
