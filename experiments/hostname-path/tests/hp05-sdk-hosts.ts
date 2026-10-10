/**
 * HP05 - Which host the SDK and the server put in URLs, custom domain active.
 *
 *   HP05a  supabase-js given the custom host: every request's host and the host
 *          of every URL returned by getPublicUrl, createSignedUrl,
 *          createSignedUrls, createSignedUploadUrl.
 *   HP05b  supabase-js still given the project hostname, after activation
 *          (does the server start returning custom-host URLs to it?).
 *   HP05c  the raw server responses behind the signed-URL calls: the sign
 *          endpoint's `signedURL`, the upload response and the PostgREST
 *          OpenAPI root, called on both hosts, scanned for any absolute URL or
 *          host name (the SDK builds the absolute URL; does the server hand
 *          one back?).
 *   HP05d  `iss` of a password-grant token and `/.well-known/jwks.json`, on both hosts.
 */
import { fetchKeys } from "../../../harness/src/platform";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { hostLabel, sdkResult } from "../lib/phase";
import { PW, USER_EMAIL, jwtPayload, useState } from "../lib/state";

const HOST_RE = /(?:https?:\/\/)?([a-z0-9-]+\.)+(co|dev|com|io)\b/gi;

const mod: TestModule = {
  id: "HP05",
  title: "SDK and server URL hosts with the custom domain active",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const st = await useState(ctx);
    if (!st?.domainActive) return [{ id: "HP05", title: this.title, status: "skip", detail: "custom domain not active (HP03 did not complete)" }];
    const keys = await fetchKeys(ctx);
    const out: TestResult[] = [];
    out.push(await sdkResult("HP05a", "SDK hosts, client given the custom hostname", ctx, st, { label: "custom", host: st.host }, keys.service));
    out.push(await sdkResult("HP05b", "SDK hosts, client given the project hostname, after activation", ctx, st, { label: "origin", host: `${st.ref}.supabase.co` }, keys.service));

    // ---- c: raw bodies ----
    const m: Record<string, string> = {};
    const auth = { Authorization: `Bearer ${keys.service}`, apikey: keys.service };
    const hosts: [string, string][] = [["origin", `${st.ref}.supabase.co`], ["custom", st.host]];
    for (const [label, h] of hosts) {
      const base = `https://${h}`;
      const bodies: Record<string, string> = {};
      const sign = await fetch(`${base}/storage/v1/object/sign/hp-priv/hello.txt`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ expiresIn: 600 }) });
      bodies.sign = await sign.text();
      const signUp = await fetch(`${base}/storage/v1/object/upload/sign/hp-priv/raw-up.txt`, { method: "POST", headers: auth });
      bodies.sign_upload = await signUp.text();
      const up = await fetch(`${base}/storage/v1/object/hp-priv/raw.txt`, { method: "POST", headers: { ...auth, "Content-Type": "text/plain", "x-upsert": "true" }, body: "x" });
      bodies.upload = await up.text();
      const rest = await fetch(`${base}/rest/v1/`, { headers: auth });
      bodies.postgrest_root = (await rest.text()).slice(0, 4000);
      for (const [k, v] of Object.entries(bodies)) {
        const found = new Set<string>();
        for (const x of v.matchAll(HOST_RE)) found.add(hostLabel(x[0].replace(/^https?:\/\//, ""), st.ref, st.host));
        m[`${label}_${k}_hosts`] = [...found].join("+") || "none";
        m[`${label}_${k}_shape`] = v.length > 200 ? `${v.length} bytes` : v.replace(/token=[^"&]+/g, "token=<jwt>").replaceAll(st.ref, "<ref>").replaceAll(st.host, "<custom>").slice(0, 120);
      }
    }
    out.push({
      id: "HP05c",
      title: "raw server bodies: any absolute host in sign, upload and PostgREST-root responses",
      status: "info",
      detail: Object.entries(m).filter(([k]) => k.endsWith("_hosts")).map(([k, v]) => `${k}=${v}`).join("; "),
      measurements: m,
    });

    // ---- d: token issuer vs host, JWKS on both hosts ----
    // A verifier that checks `iss` against the host the client used, or that
    // fetches keys from `<iss>/.well-known/jwks.json`, depends on this.
    const jm: Record<string, string> = {};
    for (const [label, h] of hosts) {
      const r = await fetch(`https://${h}/auth/v1/.well-known/jwks.json`, { headers: { apikey: st.anon } });
      jm[`${label}_jwks_status`] = String(r.status);
      jm[`${label}_jwks_keys`] = String(((await r.json().catch(() => ({}))) as { keys?: unknown[] }).keys?.length ?? "-");
      const t = await fetch(`https://${h}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: st.anon, "Content-Type": "application/json" }, body: JSON.stringify({ email: USER_EMAIL, password: PW }) });
      const jwt = ((await t.json().catch(() => ({}))) as { access_token?: string }).access_token ?? "";
      jm[`${label}_password_grant_status`] = String(t.status);
      const iss = String(jwtPayload(jwt).iss ?? "");
      jm[`${label}_token_iss`] = iss ? `${hostLabel(new URL(iss).host, st.ref, st.host)}${new URL(iss).pathname}` : "-";
    }
    out.push({
      id: "HP05d",
      title: "token `iss` and JWKS, requests entered at each host",
      status: "info",
      detail: Object.entries(jm).map(([k, v]) => `${k}=${v}`).join("; "),
      measurements: jm,
    });
    return out;
  },
};
export default mod;
