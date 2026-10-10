/**
 * K06 - the "MCP server for your app" library block (Select 2026) running on a
 * kit project: one Edge Function that verifies the caller's Supabase token and
 * gives every MCP tool an RLS-scoped client, with Supabase Middleware 1.0
 * (`pipeline`, `withOAuthProtectedResource`) doing discovery and the auth gate.
 *
 * Self-provisioning: creates a throwaway project (prefix PVLAB_PROJECT_PREFIX,
 * default kit-mcp-) in the Team org, applies the kit baseline, example app and
 * sql/60-mcp.sql, seeds the four kit users, enables the project's OAuth 2.1
 * server with dynamic registration, deploys supabase/functions/mcp, runs the
 * checks as a real MCP client over HTTP, and deletes the project. It never
 * touches kit-live or kit-ready. PVLAB_PEER_MCP=<ref> adopts an existing
 * project (kept) for re-runs.
 *
 * What it answers: does the function challenge with RFC 9728 metadata; can a
 * client register itself and run the code flow; does the OAuth token reach the
 * tool as the user (RLS by department) and carry `client_id` (RLS by client);
 * is a password-session token (the embedded-agent path) accepted with no
 * client_id; which other bearer values are refused.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { $ } from "bun";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { claimsOf, headerOf, passwordToken, provision, api, sql, teardown, type Scratch } from "../lib/scratch-project";
import { authorize, discover, http, json, registerClient } from "../lib/oauth-flow";
import { McpClient, toolStructured, toolText } from "../lib/mcp-client";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SQL_FILES = ["sql/00-baseline.sql", "sql/10-app.sql", "sql/60-mcp.sql"].map((f) => `${ROOT}${f}`);

const TITLE = "MCP server block + Supabase Middleware: discovery, OAuth, per-user RLS, client_id RLS";

function mk(id: string, title: string, ok: boolean | "info", detail?: string, measurements?: Record<string, number | string>): TestResult {
  return { id, title, status: ok === "info" ? "info" : ok ? "pass" : "fail", ...(detail ? { detail } : {}), ...(measurements ? { measurements } : {}) };
}

async function ownerRows(ctx: Ctx, ref: string, q: string): Promise<Record<string, unknown>[]> {
  return (await sql(ctx, ref, q)) as Record<string, unknown>[];
}

const mod: TestModule = {
  id: "K06",
  title: TITLE,
  where: "local",
  requires: ["pat"],
  destructive: true, // provisions and deletes its own project
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!ctx.orgs.team) return [{ id: "K06", title: TITLE, status: "skip", detail: "PVLAB_ORG_TEAM not set" }];
    if (!Bun.which("supabase")) return [{ id: "K06", title: TITLE, status: "skip", detail: "supabase CLI not found" }];
    const results: TestResult[] = [];
    let s: Scratch | undefined;
    const t0 = Date.now();
    try {
      s = await provision(ctx, "mcp", SQL_FILES, (p) => readFileSync(p, "utf8"));
      const provisionS = Math.round((Date.now() - t0) / 1000);

      // Signing keys: the block refuses legacy HS256 tokens, so record what the project signs with.
      const keys = await api(ctx, "GET", `/projects/${s.ref}/config/auth/signing-keys`);
      const keyList = ((keys.json as { keys?: { algorithm?: string; status?: string }[] } | undefined)?.keys ?? []);
      const inUse = keyList.find((k) => k.status === "in_use")?.algorithm ?? "none";

      // OAuth server with dynamic registration; the consent app does not exist, so the consent step is the API call a page would make.
      const siteUrl = "http://localhost:3000";
      const cfg = await api(ctx, "PATCH", `/projects/${s.ref}/config/auth`, {
        oauth_server_enabled: true,
        oauth_server_allow_dynamic_registration: true,
        oauth_server_authorization_path: "/oauth/consent",
        site_url: siteUrl,
      });

      // Deploy the block (gateway JWT check off, as the block's own docs require).
      const td = Date.now();
      const dep = await $`supabase functions deploy mcp --project-ref ${s.ref} --workdir ${ROOT} --use-api --no-verify-jwt`
        .env({ ...process.env, SUPABASE_ACCESS_TOKEN: ctx.pat ?? "" })
        .quiet()
        .nothrow();
      const deployS = Math.round((Date.now() - td) / 1000);
      if (dep.exitCode !== 0) throw new Error(`function deploy failed: ${dep.stderr.toString().slice(0, 400)}`);
      results.push(
        mk("K06.01", "setup: project, signing key, OAuth server config, function deploy", inUse === "ES256" || inUse === "RS256" ? "info" : false, inUse, {
          provision_s: provisionS,
          deploy_s: deployS,
          signing_alg_in_use: inUse,
          signing_keys: keyList.map((k) => `${k.algorithm}:${k.status}`).join(","),
          oauth_config_http: cfg.status,
        }),
      );

      const fnUrl = `${s.url}/functions/v1/mcp`;
      const authBase = `${s.url}/auth/v1`;
      // The first call after a deploy can lag; wait for a non-5xx challenge.
      let disc = await discover(fnUrl);
      for (let i = 0; i < 12 && disc.challengeStatus >= 500; i++) {
        await Bun.sleep(5_000);
        disc = await discover(fnUrl);
      }

      // K06.02 challenge and discovery
      const asm = disc.asMetadata ?? {};
      const methods = (asm.code_challenge_methods_supported as string[] | undefined)?.join(",") ?? "absent";
      results.push(
        mk(
          "K06.02",
          "unauthenticated call is challenged (401 + resource_metadata) and discovery reaches the project's authorization server",
          disc.challengeStatus === 401 && !!disc.resourceMetadataUrl && !!disc.resourceMetadata?.authorization_servers?.length && !!asm.registration_endpoint,
          undefined,
          {
            challenge_http: disc.challengeStatus,
            www_authenticate_scheme: disc.wwwAuthenticate.split(" ")[0] ?? "",
            resource_metadata_in_header: disc.resourceMetadataUrl ? 1 : 0,
            authorization_servers: disc.resourceMetadata?.authorization_servers?.length ?? 0,
            as_metadata_found: disc.asMetadataUrl ? 1 : 0,
            registration_endpoint: asm.registration_endpoint ? 1 : 0,
            pkce_methods: methods,
          },
        ),
      );
      if (!asm.registration_endpoint || !asm.authorization_endpoint || !asm.token_endpoint) {
        results.push(mk("K06.03", "client registration and token flow", false, "authorization-server metadata incomplete; later checks skipped"));
        return results;
      }

      // K06.03 dynamic client registration, two clients
      const regA = await registerClient(String(asm.registration_endpoint), "k06-client-a");
      const regB = await registerClient(String(asm.registration_endpoint), "k06-client-b");
      results.push(
        mk("K06.03", "dynamic client registration for two public clients", !!regA.clientId && !!regB.clientId && regA.clientId !== regB.clientId, undefined, {
          reg_a_http: regA.status,
          reg_b_http: regB.status,
          distinct_client_ids: regA.clientId && regB.clientId && regA.clientId !== regB.clientId ? 1 : 0,
        }),
      );
      if (!regA.clientId || !regB.clientId) return results;

      // K06.04 code flow: alice, bob, carol with client A; alice with client B
      const emails = { alice: "alice@example.com", bob: "bob@example.com", carol: "carol@example.com" };
      const tokens: Record<string, string> = {};
      const flowNotes: string[] = [];
      const run = async (key: string, email: string, clientId: string) => {
        const userToken = await passwordToken(s!, email);
        const f = await authorize({
          authorizationEndpoint: String(asm.authorization_endpoint),
          tokenEndpoint: String(asm.token_endpoint),
          authBase,
          publishableKey: s!.publishableKey,
          userToken,
          clientId,
          resource: disc.resourceMetadata?.resource as string | undefined,
        });
        if (f.token) tokens[key] = f.token;
        else flowNotes.push(`${key}: ${f.detail}`);
      };
      await run("alice_a", emails.alice, regA.clientId);
      await run("bob_a", emails.bob, regA.clientId);
      await run("carol_a", emails.carol, regA.clientId);
      await run("alice_b", emails.alice, regB.clientId);
      const ca = tokens.alice_a ? claimsOf(tokens.alice_a) : {};
      const ha = tokens.alice_a ? headerOf(tokens.alice_a) : {};
      const cb = tokens.alice_b ? claimsOf(tokens.alice_b) : {};
      const issued = Object.keys(tokens).length;
      results.push(
        mk("K06.04", "headless OAuth code flow (PKCE) issues a token per user and client", issued === 4 && ca.client_id === regA.clientId && cb.client_id === regB.clientId, flowNotes.join("; ") || undefined, {
          tokens_issued: issued,
          client_id_claim_matches_a: ca.client_id === regA.clientId ? 1 : 0,
          client_id_claim_matches_b: cb.client_id === regB.clientId ? 1 : 0,
          alg: String(ha.alg ?? "absent"),
          aud: String(ca.aud ?? "absent"),
          scope: String(ca.scope ?? "absent"),
          role_claim: String(ca.role ?? "absent"),
          claim_names: Object.keys(ca).sort().join(","),
          expires_in_s: typeof ca.exp === "number" && typeof ca.iat === "number" ? ca.exp - ca.iat : "absent",
        }),
      );
      if (issued < 4) return results;

      const client = async (token: string): Promise<McpClient> => {
        const c = new McpClient({ url: fnUrl, headers: { Authorization: `Bearer ${token}` }, capabilities: {}, name: "k06" });
        const init = await c.initialize();
        if (init.error || init.http >= 300) throw new Error(`initialize: http ${init.http} ${init.error?.message ?? ""}`);
        return c;
      };
      const call = async (token: string, tool: string, args: Record<string, unknown> = {}) => {
        const c = await client(token);
        return c.callTool(tool, args);
      };

      // K06.05 tools
      const cA = await client(tokens.alice_a!);
      const list = await cA.listTools();
      const names = ((list.result?.tools ?? []) as { name?: string }[]).map((t) => t.name ?? "").sort();
      results.push(
        mk("K06.05", "tools/list over the OAuth token", ["whoami", "list_purchase_requests", "decide_purchase_request", "list_client_notes"].every((n) => names.includes(n)), undefined, {
          tools: names.join(","),
          server_name: String(cA.serverInfo.name ?? ""),
          protocol: cA.protocolVersion,
        }),
      );

      // K06.06 whoami as alice through client A
      const who = (toolStructured(await call(tokens.alice_a!, "whoami")) ?? {}) as { id?: string; role?: string; client_id?: string | null; email?: string };
      results.push(
        mk("K06.06", "whoami through an OAuth token returns the user and the client_id", who.id === ca.sub && who.client_id === regA.clientId, undefined, {
          id_matches_sub: who.id === ca.sub ? 1 : 0,
          client_id_matches_a: who.client_id === regA.clientId ? 1 : 0,
          role: String(who.role ?? "absent"),
        }),
      );

      // K06.07 per-user RLS: department visibility through the tool
      const truth = await ownerRows(ctx, s.ref, "select count(*)::int as n from public.purchase_requests");
      const aliceRows = (toolStructured(await call(tokens.alice_a!, "list_purchase_requests")) ?? {}) as { count?: number; rows?: { id: string }[] };
      const carolRows = (toolStructured(await call(tokens.carol_a!, "list_purchase_requests")) ?? {}) as { count?: number; rows?: { id: string }[] };
      const overlap = (aliceRows.rows ?? []).filter((r) => (carolRows.rows ?? []).some((c) => c.id === r.id)).length;
      results.push(
        mk("K06.07", "list_purchase_requests returns each user's own department only (alice Sales 2, carol Marketing 1)", aliceRows.count === 2 && carolRows.count === 1 && overlap === 0, undefined, {
          rows_in_table: Number(truth[0]?.n ?? -1),
          alice_sees: aliceRows.count ?? -1,
          carol_sees: carolRows.count ?? -1,
          overlap,
        }),
      );

      // K06.08 write path through the tool: employee refused, manager of the same department allowed, manager of another department refused
      await sql(ctx, s.ref, "update public.purchase_requests set status = 'pending', decided_by = null, decided_at = null, decision_note = null"); // re-runs on an adopted project
      const rid = aliceRows.rows?.[0]?.id ?? "";
      const byAlice = await call(tokens.alice_a!, "decide_purchase_request", { request_id: rid, decision: "approved" });
      const carolReq = carolRows.rows?.[0]?.id ?? "";
      const byBobOther = await call(tokens.bob_a!, "decide_purchase_request", { request_id: carolReq, decision: "approved" });
      const byBob = await call(tokens.bob_a!, "decide_purchase_request", { request_id: rid, decision: "approved" });
      const after = await ownerRows(ctx, s.ref, `select id, status from public.purchase_requests where id in ('${rid}', '${carolReq}')`);
      const st = (id: string) => String(after.find((r) => r.id === id)?.status ?? "absent");
      results.push(
        mk(
          "K06.08",
          "decide_purchase_request: employee refused, same-department manager approves, other-department manager refused",
          byAlice.result?.isError === true && byBobOther.result?.isError === true && byBob.result?.isError !== true && st(rid) === "approved" && st(carolReq) === "pending",
          undefined,
          {
            employee_is_error: byAlice.result?.isError === true ? 1 : 0,
            employee_text: toolText(byAlice).slice(0, 80),
            other_dept_manager_is_error: byBobOther.result?.isError === true ? 1 : 0,
            same_dept_manager_ok: byBob.result?.isError !== true ? 1 : 0,
            alice_request_status_after: st(rid),
            carol_request_status_after: st(carolReq),
          },
        ),
      );

      // K06.09 client_id reaches RLS: rows tagged per client
      await sql(ctx, s.ref, "truncate public.mcp_notes");
      await sql(
        ctx,
        s.ref,
        `insert into public.mcp_notes (client_id, note) values (null, 'unscoped'), ('${regA.clientId}', 'note-for-a'), ('${regB.clientId}', 'note-for-b')`,
      );
      const notes = async (t: string) => ((toolStructured(await call(t, "list_client_notes")) ?? {}) as { notes?: string[] }).notes ?? ["<error>"];
      const nA = await notes(tokens.alice_a!);
      const nB = await notes(tokens.alice_b!);
      const nBobA = await notes(tokens.bob_a!);
      results.push(
        mk("K06.09", "client_id claim scopes rows: client A sees note-for-a only, client B note-for-b only (same user)", nA.join() === "note-for-a" && nB.join() === "note-for-b" && nBobA.join() === "note-for-a", undefined, {
          alice_client_a: nA.join("|"),
          alice_client_b: nB.join("|"),
          bob_client_a: nBobA.join("|"),
        }),
      );

      // K06.10 product session token (embedded-agent path): accepted, no client_id, sees the unscoped row
      const session = await passwordToken(s, emails.alice);
      let sessionDetail: string | undefined;
      let wsess: { client_id?: string | null; id?: string } = {};
      let nSess: string[] = [];
      try {
        wsess = (toolStructured(await call(session, "whoami")) ?? {}) as typeof wsess;
        nSess = await notes(session);
      } catch (e) {
        sessionDetail = (e as Error).message;
      }
      results.push(
        mk("K06.10", "a password-session access token (no OAuth) is accepted: client_id null, only unscoped rows", wsess.client_id === null && nSess.join() === "unscoped", sessionDetail, {
          client_id: wsess.client_id === null ? "null" : String(wsess.client_id ?? "n/a"),
          notes_visible: nSess.join("|") || "none",
          session_alg: String(headerOf(session).alg ?? ""),
        }),
      );

      // K06.11 bearer values the block must refuse
      const legacyAnon = (await api(ctx, "GET", `/projects/${s.ref}/api-keys?reveal=true`)).json as { type?: string; name?: string; api_key?: string }[];
      const anonJwt = legacyAnon.find((k) => k.name === "anon")?.api_key ?? "";
      const probe = async (bearer: string): Promise<number> => {
        if (!bearer) return -1;
        const r = await http(fnUrl, {
          method: "POST",
          headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        });
        return r.status;
      };
      const pub = await probe(s.publishableKey);
      const anon = await probe(anonJwt);
      const garbage = await probe("not.a.jwt");
      const none = await probe("x");
      results.push(
        mk("K06.11", "publishable key, legacy anon key and garbage bearer values are refused", [pub, anon, garbage, none].every((c) => c === 401 || c === 403), undefined, {
          publishable_key_http: pub,
          legacy_anon_jwt_http: anon === -1 ? "no legacy key listed" : anon,
          garbage_http: garbage,
          single_char_http: none,
        }),
      );

      // K06.12 OAuth scopes do not limit database access: the same token, sent straight to the Data API, reads rows
      const direct = await http(`${s.url}/rest/v1/purchase_requests?select=id`, { headers: { apikey: s.publishableKey, Authorization: `Bearer ${tokens.alice_a}` } });
      const directRows = (json<unknown[]>(direct) ?? []) as unknown[];
      results.push(
        mk("K06.12", "the OAuth access token also works against the Data API (scope 'email' does not limit the database)", "info", undefined, {
          data_api_http: direct.status,
          rows_returned: directRows.length,
          scope_claim: String(ca.scope ?? "absent"),
        }),
      );
    } catch (e) {
      results.push(mk("K06.99", "aborted", false, (e as Error).message));
    } finally {
      const note = await teardown(ctx, s).catch((e) => `teardown error: ${(e as Error).message}`);
      ctx.log(`teardown: ${note}`);
      results.push(mk("K06.teardown", "project removed", "info", note));
    }
    return results;
  },
};

export default mod;
