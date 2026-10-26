/**
 * O03 - the project's own OAuth 2.1 IdP (Authorization Server) and whether
 * RLS can actually read `client_id`.
 *
 * The shared-tenancy guide says access tokens issued through the project's
 * OAuth server carry a `client_id` claim and RLS can scope on it --
 * "documented, not tested". This module runs the whole flow headless on a
 * throwaway project:
 *
 *   O03-control  provision + enable oauth_server via the auth config PATCH,
 *                then poll the RFC 8414 discovery document until it answers
 *                200 (on 2026-10-26 discovery answered 404 right after the
 *                PATCH and 200 within 4322 ms).
 *   O03a         register an OAuth client (admin API) + create a user.
 *   O03b         authorization code flow with PKCE, headless: password-login
 *                user token -> GET authorize (302 -> authorization_id) ->
 *                GET /oauth/authorizations/{id} (user binding) ->
 *                POST .../consent {action:"approve"} -> code ->
 *                POST token (client_secret_basic) -> access token. Decode
 *                the payload: claim shape.
 *   O03c         an RLS policy `auth.jwt() ->> 'client_id' = <client A>` on
 *                a table; the client A token reads the row (positive), a
 *                client B token does not (negative).
 *
 * The whole point of registering clients inside the run: the client_secret
 * lives only in this closure - the admin list endpoint does not echo it.
 * The project is deleted in finally. No token values in output.
 */
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import { errorSummary, failedStep, stepMeasurements, type FlowStep } from "../lib/flow-steps.js";

let PRO_ORG = ""; // from PVLAB_ORG_PRO via ctx.orgs.pro; set in run()
const REGION = "ap-southeast-1";
const REDIRECT = "http://localhost:54321/callback";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ProjectCreateResponse {
  ref?: string;
}
interface ProjectStatusResponse {
  status?: string;
}
interface ApiKeyRow {
  name?: string;
  type?: string;
  api_key?: string;
}

function pickKey(keys: ApiKeyRow[], ...names: string[]): string {
  for (const n of names) {
    const hit = keys.find((k) => k.name === n || k.type === n);
    if (hit?.api_key) return hit.api_key;
  }
  return "";
}

interface ClientReg {
  clientId: string;
  clientSecret: string;
}
interface ClientHttp {
  client: (path: string, init?: { body?: unknown; method?: string }) => Promise<{ status: number; text: string }>;
}
interface FlowResult {
  token: string;
  claims: { client_id?: string; aud?: string; scope?: string; sub?: string };
}
interface SessionCreds {
  anonKey: string;
  serviceKey: string;
  baseUrl: string;
}

async function gocall(
  url: string,
  opts: { anonKey?: string; bearerToken?: string; body?: unknown; method?: string; urlEncodedBody?: URLSearchParams },
): Promise<{ status: number; text: string }> {
  const headers: Record<string, string> = {};
  if (opts.anonKey) headers.apikey = opts.anonKey;
  if (opts.bearerToken) headers.Authorization = `Bearer ${opts.bearerToken}`;
  let body: string | undefined;
  if (opts.urlEncodedBody) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = opts.urlEncodedBody.toString();
  } else if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(url, {
    method: opts.method ?? (body ? "POST" : "GET"),
    headers,
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
  return { status: res.status, text: await res.text() };
}

function b64url(bytes: Buffer): string {
  return Buffer.from(bytes).toString("base64url");
}

/** Register a client and run the full headless code flow; token claims out. Every step's status is kept. */
async function runFlow(
  sc: SessionCreds,
  name: string,
  pass: string,
  email: string,
): Promise<{ reg: ClientReg; flow?: FlowResult; steps: FlowStep[] }> {
  const steps: FlowStep[] = [];
  const noReg = { clientId: "", clientSecret: "" };
  const regJson = await gocall(`${sc.baseUrl}/auth/v1/admin/oauth/clients`, {
    anonKey: sc.serviceKey,
    bearerToken: sc.serviceKey,
    body: { name, redirect_uris: [REDIRECT], client_type: "confidential" },
  });
  let reg: { client_id?: string; client_secret?: string } = {};
  try {
    reg = JSON.parse(regJson.text) as typeof reg;
  } catch {
    reg = {};
  }
  if (!reg.client_id || !reg.client_secret) {
    steps.push({ step: "register", status: regJson.status, ok: false, error: errorSummary(regJson.text) });
    return { reg: noReg, steps };
  }
  steps.push({ step: "register", status: regJson.status, ok: true });
  const client = { clientId: reg.client_id, clientSecret: reg.client_secret };

  // fresh verifier per client
  const verifier = b64url(Buffer.from(cryptoRandomBytes(48)));
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  const authz = await gocall(
    `${sc.baseUrl}/auth/v1/oauth/authorize?client_id=${reg.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code&code_challenge=${challenge}&code_challenge_method=S256`,
    { anonKey: sc.anonKey, bearerToken: userToken(sc, email, pass) },
  );
  const aidMatch = /authorization_id=([a-z0-9]+)/.exec(authz.text);
  if (!aidMatch) {
    steps.push({ step: "authorize", status: authz.status, ok: false, error: `no authorization_id in body; ${errorSummary(authz.text)}` });
    return { reg: client, steps };
  }
  steps.push({ step: "authorize", status: authz.status, ok: true });
  const aid = aidMatch[1];
  // GET binds the user (required by the consent route)
  const bind = await gocall(`${sc.baseUrl}/auth/v1/oauth/authorizations/${aid}`, {
    anonKey: sc.anonKey,
    bearerToken: userToken(sc, email, pass),
  });
  const bindOk = bind.status >= 200 && bind.status < 300;
  steps.push({ step: "authorization", status: bind.status, ok: bindOk, error: bindOk ? undefined : errorSummary(bind.text) });
  if (!bindOk) return { reg: client, steps };
  const consent = await gocall(`${sc.baseUrl}/auth/v1/oauth/authorizations/${aid}/consent`, {
    anonKey: sc.anonKey,
    bearerToken: userToken(sc, email, pass),
    body: { action: "approve" },
  });
  const codeMatch = /code=([a-z0-9-]+)/.exec(consent.text);
  const code = codeMatch?.[1];
  if (!code) {
    steps.push({ step: "consent", status: consent.status, ok: false, error: `no code in body; ${errorSummary(consent.text)}` });
    return { reg: client, steps };
  }
  steps.push({ step: "consent", status: consent.status, ok: true });
  const basic = btoa(`${reg.client_id}:${reg.client_secret}`);
  const token = await fetch(`${sc.baseUrl}/auth/v1/oauth/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id: reg.client_id,
      code_verifier: verifier,
    }).toString(),
    signal: AbortSignal.timeout(30_000),
  });
  const tokenText = await token.text();
  let parsed: { access_token?: string } = {};
  try {
    parsed = JSON.parse(tokenText) as { access_token?: string };
  } catch {
    parsed = {};
  }
  if (!parsed.access_token) {
    steps.push({ step: "token", status: token.status, ok: false, error: errorSummary(tokenText) });
    return { reg: client, steps };
  }
  steps.push({ step: "token", status: token.status, ok: true });
  const claims = JSON.parse(Buffer.from(parsed.access_token.split(".")[1] ?? "", "base64url").toString()) as {
    client_id?: string;
    aud?: string;
    scope?: string;
    sub?: string;
  };
  return { reg: client, flow: { token: parsed.access_token, claims }, steps };
}

const userTokenCache = new Map<string, string>();
function userToken(sc: SessionCreds, email: string, pass: string): string {
  const cached = userTokenCache.get(email);
  if (cached) return cached;
  throw new Error("userToken not initialized");
}
async function primeUserToken(sc: SessionCreds, email: string, pass: string): Promise<void> {
  const login = await gocall(`${sc.baseUrl}/auth/v1/token?grant_type=password`, {
    anonKey: sc.anonKey,
    body: { email, password: pass },
  });
  const parsed = JSON.parse(login.text) as { access_token?: string };
  if (parsed.access_token) userTokenCache.set(email, parsed.access_token);
}

const mod: TestModule = {
  id: "O03",
  title: "Project OAuth IdP: client_id claim and RLS scoping, headless",
  where: "local",
  requires: ["pat"],
  destructive: true, // provisions and deletes its own project
  async run(ctx: Ctx): Promise<TestResult[]> {
    PRO_ORG = ctx.orgs.pro ?? "";
    if (!PRO_ORG) return [{ id: "O03", title: this.title, status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    const results: TestResult[] = [];
    let ref = "";
    try {
      // O03-control: provision + enable oauth_server
      const t0 = Date.now();
      const create = await mgmt(ctx, "POST", "/projects", {
        organization_slug: PRO_ORG,
        name: `o03-idp-${t0}`,
        db_pass: `${crypto.randomUUID()}Aa1!`,
        region: REGION,
      });
      ref = (create.json as ProjectCreateResponse | undefined)?.ref ?? "";
      if (create.status !== 201 || !ref) {
        results.push({ id: "O03-control", title: "O03-control: provision", status: "fail", detail: `create: HTTP ${create.status}: ${create.text.slice(0, 200)}` });
        results.push(...["O03a", "O03b", "O03c"].map((id) => ({ id, title: id, status: "skip" as const, detail: "no project" })));
        return results;
      }
      let status = "";
      for (let i = 0; i < 90 && status !== "ACTIVE_HEALTHY"; i++) {
        await sleep(10_000);
        const p = await mgmt(ctx, "GET", `/projects/${ref}`);
        status = (p.json as ProjectStatusResponse | undefined)?.status ?? "";
      }
      const conf = await mgmt(ctx, "PATCH", `/projects/${ref}/config/auth`, {
        oauth_server_enabled: true,
        oauth_server_authorization_path: "/oauth/consent",
      });
      // Same span as 2026-08-18 and 2026-10-13: create to PATCH response. The
      // four 2026-10-26 runs computed it after the discovery read/poll instead.
      const provisionS = Math.round((Date.now() - t0) / 1000);
      const baseUrl = `https://${ref}.supabase.co`;
      // Has Auth applied the PATCH yet? The RFC 8414 discovery document answers
      // 404 feature_disabled while the OAuth server is off (cross-project-auth X09).
      const discoveryUrl = `${baseUrl}/.well-known/oauth-authorization-server/auth/v1`;
      const tPatch = performance.now();
      const disc0 = await gocall(discoveryUrl, {});
      // Wait for it: in the two no-wait runs of 2026-10-26 the client
      // registration seconds later answered the same 404 and the flow never
      // started (2026-10-13's `consent=404` is most likely the same, inferred).
      // Poll every 2 s, budget 300 s.
      let ready = disc0.status === 200;
      let polls = 1;
      while (!ready && performance.now() - tPatch < 300_000) {
        await sleep(2_000);
        polls++;
        ready = (await gocall(discoveryUrl, {})).status === 200;
      }
      const readyMs = ready ? Math.round(performance.now() - tPatch) : -1;
      results.push({
        id: "O03-control",
        title: "O03-control: provision + enable OAuth server",
        status: status === "ACTIVE_HEALTHY" && (conf.status === 200 || conf.status === 202) && ready ? "pass" : "fail",
        detail:
          status !== "ACTIVE_HEALTHY"
            ? `not healthy (status=${status})`
            : `discovery right after the PATCH: HTTP ${disc0.status}${disc0.status === 200 ? "" : ` (${errorSummary(disc0.text)})`}; ` +
              (ready ? `first 200 after ${readyMs} ms (${polls} polls, 2 s apart)` : `no 200 within 300 s (${polls} polls)`),
        measurements: {
          provision_s: provisionS,
          config_status: conf.status,
          discovery_after_patch_status: disc0.status,
          oauth_ready_ms: readyMs,
          oauth_ready_polls: polls,
        },
      });

      const keysRes = await mgmt(ctx, "GET", `/projects/${ref}/api-keys?reveal=true`);
      const keys = Array.isArray(keysRes.json) ? (keysRes.json as ApiKeyRow[]) : [];
      const sc: SessionCreds = {
        anonKey: pickKey(keys, "anon", "publishable"),
        serviceKey: pickKey(keys, "service_role", "secret"),
        baseUrl,
      };

      // O03a: user + first client through the admin API. A fresh project
      // 500s its first admin write for a few seconds after ACTIVE_HEALTHY
      // (readiness lag) - retry with backoff, bounded.
      const email = `o03probe+${Date.now()}@else.work`;
      const pass = "probe-pass-A1!";
      let mk = await gocall(`${baseUrl}/auth/v1/admin/users`, {
        anonKey: sc.serviceKey,
        bearerToken: sc.serviceKey,
        body: { email, password: pass, email_confirm: true },
      });
      for (let attempt = 0; attempt < 12 && mk.status !== 200 && mk.status !== 201; attempt++) {
        await sleep(5_000);
        mk = await gocall(`${baseUrl}/auth/v1/admin/users`, {
          anonKey: sc.serviceKey,
          bearerToken: sc.serviceKey,
          body: { email, password: pass, email_confirm: true },
        });
      }
      await primeUserToken(sc, email, pass).catch(() => null);
      if (!userTokenCache.get(email)) {
        results.push({
          id: "O03a",
          title: "O03a: user + client registration",
          status: "fail",
          detail: `user create: HTTP ${mk.status}: ${mk.text.slice(0, 200)} or login failed`,
        });
        results.push(...["O03b", "O03c"].map((id) => ({ id, title: id, status: "skip" as const, detail: "no user session" })));
        return results;
      }
      results.push({
        id: "O03a",
        title: "O03a: user + client registration",
        status: "info",
        measurements: { admin_user_status: mk.status },
      });

      // O03b: headless code flow for client A
      const flowA = await runFlow(sc, "o03-client-a", pass, email);
      const claim = flowA.flow?.claims;
      results.push({
        id: "O03b",
        title: "O03b: headless authorization code flow, claim shape",
        status: flowA.flow ? "pass" : "fail",
        detail: flowA.flow ? undefined : `flow failed at ${failedStep(flowA.steps)}`,
        measurements: {
          ...stepMeasurements(flowA.steps),
          client_id_claim: claim?.client_id ? 1 : 0,
          aud: claim?.aud ?? "absent",
          scope: claim?.scope ?? "absent",
        },
      });
      if (!flowA.flow) {
        results.push({ id: "O03c", title: "O03c: RLS client_id scoping", status: "skip", detail: "no OAuth token" });
        return results;
      }

      // O03c: RLS scoping on client_id
      const table = "o03_docs";
      const setup = await mgmt(ctx, "POST", `/projects/${ref}/database/query`, {
        query:
          `create table public.${table} (id bigint generated always as identity primary key, note text); ` +
          `grant select, insert, update, delete on table public.${table} to anon, authenticated, service_role; ` +
          `alter table public.${table} enable row level security; ` +
          `create policy client_can_read on public.${table} for select using (auth.jwt() ->> 'client_id' = '${claim?.client_id ?? ""}'); ` +
          `insert into public.${table} (note) values ('client-visible'); ` +
          `select pg_notify('pgrst', 'reload schema');`,
      });
      void setup; // status recorded via the probes below
      // warm schema cache
      for (let i = 0; i < 20; i++) {
        const warm = await gocall(`${baseUrl}/rest/v1/${table}?select=id&limit=1`, { anonKey: sc.anonKey, bearerToken: sc.anonKey });
        if (warm.status === 200) break;
        await sleep(3_000);
      }
      const readA = await gocall(`${baseUrl}/rest/v1/${table}?select=note&limit=1`, {
        anonKey: sc.anonKey,
        bearerToken: flowA.flow.token,
      });
      let visibleWithA = 0;
      try {
        const rows = JSON.parse(readA.text) as Array<Record<string, unknown>>;
        visibleWithA = Array.isArray(rows) && rows.length === 1 ? 1 : 0;
      } catch {
        visibleWithA = 0;
      }
      // client B: same user, different client -> token with a different client_id
      const flowB = await runFlow(sc, "o03-client-b", pass, email);
      const readB = await gocall(`${baseUrl}/rest/v1/${table}?select=note&limit=1`, {
        anonKey: sc.anonKey,
        bearerToken: flowB.flow?.token ?? sc.anonKey,
      });
      let hiddenWithB = 0;
      try {
        const rows = JSON.parse(readB.text) as Array<Record<string, unknown>>;
        hiddenWithB = Array.isArray(rows) && rows.length === 0 ? 1 : 0;
      } catch {
        hiddenWithB = 0;
      }
      results.push({
        id: "O03c",
        title: "O03c: RLS client_id scoping",
        status: "info",
        detail: visibleWithA === 1 && hiddenWithB === 1 ? undefined : "scoping did not isolate as expected - see measurements",
        measurements: {
          policy_status: setup.status,
          visible_with_matching_client: visibleWithA,
          hidden_with_other_client: hiddenWithB,
          client_b_token: flowB.flow ? 1 : 0,
          ...(flowB.flow ? {} : { client_b_failed_at: failedStep(flowB.steps) ?? "" }),
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      for (const id of ["O03-control", "O03a", "O03b", "O03c"]) {
        if (!results.some((r) => r.id === id)) results.push({ id, title: id, status: "fail", detail: `threw: ${msg}` });
      }
    } finally {
      if (ref) await mgmt(ctx, "DELETE", `/projects/${ref}`).catch(() => null);
    }
    return results;
  },
};
export default mod;

function cryptoRandomBytes(n: number): Buffer {
  const buf = Buffer.allocUnsafe(n);
  for (let i = 0; i < n; i++) buf[i] = Math.floor(Math.random() * 256);
  return buf;
}
