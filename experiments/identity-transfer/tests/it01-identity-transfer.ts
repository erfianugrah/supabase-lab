/**
 * IT01 - when an OAuth identity returns with a NEW subject for an existing
 * person, what does the managed Auth server do?
 *
 * The shape an Apple Developer team transfer produces: Apple's user identifier
 * (`sub`) and private relay address are team-scoped, so after the transfer the
 * same person arrives with a new `sub` and, for relay users, a new email. Apple
 * is not mintable in a lab, so every case here drives the MANAGED project's
 * Keycloak provider slot (a social provider whose issuer URL is a per-project
 * setting, `external_keycloak_url`; the Auth server appends
 * /protocol/openid-connect/{auth,token,userinfo} to it and performs no issuer
 * check) from a lab-controlled issuer worker (ctx.endpoints.issuer) that
 * returns whatever subject, email and email_verified the case asks for. The
 * account-resolution code the cases exercise (identity lookup by provider +
 * subject, then linking on verified email) is shared by every provider.
 *
 *   IT01-setup  PATCH /config/auth: keycloak on, pointed at the issuer; poll
 *               /auth/v1/settings until external.keycloak is true (settle time).
 *   IT01a       first sign-in: subject a1, verified email a -> new user;
 *               auth.identities row has provider_id = identity_data.sub = a1.
 *   IT01b       subject a2, same verified email a -> the SAME user (linked),
 *               two identity rows. The post-transfer shape for a user who gave
 *               Apple their real address.
 *   IT01c       subject b1 with email b1, then subject b2 with email b2 (a
 *               relay address that changed) -> two users. The post-transfer
 *               shape for a relay user with no remap.
 *   IT01d       the remap recipe for the relay case: subject c1 with email c
 *               signs in; SQL rewrites the identity row's provider_id and
 *               identity_data.sub to c2; c2 signs in with a DIFFERENT email
 *               c2 -> the same user, still one identity row; records which
 *               stored email (identity_data.email, auth.users.email) moved.
 *               Control: c1 again with another email -> a new user (the old
 *               subject is no longer known).
 *   IT01e       subject d2, same email as d1 but email_verified=false ->
 *               not linked; records what the server answers instead.
 *   IT01z       cleanup: created users deleted, auth config restored; fails
 *               if the restore or the sweep did not answer 2xx.
 *
 * Pass means the server did what the source (internal/models/linking.go,
 * internal/api/external.go) says; fail is a measured disagreement. Platform
 * error text is quoted verbatim in `detail`, numbers live in `measurements`.
 *
 * Not settled by this module: anything Apple-specific - that `transfer_sub`
 * and `is_private_email` are copied into the provider claims' custom-claims
 * map (source-read only; where they surface in identity_data was not run),
 * the audience check across Services ID and bundle ID, and Apple's own
 * transfer-identifier exchange (open for 60 days after acceptance).
 *
 * DESTRUCTIVE: writes auth config (restored in finally), creates users
 * (deleted in finally). Self-skips without ctx.endpoints.issuer.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { mgmt } from "../../../harness/src/mgmt";
import { fetchKeys, sql } from "../../../harness/src/platform";

const ID = "IT01";
const CONFIG_KEYS = [
  "external_keycloak_enabled",
  "external_keycloak_client_id",
  "external_keycloak_secret",
  "external_keycloak_url",
  "site_url",
] as const;
const SITE_URL = "http://localhost:3000/pvlab-callback";
const SETTLE_BUDGET_MS = 120_000;

interface Persona {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
}

interface SignIn {
  /** HTTP status of the Auth server's /authorize hop. */
  authorizeStatus: number;
  /** HTTP status of the Auth server's /callback hop. */
  callbackStatus: number;
  userId?: string;
  email?: string;
  /** Verbatim error and error_description the callback redirected with, if any. */
  error?: string;
  errorCode?: string;
  errorDescription?: string;
  /** Where the callback sent the browser (host + path, no tokens). */
  landed?: string;
}

const b64url = (s: string) => Buffer.from(s).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

function jwtPayload(token: string): Record<string, unknown> {
  try {
    const p = token.split(".")[1] ?? "";
    return JSON.parse(Buffer.from(p.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * The full browser flow with redirects followed by hand: Auth server
 * /authorize -> issuer /auth (persona appended) -> Auth server /callback ->
 * site_url with tokens or an error in the fragment/query.
 */
async function signIn(ctx: Ctx, apikey: string, persona: Persona): Promise<SignIn> {
  const base = `https://${ctx.apiHost}/auth/v1`;
  const r1 = await fetch(`${base}/authorize?provider=keycloak`, {
    headers: { apikey },
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
  const issuerAuth = r1.headers.get("location");
  if (r1.status !== 302 || !issuerAuth) {
    const body = (await r1.text()).slice(0, 300);
    return { authorizeStatus: r1.status, callbackStatus: -1, error: `authorize did not redirect: ${body}` };
  }
  const u = new URL(issuerAuth);
  u.searchParams.set("persona", b64url(JSON.stringify(persona)));
  const r2 = await fetch(u, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
  const callback = r2.headers.get("location");
  if (r2.status !== 302 || !callback) {
    return { authorizeStatus: r1.status, callbackStatus: -1, error: `issuer did not redirect: HTTP ${r2.status}` };
  }
  const r3 = await fetch(callback, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
  const landing = r3.headers.get("location");
  if (!landing) {
    const body = (await r3.text()).slice(0, 300);
    return { authorizeStatus: r1.status, callbackStatus: r3.status, error: `callback did not redirect: ${body}` };
  }
  const l = new URL(landing);
  const frag = new URLSearchParams(l.hash.replace(/^#/, ""));
  const q = l.searchParams;
  const pick = (k: string) => frag.get(k) ?? q.get(k) ?? undefined;
  const out: SignIn = { authorizeStatus: r1.status, callbackStatus: r3.status, landed: `${l.host}${l.pathname}` };
  const access = pick("access_token");
  if (access) {
    const p = jwtPayload(access);
    out.userId = typeof p.sub === "string" ? p.sub : undefined;
    out.email = typeof p.email === "string" ? p.email : undefined;
  } else {
    out.error = pick("error");
    out.errorCode = pick("error_code");
    out.errorDescription = pick("error_description");
  }
  return out;
}

const mod: TestModule = {
  id: ID,
  title: "New subject for an existing person: link, new user, or remap",
  where: "local",
  requires: ["pat", "anon-key"],
  destructive: true,

  async run(ctx: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];
    const issuer = ctx.endpoints["issuer"];
    if (!issuer) return [{ id: ID, title: this.title, status: "skip", detail: "PVLAB_ENDPOINT_ISSUER not set (the lab OIDC issuer worker URL)" }];
    const nonce = Math.random().toString(36).slice(2, 8);
    const email = (k: string) => `it01-${nonce}-${k}@example.com`;
    const subj = (k: string) => `it01-${nonce}-${k}`;
    const apikey = ctx.anonKey!;
    const createdUsers = new Set<string>();
    let original: Record<string, unknown> | undefined;

    const identityRows = async (where: string) =>
      sql(ctx, `select provider, provider_id, identity_data->>'sub' as sub, identity_data->>'email' as email, (identity_data->>'email_verified') as email_verified, user_id::text as user_id from auth.identities where provider = 'keycloak' and ${where} order by created_at`);
    const userRow = async (id: string) =>
      sql(ctx, `select id::text, email, email_confirmed_at is not null as confirmed, (select count(*) from auth.identities i where i.user_id = u.id) as identities from auth.users u where id = '${id}'`);
    const note = (s: SignIn) => (s.userId ? `user ${s.userId.slice(0, 8)}... email ${s.email}` : `no session: error=${s.error ?? "-"} code=${s.errorCode ?? "-"} "${s.errorDescription ?? ""}"`);

    try {
      // ---- setup: point the Keycloak slot at the lab issuer -----------------
      const cur = await mgmt(ctx, "GET", `/projects/${ctx.ref}/config/auth`);
      if (cur.status !== 200 || !cur.json) {
        return [{ id: ID, title: this.title, status: "fail", detail: `GET /config/auth HTTP ${cur.status}`, evidence: cur.text.slice(0, 300) }];
      }
      const cfg = cur.json as Record<string, unknown>;
      original = Object.fromEntries(CONFIG_KEYS.map((k) => [k, cfg[k] ?? null]));
      const t0 = Date.now();
      const patch = await mgmt(ctx, "PATCH", `/projects/${ctx.ref}/config/auth`, {
        external_keycloak_enabled: true,
        external_keycloak_client_id: "pvlab-issuer",
        external_keycloak_secret: "unused. the lab issuer ignores client auth",
        external_keycloak_url: issuer,
        site_url: SITE_URL,
      });
      let settled = false;
      let settleAttempts = 0;
      let settingsText = "";
      while (Date.now() - t0 < SETTLE_BUDGET_MS) {
        settleAttempts++;
        const s = await fetch(`https://${ctx.apiHost}/auth/v1/settings`, { headers: { apikey }, signal: AbortSignal.timeout(15_000) });
        settingsText = await s.text();
        try {
          const j = JSON.parse(settingsText) as { external?: Record<string, boolean> };
          if (j.external?.keycloak === true) {
            settled = true;
            break;
          }
        } catch {
          // not JSON yet
        }
        await Bun.sleep(3_000);
      }
      const settleS = Math.round((Date.now() - t0) / 1000);
      out.push({
        id: `${ID}-setup`,
        title: "keycloak slot pointed at the lab issuer",
        status: patch.status < 300 && settled ? "pass" : "fail",
        detail: `PATCH /config/auth HTTP ${patch.status}; /auth/v1/settings external.keycloak true after ${settleS}s (${settleAttempts} reads); mailer_autoconfirm=${String(cfg.mailer_autoconfirm)}, security_manual_linking_enabled=${String(cfg.security_manual_linking_enabled)}`,
        measurements: {
          patch_status: patch.status,
          settle_s: settleS,
          settle_reads: settleAttempts,
          mailer_autoconfirm: String(cfg.mailer_autoconfirm),
          manual_linking_enabled: String(cfg.security_manual_linking_enabled),
        },
        evidence: settled ? undefined : settingsText.slice(0, 300),
      });
      if (!settled) return out;

      // ---- IT01a: first sign-in -------------------------------------------
      const a1 = await signIn(ctx, apikey, { sub: subj("a1"), email: email("a"), email_verified: true, name: "A" });
      if (a1.userId) createdUsers.add(a1.userId);
      const a1rows = await identityRows(`provider_id = '${subj("a1")}'`);
      const a1row = a1rows.rows[0] ?? {};
      const aPass = !!a1.userId && a1rows.rows.length === 1 && a1row.sub === subj("a1") && a1row.user_id === a1.userId;
      out.push({
        id: `${ID}a`,
        title: "first sign-in: new user, identity keyed by subject",
        status: aPass ? "pass" : "fail",
        detail: `${note(a1)}; auth.identities rows for subject a1: ${a1rows.rows.length}, provider_id = identity_data.sub: ${String(a1row.provider_id === a1row.sub)}`,
        measurements: {
          authorize_status: a1.authorizeStatus,
          callback_status: a1.callbackStatus,
          session: a1.userId ? 1 : 0,
          identity_rows: a1rows.rows.length,
          provider_id_equals_sub: String(a1row.provider_id === a1row.sub),
          email_verified_in_identity_data: String(a1row.email_verified ?? "-"),
        },
      });

      // ---- IT01b: new subject, same verified email ------------------------
      const a2 = await signIn(ctx, apikey, { sub: subj("a2"), email: email("a"), email_verified: true, name: "A" });
      if (a2.userId) createdUsers.add(a2.userId);
      const aUser = a1.userId ? (await userRow(a1.userId)).rows[0] ?? {} : {};
      const bLinked = !!a1.userId && a2.userId === a1.userId;
      out.push({
        id: `${ID}b`,
        title: "new subject, same verified email: linked to the existing user",
        status: bLinked && Number(aUser.identities) === 2 ? "pass" : "fail",
        detail: `${note(a2)}; same user as a1: ${String(bLinked)}; identities on that user now: ${String(aUser.identities ?? "-")}`,
        measurements: {
          callback_status: a2.callbackStatus,
          same_user_as_a1: String(bLinked),
          identities_on_user: Number(aUser.identities ?? 0),
          error_code: a2.errorCode ?? "-",
        },
      });

      // ---- IT01c: new subject, different email ----------------------------
      const b1 = await signIn(ctx, apikey, { sub: subj("b1"), email: email("b1"), email_verified: true, name: "B" });
      if (b1.userId) createdUsers.add(b1.userId);
      const b2 = await signIn(ctx, apikey, { sub: subj("b2"), email: email("b2"), email_verified: true, name: "B" });
      if (b2.userId) createdUsers.add(b2.userId);
      const cNew = !!b1.userId && !!b2.userId && b1.userId !== b2.userId;
      out.push({
        id: `${ID}c`,
        title: "new subject, different email (relay address changed): a new user",
        status: cNew ? "pass" : "fail",
        detail: `b1 ${note(b1)}; b2 ${note(b2)}; different users: ${String(cNew)}`,
        measurements: { b1_session: b1.userId ? 1 : 0, b2_session: b2.userId ? 1 : 0, different_users: String(cNew) },
      });

      // ---- IT01d: the remap recipe ----------------------------------------
      const c1 = await signIn(ctx, apikey, { sub: subj("c1"), email: email("c"), email_verified: true, name: "C" });
      if (c1.userId) createdUsers.add(c1.userId);
      const remap = await sql(
        ctx,
        `update auth.identities set provider_id = '${subj("c2")}', identity_data = identity_data || jsonb_build_object('sub', '${subj("c2")}') where provider = 'keycloak' and provider_id = '${subj("c1")}' returning user_id::text`,
      );
      const c2 = await signIn(ctx, apikey, { sub: subj("c2"), email: email("c2"), email_verified: true, name: "C" });
      if (c2.userId) createdUsers.add(c2.userId);
      const cUser = c1.userId ? (await userRow(c1.userId)).rows[0] ?? {} : {};
      const cIdentity = (await identityRows(`provider_id = '${subj("c2")}'`)).rows[0] ?? {};
      const userEmailMoved = cUser.email === email("c2") ? "new" : cUser.email === email("c") ? "old" : "other";
      const identityEmailMoved = cIdentity.email === email("c2") ? "new" : cIdentity.email === email("c") ? "old" : "other";
      // control: the old subject is gone; with another email it must be a stranger
      const c1again = await signIn(ctx, apikey, { sub: subj("c1"), email: email("c-old"), email_verified: true, name: "C" });
      if (c1again.userId) createdUsers.add(c1again.userId);
      const dPass = !!c1.userId && remap.rows.length === 1 && c2.userId === c1.userId && Number(cUser.identities) === 1 && !!c1again.userId && c1again.userId !== c1.userId;
      out.push({
        id: `${ID}d`,
        title: "remap provider_id in SQL, sign in with the new subject and a new email: same user",
        status: dPass ? "pass" : "fail",
        detail: `c1 ${note(c1)}; remap updated ${remap.rows.length} row(s)${remap.error ? ` (${remap.error})` : ""}; c2 (different email) ${note(c2)}; same user as c1: ${String(c2.userId === c1.userId)}, identities on that user: ${String(cUser.identities ?? "-")}; after the c2 sign-in auth.users.email is the ${userEmailMoved} address and identity_data.email the ${identityEmailMoved} one; control c1-with-new-email is a different user: ${String(!!c1again.userId && c1again.userId !== c1.userId)}`,
        measurements: {
          remap_rows: remap.rows.length,
          c2_same_user_as_c1: String(c2.userId === c1.userId),
          identities_on_user: Number(cUser.identities ?? 0),
          users_email_after: userEmailMoved,
          identity_data_email_after: identityEmailMoved,
          token_email_after: c2.email === email("c2") ? "new" : c2.email === email("c") ? "old" : "other",
          control_old_subject_new_user: String(!!c1again.userId && c1again.userId !== c1.userId),
          c2_callback_status: c2.callbackStatus,
        },
      });

      // ---- IT01e: new subject, same email, unverified ----------------------
      const d1 = await signIn(ctx, apikey, { sub: subj("d1"), email: email("d"), email_verified: true, name: "D" });
      if (d1.userId) createdUsers.add(d1.userId);
      const d2 = await signIn(ctx, apikey, { sub: subj("d2"), email: email("d"), email_verified: false, name: "D" });
      if (d2.userId) createdUsers.add(d2.userId);
      const d2rows = await identityRows(`provider_id = '${subj("d2")}'`);
      // The refused sign-in still writes rows: an identity carrying the email
      // and a user row whose own email column is NULL (first run, 2026-09-07),
      // which an email-keyed cleanup cannot see.
      const d2shadow = await sql(ctx, `select u.email as user_email, u.email_confirmed_at is not null as confirmed, u.is_anonymous from auth.identities i join auth.users u on u.id = i.user_id where i.provider = 'keycloak' and i.provider_id = '${subj("d2")}'`);
      const shadow = d2shadow.rows[0];
      const dUser = d1.userId ? (await userRow(d1.userId)).rows[0] ?? {} : {};
      const eNotLinked = !!d1.userId && d2.userId !== d1.userId && Number(dUser.identities) === 1;
      out.push({
        id: `${ID}e`,
        title: "new subject, same email but unverified: not linked",
        status: eNotLinked ? "pass" : "fail",
        detail: `d1 ${note(d1)}; d2 ${note(d2)}; identities on d1's user: ${String(dUser.identities ?? "-")}; rows the refused sign-in left for d2: ${d2rows.rows.length} identity, ${d2shadow.rows.length} user (auth.users.email ${shadow ? (shadow.user_email == null ? "NULL" : "set") : "-"}, confirmed ${shadow ? String(shadow.confirmed) : "-"})`,
        measurements: {
          d2_session: d2.userId ? 1 : 0,
          d2_error: d2.error ?? "-",
          d2_error_code: d2.errorCode ?? "-",
          d2_identity_rows: d2rows.rows.length,
          d2_shadow_user_rows: d2shadow.rows.length,
          d2_shadow_user_email: shadow ? (shadow.user_email == null ? "null" : "set") : "-",
          d2_shadow_user_confirmed: shadow ? String(shadow.confirmed) : "-",
          identities_on_d1_user: Number(dUser.identities ?? 0),
        },
        evidence: d2.errorDescription ? `callback error_description: ${d2.errorDescription}` : undefined,
      });
    } catch (e) {
      out.push({ id: ID, title: this.title, status: "fail", detail: `threw: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      const notes: string[] = [];
      // Users: the ones we saw ids for via the admin API, then a sweep by the
      // run's email prefix for anything created without a session.
      const keys = await fetchKeys(ctx).catch(() => undefined);
      let deleted = 0;
      if (keys) {
        for (const id of createdUsers) {
          const r = await fetch(`https://${ctx.apiHost}/auth/v1/admin/users/${id}`, {
            method: "DELETE",
            headers: { apikey: keys.service, Authorization: `Bearer ${keys.service}` },
            signal: AbortSignal.timeout(30_000),
          });
          if (r.status < 300) deleted++;
        }
      }
      // Sweep by the identity subjects, not by user email: the refused
      // unverified sign-in leaves a user whose email column is NULL.
      const sweep = await sql(ctx, `delete from auth.users where id in (select user_id from auth.identities where provider = 'keycloak' and provider_id like 'it01-${nonce}-%') or email like 'it01-${nonce}-%@example.com' returning id`);
      notes.push(`deleted ${deleted} user(s) via admin API, ${sweep.rows.length} more by identity-subject sweep`);
      let restored = true;
      if (original) {
        const restore = await mgmt(ctx, "PATCH", `/projects/${ctx.ref}/config/auth`, original);
        restored = restore.status < 300;
        notes.push(`auth config restored: HTTP ${restore.status}`);
      }
      out.push({ id: `${ID}z`, title: "cleanup", status: restored && !sweep.error ? "pass" : "fail", detail: notes.join("; ") + (sweep.error ? `; sweep error: ${sweep.error}` : "") });
    }
    return out;
  },
};
export default mod;
