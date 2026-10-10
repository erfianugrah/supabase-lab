/**
 * AU03 - what an Auth canary can and cannot see, per sign-in method.
 *
 * Design for a synthetic monitor: one probe per sign-in method that the
 * project actually serves, each with a latency and an error class that tells
 * "Auth is down" from "this method is broken" from "my probe is wrong".
 * Methods probed here: password, `signInWithIdToken` for a `custom:` OIDC
 * provider (token minted by the lab issuer), and the OAuth browser flow
 * through the lab issuer. SAML SSO is AU04.
 *
 *   AU03a  per-method canary, n=10 password, n=10 id_token, n=4 browser flow:
 *          status and latency percentiles
 *   AU03b  negative controls: wrong password, bad-signature / expired /
 *          wrong-aud id_token, unknown and disabled provider: error codes
 *   AU03c  an existing session while Auth is unreachable from the client
 *          (client-side fetch block on /auth/v1/*; jwt_exp shortened):
 *          before expiry vs after expiry, REST and supabase-js
 *   AU03d  server-side revoke vs a still-valid access token
 *   AU03e  IdP outage (issuer deleted): password still works; id_token and
 *          browser flow outcomes over time (Auth's discovery/JWKS caching)
 *
 * The block in AU03c is a client-side simulation of "Auth unreachable"; it
 * does not make the managed Auth server fail, so it says what a client holding
 * a session does, not what the server does during an incident.
 *
 * DESTRUCTIVE: au-* project + Worker, both deleted in `finally`.
 */
import { createClient } from "@supabase/supabase-js";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { sql } from "../../../harness/src/platform.js";
import {
  adminCreateUser,
  authFetch,
  createProviderWhenResolvable,
  cell,
  deleteIssuer,
  deployIssuer,
  issuerSkipReason,
  destroyProject,
  errCode,
  errMsg,
  genKeypair,
  mintIdToken,
  oauthFlow,
  patchAuthConfig,
  provisionProject,
  SITE_URL,
  sleep,
  type Issuer,
  type Rig,
} from "../lib/rig.js";

const pct = (xs: number[], p: number): number => {
  if (!xs.length) return -1;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
};
const timed = async <T>(f: () => Promise<T>): Promise<{ v: T; ms: number }> => {
  const t0 = performance.now();
  const v = await f();
  return { v, ms: Math.round(performance.now() - t0) };
};

const mod: TestModule = {
  id: "AU03",
  title: "Auth canary: per-method sign-in, sessions with Auth unreachable, IdP outage",
  where: "local",
  requires: ["pat", "org"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const results: TestResult[] = [];
    const pro = ctx.orgs.pro ?? "";
    if (!pro) return [{ id: "AU03", title: this.title, status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    const noIssuer = await issuerSkipReason();
    if (noIssuer) return [{ id: "AU03", title: this.title, status: "skip", detail: noIssuer }];
    let rig: Rig | undefined;
    let iss: Issuer | undefined;
    let issDeleted = false;
    try {
      iss = await deployIssuer("au03");
      rig = await provisionProject(ctx, pro, "au03", { pro: true });
      const r = rig;
      const issuer = iss;
      const pub = r.keys.publishable!;
      const email = `canary-${Date.now()}@example.com`;
      const password = `${crypto.randomUUID()}Aa1!`;
      await adminCreateUser(r, email, password);
      await patchAuthConfig(r, { site_url: SITE_URL });
      const cp = await createProviderWhenResolvable(r, { provider_type: "oidc", identifier: "custom:canary", name: "Canary", client_id: "cid-canary", client_secret: issuer.clientSecret, issuer: issuer.url, scopes: ["openid", "email", "profile"] });
      results.push({
        id: "AU03-setup",
        title: "AU03-setup: project, user, custom provider",
        status: cp.status === 201 ? "info" : "fail",
        detail: `custom provider create HTTP ${cp.status}${cp.status === 201 ? "" : " " + errMsg(cp)}`,
        measurements: { provision_s: r.provisionS, issuer_resolvable_after_s: cp.waitedS, create_attempts: cp.attempts },
      });
      if (cp.status !== 201) throw new Error("custom provider create failed");

      const mintTok = (over: Record<string, unknown> = {}, key = issuer.priv) => {
        const now = Math.floor(Date.now() / 1000);
        return mintIdToken(key, { iss: issuer.url, sub: `c-${crypto.randomUUID().slice(0, 8)}`, aud: "cid-canary", iat: now, exp: now + 600, email: `c-${crypto.randomUUID().slice(0, 8)}@example.com`, email_verified: true, ...over });
      };
      const pwSignIn = () => authFetch(r, "POST", "/token?grant_type=password", { key: pub, body: { email, password } });
      const idSignIn = async (tok?: string, provider = "custom:canary") => authFetch(r, "POST", "/token?grant_type=id_token", { key: pub, body: { provider, id_token: tok ?? (await mintTok()) } });

      // ---- AU03a: per-method canary ----
      const pw: number[] = [];
      const pwSt: number[] = [];
      const id: number[] = [];
      const idSt: number[] = [];
      for (let i = 0; i < 10; i++) {
        const a = await timed(pwSignIn);
        pw.push(a.ms);
        pwSt.push(a.v.status);
        const tok = await mintTok();
        const b = await timed(() => idSignIn(tok));
        id.push(b.ms);
        idSt.push(b.v.status);
      }
      const flow: number[] = [];
      const flowOk: boolean[] = [];
      for (let i = 0; i < 4; i++) {
        const f = await timed(() => oauthFlow(r, "custom:canary", { sub: `flow-${i}`, email: `flow-${i}@example.com`, email_verified: true }));
        flow.push(f.ms);
        flowOk.push(Boolean(f.v.userId));
      }
      results.push({
        id: "AU03a",
        title: "AU03a: per-method canary (password, id_token, browser flow)",
        status: pwSt.every((s) => s === 200) && idSt.every((s) => s === 200) && flowOk.every(Boolean) ? "pass" : "fail",
        detail: `password statuses ${[...new Set(pwSt)].join(",")}; id_token statuses ${[...new Set(idSt)].join(",")}; flow ok ${flowOk.filter(Boolean).length}/${flowOk.length}`,
        measurements: {
          password_n: pw.length,
          password_ok: pwSt.filter((s) => s === 200).length,
          password_p50_ms: pct(pw, 50),
          password_max_ms: pct(pw, 100),
          id_token_n: id.length,
          id_token_ok: idSt.filter((s) => s === 200).length,
          id_token_p50_ms: pct(id, 50),
          id_token_max_ms: pct(id, 100),
          flow_n: flow.length,
          flow_ok: flowOk.filter(Boolean).length,
          flow_p50_ms: pct(flow, 50),
          flow_max_ms: pct(flow, 100),
          vantage: "one workstation, ap-southeast-1 project",
        },
      });

      // ---- AU03b: negative controls ----
      const other = await genKeypair();
      const nowS = Math.floor(Date.now() / 1000);
      const ctl: Record<string, { status: number; code: string; msg: string }> = {};
      const rec = async (k: string, p: Promise<{ status: number; json?: unknown; text: string }>) => {
        const x = (await p) as Parameters<typeof errCode>[0];
        ctl[k] = { status: x.status, code: errCode(x), msg: errMsg(x) };
      };
      await rec("wrong_password", authFetch(r, "POST", "/token?grant_type=password", { key: pub, body: { email, password: "wrong-" + password } }));
      await rec("unknown_user", authFetch(r, "POST", "/token?grant_type=password", { key: pub, body: { email: "nobody@example.com", password } }));
      await rec("bad_signature", idSignIn(await mintTok({}, { ...other.priv, kid: issuer.priv.kid } as typeof issuer.priv)));
      await rec("expired", idSignIn(await mintTok({ iat: nowS - 7200, exp: nowS - 3600 })));
      await rec("wrong_aud", idSignIn(await mintTok({ aud: "someone-else" })));
      await rec("wrong_iss", idSignIn(await mintTok({ iss: "https://elsewhere.example.com" })));
      await rec("unknown_provider", idSignIn(undefined, "custom:nope"));
      await authFetch(r, "PUT", "/admin/custom-providers/custom:canary", { body: { enabled: false } });
      await sleep(3000);
      await rec("provider_disabled", idSignIn());
      await authFetch(r, "PUT", "/admin/custom-providers/custom:canary", { body: { enabled: true } });
      const m: Record<string, string | number> = {};
      for (const [k, v] of Object.entries(ctl)) {
        m[`${k}_status`] = v.status;
        m[`${k}_code`] = cell(v.code);
      }
      results.push({
        id: "AU03b",
        title: "AU03b: negative controls, error class per failure",
        status: "info",
        detail: Object.entries(ctl).map(([k, v]) => `${k}: ${v.status} ${v.code} "${v.msg.slice(0, 80)}"`).join(" | "),
        measurements: m,
      });

      // ---- AU03c: existing session with the client cut off from Auth ----
      const tbl = await sql(r.ctx, "create table public.canary(id int primary key); alter table public.canary enable row level security; grant select on public.canary to authenticated; create policy c on public.canary for select to authenticated using (true); insert into public.canary values (1);");
      const exp = await patchAuthConfig(r, { jwt_exp: 60 });
      await sleep(8000);
      let blocked = false;
      const blockedCalls: string[] = [];
      const blockingFetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
        if (blocked && url.includes("/auth/v1/")) {
          blockedCalls.push(new URL(url).pathname.replace("/auth/v1", ""));
          throw new TypeError("fetch failed (simulated: Auth unreachable)");
        }
        return fetch(input, init);
      }) as typeof fetch;
      const store = new Map<string, string>();
      const sb = createClient(`https://${r.ctx.apiHost}`, pub, {
        auth: { autoRefreshToken: true, persistSession: true, storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v), removeItem: (k) => void store.delete(k) } },
        global: { fetch: blockingFetch },
      });
      const si = await sb.auth.signInWithPassword({ email, password });
      const sess = si.data.session;
      const lifetime = sess ? (sess.expires_at ?? 0) - Math.floor(Date.now() / 1000) : -1;
      const rest = async (token: string) => {
        const x = await fetch(`https://${r.ctx.apiHost}/rest/v1/canary?select=id`, { headers: { apikey: pub, Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
        return { status: x.status, body: (await x.text()).slice(0, 120) };
      };
      const warm = await sb.auth.getClaims().catch((e) => ({ data: null, error: e }));
      blocked = true;
      const pre = {
        getSession: await sb.auth.getSession(),
        claims: await sb.auth.getClaims().catch((e) => ({ data: null, error: e as Error })),
        user: await sb.auth.getUser().catch((e) => ({ data: { user: null }, error: e as Error })),
        rest: await rest(sess?.access_token ?? ""),
      };
      const expAt = (sess?.expires_at ?? 0) * 1000;
      let restRejectedBody = "";
      let restRejectedStatus = 0;
      while (Date.now() < expAt + 8_000) await sleep(2_000);
      const post = {
        rest: await rest(sess?.access_token ?? ""),
        getSession: await sb.auth.getSession(),
        claims: await sb.auth.getClaims().catch((e) => ({ data: null, error: e as Error })),
      };
      const storedAfter = store.size > 0;
      // How long does PostgREST keep accepting the expired access token?
      let restRejectedAfterS = -1;
      const pollStart = Date.now();
      while (Date.now() - pollStart < 240_000) {
        const x = await rest(sess?.access_token ?? "");
        if (x.status !== 200) {
          restRejectedAfterS = Math.round((Date.now() - expAt) / 1000);
          restRejectedBody = x.body;
          restRejectedStatus = x.status;
          break;
        }
        await sleep(10_000);
      }
      blocked = false;
      // supabase-js may hold a failed in-flight refresh; retry for a short while.
      let rec2 = await sb.auth.refreshSession();
      for (let i = 0; i < 4 && rec2.error; i++) {
        await sleep(5_000);
        rec2 = await sb.auth.refreshSession();
      }
      const rest2 = await rest(rec2.data.session?.access_token ?? "");
      results.push({
        id: "AU03c",
        title: "AU03c: existing session with the client cut off from /auth/v1",
        status: lifetime > 0 && pre.rest.status === 200 ? "pass" : "fail",
        detail: `jwt_exp patch HTTP ${exp.status}; token lifetime ${lifetime}s; before expiry: REST ${pre.rest.status}, getSession ${pre.getSession.data.session ? "session" : "null"}; 8 s after expiry: REST ${post.rest.status}, first rejected ${restRejectedAfterS} s after expiry (${restRejectedStatus} ${restRejectedBody}), getSession ${post.getSession.data.session ? "session" : "null"} ${post.getSession.error?.message ?? ""}; after unblock: refresh ${rec2.error ? rec2.error.message : "ok"}, REST ${rest2.status}`,
        measurements: {
          table_create_status: tbl.status,
          jwt_exp_patch_status: exp.status,
          token_lifetime_s: lifetime,
          warm_getclaims_ok: String(Boolean((warm as { data: unknown }).data)),
          before_expiry_rest_status: pre.rest.status,
          before_expiry_getsession_has_session: String(Boolean(pre.getSession.data.session)),
          before_expiry_getclaims_ok: String(Boolean(pre.claims.data)),
          before_expiry_getuser_ok: String(Boolean(pre.user.data?.user)),
          before_expiry_getuser_error: cell(pre.user.error?.message),
          rest_status_8s_after_expiry: post.rest.status,
          rest_first_rejected_s_after_expiry: restRejectedAfterS,
          rest_rejected_status: cell(restRejectedStatus),
          rest_rejected_body: cell(restRejectedBody),
          after_expiry_getsession_has_session: String(Boolean(post.getSession.data.session)),
          after_expiry_getsession_error: cell(post.getSession.error?.message),
          after_expiry_getclaims_ok: String(Boolean(post.claims.data)),
          storage_kept_session_after_failed_refresh: String(storedAfter),
          auth_calls_blocked: blockedCalls.length,
          blocked_paths: [...new Set(blockedCalls)].join(","),
          refresh_after_unblock_ok: String(!rec2.error && Boolean(rec2.data.session)),
          rest_after_unblock_status: rest2.status,
        },
      });

      // ---- AU03d: server-side revoke vs valid access token ----
      const s2 = await pwSignIn();
      const tok2 = s2.json?.access_token as string;
      const rt2 = s2.json?.refresh_token as string;
      await patchAuthConfig(r, { jwt_exp: 3600 });
      const before = await rest(tok2);
      const logout = await authFetch(r, "POST", "/logout?scope=global", { key: pub, bearer: tok2 });
      const afterRest = await rest(tok2);
      const afterUser = await authFetch(r, "GET", "/user", { key: pub, bearer: tok2 });
      const afterRefresh = await authFetch(r, "POST", "/token?grant_type=refresh_token", { key: pub, body: { refresh_token: rt2 } });
      results.push({
        id: "AU03d",
        title: "AU03d: global sign-out vs the access token already issued",
        status: "info",
        detail: `logout HTTP ${logout.status}; REST with that access token: ${before.status} before, ${afterRest.status} after; GET /user ${afterUser.status} ${errCode(afterUser)}; refresh ${afterRefresh.status} ${errCode(afterRefresh)}`,
        measurements: {
          logout_status: logout.status,
          rest_before_logout: before.status,
          rest_after_logout: afterRest.status,
          user_after_logout_status: afterUser.status,
          user_after_logout_code: cell(errCode(afterUser)),
          refresh_after_logout_status: afterRefresh.status,
          refresh_after_logout_code: cell(errCode(afterRefresh)),
        },
      });

      // ---- AU03e: IdP outage ----
      const warmTok = await mintTok();
      const preOut = await idSignIn(warmTok);
      const preFlow = await oauthFlow(r, "custom:canary", { sub: "out-pre", email: "out-pre@example.com", email_verified: true });
      issDeleted = await deleteIssuer(issuer.name);
      const series: string[] = [];
      const t0 = Date.now();
      let firstFail = -1;
      let failIdx = -1;
      for (let i = 0; i < 17; i++) {
        const tok = await mintTok();
        const x = await timed(() => idSignIn(tok));
        const reuse = await idSignIn(warmTok);
        const cls = `${x.v.status}${x.v.status === 200 ? "" : ":" + errCode(x.v)}/${x.ms}ms reuse=${reuse.status}`;
        series.push(`t+${Math.round((Date.now() - t0) / 1000)}s ${cls}`);
        if (firstFail < 0 && x.v.status !== 200) firstFail = Math.round((Date.now() - t0) / 1000);
        if (firstFail >= 0 && failIdx < 0) failIdx = i;
        if (failIdx >= 0 && i >= failIdx + 2) break;
        if (i < 16) await sleep(30_000);
      }
      const flowDown = await timed(() => oauthFlow(r, "custom:canary", { sub: "out-1", email: "out-1@example.com", email_verified: true }));
      const pwDown = await timed(pwSignIn);
      results.push({
        id: "AU03e",
        title: "AU03e: IdP outage (issuer Worker deleted): fallback and caching",
        status: pwDown.v.status === 200 ? "info" : "fail",
        detail: `issuer delete ${issDeleted ? "ok" : "failed"}; id_token series: ${series.join(" | ")}; browser flow: ${flowDown.v.userId ? "signed in" : `${flowDown.v.stage} ${flowDown.v.error ?? ""} ${flowDown.v.errorDescription ?? ""}`}; password: ${pwDown.v.status} in ${pwDown.ms}ms`,
        measurements: {
          before_outage_id_token_status: preOut.status,
          before_outage_flow_ok: String(Boolean(preFlow.userId)),
          issuer_deleted: String(issDeleted),
          first_failed_id_token_s: firstFail,
          polls: series.length,
          flow_during_outage_ok: String(Boolean(flowDown.v.userId)),
          flow_during_outage_error: cell(flowDown.v.errorDescription ?? flowDown.v.error),
          flow_during_outage_ms: flowDown.ms,
          password_during_outage_status: pwDown.v.status,
          password_during_outage_ms: pwDown.ms,
        },
        evidence: series.join("\n"),
      });
    } catch (e) {
      results.push({ id: "AU03-error", title: "AU03-error", status: "fail", detail: String((e as Error)?.stack ?? e).slice(0, 600) });
    } finally {
      const cleanup: string[] = [];
      if (rig) cleanup.push(`project delete HTTP ${await destroyProject(ctx, rig.ref)}`);
      if (iss && !issDeleted) cleanup.push(`worker delete ${(await deleteIssuer(iss.name)) ? "ok" : "FAILED"}`);
      else if (iss) cleanup.push("worker deleted during AU03e");
      results.push({ id: "AU03z", title: "AU03z: cleanup", status: cleanup.some((c) => /FAILED|HTTP [45]/.test(c)) ? "fail" : "info", detail: cleanup.join("; ") });
    }
    return results;
  },
};
export default mod;
