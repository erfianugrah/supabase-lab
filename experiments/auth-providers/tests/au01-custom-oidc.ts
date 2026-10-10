/**
 * AU01 - custom OIDC providers on the managed Auth server.
 *
 * Source claims (public): https://supabase.com/docs/guides/auth/custom-oauth-providers
 * says up to 3 custom providers on Free and unlimited on Pro and above, PKCE on
 * by default (`pkce_enabled`), `email_optional`, `acceptable_client_ids` for the
 * audience check, and `provider_type` / `identifier` immutable on update. This
 * module measures each against a lab issuer (worker/issuer.ts, RS256, per-run
 * key) on a throwaway project.
 *
 *   AU01a  create against an unresolvable issuer (validation), then a valid one;
 *          response shape, whether the client secret is echoed back
 *   AU01b  provider quota: create providers until the platform refuses or 6 exist
 *   AU01c  immutability: PUT with a changed provider_type / identifier
 *   AU01d  PKCE: the authorize redirect carries code_challenge / S256 by default;
 *          the issuer verifies the verifier; pkce_enabled=false removes both
 *   AU01e  sign-in WITH an email claim: user, identity, provider label
 *   AU01f  sign-in with NO email claim, email_optional=false then true
 *   AU01g  wrong aud: refused; same aud listed in acceptable_client_ids: accepted
 *          (code flow and signInWithIdToken)
 *
 * Run once per org role (pro, free; free is quota-only and skipped if absent).
 * DESTRUCTIVE: creates a au-* project and a Cloudflare Worker, both
 * deleted in `finally`.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import {
  authFetch,
  createProviderWhenResolvable,
  cell,
  deleteIssuer,
  deployIssuer,
  issuerSkipReason,
  destroyProject,
  errCode,
  errMsg,
  flowNote,
  mintIdToken,
  oauthFlow,
  patchAuthConfig,
  provisionProject,
  SITE_URL,
  type Issuer,
  type Rig,
} from "../lib/rig.js";

const mkBody = (iss: Issuer, n: number, extra: Record<string, unknown> = {}) => ({
  provider_type: "oidc",
  identifier: `custom:au-${n}`,
  name: `AU ${n}`,
  client_id: `cid-${n}`,
  client_secret: iss.clientSecret,
  issuer: iss.url,
  scopes: ["openid", "email", "profile"],
  ...extra,
});

async function quota(rig: Rig, iss: Issuer, label: string, results: TestResult[], max: number): Promise<void> {
  const codes: string[] = [];
  let firstRefused = -1;
  const existing = ((await authFetch(rig, "GET", "/admin/custom-providers")).json?.providers ?? []).length as number;
  for (let n = 1; n <= max; n++) {
    const r = await authFetch(rig, "POST", "/admin/custom-providers", { body: mkBody(iss, 100 + n) });
    codes.push(r.status === 201 ? "201" : `${r.status}:${errCode(r)}`);
    if (r.status !== 201) {
      firstRefused = n;
      results.push({
        id: `AU01b-${label}`,
        title: `AU01b-${label}: provider quota`,
        status: "info",
        detail: `provider ${n} refused: HTTP ${r.status} ${errCode(r)} "${errMsg(r)}"`,
        measurements: { plan_org: label, providers_before_loop: existing, created_in_loop_before_refusal: n - 1, total_providers_at_refusal: existing + n - 1 },
        evidence: codes.join(" "),
      });
      return;
    }
  }
  results.push({
    id: `AU01b-${label}`,
    title: `AU01b-${label}: provider quota`,
    status: "info",
    detail: `no refusal in ${max} creates`,
    measurements: { plan_org: label, providers_before_loop: existing, created_in_loop_before_refusal: max, total_providers_at_refusal: existing + max, refusal_seen: String(firstRefused > 0) },
    evidence: codes.join(" "),
  });
}

const mod: TestModule = {
  id: "AU01",
  title: "Custom OIDC providers: quota, PKCE, email_optional, acceptable_client_ids",
  where: "local",
  requires: ["pat", "org"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const results: TestResult[] = [];
    const pro = ctx.orgs.pro ?? "";
    const free = ctx.orgs.free ?? "";
    if (!pro) return [{ id: "AU01", title: this.title, status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    const noIssuer = await issuerSkipReason();
    if (noIssuer) return [{ id: "AU01", title: this.title, status: "skip", detail: noIssuer }];

    let proRig: Rig | undefined;
    let freeRig: Rig | undefined;
    let iss: Issuer | undefined;
    try {
      iss = await deployIssuer("au01");
      proRig = await provisionProject(ctx, pro, "au01", { pro: true });
      const rig = proRig;
      results.push({
        id: "AU01-setup",
        title: "AU01-setup: throwaway Pro project + lab issuer",
        status: "info",
        measurements: { provision_s: rig.provisionS },
      });
      const patch = await patchAuthConfig(rig, { site_url: SITE_URL });
      if (patch.status >= 300) throw new Error(`site_url patch: HTTP ${patch.status}`);

      // ---- AU01a: create ----
      const bad = await authFetch(rig, "POST", "/admin/custom-providers", {
        body: { ...mkBody(iss, 0), identifier: "custom:bad", issuer: "https://invalid.example.invalid" },
      });
      const first = await createProviderWhenResolvable(rig, mkBody(iss, 1, { custom_claims_allowlist: ["pvlab_pkce", "pvlab_auth"] }));
      const echoedSecret = first.text.includes(iss.clientSecret);
      results.push({
        id: "AU01a",
        title: "AU01a: create (unresolvable issuer, then valid)",
        status: bad.status === 400 && first.status === 201 ? "pass" : "fail",
        detail: `bad issuer: HTTP ${bad.status} ${errCode(bad)} "${errMsg(bad)}"; valid: HTTP ${first.status}`,
        measurements: {
          bad_issuer_status: bad.status,
          bad_issuer_code: cell(errCode(bad)),
          create_status: first.status,
          issuer_resolvable_after_s: first.waitedS,
          secret_echoed: String(echoedSecret),
          pkce_enabled_default: cell(first.json?.pkce_enabled),
          email_optional_default: cell(first.json?.email_optional),
          skip_nonce_check_default: cell(first.json?.skip_nonce_check),
          response_keys: Object.keys(first.json ?? {}).sort().join(","),
        },
      });
      if (first.status !== 201) throw new Error("first provider create failed; cannot continue");

      // ---- AU01c: immutability ----
      const putType = await authFetch(rig, "PUT", "/admin/custom-providers/custom:au-1", { body: { provider_type: "oauth2" } });
      const putId = await authFetch(rig, "PUT", "/admin/custom-providers/custom:au-1", { body: { identifier: "custom:au-renamed" } });
      const putName = await authFetch(rig, "PUT", "/admin/custom-providers/custom:au-1", { body: { name: "AU 1 renamed" } });
      const after = await authFetch(rig, "GET", "/admin/custom-providers/custom:au-1");
      results.push({
        id: "AU01c",
        title: "AU01c: provider_type and identifier on update",
        status: "info",
        detail: `type change HTTP ${putType.status} ${errCode(putType)}; identifier change HTTP ${putId.status} ${errCode(putId)}; name change HTTP ${putName.status}`,
        measurements: {
          type_change_status: putType.status,
          identifier_change_status: putId.status,
          name_change_status: putName.status,
          type_after: cell(after.json?.provider_type),
          identifier_after: cell(after.json?.identifier),
          name_after: cell(after.json?.name),
        },
        evidence: `${errMsg(putType)} | ${errMsg(putId)}`,
      });

      // ---- AU01d: PKCE ----
      const d1 = await oauthFlow(rig, "custom:au-1", { sub: "pk-1", email: "pk1@example.com", email_verified: true });
      const u1 = d1.userId ? await authFetch(rig, "GET", `/admin/users/${d1.userId}`) : undefined;
      const claims1 = (u1?.json?.user_metadata?.custom_claims ?? {}) as Record<string, string>;
      await authFetch(rig, "PUT", "/admin/custom-providers/custom:au-1", { body: { pkce_enabled: false } });
      const d2 = await oauthFlow(rig, "custom:au-1", { sub: "pk-2", email: "pk2@example.com", email_verified: true });
      const u2 = d2.userId ? await authFetch(rig, "GET", `/admin/users/${d2.userId}`) : undefined;
      const claims2 = (u2?.json?.user_metadata?.custom_claims ?? {}) as Record<string, string>;
      await authFetch(rig, "PUT", "/admin/custom-providers/custom:au-1", { body: { pkce_enabled: true } });
      results.push({
        id: "AU01d",
        title: "AU01d: provider-side PKCE default and pkce_enabled=false",
        status: d1.authorizeParams.code_challenge && claims1.pvlab_pkce === "S256-verified" ? "pass" : "fail",
        detail: `default: ${flowNote(d1)}; pkce off: ${flowNote(d2)}`,
        measurements: {
          default_code_challenge_present: String(Boolean(d1.authorizeParams.code_challenge)),
          default_code_challenge_method: cell(d1.authorizeParams.code_challenge_method),
          default_issuer_saw: cell(claims1.pvlab_pkce),
          default_nonce_param_on_authorize: String("nonce" in d1.authorizeParams),
          default_state_present: String(Boolean(d1.authorizeParams.state)),
          off_code_challenge_present: String(Boolean(d2.authorizeParams.code_challenge)),
          off_issuer_saw: cell(claims2.pvlab_pkce),
          secret_presented_as: cell(claims1.pvlab_auth),
          authorize_scope: cell(d1.authorizeParams.scope),
        },
      });

      // ---- AU01e: sign-in with email ----
      const e1 = await oauthFlow(rig, "custom:au-1", { sub: "em-1", email: "em1@example.com", email_verified: true });
      const e1b = await oauthFlow(rig, "custom:au-1", { sub: "em-1", email: "em1@example.com", email_verified: true });
      const eu = e1.userId ? await authFetch(rig, "GET", `/admin/users/${e1.userId}`) : undefined;
      results.push({
        id: "AU01e",
        title: "AU01e: sign-in with an email claim",
        status: e1.userId && e1.userId === e1b.userId ? "pass" : "fail",
        detail: flowNote(e1),
        measurements: {
          same_user_second_signin: String(Boolean(e1.userId) && e1.userId === e1b.userId),
          app_metadata_provider: cell(eu?.json?.app_metadata?.provider),
          identity_provider: cell(eu?.json?.identities?.[0]?.provider),
          identity_provider_id: cell(eu?.json?.identities?.[0]?.provider_id),
          user_email: cell(eu?.json?.email),
        },
      });

      // ---- AU01f: no email claim ----
      const n1 = await oauthFlow(rig, "custom:au-1", { sub: "ne-1" });
      await authFetch(rig, "PUT", "/admin/custom-providers/custom:au-1", { body: { email_optional: true } });
      let n2 = await oauthFlow(rig, "custom:au-1", { sub: "ne-1" });
      for (let i = 0; i < 5 && !n2.userId; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        n2 = await oauthFlow(rig, "custom:au-1", { sub: "ne-1" });
      }
      const n3 = await oauthFlow(rig, "custom:au-1", { sub: "ne-1" });
      const nu = n2.userId ? await authFetch(rig, "GET", `/admin/users/${n2.userId}`) : undefined;
      results.push({
        id: "AU01f",
        title: "AU01f: no email claim, email_optional false then true",
        status: !n1.userId && n2.userId ? "pass" : "fail",
        detail: `optional=false: ${flowNote(n1)}; optional=true: ${flowNote(n2)}`,
        measurements: {
          default_refused: String(!n1.userId),
          default_error_code: cell(n1.errorCode),
          default_error_description: cell(n1.errorDescription),
          optional_signed_in: String(Boolean(n2.userId)),
          optional_user_email: cell(nu?.json?.email),
          optional_app_metadata_provider: cell(nu?.json?.app_metadata?.provider),
          optional_second_signin_same_user: String(Boolean(n2.userId) && n2.userId === n3.userId),
        },
        evidence: `${n1.error ?? ""} ${n1.errorDescription ?? ""}`.slice(0, 300),
      });

      // ---- AU01g: audience ----
      const stranger = "stranger-client";
      const g1 = await oauthFlow(rig, "custom:au-1", { sub: "aud-1", email: "aud1@example.com", email_verified: true, aud: stranger });
      const now = Math.floor(Date.now() / 1000);
      const idt = (aud: string, sub: string) =>
        mintIdToken(iss!.priv, { iss: iss!.url, sub, aud, iat: now, exp: now + 600, email: `${sub}@example.com`, email_verified: true });
      const pub = rig.keys.publishable!;
      const t1 = await authFetch(rig, "POST", "/token?grant_type=id_token", { key: pub, body: { provider: "custom:au-1", id_token: await idt(stranger, "aud-t1") } });
      const tOk = await authFetch(rig, "POST", "/token?grant_type=id_token", { key: pub, body: { provider: "custom:au-1", id_token: await idt("cid-1", "aud-t0") } });
      await authFetch(rig, "PUT", "/admin/custom-providers/custom:au-1", { body: { acceptable_client_ids: [stranger] } });
      let g2 = await oauthFlow(rig, "custom:au-1", { sub: "aud-2", email: "aud2@example.com", email_verified: true, aud: stranger });
      for (let i = 0; i < 4 && !g2.userId; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        g2 = await oauthFlow(rig, "custom:au-1", { sub: "aud-2", email: "aud2@example.com", email_verified: true, aud: stranger });
      }
      const t2 = await authFetch(rig, "POST", "/token?grant_type=id_token", { key: pub, body: { provider: "custom:au-1", id_token: await idt(stranger, "aud-t2") } });
      results.push({
        id: "AU01g",
        title: "AU01g: aud vs client_id and acceptable_client_ids",
        status: !g1.userId && g2.userId && t1.status >= 400 && t2.status === 200 ? "pass" : "fail",
        detail: `code flow wrong aud: ${flowNote(g1)}; id_token wrong aud: HTTP ${t1.status} ${errCode(t1)} "${errMsg(t1)}"`,
        measurements: {
          code_wrong_aud_refused: String(!g1.userId),
          code_wrong_aud_error: cell(g1.errorDescription ?? g1.error),
          idtoken_right_aud_status: tOk.status,
          idtoken_wrong_aud_status: t1.status,
          idtoken_wrong_aud_code: cell(errCode(t1)),
          listed_code_flow_signed_in: String(Boolean(g2.userId)),
          listed_idtoken_status: t2.status,
        },
      });

      // ---- AU01b-pro: quota (last: leaves many providers) ----
      await quota(rig, iss, "pro", results, 6);

      // ---- AU01b-free: quota on a Free org ----
      if (!free) {
        results.push({ id: "AU01b-free", title: "AU01b-free: provider quota", status: "skip", detail: "PVLAB_ORG_FREE not set" });
      } else {
        freeRig = await provisionProject(ctx, free, "au01f");
        const fr = freeRig;
        results.push({ id: "AU01-setup-free", title: "AU01-setup-free: throwaway Free project", status: "info", measurements: { provision_s: fr.provisionS } });
        await quota(fr, iss, "free", results, 6);
      }
    } catch (e) {
      results.push({ id: "AU01-error", title: "AU01-error", status: "fail", detail: String((e as Error)?.message ?? e).slice(0, 400) });
    } finally {
      const cleanup: string[] = [];
      for (const r of [proRig, freeRig]) if (r) cleanup.push(`project delete HTTP ${await destroyProject(ctx, r.ref)}`);
      if (iss) cleanup.push(`worker delete ${(await deleteIssuer(iss.name)) ? "ok" : "FAILED"}`);
      results.push({ id: "AU01z", title: "AU01z: cleanup", status: cleanup.some((c) => /FAILED|HTTP [45]/.test(c)) ? "fail" : "info", detail: cleanup.join("; ") });
    }
    return results;
  },
};
export default mod;
