/**
 * The OAuth and SDK probes, parameterised so the same code runs before the
 * custom domain exists (HP02, the baseline), and after it is active (HP04,
 * HP05). Hosts are reported as labels - `origin` (`<ref>.supabase.co`),
 * `custom` (the custom hostname) - so a result row reads the same in every run
 * and carries neither the project ref nor the hostname.
 */
import { createClient } from "@supabase/supabase-js";
import type { Ctx, TestResult } from "../../../harness/src/types";
import { roundTrip } from "./idp";
import { sdkProbe, type OpRow } from "./sdk";
import { jwtPayload, type HpState } from "./state";

export function hostLabel(h: string, ref: string, custom: string): string {
  if (!h) return "-";
  if (h === `${ref}.supabase.co`) return "origin";
  if (h === custom) return "custom";
  if (h === `${ref}.storage.supabase.co`) return "origin-storage-host";
  if (h === `${ref}.functions.supabase.co`) return "origin-functions-host";
  return h.replace(ref, "<ref>");
}

const hl = (h: string, st: HpState) => hostLabel(h, st.ref, st.host);

export interface Entry {
  label: "origin" | "custom";
  host: string;
}

/** OAuth round trip entering at each host in turn, id `<prefix>a`, `<prefix>b`... */
export async function oauthResults(prefix: string, ctx: Ctx, st: HpState, entries: Entry[]): Promise<TestResult[]> {
  const out: TestResult[] = [];
  let n = 0;
  for (const e of entries) {
    const base = `https://${e.host}`;
    const sb = createClient(base, st.anon, { auth: { persistSession: false, autoRefreshToken: false } });
    const r = await sb.auth.signInWithOAuth({ provider: "keycloak", options: { redirectTo: "http://localhost:3000/hp-callback", skipBrowserRedirect: true } });
    const authorizeUrl = r.data.url ?? "";
    const rt = await roundTrip(authorizeUrl);
    const id = `${prefix}${String.fromCharCode(97 + n++)}`;

    // What the token is worth: on each host, and what the Auth server told the issuer.
    const userOn: Record<string, string> = {};
    let tokenRedirect = "";
    if (rt.accessToken) {
      for (const h of [`${ctx.ref}.supabase.co`, st.host]) {
        if (h === st.host && !st.domainActive) continue;
        const u = await fetch(`https://${h}/auth/v1/user`, { headers: { apikey: st.anon, Authorization: `Bearer ${rt.accessToken}` }, signal: AbortSignal.timeout(20_000) }).catch(() => undefined);
        userOn[hl(h, st)] = u ? String(u.status) : "no-response";
        if (u?.status === 200 && !tokenRedirect) {
          const j = (await u.json()) as { identities?: { identity_data?: Record<string, unknown> }[] };
          const cc = j.identities?.[0]?.identity_data?.custom_claims as { hp_token_redirect_uri?: string } | undefined;
          tokenRedirect = String(cc?.hp_token_redirect_uri ?? "");
        }
      }
    }
    const lbl = (u: string) => {
      try {
        const x = new URL(u);
        return `${hl(x.host, st)}${x.pathname}`;
      } catch {
        return u ? "unparsed" : "-";
      }
    };
    const hostOnly = (s: string) => {
      try {
        return hl(new URL(s).host, st);
      } catch {
        return "-";
      }
    };
    const ok = !!rt.accessToken;
    out.push({
      id,
      title: `OAuth round trip entering at ${e.label} (${prefix === "HP02" ? "before the custom domain" : "custom domain active"})`,
      status: ok ? "pass" : "fail",
      detail: `authorize built client-side at ${hl(e.host, st)}; redirect_uri to the issuer ${lbl(rt.redirectUri)}; issuer sent the browser to ${hl(rt.callbackHost, st)}; landed ${rt.landed.split("/")[0]}; token iss ${lbl(rt.iss)}; redirect_uri in the token request ${lbl(tokenRedirect)}; /auth/v1/user with the token ${JSON.stringify(userOn)}${rt.error ? `; error ${rt.error.replace(st.ref, "<ref>")}` : ""}`,
      measurements: {
        entry: e.label,
        hops: rt.hops.map((h) => h.status).join(">"),
        redirect_uri_host: hostOnly(rt.redirectUri),
        redirect_uri_path: (() => { try { return new URL(rt.redirectUri).pathname; } catch { return "-"; } })(),
        callback_host: hl(rt.callbackHost, st),
        landing_host: rt.landed.split("/")[0] === "localhost:3000" ? "localhost:3000" : hl(rt.landed.split("/")[0] ?? "", st),
        iss_host: hostOnly(rt.iss),
        iss_path: (() => { try { return new URL(rt.iss).pathname; } catch { return "-"; } })(),
        token_request_redirect_host: hostOnly(tokenRedirect),
        user_on: JSON.stringify(userOn),
        sub_present: jwtPayload(rt.accessToken).sub ? "yes" : "no",
      },
    });
  }
  return out;
}

/** The SDK's hosts for one base URL: one result per op, so a column diff is a host diff. */
export async function sdkResult(id: string, title: string, ctx: Ctx, st: HpState, entry: Entry, serviceKey: string): Promise<TestResult> {
  const rows: OpRow[] = await sdkProbe(`https://${entry.host}`, serviceKey, st.anon);
  const m: Record<string, string> = {};
  const foreign: string[] = [];
  for (const r of rows) {
    const k = r.op.replace(/[^a-zA-Z]+/g, "_");
    const req = r.requested.map((h) => hl(h, st));
    m[`${k}_requested`] = req.join("+") || "none";
    m[`${k}_result_host`] = hl(r.resultHost, st);
    m[`${k}_fetched`] = r.fetched.replace(st.ref, "<ref>");
    if (r.note) m[`${k}_note`] = r.note.replace(st.ref, "<ref>").replaceAll(st.host, "<custom>");
    for (const h of [...req, hl(r.resultHost, st)]) if (h !== "-" && h !== entry.label) foreign.push(`${r.op}:${h}`);
  }
  return {
    id,
    title,
    status: foreign.length === 0 ? "pass" : "info",
    detail: foreign.length === 0 ? `every request and every returned URL used the ${entry.label} host (${rows.length} ops)` : `hosts other than ${entry.label}: ${[...new Set(foreign)].join(", ")}`,
    measurements: m,
    evidence: JSON.stringify(rows, null, 1).replaceAll(st.ref, "<ref>").replaceAll(st.host, "<custom-host>").replace(/token=[A-Za-z0-9._-]+/g, "token=<jwt>"),
  };
}
