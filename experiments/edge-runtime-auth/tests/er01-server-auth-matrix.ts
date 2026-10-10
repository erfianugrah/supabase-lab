/**
 * ER01 - @supabase/server auth modes x credential types, on an Edge Function
 * and on the Workers runtime.
 *
 * The package documents five ways to configure `auth` (none, user, secret,
 * publishable, ['user','secret']) and says a request is refused before the
 * handler body runs. This module deploys one handler per mode, sends fourteen
 * credential presentations at each, and records for every cell the HTTP status,
 * whether the handler ran, and which layer refused (the library, flagged by
 * its x-supabase-server-error header, or the platform gateway).
 *
 * Targets (one TestResult per mode per target):
 *   ER01-ef-<mode>     Edge Function, verify_jwt=false (the documented setting
 *                      for any mode other than 'user')
 *   ER01-efvj-<mode>   the same code, verify_jwt=true: shows the gateway layer
 *                      in front of the library. Recorded as `info`: the package
 *                      docs do not claim a gateway behaviour.
 *   ER01-wk<env>-<mode> the Worker bundle on workerd in a container, with the
 *                      library reading env from process.env (auto), from
 *                      explicit overrides (ovr) or overrides plus inline JWKS
 *                      (jwks). NOT a Cloudflare deployment.
 *   ER01-cf<env>-<mode> the same bundle deployed to Cloudflare Workers
 *                      (workers.dev), same three env paths, run only when
 *                      CLOUDFLARE_WORKERS_TOKEN and CLOUDFLARE_ACCOUNT_ID are
 *                      set and `wrangler` is on PATH. One Worker script serves
 *                      the three paths (selected by ?env=); it is deleted in
 *                      finally and the account's script list is re-read.
 *
 * Fixtures are real: the user tokens come from the project's own Auth (the
 * expired one from a jwt_exp=300 window and a wait), the third-party token is
 * signed by an issuer registered through the Management API, the legacy HS256
 * token is signed with the project's shared JWT secret.
 *
 * Self-provisions one Pro-org project and deletes it in finally.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";
import { mgmt } from "../../../harness/src/mgmt";
import { sql } from "../../../harness/src/platform";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { deployViaApi } from "../../edge-function-limits/lib/ef";
import { adminCreateUser, deleteTpa, generateIdp, mint, passwordGrant, publishJwks, registerTpa } from "../../third-party-auth/lib/idp";
import { PREFIX, cell, createProject, decodeJwt, deleteProject, mintHs256, probe, projectCtx, revealKeys, sleep, waitProjectReady, type Keys } from "../lib/er";
import { CREDENTIALS, MODES, headersFor, verdict, type Mode, type TokenBag } from "../lib/matrix";
import { cfAuthFromEnv, deployWorker, listScripts, wranglerAvailable, type CfWorker } from "../lib/cfworker";
import { startWorkerd, type Workerd } from "../lib/workerd";

const DIR = join(import.meta.dir, "..");
const SHORT_EXP_S = 300;

async function serverVersion(): Promise<string> {
  const pkg = JSON.parse(await readFile(join(DIR, "node_modules/@supabase/server/package.json"), "utf8")) as { version: string };
  return pkg.version;
}

async function setJwtExp(ctx: Ctx, seconds: number): Promise<{ status: number; readback: number }> {
  const patch = await mgmt(ctx, "PATCH", `/projects/${ctx.ref}/config/auth`, { jwt_exp: seconds });
  let readback = -1;
  for (let i = 0; i < 12; i++) {
    const g = await mgmt(ctx, "GET", `/projects/${ctx.ref}/config/auth`);
    readback = Number((g.json as { jwt_exp?: number } | undefined)?.jwt_exp ?? -1);
    if (readback === seconds) break;
    await sleep(5_000);
  }
  return { status: patch.status, readback };
}

async function signIn(ctx: Ctx, keys: Keys, email: string, password: string): Promise<string> {
  for (let i = 0; i < 6; i++) {
    const g = await passwordGrant(ctx, keys.publishable, email, password);
    if (g.token) return g.token;
    await sleep(5_000);
  }
  return "";
}

const lifetimeOf = (token: string): number => {
  const p = decodeJwt(token).payload;
  return Number(p.exp) - Number(p.iat);
};

/**
 * A readback of jwt_exp from the Management API is not the setting taking
 * effect in Auth: sign in repeatedly until a token carries the wanted lifetime.
 */
async function signInWithLifetime(ctx: Ctx, keys: Keys, email: string, password: string, wantS: number, maxMs = 240_000): Promise<{ token: string; effectiveAfterS: number }> {
  const t0 = Date.now();
  let token = "";
  while (Date.now() - t0 < maxMs) {
    token = await signIn(ctx, keys, email, password);
    if (token && lifetimeOf(token) === wantS) return { token, effectiveAfterS: Math.round((Date.now() - t0) / 1000) };
    await sleep(10_000);
  }
  return { token: "", effectiveAfterS: -1 };
}

/** A reachable Docker daemon is a precondition of the Workers leg only. */
async function dockerAvailable(): Promise<boolean> {
  try {
    return (await $`docker info`.quiet().nothrow()).exitCode === 0;
  } catch {
    return false;
  }
}

const mod: TestModule = {
  id: "ER01",
  title: "@supabase/server auth mode x credential matrix (Edge Function, Workers runtime)",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(base: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];
    const org = base.orgs.pro ?? "";
    if (!org) return [{ id: "ER01", title: this.title, status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    // Probe before the project exists: a missing tool must not cost a paid project.
    const haveDocker = await dockerAvailable();
    const cfAuth = cfAuthFromEnv();
    const haveCf = Boolean(cfAuth) && (await wranglerAvailable());
    // The pinned @supabase/server is bundled into the Worker and its version is read from node_modules.
    await $`bun install --cwd ${DIR}`.quiet();
    let ref = "";
    let tpaId = "";
    let ctx = base;
    let worker: Workerd | undefined;
    let cfWorker: CfWorker | undefined;
    let cfName = "";
    let cfNote = "";
    try {
      // ---- project ----
      const created = await createProject(base, org, "er01");
      ref = created.ref;
      if (created.status !== 201 || !ref) {
        return [{ id: "ER01", title: this.title, status: "fail", detail: `create HTTP ${created.status}: ${created.text}` }];
      }
      ctx = projectCtx(base, ref);
      const ready = await waitProjectReady(ctx, ref);
      if (!ready.ok) throw new Error(`project not ready: ${ready.status}`);
      const keys = await revealKeys(ctx);
      const version = await serverVersion();

      // ---- fixtures: real user tokens (short-lived one first) ----
      const email = `er01-${Date.now()}@example.com`;
      const password = `Pw-${crypto.randomUUID()}`;
      const created2 = await adminCreateUser(ctx, keys.service, email, password);
      const shortCfg = await setJwtExp(ctx, SHORT_EXP_S);
      const shortTok = await signInWithLifetime(ctx, keys, email, password, SHORT_EXP_S);
      const expiring = shortTok.token;
      if (!expiring) throw new Error(`jwt_exp=${SHORT_EXP_S} never took effect in issued tokens (user create HTTP ${created2})`);
      const restoreCfg = await setJwtExp(ctx, 3600);
      const longTok = await signInWithLifetime(ctx, keys, email, password, 3600);
      const user = longTok.token;
      if (!user) throw new Error("jwt_exp restore never took effect in issued tokens");
      const ex = decodeJwt(expiring);
      const us = decodeJwt(user);
      const expExpiring = Number(ex.payload.exp);
      const lifetime = (t: ReturnType<typeof decodeJwt>) => Number(t.payload.exp) - Number(t.payload.iat);

      // legacy HS256 user-shaped token under the shared JWT secret (no kid)
      const pg = await mgmt(ctx, "GET", `/projects/${ref}/postgrest`);
      const jwtSecret = String((pg.json as { jwt_secret?: string } | undefined)?.jwt_secret ?? "");
      const nowS = Math.floor(Date.now() / 1000);
      const hs256 = jwtSecret
        ? mintHs256(jwtSecret, { sub: us.payload.sub, role: "authenticated", aud: "authenticated", iat: nowS, exp: nowS + 3600, iss: `https://${ctx.apiHost}/auth/v1` })
        : "";
      const foreignIdp = await generateIdp();
      const foreign = await mint(foreignIdp, { sub: crypto.randomUUID(), iss: "https://issuer.invalid" });

      // ---- functions ----
      const src = (await readFile(join(DIR, "functions/matrix.ts"), "utf8")).replaceAll("__SERVER_VERSION__", version);
      const deploys: string[] = [];
      for (const [slug, vj] of [["er-matrix", false], ["er-matrix-vj", true]] as const) {
        const d = await deployViaApi(ctx, slug, [{ name: "index.ts", content: src }], { entrypoint_path: "index.ts", name: slug, verify_jwt: vj });
        deploys.push(`${slug}:${d.status}`);
      }
      const efUrl = (slug: string) => `https://${ctx.apiHost}/functions/v1/${slug}`;
      let envBody = "";
      for (let i = 0; i < 24; i++) {
        const r = await fetch(`${efUrl("er-matrix")}?mode=_env`).catch(() => null);
        if (r?.status === 200) {
          envBody = await r.text();
          break;
        }
        await sleep(5_000);
      }
      const envJson = (envBody ? JSON.parse(envBody) : {}) as Record<string, unknown>;
      out.push({
        id: "ER01-setup",
        title: "ER01 setup: self-provisioned project, fixtures, runtime-injected variables",
        status: envBody ? "pass" : "fail",
        detail: `project healthy in ${ready.seconds}s after create ${created.createMs}ms; @supabase/server ${version}; deploys ${deploys.join(",")}`,
        measurements: {
          server_version: version,
          api_keys_present: "legacy anon+service_role, publishable, secret",
          user_token_alg: String(us.header.alg),
          user_token_has_kid: us.header.kid ? 1 : 0,
          jwt_exp_short_patch_status: shortCfg.status,
          jwt_exp_short_readback: shortCfg.readback,
          jwt_exp_restore_readback: restoreCfg.readback,
          short_lifetime_effective_after_s: shortTok.effectiveAfterS,
          restore_lifetime_effective_after_s: longTok.effectiveAfterS,
          short_token_lifetime_s: lifetime(ex),
          user_token_lifetime_s: lifetime(us),
          legacy_jwt_secret_available: jwtSecret ? 1 : 0,
          ef_env_publishable_key_names: JSON.stringify(envJson.publishable_keys_names ?? null),
          ef_env_secret_key_names: JSON.stringify(envJson.secret_keys_names ?? null),
          ef_env_jwks_set: String(envJson.jwks_set ?? "unread"),
          ef_env_jwks_key_types: JSON.stringify(envJson.jwks_key_types ?? null),
          ef_env_singular_keys_set: String(Boolean(envJson.singular_publishable_set) || Boolean(envJson.singular_secret_set)),
        },
        evidence: envBody.slice(0, 500),
      });
      if (!envBody) throw new Error("matrix function never answered _env");

      // ---- third-party issuer registered on the project ----
      const idp = await generateIdp();
      const jwksSlug = "er-tpa-jwks";
      const pub = await publishJwks(ctx, jwksSlug, idp.publicJwk);
      const tOffer = Date.now();
      const reg = pub.ok ? await registerTpa(ctx, pub.url) : { status: 0, id: "", body: `jwks not served ${pub.status}` };
      tpaId = reg.id;
      const tpa = await mint(idp, { sub: crypto.randomUUID(), iss: pub.url });
      // gateway acceptance of the new issuer: verify_jwt=true, mode none, TPA token as the only credential
      let gatewayAcceptedS: number | string = "never";
      for (let i = 0; i < 24 && tpaId; i++) {
        const o = await probe(`${efUrl("er-matrix-vj")}?mode=none`, { Authorization: `Bearer ${tpa}` });
        if (o.ran) {
          gatewayAcceptedS = Math.round((Date.now() - tOffer) / 1000);
          break;
        }
        await sleep(5_000);
      }
      // control: does the data API accept the third-party token at all? (fixture check, as in the third-party-auth experiment)
      await sql(ctx, "create table if not exists public.er_probe (id int primary key)");
      await sql(ctx, "insert into public.er_probe values (1) on conflict do nothing");
      await sql(ctx, "alter table public.er_probe enable row level security");
      await sql(ctx, "create policy er_probe_read on public.er_probe for select to authenticated using (true)");
      await sql(ctx, "notify pgrst, 'reload schema'");
      let dataApi = 0;
      for (let i = 0; i < 24 && tpaId; i++) {
        const r = await fetch(`https://${ctx.apiHost}/rest/v1/er_probe?select=id`, { headers: { apikey: keys.publishable, Authorization: `Bearer ${tpa}` }, signal: AbortSignal.timeout(15_000) }).catch(() => null);
        dataApi = r?.status ?? 0;
        if (dataApi === 200) break;
        await sleep(5_000);
      }
      out.push({
        id: "ER01-tpa",
        title: "ER01 fixture: third-party issuer registered; gateway acceptance of its token",
        status: tpaId ? "pass" : "fail",
        detail: `register -> HTTP ${reg.status}; Edge Function gateway (verify_jwt=true) accepted the token: ${gatewayAcceptedS === "never" ? "not within 120 s" : `after ${gatewayAcceptedS} s`}; data API (PostgREST) answered ${dataApi}`,
        measurements: { register_status: reg.status, gateway_accepted_after_s: gatewayAcceptedS, data_api_status_for_tpa_token: dataApi },
      });

      // ---- Worker runtime ----
      // the project's published JWKS, fetched here (public keys) for the inline-JWKS Worker path
      const jwksUrl = `https://${ctx.apiHost}/auth/v1/.well-known/jwks.json`;
      const hostJwksNoKey = await fetch(jwksUrl, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
      const hostJwksKey = await fetch(jwksUrl, { headers: { apikey: keys.publishable }, signal: AbortSignal.timeout(15_000) }).catch(() => null);
      const jwksText = hostJwksKey?.status === 200 ? await hostJwksKey.text() : hostJwksNoKey?.status === 200 ? await hostJwksNoKey.text() : "";
      const vars: Record<string, string> = { SUPABASE_URL: `https://${ctx.apiHost}`, SUPABASE_PUBLISHABLE_KEY: keys.publishable, SUPABASE_SECRET_KEY: keys.secret, ...(jwksText ? { ER_JWKS: jwksText } : {}) };
      let workerNote = "";
      if (haveDocker) {
        try {
          worker = await startWorkerd(DIR, vars, "er01-workerd");
        } catch (e) {
          workerNote = e instanceof Error ? e.message : String(e);
        }
      }

      if (haveCf && cfAuth) {
        cfName = `${PREFIX}er01-cf-${Date.now()}`;
        try {
          cfWorker = await deployWorker(DIR, cfAuth, vars, cfName);
        } catch (e) {
          cfNote = e instanceof Error ? e.message : String(e);
        }
      }

      // JWKS reachability: host vantage and from inside the Workers runtime
      let workerJwks = haveDocker ? "worker not started" : "worker skipped (docker not available)";
      if (worker) {
        const wr = await fetch(`${worker.baseUrl}/?mode=_jwks`, { signal: AbortSignal.timeout(30_000) }).catch(() => null);
        workerJwks = wr ? (await wr.text()).slice(0, 400) : "no response";
      }
      out.push({
        id: "ER01-jwks",
        title: "ER01 JWKS endpoint: reachable without an apikey, from this host and from the Workers runtime",
        status: "info",
        detail: `GET /auth/v1/.well-known/jwks.json from this host: no apikey -> ${hostJwksNoKey?.status ?? 0}, publishable apikey -> ${hostJwksKey?.status ?? 0}`,
        measurements: { host_no_apikey_status: hostJwksNoKey?.status ?? 0, host_with_apikey_status: hostJwksKey?.status ?? 0, inline_jwks_available: jwksText ? 1 : 0 },
        evidence: `worker _jwks: ${workerJwks}`,
      });

      // The deployed Worker's runtime facts and its JWKS reach, from Cloudflare's network.
      if (cfWorker) {
        const rt = await fetch(`${cfWorker.baseUrl}/?mode=_runtime`, { signal: AbortSignal.timeout(30_000) }).then((r) => r.text()).catch(() => "no response");
        const jw = await fetch(`${cfWorker.baseUrl}/?mode=_jwks`, { signal: AbortSignal.timeout(30_000) }).then((r) => r.text()).catch(() => "no response");
        out.push({
          id: "ER01-cfsetup",
          title: "ER01 Cloudflare Worker: deployed, runtime facts, JWKS reach from Cloudflare's network",
          status: "info",
          detail: `deployed ${cfWorker.name} to workers.dev; first 200 ${cfWorker.readyAfterS} s after the deploy command started`,
          measurements: { ready_after_s: cfWorker.readyAfterS },
          evidence: `_runtime: ${rt.slice(0, 300)}
_jwks: ${jw.slice(0, 400)}`,
        });
      }

      // ---- expiry boundary: probe the short token against 'user' mode around its exp ----
      const bag: TokenBag = { anon: keys.anon, service: keys.service, publishable: keys.publishable, secret: keys.secret, user, expired: expiring, tpa, foreign, hs256 };
      const boundary: string[] = [];
      let lastAccepted = Number.NaN;
      let firstRefused = Number.NaN;
      const windowStart = expExpiring - 20;
      const windowEnd = expExpiring + 30;
      while (Date.now() / 1000 < windowEnd) {
        const nowSec = Date.now() / 1000;
        if (nowSec >= windowStart) {
          const o = await probe(`${efUrl("er-matrix")}?mode=user`, { Authorization: `Bearer ${expiring}` });
          const off = Math.round((nowSec - expExpiring) * 10) / 10;
          boundary.push(`${off}s:${o.ran ? "ran" : o.serverError || o.status}`);
          if (o.ran) lastAccepted = off;
          else if (Number.isNaN(firstRefused)) firstRefused = off;
          await sleep(4_000);
        } else {
          await sleep(Math.min(5_000, (windowStart - nowSec) * 1000));
        }
      }
      out.push({
        id: "ER01-expiry",
        title: "ER01 expiry: when the library stops accepting a real token (user mode, Edge Function)",
        status: Number.isNaN(firstRefused) ? "fail" : "pass",
        detail: `offsets are seconds from the token's exp on this machine's clock; last accepted ${Number.isNaN(lastAccepted) ? "none seen" : lastAccepted}, first refused ${Number.isNaN(firstRefused) ? "none seen" : firstRefused}`,
        measurements: { last_accepted_offset_s: Number.isNaN(lastAccepted) ? "none" : lastAccepted, first_refused_offset_s: Number.isNaN(firstRefused) ? "none" : firstRefused, probes: boundary.length },
        evidence: boundary.join(" "),
      });

      // ---- matrices ----
      let jwksFailBody = "";
      const runMatrix = async (id: string, title: string, target: string, mk: (mode: Mode) => string, gated: boolean) => {
        for (const mode of MODES) {
          const m: Record<string, number | string> = {};
          const lines: string[] = [];
          let mismatches = 0;
          let undoc = 0;
          for (const cred of CREDENTIALS) {
            const o = await probe(mk(mode), headersFor(cred, bag));
            if (!jwksFailBody && o.serverError === "JWKS_FETCH_FAILED") jwksFailBody = o.body;
            const v = verdict(mode, cred, o.ran);
            if (v === "MISMATCH") mismatches++;
            if (v === "undoc") undoc++;
            m[cred] = cell(o);
            lines.push(`${cred.padEnd(22)} ${cell(o).padEnd(34)} ${v}`);
          }
          m.docs_mismatches = mismatches;
          m.docs_silent_cells = undoc;
          out.push({
            id: `${id}-${mode}`,
            title: `${title}: auth ${mode === "user_secret" ? "['user','secret']" : `'${mode}'`}`,
            status: gated ? "info" : mismatches ? "fail" : "pass",
            detail: `${target}: ${mismatches} cell(s) differ from the package docs, ${undoc} cell(s) the docs do not cover`,
            measurements: m,
            evidence: lines.join("\n"),
          });
        }
      };
      await runMatrix("ER01-ef", "Edge Function verify_jwt=false", "Edge Function, verify_jwt=false", (mode) => `${efUrl("er-matrix")}?mode=${mode}`, false);
      await runMatrix("ER01-efvj", "Edge Function verify_jwt=true", "Edge Function, verify_jwt=true (gateway in front)", (mode) => `${efUrl("er-matrix-vj")}?mode=${mode}`, true);
      if (cfWorker) {
        const c = cfWorker;
        await runMatrix("ER01-cfauto", "Cloudflare Workers, env via process.env", "Cloudflare Workers (workers.dev), env auto-detected", (mode) => `${c.baseUrl}/?mode=${mode}&env=auto`, false);
        await runMatrix("ER01-cfovr", "Cloudflare Workers, env via overrides", "Cloudflare Workers (workers.dev), env overrides", (mode) => `${c.baseUrl}/?mode=${mode}&env=override`, false);
        if (jwksText) await runMatrix("ER01-cfjwks", "Cloudflare Workers, overrides plus inline JWKS", "Cloudflare Workers (workers.dev), env overrides with inline JWKS", (mode) => `${c.baseUrl}/?mode=${mode}&env=jwks`, false);
      } else if (cfAuth) {
        out.push({ id: "ER01-cf", title: "ER01 Cloudflare Workers matrix", status: haveCf ? "fail" : "skip", detail: haveCf ? `deploy failed: ${cfNote}` : "wrangler not on PATH" });
      }
      if (worker) {
        const w = worker;
        await runMatrix("ER01-wkauto", "Workers runtime (workerd), env via process.env", "workerd, env auto-detected", (mode) => `${w.baseUrl}/?mode=${mode}&env=auto`, false);
        await runMatrix("ER01-wkovr", "Workers runtime (workerd), env via overrides", "workerd, env overrides", (mode) => `${w.baseUrl}/?mode=${mode}&env=override`, false);
        if (jwksText) await runMatrix("ER01-wkjwks", "Workers runtime (workerd), overrides plus inline JWKS", "workerd, env overrides with inline JWKS", (mode) => `${w.baseUrl}/?mode=${mode}&env=jwks`, false);
        if (jwksFailBody) out.push({ id: "ER01-jwksfail", title: "ER01 first JWKS_FETCH_FAILED response body from the Workers runtime", status: "info", detail: "body of the first library refusal with code JWKS_FETCH_FAILED", evidence: jwksFailBody });
      } else if (!haveDocker) {
        out.push({ id: "ER01-wk", title: "ER01 Workers runtime matrix", status: "skip", detail: "docker not available (`docker info` failed); the Workers leg needs a container runtime, the Edge Function legs ran" });
      } else {
        out.push({ id: "ER01-wk", title: "ER01 Workers runtime matrix", status: "fail", detail: `workerd container did not start: ${workerNote}` });
      }
    } catch (e) {
      out.push({ id: "ER01", title: this.title, status: "fail", detail: `threw: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      const notes: string[] = [];
      await worker?.stop().catch(() => null);
      if (cfAuth && cfName) {
        const del = cfWorker ? await cfWorker.stop().catch(() => ({ deleteStatus: 0 })) : { deleteStatus: -1 };
        const left = (await listScripts(cfAuth).catch(() => [] as string[])).filter((n) => n.startsWith(PREFIX));
        notes.push(`worker delete ${del.deleteStatus === -1 ? "not deployed" : del.deleteStatus}; scripts on the account with the prefix after teardown: ${left.length}`);
      }
      if (tpaId) notes.push(`tpa delete ${await deleteTpa(ctx, tpaId)}`);
      if (ref) notes.push(`project delete ${await deleteProject(base, ref)}`);
      out.push({ id: "ER01z", title: `ER01 cleanup: project (${PREFIX}er01-*), issuer, workerd container, Cloudflare Worker`, status: "info", detail: notes.join("; ") });
    }
    return out;
  },
};

export default mod;
