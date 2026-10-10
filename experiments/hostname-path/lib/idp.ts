/**
 * A mock OIDC issuer for the Keycloak provider slot, deployed as an Edge
 * Function on the project under test, so the OAuth round trip needs no
 * third-party credential and no Worker (the vault Cloudflare token cannot
 * deploy one). The Auth server appends /protocol/openid-connect/{auth,token,
 * userinfo} to `external_keycloak_url` and performs no issuer check
 * (identity-transfer lib/flow.ts; supabase/auth keycloak.go).
 *
 * The issuer auto-approves: /auth redirects straight back to the
 * `redirect_uri` it was given. It also records what the Auth server sent it:
 * the token request's `redirect_uri` is folded into the access token, and
 * /userinfo returns it as an extra claim, which the Keycloak provider keeps
 * in the identity's `identity_data.custom_claims`. That is how the module reads which host
 * the Auth server believed its callback lived on, from the server side.
 */
import type { Ctx } from "../../../harness/src/types";
import { mgmt, mgmtBase } from "../../../harness/src/mgmt";
import { jwtPayload } from "./state";

export const IDP_SLUG = "hp-mock-idp";
export const SITE_URL = "http://localhost:3000/hp-callback";

export const IDP_SOURCE = `const b64 = (s: string) => btoa(s).replace(/=+$/, "");
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
Deno.serve(async (req) => {
  const u = new URL(req.url);
  const p = u.pathname.replace(/^\\/(functions\\/v1\\/)?${IDP_SLUG}/, "");
  if (p === "/protocol/openid-connect/auth") {
    const ru = u.searchParams.get("redirect_uri") ?? "";
    if (!ru) return json({ error: "no redirect_uri" }, 400);
    const to = new URL(ru);
    to.searchParams.set("code", "hp-code");
    to.searchParams.set("state", u.searchParams.get("state") ?? "");
    return new Response(null, { status: 302, headers: { Location: to.toString() } });
  }
  if (p === "/protocol/openid-connect/token") {
    const f = new URLSearchParams(await req.text());
    return json({ access_token: "hp." + b64(f.get("redirect_uri") ?? ""), token_type: "Bearer", expires_in: 300 });
  }
  if (p === "/protocol/openid-connect/userinfo") {
    const at = (req.headers.get("authorization") ?? "").replace(/^Bearer /i, "");
    let seen = "";
    try { seen = atob(at.slice(3)); } catch { /* not ours */ }
    return json({ sub: "hp-user-1", email: "hp-oauth@lab.test", email_verified: true, name: "HP User", hp_token_redirect_uri: seen });
  }
  return json({ ok: true, path: p });
});
`;

export async function deployIdp(ctx: Ctx): Promise<{ status: number; error: string }> {
  const form = new FormData();
  form.append("file", new Blob([IDP_SOURCE]), "index.ts");
  form.append("metadata", JSON.stringify({ entrypoint_path: "index.ts", name: IDP_SLUG, verify_jwt: false }));
  const res = await fetch(`${mgmtBase(ctx)}/projects/${ctx.ref}/functions/deploy?slug=${IDP_SLUG}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ctx.pat}` },
    body: form,
    signal: AbortSignal.timeout(180_000),
  });
  const text = await res.text();
  return { status: res.status, error: res.status >= 300 ? text.slice(0, 300) : "" };
}

/** Point the project's Keycloak slot at the mock issuer and wait for /auth/v1/settings to say so. */
export async function enableKeycloak(ctx: Ctx, apikey: string, issuer: string): Promise<{ patch: number; settledS: number | string }> {
  const t0 = Date.now();
  const patch = await mgmt(ctx, "PATCH", `/projects/${ctx.ref}/config/auth`, {
    external_keycloak_enabled: true,
    external_keycloak_client_id: "hp-client",
    external_keycloak_secret: "unused-the-mock-issuer-ignores-client-auth",
    external_keycloak_url: issuer,
    site_url: SITE_URL,
    uri_allow_list: "http://localhost:3000/**",
  });
  while (Date.now() - t0 < 120_000) {
    const s = await fetch(`https://${ctx.apiHost}/auth/v1/settings`, { headers: { apikey }, signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
    const j = (await s?.json().catch(() => ({}))) as { external?: Record<string, boolean> } | undefined;
    if (j?.external?.keycloak === true) return { patch: patch.status, settledS: Math.round((Date.now() - t0) / 1000) };
    await Bun.sleep(3_000);
  }
  return { patch: patch.status, settledS: "never" };
}

export interface Hop {
  /** "authorize", "issuer", "callback" */
  step: string;
  status: number;
  /** host + path of the request, no query. */
  at: string;
  /** host + path of the Location header, no query/fragment. */
  to: string;
}

export interface RoundTrip {
  hops: Hop[];
  /** `redirect_uri` the Auth server put on the issuer redirect. */
  redirectUri: string;
  /** Host of the callback the browser was sent to after the issuer. */
  callbackHost: string;
  /** Where the browser lands (host + path). */
  landed: string;
  accessToken: string;
  iss: string;
  error: string;
}

const hostPath = (u: string) => {
  try {
    const x = new URL(u);
    return `${x.host}${x.pathname}`;
  } catch {
    return u;
  }
};

/**
 * Drive the browser flow by hand against `entryHost`: /authorize -> issuer
 * /auth -> callback -> landing page with tokens in the fragment. The first
 * request is built exactly as supabase-js builds it (signInWithOAuth with
 * skipBrowserRedirect), so the entry host is whatever the client was given.
 */
export async function roundTrip(entryUrl: string): Promise<RoundTrip> {
  const rt: RoundTrip = { hops: [], redirectUri: "", callbackHost: "", landed: "", accessToken: "", iss: "", error: "" };
  const step = async (name: string, url: string): Promise<string> => {
    const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
    const loc = r.headers.get("location") ?? "";
    rt.hops.push({ step: name, status: r.status, at: hostPath(url), to: loc ? hostPath(loc) : "" });
    if (!loc) rt.error = `${name}: HTTP ${r.status} ${(await r.text()).slice(0, 160)}`;
    return loc;
  };
  try {
    const l1 = await step("authorize", entryUrl);
    if (!l1) return rt;
    rt.redirectUri = new URL(l1).searchParams.get("redirect_uri") ?? "";
    const l2 = await step("issuer", l1);
    if (!l2) return rt;
    rt.callbackHost = new URL(l2).host;
    const l3 = await step("callback", l2);
    if (!l3) return rt;
    const u = new URL(l3);
    rt.landed = `${u.host}${u.pathname}`;
    const frag = new URLSearchParams(u.hash.replace(/^#/, ""));
    rt.accessToken = frag.get("access_token") ?? "";
    if (!rt.accessToken) rt.error = `landing without access_token: ${frag.get("error_description") ?? u.searchParams.get("error_description") ?? l3.slice(0, 120)}`;
    rt.iss = String(jwtPayload(rt.accessToken).iss ?? "");
  } catch (e) {
    rt.error = (e instanceof Error ? e.message : String(e)).slice(0, 200);
  }
  return rt;
}
