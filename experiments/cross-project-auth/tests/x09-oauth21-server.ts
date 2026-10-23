/**
 * X09 - a token from the hub's OAuth 2.1 server at the spoke.
 *
 * The discovery document on a project without the OAuth 2.1 server enabled
 * already advertised `authorization_code` (run 1, 2026-08-03), but nobody had
 * issued a token through it and presented it to a project that trusts the
 * hub. An OAuth client's token adds `client_id` and `scope`; does that change
 * what the spoke accepts?
 *
 * SIDE: the lib/fanout.ts pair; B trusts A via `oidc_issuer_url`. The OAuth
 * 2.1 server is enabled on A with the Management API auth config PATCH (the
 * docs' Cloud instructions name only the dashboard; byo-oauth O03 and
 * governed-starter-kit K06 used the PATCH). A confidential client is
 * registered through A's admin API; the code flow runs headless (authorize
 * with PKCE, GET the authorization to bind the user, consent approve through
 * the API, token with client_secret_basic), with tenant-a's A session as the
 * signed-in user. VERIFIERS and KEYS as X08.
 *
 *   X09a  discovery before, enable via Management API, read back, discovery after.
 *   X09b  client registration + code flow; the access token's claim set.
 *   X09c  that token on all seven cells.
 *   X09d  refresh: the OAuth refresh token at A's and at B's /oauth/token.
 *   X09e  the docs' pattern: the access token hook sets aud for OAuth tokens
 *         ("spoke-api"); a second token from the same flow on all seven cells.
 *
 * X09 installs the X08 hook itself (idempotent), so its state is the same
 * whether or not X08 ran first: hook enabled, no OAuth override until X09e.
 *
 * DESTRUCTIVE: writes auth config, users and OAuth clients on the pair; X99 deletes it.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import {
  awaitOauthServer,
  awaitSpoke,
  claimSet,
  codeFlow,
  discovery,
  ensureFixtures,
  ensureHook,
  ensureTrust,
  matrix,
  matrixLine,
  matrixMeasurements,
  oauthRefresh,
  registerClient,
  setOauthAud,
  SPOKE_AUD,
} from "../lib/audprobe.js";
import { ensurePair, skipWithoutPro, sleep } from "../lib/fanout.js";

const claimsText = (c: Record<string, string | number>) =>
  Object.entries(c)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");

const mod: TestModule = {
  id: "X09",
  title: "OAuth 2.1 server on the hub: an OAuth client's token at the spoke",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const skip = skipWithoutPro(ctx, "X09");
    if (skip) return skip;
    const out: TestResult[] = [];
    const p = await ensurePair(ctx);
    await ensureTrust(ctx, p);
    await ensureFixtures(ctx, p.a);
    await ensureFixtures(ctx, p.b);
    await awaitSpoke(p, p.tokA);
    await ensureHook(ctx, p.a);
    await setOauthAud(ctx, p.a, null);

    // X09a - enable.
    const before = await discovery(p.a);
    const cfg0 = await mgmt(ctx, "GET", `/projects/${p.a.ref}/config/auth`);
    const en0 = String((cfg0.json as Record<string, unknown> | undefined)?.oauth_server_enabled);
    const patch = await mgmt(ctx, "PATCH", `/projects/${p.a.ref}/config/auth`, {
      oauth_server_enabled: true,
      oauth_server_authorization_path: "/oauth/consent",
    });
    const cfg1 = await mgmt(ctx, "GET", `/projects/${p.a.ref}/config/auth`);
    const c1 = (cfg1.json ?? {}) as Record<string, unknown>;
    const immediate = await discovery(p.a);
    const live = await awaitOauthServer(p.a);
    const after = await discovery(p.a);
    out.push({
      id: "X09a",
      title: "OAuth 2.1 server enabled on A through the Management API",
      status: patch.status < 300 && c1.oauth_server_enabled === true && live.ms >= 0 ? "pass" : "fail",
      detail: `before: oauth_server_enabled=${en0}, discovery HTTP ${before.status} grants [${before.grants}]${before.text ? ` ${before.text}` : ""}; PATCH /config/auth HTTP ${patch.status}${patch.status >= 300 ? ` ${patch.text.slice(0, 200)}` : ""}; read back oauth_server_enabled=${String(c1.oauth_server_enabled)}, authorization_path=${String(c1.oauth_server_authorization_path)}, dynamic_registration=${String(c1.oauth_server_allow_dynamic_registration)}; discovery right after the PATCH HTTP ${immediate.status}${immediate.text ? ` ${immediate.text}` : ""}; first 200 after ${live.ms} ms (${live.polls} polls, 5 s apart${live.last ? `; last refusal ${live.last}` : ""}); then: discovery HTTP ${after.status} issuer ${after.issuer} grants [${after.grants}] scopes [${after.scopes}]`,
      measurements: {
        enabled_before: en0,
        patch_status: patch.status,
        enabled_after: String(c1.oauth_server_enabled),
        discovery_before_status: before.status,
        discovery_before_grants: before.grants,
        discovery_immediate_status: immediate.status,
        oauth_live_ms: live.ms,
        oauth_live_polls: live.polls,
        discovery_after_status: after.status,
        discovery_after_grants: after.grants,
        discovery_issuer: after.issuer,
      },
    });

    // X09b - client + code flow (retry while the config change reaches Auth).
    const client = await registerClient(p.a, `xaud-client-${Date.now()}`);
    let flow = await codeFlow(p.a, p.tokA, client);
    for (let i = 0; i < 12 && !flow.token && client.clientId; i++) {
      await sleep(5000);
      flow = await codeFlow(p.a, p.tokA, client);
    }
    const cs = flow.token ? claimSet(flow.token) : undefined;
    out.push({
      id: "X09b",
      title: "Confidential client registered; headless code flow issues an access token",
      status: flow.token ? "pass" : "fail",
      detail: `register HTTP ${client.status}${client.text ? ` ${client.text}` : ""}; authorize ${flow.authorizeStatus}, consent ${flow.consentStatus}, token ${flow.tokenStatus}; token_type ${flow.tokenType || "-"}, response scope "${flow.responseScope}", refresh token ${flow.refresh ? "present" : "absent"}; ${flow.consentPath}${flow.detail ? `; ${flow.detail}` : ""}`,
      measurements: { register_status: client.status, authorize_status: flow.authorizeStatus, consent_status: flow.consentStatus, token_status: flow.tokenStatus, ...(cs ?? {}) },
      evidence: cs ? claimsText(cs) : undefined,
    });
    if (!flow.token) return out;

    // X09c - the OAuth token on every cell.
    const m = await matrix(p, flow.token);
    out.push({
      id: "X09c",
      title: "OAuth 2.1 access token (aud as issued) on A and B: PostgREST, Storage, Realtime, A /auth/v1/user",
      status: "info",
      detail: `aud ${cs?.aud}, client_id ${cs?.client_id}, scope "${cs?.scope}"; ${matrixLine(m)}`,
      measurements: matrixMeasurements(m),
    });

    // X09d - refresh at the issuer and at the spoke.
    const refB = await oauthRefresh(p.b, client, flow.refresh);
    const refA = await oauthRefresh(p.a, client, flow.refresh);
    out.push({
      id: "X09d",
      title: "OAuth refresh token: presented to B's /oauth/token, then to A's",
      status: "info",
      detail: `B HTTP ${refB.status} ${refB.text}; A HTTP ${refA.status}${refA.token ? ` new access token aud ${claimSet(refA.token).aud}, client_id ${claimSet(refA.token).client_id}` : ` ${refA.text}`}`,
      measurements: { refresh_at_b_status: refB.status, refresh_at_b_body: refB.text, refresh_at_a_status: refA.status },
    });

    // X09e - hook sets aud for OAuth-issued tokens.
    const setS = await setOauthAud(ctx, p.a, SPOKE_AUD);
    const flow2 = await codeFlow(p.a, p.tokA, client);
    if (!flow2.token) {
      out.push({ id: "X09e", title: "OAuth token with hook-set aud", status: "info", detail: `set ${setS}; flow: authorize ${flow2.authorizeStatus} consent ${flow2.consentStatus} token ${flow2.tokenStatus}; ${flow2.consentPath} ${flow2.detail}` });
    } else {
      const cs2 = claimSet(flow2.token);
      const m2 = await matrix(p, flow2.token);
      out.push({
        id: "X09e",
        title: 'OAuth token with aud "spoke-api" (access token hook keyed on client_id) on all seven cells',
        status: "info",
        detail: `second flow, same user and client: ${flow2.consentPath}; aud ${cs2.aud}, client_id ${cs2.client_id}; ${matrixLine(m2)}`,
        measurements: { aud: cs2.aud, ...matrixMeasurements(m2) },
        evidence: claimsText(cs2),
      });
    }
    await setOauthAud(ctx, p.a, null);
    return out;
  },
};
export default mod;
