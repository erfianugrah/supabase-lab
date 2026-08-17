/**
 * O01 - the "bring your own backend" OAuth2 pattern, measured.
 *
 * A platform can let its users connect THEIR OWN Supabase organization to the
 * platform's app via the Management API OAuth2 flow (authorize -> code ->
 * token -> act on the user's orgs/projects -> revoke). The public guide
 * (build-a-supabase-oauth-integration) describes the flow; this module
 * measures the runtime surface:
 *
 *   O01-control  the PAT reaches the Management API (without a green control
 *                the authorize probes below are uninterpretable).
 *   O01a         GET /v1/oauth/authorize with a well-formed but BOGUS
 *                client_id, no session. Whatever it answers is data.
 *   O01b         GET /v1/oauth/authorize with well-formed params (PKCE,
 *                state), no session cookie. Whatever it answers is data.
 *                NOTE: until the manual consent drill supplies a real
 *                client_id, O01a/O01b both measure error PRECEDENCE (client
 *                validation vs session redirect), not the consent screen.
 *   O01c/d/e     the token lifecycle - gated on PVLAB_OAUTH_CLIENT_ID /
 *                PVLAB_OAUTH_CLIENT_SECRET / PVLAB_OAUTH_REFRESH_TOKEN from
 *                the manual drill (app registration is dashboard-only, and
 *                the consent click needs a logged-in browser).
 *
 * O01e revokes the captured grant, which is why the module is destructive:
 * a green O01e BURNS the drill's grant - re-consent to re-run.
 *
 * Token VALUES never appear in results - only shapes (statuses, counts,
 * booleans-as-1/0, seconds).
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";

const OAUTH_BASE = "https://api.supabase.com/v1/oauth";
const BOGUS_CLIENT_A = "00000000-0000-0000-0000-000000000000";
const BOGUS_CLIENT_B = "11111111-1111-4111-8111-111111111111";
const REDIRECT_URI = "http://localhost:54321/callback";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}

function failRow(id: string, title: string, e: unknown): TestResult {
  return {
    id,
    title,
    status: "fail",
    detail: `test threw: ${e instanceof Error ? e.message : String(e)}`,
  };
}

/** Host of an absolute Location header, else the raw value for the record. */
function locationHost(location: string | null): string {
  if (!location) return "none";
  try {
    return new URL(location).host;
  } catch {
    return location.slice(0, 120);
  }
}

async function authorizeProbe(
  id: string,
  title: string,
  statusKey: string,
  params: Record<string, string>,
): Promise<TestResult> {
  try {
    const url = new URL(`${OAUTH_BASE}/authorize`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url.toString(), {
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    const body = await res.text();
    return {
      id,
      title,
      status: "info",
      measurements: { [statusKey]: res.status, location_host: locationHost(res.headers.get("location")) },
      evidence: body.slice(0, 300) || undefined,
    };
  } catch (e) {
    return failRow(id, title, e);
  }
}

/** O01c/d/e - only reached when all three PVLAB_OAUTH_* vars are present. */
async function oauthLifecycle(
  ctx: Ctx,
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const basic = btoa(`${clientId}:${clientSecret}`);

  // O01c - refresh_token grant. Tokens stay in this closure; only shapes leave.
  let accessToken: string | undefined;
  let liveRefreshToken = refreshToken;
  try {
    const res = await fetch(`${OAUTH_BASE}/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }).toString(),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (res.status === 200) {
      const json = JSON.parse(text) as TokenResponse;
      accessToken = json.access_token;
      if (json.refresh_token) liveRefreshToken = json.refresh_token;
      results.push({
        id: "O01c",
        title: "O01c: refresh_token grant",
        status: "pass",
        measurements: {
          expires_in: json.expires_in ?? "absent",
          token_type: json.token_type ?? "absent",
          new_refresh_token: json.refresh_token ? 1 : 0,
        },
      });
    } else {
      results.push({
        id: "O01c",
        title: "O01c: refresh_token grant",
        status: "fail",
        detail: `HTTP ${res.status}`,
        measurements: { status: res.status },
        evidence: text.slice(0, 300),
      });
    }
  } catch (e) {
    results.push(failRow("O01c", "O01c: refresh_token grant", e));
  }

  // O01d - act on the user's orgs/projects with the OAuth token. Gated on
  // O01c: without a token there is nothing to measure (Bearer undefined is
  // recorded garbage, not data).
  if (accessToken) {
    try {
      const oauthCtx = { ...ctx, pat: accessToken };
      const orgs = await mgmt(oauthCtx, "GET", "/organizations");
      const projs = await mgmt(oauthCtx, "GET", "/projects");
      results.push({
        id: "O01d",
        title: "O01d: Management API with the OAuth access token",
        status: "info",
        measurements: {
          orgs_status: orgs.status,
          projects_status: projs.status,
          organizations: Array.isArray(orgs.json) ? orgs.json.length : "n/a",
          projects: Array.isArray(projs.json) ? projs.json.length : "n/a",
        },
      });
    } catch (e) {
      results.push(failRow("O01d", "O01d: Management API with the OAuth access token", e));
    }
  } else {
    results.push({
      id: "O01d",
      title: "O01d: Management API with the OAuth access token",
      status: "skip",
      detail: "O01c produced no access token",
    });
  }

  // O01e - revoke the grant, then poll the refresh grant until it stops
  // answering 200. BURNS THE GRANT: re-consent in the dashboard to re-run.
  if (accessToken) {
    try {
      const revoke = await fetch(`${OAUTH_BASE}/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: liveRefreshToken,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      await revoke.text();

      const t0 = Date.now();
      let grantStatus = 200;
      while (Date.now() - t0 < 60_000) {
        const probe = await fetch(`${OAUTH_BASE}/token`, {
          method: "POST",
          headers: {
            Authorization: `Basic ${basic}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: liveRefreshToken }).toString(),
          signal: AbortSignal.timeout(30_000),
        });
        await probe.text();
        grantStatus = probe.status;
        if (grantStatus !== 200) break;
        await sleep(2_000);
      }
      results.push({
        id: "O01e",
        title: "O01e: revoke and time-to-effect",
        status: "info",
        detail: grantStatus === 200 ? "refresh grant still answered 200 after 60s - revocation not effective" : undefined,
        measurements: {
          revoke_http_status: revoke.status,
          grant_status_after: grantStatus,
          time_to_effect_s: Math.round((Date.now() - t0) / 1000),
        },
      });
    } catch (e) {
      results.push(failRow("O01e", "O01e: revoke and time-to-effect", e));
    }
  } else {
    results.push({
      id: "O01e",
      title: "O01e: revoke and time-to-effect",
      status: "skip",
      detail: "O01c produced no access token",
    });
  }

  return results;
}

const mod: TestModule = {
  id: "O01",
  title: "BYO-backend OAuth2 lifecycle",
  where: "local",
  requires: ["pat"],
  destructive: true, // O01e revokes the drill's grant - re-consent to re-run
  async run(ctx: Ctx): Promise<TestResult[]> {
    const results: TestResult[] = [];

    try {
      const control = await mgmt(ctx, "GET", "/projects");
      results.push({
        id: "O01-control",
        title: "O01-control: PAT reaches the Management API",
        status: control.status === 200 ? "pass" : "fail",
        detail:
          control.status === 200
            ? undefined
            : `GET /projects HTTP ${control.status} - every other row is uninterpretable`,
        measurements: { status: control.status },
      });
    } catch (e) {
      results.push(failRow("O01-control", "O01-control: PAT reaches the Management API", e));
    }

    results.push(
      await authorizeProbe("O01a", "O01a: authorize with bogus client_id", "bogus_client_status", {
        client_id: BOGUS_CLIENT_A,
        redirect_uri: REDIRECT_URI,
        response_type: "code",
      }),
    );
    results.push(
      await authorizeProbe("O01b", "O01b: authorize with no session", "no_session_status", {
        client_id: BOGUS_CLIENT_B,
        redirect_uri: REDIRECT_URI,
        response_type: "code",
        state: "pvlab-o01b",
        code_challenge: "PvLabO01bChallengeStringThatIsLongEnough43x",
        code_challenge_method: "plain",
      }),
    );

    const clientId = process.env.PVLAB_OAUTH_CLIENT_ID;
    const clientSecret = process.env.PVLAB_OAUTH_CLIENT_SECRET;
    const refreshToken = process.env.PVLAB_OAUTH_REFRESH_TOKEN;
    const missing = [
      ...(clientId ? [] : ["PVLAB_OAUTH_CLIENT_ID"]),
      ...(clientSecret ? [] : ["PVLAB_OAUTH_CLIENT_SECRET"]),
      ...(refreshToken ? [] : ["PVLAB_OAUTH_REFRESH_TOKEN"]),
    ];

    if (missing.length > 0) {
      const reason = `missing env: ${missing.join(", ")} - supplied by the manual consent drill`;
      for (const [id, title] of [
        ["O01c", "O01c: refresh_token grant"],
        ["O01d", "O01d: Management API with the OAuth access token"],
        ["O01e", "O01e: revoke and time-to-effect"],
      ] as const) {
        results.push({ id, title, status: "skip", detail: reason });
      }
    } else {
      results.push(...(await oauthLifecycle(ctx, clientId!, clientSecret!, refreshToken!)));
    }

    return results;
  },
};
export default mod;
