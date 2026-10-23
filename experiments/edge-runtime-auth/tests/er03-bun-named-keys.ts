/**
 * ER03 - @supabase/server on a Bun server, and the named-key auth syntax.
 *
 * ER01 ran the five auth modes x fourteen credential presentations on an Edge
 * Function and on the Workers runtime. This module adds two things:
 *
 *   1. A Bun server (Bun.serve on loopback, this machine) running the same
 *      handlers against a real project, in three env configurations, each its
 *      own process with a clean environment:
 *        bunsing  SUPABASE_URL + singular SUPABASE_PUBLISHABLE_KEY /
 *                 SUPABASE_SECRET_KEY (the docs' minimal non-Supabase setup);
 *                 no JWKS variable, so the library derives the JWKS URL
 *        bunplur  SUPABASE_URL + plural SUPABASE_PUBLISHABLE_KEYS /
 *                 SUPABASE_SECRET_KEYS holding `default` and one named key each
 *        bunovr   no SUPABASE_* variable; url, both key sets and the project's
 *                 JWKS passed inline through the `env` option
 *   2. The named-key forms (`publishable:<name>`, `publishable:*`, a name not
 *      configured, the same for `secret`, and two arrays) against a project
 *      that holds one extra publishable key and one extra secret key, on the
 *      three Bun configurations and on an Edge Function, whose key sets the
 *      platform injects. The Edge Function is deployed before the extra keys
 *      exist, so the module also records whether and when the running
 *      deployment sees them, and redeploys if it does not.
 *
 * Every matrix is run ER_PASSES times (default 2) per target; a cell whose
 * text differs between passes is reported. Each cell keeps the response body
 * (key and token values replaced by labels).
 *
 * Not covered: Vercel (needs an account and a token this lab does not hold),
 * Bun behind any proxy or platform, a request rate.
 *
 * Self-provisions one Pro-org project and deletes it in finally. If
 * ER_REFS_FILE is set, the created ref is appended to it (outside git).
 */
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";
import { mgmt } from "../../../harness/src/mgmt";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { deployViaApi } from "../../edge-function-limits/lib/ef";
import { adminCreateUser, deleteTpa, generateIdp, mint, passwordGrant, publishJwks, registerTpa } from "../../third-party-auth/lib/idp";
import { PREFIX, createProject, decodeJwt, deleteProject, mintHs256, projectCtx, revealKeys, sleep, waitProjectReady, type Keys } from "../lib/er";
import { CREDENTIALS, MODES, headersFor, verdict, type TokenBag } from "../lib/matrix";
import { AUTH_TABLE, DOCS_SHORT_NAME, EXTRA_PUBLISHABLE, EXTRA_SECRET, NAMED_CREDENTIALS, NAMED_MODES, namedHeaders, namedVerdict, passDiff, scrub, type NamedKeys } from "../lib/named";

const DIR = join(import.meta.dir, "..");
const SHORT_EXP_S = 300;
const PASSES = Math.max(1, Number(process.env.ER_PASSES ?? "2"));
const BODY_MAX = 1500;
const BUN_LABELS: Record<string, string> = {
  bunsing: "Bun, singular env vars",
  bunplur: "Bun, plural env vars with named keys",
  bunovr: "Bun, env override with named keys and inline JWKS",
};

interface Obs {
  status: number;
  ran: boolean;
  serverError: string;
  authMode: string;
  keyName: string;
  body: string;
}

async function probeFull(url: string, headers: Record<string, string>): Promise<Obs> {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      /* non-JSON body */
    }
    const ran = res.headers.get("x-er-handler") === "ran";
    return {
      status: res.status,
      ran,
      serverError: res.headers.get("x-supabase-server-error") ?? "",
      authMode: ran ? String(json.authMode ?? "") : "",
      keyName: ran && json.keyName != null ? String(json.keyName) : "",
      body: text.slice(0, BODY_MAX),
    };
  } catch (e) {
    return { status: 0, ran: false, serverError: "", authMode: "", keyName: "", body: `ERR:${(e instanceof Error ? e.message : String(e)).slice(0, 120)}` };
  }
}

/** "200 ran:secret/automations", "401 lib:INVALID_API_KEY", "401 gw:Invalid API key". */
function cellOf(o: Obs): string {
  if (o.ran) return `${o.status} ran:${o.authMode || "?"}${o.keyName ? `/${o.keyName}` : ""}`;
  if (o.serverError) return `${o.status} lib:${o.serverError}`;
  let msg = o.body.slice(0, 60);
  try {
    const j = JSON.parse(o.body) as Record<string, unknown>;
    msg = String(j.message ?? j.msg ?? j.error ?? msg).slice(0, 60);
  } catch {
    /* keep raw */
  }
  return `${o.status} ${o.status === 401 || o.status === 403 ? "gw" : "other"}:${msg}`;
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

const lifetimeOf = (token: string): number => {
  const p = decodeJwt(token).payload;
  return Number(p.exp) - Number(p.iat);
};

/** Sign in until a token carries the wanted lifetime (a jwt_exp readback is not the setting in force, ER01). */
async function signInWithLifetime(ctx: Ctx, apikey: string, email: string, password: string, wantS: number, maxMs = 240_000): Promise<{ token: string; effectiveAfterS: number }> {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const g = await passwordGrant(ctx, apikey, email, password);
    if (g.token && lifetimeOf(g.token) === wantS) return { token: g.token, effectiveAfterS: Math.round((Date.now() - t0) / 1000) };
    await sleep(10_000);
  }
  return { token: "", effectiveAfterS: -1 };
}

/** Create one extra API key of a kind under a name and return its revealed value. */
async function createNamedKey(ctx: Ctx, type: "publishable" | "secret", name: string): Promise<{ status: number; value: string; body: string }> {
  let r = await mgmt(ctx, "POST", `/projects/${ctx.ref}/api-keys?reveal=true`, { type, name });
  for (let i = 0; i < 6 && (r.throttled || r.status === 429); i++) {
    await sleep(15_000);
    r = await mgmt(ctx, "POST", `/projects/${ctx.ref}/api-keys?reveal=true`, { type, name });
  }
  const clean = (v: unknown) => (typeof v === "string" && /^[\x21-\x7e]+$/.test(v.trim()) ? v.trim() : "");
  let value = clean((r.json as { api_key?: unknown } | undefined)?.api_key);
  const id = String((r.json as { id?: unknown } | undefined)?.id ?? "");
  if (!value && id) {
    const g = await mgmt(ctx, "GET", `/projects/${ctx.ref}/api-keys/${id}?reveal=true`);
    value = clean((g.json as { api_key?: unknown } | undefined)?.api_key);
  }
  const message = (r.json as { message?: unknown } | undefined)?.message;
  return { status: r.status, value, body: typeof message === "string" ? message.slice(0, 300) : r.status < 300 ? "created" : r.text.slice(0, 120) };
}

interface BunProc {
  name: string;
  baseUrl: string;
  stop: () => Promise<void>;
}

/** Start server/bun.ts with exactly `vars` (plus PATH/HOME) as its environment; wait for its listening line. */
async function startBun(name: string, vars: Record<string, string>): Promise<BunProc> {
  const proc = Bun.spawn(["bun", "--no-env-file", "server/bun.ts"], {
    cwd: DIR,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ER_PORT: "0", ...vars },
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = proc.stdout.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const chunk = await Promise.race([reader.read(), sleep(1_000).then(() => null)]);
    if (chunk && !chunk.done) buf += dec.decode(chunk.value);
    const m = buf.match(/ER_LISTENING (\d+)/);
    if (m) {
      reader.releaseLock();
      return {
        name,
        baseUrl: `http://127.0.0.1:${m[1]}`,
        stop: async () => {
          proc.kill();
          await proc.exited;
        },
      };
    }
    if (chunk?.done) break;
  }
  proc.kill();
  const err = await new Response(proc.stderr).text().catch(() => "");
  throw new Error(`bun server ${name} did not start: ${buf.slice(0, 200)} ${err.slice(0, 300)}`);
}

const mod: TestModule = {
  id: "ER03",
  title: "@supabase/server on a Bun server, and the named-key auth syntax (Bun, Edge Function)",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(base: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];
    const org = base.orgs.pro ?? "";
    if (!org) return [{ id: "ER03", title: this.title, status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    await $`bun install --cwd ${DIR}`.quiet();
    const serverVersion = (JSON.parse(await readFile(join(DIR, "node_modules/@supabase/server/package.json"), "utf8")) as { version: string }).version;
    let ref = "";
    let tpaId = "";
    let ctx = base;
    const procs: BunProc[] = [];
    try {
      // ---- project ----
      const created = await createProject(base, org, "er03");
      ref = created.ref;
      if (ref && process.env.ER_REFS_FILE) await appendFile(process.env.ER_REFS_FILE, `${ref} ${PREFIX}er03 created ${new Date().toISOString()}\n`).catch(() => null);
      if (created.status !== 201 || !ref) return [{ id: "ER03", title: this.title, status: "fail", detail: `create HTTP ${created.status}: ${created.text}` }];
      ctx = projectCtx(base, ref);
      const ready = await waitProjectReady(ctx, ref);
      if (!ready.ok) throw new Error(`project not ready: ${ready.status}`);
      const keys: Keys = await revealKeys(ctx);
      const supaUrl = `https://${ctx.apiHost}`;

      // ---- short-lived user token first, so it expires while the rest is set up ----
      const email = `er03-${Date.now()}@example.com`;
      const password = `Pw-${crypto.randomUUID()}`;
      const userCreate = await adminCreateUser(ctx, keys.service, email, password);
      const shortCfg = await setJwtExp(ctx, SHORT_EXP_S);
      const shortTok = await signInWithLifetime(ctx, keys.publishable, email, password, SHORT_EXP_S);
      if (!shortTok.token) throw new Error(`jwt_exp=${SHORT_EXP_S} never took effect (user create HTTP ${userCreate})`);
      const restoreCfg = await setJwtExp(ctx, 3600);
      const longTok = await signInWithLifetime(ctx, keys.publishable, email, password, 3600);
      if (!longTok.token) throw new Error("jwt_exp restore never took effect in issued tokens");
      const expiredExp = Number(decodeJwt(shortTok.token).payload.exp);

      // ---- Edge Function, deployed before the extra keys exist ----
      const src = (await readFile(join(DIR, "functions/named.ts"), "utf8")).replaceAll("__SERVER_VERSION__", serverVersion).replaceAll("__AUTH_TABLE__", JSON.stringify(AUTH_TABLE));
      const slug = "er-named";
      const deploy = async () => deployViaApi(ctx, slug, [{ name: "index.ts", content: src }], { entrypoint_path: "index.ts", name: slug, verify_jwt: false });
      const d1 = await deploy();
      const efUrl = `${supaUrl}/functions/v1/${slug}`;
      let lastEnvMiss = "";
      const readEnv = async (): Promise<{ pub: string[]; sec: string[]; booted: string } | null> => {
        const r = await fetch(`${efUrl}?mode=_env`, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
        if (r?.status !== 200) {
          lastEnvMiss = `HTTP ${r?.status ?? 0} ${r ? (await r.text().catch(() => "")).slice(0, 200) : "no response"}`;
          return null;
        }
        const j = (await r.json().catch(() => null)) as { publishable_keys_names?: string[]; secret_keys_names?: string[]; booted_at?: string } | null;
        return j ? { pub: j.publishable_keys_names ?? [], sec: j.secret_keys_names ?? [], booted: j.booted_at ?? "" } : null;
      };
      let env0: Awaited<ReturnType<typeof readEnv>> = null;
      for (let i = 0; i < 24 && !env0; i++) {
        env0 = await readEnv();
        if (!env0) await sleep(5_000);
      }
      if (!env0) throw new Error(`er-named never answered _env (deploy HTTP ${d1.status}; last answer ${lastEnvMiss})`);

      // ---- extra named keys ----
      // the docs' example name, as written there
      const shortName = await createNamedKey(ctx, "publishable", DOCS_SHORT_NAME);
      const tKeys = Date.now();
      const pubNamed = await createNamedKey(ctx, "publishable", EXTRA_PUBLISHABLE);
      const secNamed = await createNamedKey(ctx, "secret", EXTRA_SECRET);
      if (!pubNamed.value || !secNamed.value) throw new Error(`named key create: publishable HTTP ${pubNamed.status} ${pubNamed.body}; secret HTTP ${secNamed.status} ${secNamed.body}`);
      const listing = await mgmt(ctx, "GET", `/projects/${ref}/api-keys`);
      const keyRows = (Array.isArray(listing.json) ? listing.json : []) as { name?: string; type?: string }[];
      const hasNamed = (e: { pub: string[]; sec: string[] } | null) => Boolean(e && e.pub.includes(EXTRA_PUBLISHABLE) && e.sec.includes(EXTRA_SECRET));

      // Does the running deployment see the new keys without a redeploy?
      const envPolls: string[] = [];
      let seenWithoutRedeployS: number | string = "not within 180 s";
      let lastEnv = env0;
      while (Date.now() - tKeys < 180_000) {
        const e = await readEnv();
        if (e) {
          lastEnv = e;
          envPolls.push(`${Math.round((Date.now() - tKeys) / 1000)}s:pub=[${e.pub.join(",")}] sec=[${e.sec.join(",")}] boot=${e.booted}`);
          if (hasNamed(e)) {
            seenWithoutRedeployS = Math.round((Date.now() - tKeys) / 1000);
            break;
          }
        }
        await sleep(10_000);
      }
      let redeploy = "not needed";
      let seenAfterRedeployS: number | string = "n/a";
      if (!hasNamed(lastEnv)) {
        const tRe = Date.now();
        const d2 = await deploy();
        redeploy = `HTTP ${d2.status}`;
        seenAfterRedeployS = "not within 180 s";
        while (Date.now() - tRe < 180_000) {
          const e = await readEnv();
          if (e) {
            lastEnv = e;
            envPolls.push(`redeploy+${Math.round((Date.now() - tRe) / 1000)}s:pub=[${e.pub.join(",")}] sec=[${e.sec.join(",")}] boot=${e.booted}`);
            if (hasNamed(e)) {
              seenAfterRedeployS = Math.round((Date.now() - tRe) / 1000);
              break;
            }
          }
          await sleep(10_000);
        }
      }
      out.push({
        id: "ER03-keys",
        title: "ER03 setup: extra named keys; key names the Edge Function runtime injects before and after",
        status: hasNamed(lastEnv) ? "pass" : "info",
        detail: `project healthy in ${ready.seconds}s; @supabase/server ${serverVersion}; create '${EXTRA_PUBLISHABLE}' publishable HTTP ${pubNamed.status}, '${EXTRA_SECRET}' secret HTTP ${secNamed.status}; running deployment saw both names: ${seenWithoutRedeployS === "not within 180 s" ? seenWithoutRedeployS : `after ${seenWithoutRedeployS} s`}; redeploy ${redeploy}${seenAfterRedeployS === "n/a" ? "" : `, names seen after redeploy: ${seenAfterRedeployS === "not within 180 s" ? seenAfterRedeployS : `${seenAfterRedeployS} s`}`}`,
        measurements: {
          server_version: serverVersion,
          docs_example_name_create_status: shortName.status,
          docs_example_name_create_message: shortName.body,
          deploy_status: d1.status,
          ef_env_before_publishable: JSON.stringify(env0.pub),
          ef_env_before_secret: JSON.stringify(env0.sec),
          ef_env_after_publishable: JSON.stringify(lastEnv?.pub ?? null),
          ef_env_after_secret: JSON.stringify(lastEnv?.sec ?? null),
          named_seen_without_redeploy_s: seenWithoutRedeployS,
          redeploy,
          named_seen_after_redeploy_s: seenAfterRedeployS,
          api_keys_listed: keyRows.map((k) => `${k.type ?? "?"}:${k.name ?? "?"}`).join(","),
          jwt_exp_short_patch_status: shortCfg.status,
          jwt_exp_short_readback: shortCfg.readback,
          jwt_exp_restore_readback: restoreCfg.readback,
          short_lifetime_effective_after_s: shortTok.effectiveAfterS,
          restore_lifetime_effective_after_s: longTok.effectiveAfterS,
        },
        evidence: envPolls.join("\n"),
      });

      // ---- remaining fixtures (as ER01) ----
      const us = decodeJwt(longTok.token);
      const pg = await mgmt(ctx, "GET", `/projects/${ref}/postgrest`);
      const jwtSecret = String((pg.json as { jwt_secret?: string } | undefined)?.jwt_secret ?? "");
      const nowS = Math.floor(Date.now() / 1000);
      const hs256 = jwtSecret ? mintHs256(jwtSecret, { sub: us.payload.sub, role: "authenticated", aud: "authenticated", iat: nowS, exp: nowS + 3600, iss: `${supaUrl}/auth/v1` }) : "";
      const foreign = await mint(await generateIdp(), { sub: crypto.randomUUID(), iss: "https://issuer.invalid" });
      const idp = await generateIdp();
      const pub = await publishJwks(ctx, "er-tpa-jwks", idp.publicJwk);
      const reg = pub.ok ? await registerTpa(ctx, pub.url) : { status: 0, id: "", body: `jwks not served ${pub.status}` };
      tpaId = reg.id;
      const tpa = await mint(idp, { sub: crypto.randomUUID(), iss: pub.url });
      const bag: TokenBag = { anon: keys.anon, service: keys.service, publishable: keys.publishable, secret: keys.secret, user: longTok.token, expired: shortTok.token, tpa, foreign, hs256 };
      const nk: NamedKeys = { pubDefault: keys.publishable, pubNamed: pubNamed.value, secDefault: keys.secret, secNamed: secNamed.value, user: longTok.token };
      const secrets: Record<string, string> = {
        anon_key: keys.anon,
        service_role_key: keys.service,
        publishable_default: keys.publishable,
        publishable_named: pubNamed.value,
        secret_default: keys.secret,
        secret_named: secNamed.value,
        user_token: longTok.token,
        expired_token: shortTok.token,
        tpa_token: tpa,
        foreign_token: foreign,
        hs256_token: hs256,
      };

      // ---- Bun servers ----
      const jwksRes = await fetch(`${supaUrl}/auth/v1/.well-known/jwks.json`, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
      const jwksText = jwksRes?.status === 200 ? await jwksRes.text() : "";
      const pubSet = JSON.stringify({ default: keys.publishable, [EXTRA_PUBLISHABLE]: pubNamed.value });
      const secSet = JSON.stringify({ default: keys.secret, [EXTRA_SECRET]: secNamed.value });
      const bunNotes: string[] = [];
      const tryStart = async (name: string, vars: Record<string, string>) => {
        try {
          procs.push(await startBun(name, vars));
        } catch (e) {
          bunNotes.push(e instanceof Error ? e.message : String(e));
        }
      };
      await tryStart("bunsing", { ER_ENV_PATH: "auto", SUPABASE_URL: supaUrl, SUPABASE_PUBLISHABLE_KEY: keys.publishable, SUPABASE_SECRET_KEY: keys.secret });
      await tryStart("bunplur", { ER_ENV_PATH: "auto", SUPABASE_URL: supaUrl, SUPABASE_PUBLISHABLE_KEYS: pubSet, SUPABASE_SECRET_KEYS: secSet });
      await tryStart("bunovr", { ER_ENV_PATH: "override", ER_URL: supaUrl, ER_PUBLISHABLE_KEYS: pubSet, ER_SECRET_KEYS: secSet, ...(jwksText ? { ER_JWKS: jwksText } : {}) });
      const runtimes: string[] = [];
      for (const p of procs) runtimes.push(`${p.name}: ${await fetch(`${p.baseUrl}/?mode=_runtime`).then((r) => r.text()).catch((e) => `ERR ${e}`)}`);
      const bunVersion = (await $`bun --version`.quiet().nothrow()).stdout.toString().trim();
      out.push({
        id: "ER03-runtime",
        title: "ER03 Bun servers: runtime facts per env configuration",
        status: procs.length === 3 ? "info" : "fail",
        detail: `${procs.length} of 3 Bun servers started (Bun ${bunVersion}, loopback, this machine); project JWKS fetched for bunovr: ${jwksText ? "yes" : `no (HTTP ${jwksRes?.status ?? 0})`}${bunNotes.length ? `; ${bunNotes.join("; ")}` : ""}`,
        measurements: { bun_version: bunVersion, servers_started: procs.length, inline_jwks_bytes: jwksText.length },
        evidence: runtimes.join("\n"),
      });

      // the expired fixture must be past its exp before any matrix runs
      while (Date.now() / 1000 < expiredExp + 5) await sleep(5_000);

      // ---- matrices ----
      const targets: { name: string; label: string; url: (mode: string) => string }[] = [
        { name: "ef", label: "Edge Function, verify_jwt=false, platform-injected env", url: (m) => `${efUrl}?mode=${m}` },
        ...procs.map((p) => ({
          name: p.name,
          label: BUN_LABELS[p.name] ?? p.name,
          url: (m: string) => `${p.baseUrl}/?mode=${m}`,
        })),
      ];
      const basePass1: Record<string, Record<string, string>> = {};
      const namedPass1: Record<string, Record<string, string>> = {};

      const runGrid = async <M extends string, C extends string>(
        kind: "base" | "named",
        t: (typeof targets)[number],
        modes: readonly M[],
        creds: readonly C[],
        hdrs: (c: C) => Record<string, string>,
        judge: (m: M, c: C, ran: boolean) => "match" | "MISMATCH" | "undoc",
      ) => {
        // passes[p][mode][cred] = observation
        const passes: Record<string, Record<string, Obs>>[] = [];
        for (let p = 0; p < PASSES; p++) {
          const grid: Record<string, Record<string, Obs>> = {};
          for (const mode of modes) {
            grid[mode] = {};
            for (const cred of creds) grid[mode]![cred] = await probeFull(t.url(mode), hdrs(cred));
          }
          passes.push(grid);
        }
        for (const mode of modes) {
          const m: Record<string, number | string> = {};
          const lines: string[] = [];
          let mismatches = 0;
          let undoc = 0;
          let diffs = 0;
          for (const cred of creds) {
            const obs = passes.map((g) => g[mode]![cred]!);
            const cells = obs.map(cellOf);
            const verdicts = obs.map((o) => judge(mode, cred, o.ran));
            mismatches += verdicts.filter((v) => v === "MISMATCH").length;
            if (verdicts[0] === "undoc") undoc++;
            const same = cells.every((c) => c === cells[0]);
            if (!same) diffs++;
            m[cred] = same ? cells[0]! : cells.map((c, i) => `p${i + 1} ${c}`).join(" | ");
            const bodies = obs.map((o) => scrub(o.body, secrets));
            const sameBody = bodies.every((b) => b === bodies[0]);
            lines.push(`${cred.padEnd(20)} ${m[cred]} [${verdicts[0]}]${sameBody ? "" : " (body differs between passes)"}`);
            bodies.forEach((b, i) => {
              if (i === 0 || !sameBody) lines.push(`  p${i + 1} body: ${b}`);
            });
          }
          (kind === "base" ? basePass1 : namedPass1)[`${t.name}:${mode}`] = Object.fromEntries(creds.map((c) => [c, cellOf(passes[0]![mode]![c]!)]));
          m.passes = PASSES;
          m.docs_mismatches = mismatches;
          m.docs_silent_cells = undoc;
          m.cells_differing_between_passes = diffs;
          const authLabel = JSON.stringify(AUTH_TABLE[mode]);
          out.push({
            id: `ER03-${t.name}-${mode}`,
            title: `${t.label}: auth ${authLabel}`,
            // The singular-env server holds only `default` keys, so the named-key
            // expectations (which assume the extra keys are configured) do not apply.
            status: kind === "named" && t.name === "bunsing" ? "info" : mismatches ? "fail" : "pass",
            detail: `${t.label}${kind === "named" && t.name === "bunsing" ? " (no named keys configured; expectations assume them)" : ""}: ${mismatches} observation(s) over ${PASSES} passes differ from the package docs, ${undoc} cell(s) the docs do not cover, ${diffs} cell(s) differ between passes`,
            measurements: m,
            evidence: lines.join("\n"),
          });
        }
      };

      for (const t of targets) await runGrid("base", t, MODES, CREDENTIALS, (c) => headersFor(c, bag), verdict);
      for (const t of targets) await runGrid("named", t, NAMED_MODES, NAMED_CREDENTIALS, (c) => namedHeaders(c, nk), namedVerdict);

      // ---- comparisons, pass 1, against the Edge Function cells of the same run ----
      const cmpLines: string[] = [];
      const cmpM: Record<string, number> = {};
      for (const [kind, store, modes] of [["base", basePass1, MODES], ["named", namedPass1, NAMED_MODES]] as const) {
        for (const t of targets.filter((x) => x.name !== "ef")) {
          let n = 0;
          let total = 0;
          for (const mode of modes) {
            const ef = store[`ef:${mode}`] ?? {};
            const other = store[`${t.name}:${mode}`] ?? {};
            const d = passDiff(ef, other);
            total += Object.keys(ef).length;
            n += d.length;
            for (const c of d) cmpLines.push(`${kind} ${t.name} ${mode} ${c}: ef "${ef[c]}" vs ${t.name} "${other[c]}"`);
          }
          cmpM[`${kind}_${t.name}_vs_ef_differing`] = n;
          cmpM[`${kind}_${t.name}_vs_ef_cells`] = total;
        }
      }
      out.push({
        id: "ER03-cmp",
        title: "ER03 cells that differ from the Edge Function cell of the same mode, credential and run (pass 1)",
        status: "info",
        detail: Object.entries(cmpM)
          .filter(([k]) => k.endsWith("_differing"))
          .map(([k, v]) => `${k.replace("_differing", "")}: ${v} of ${cmpM[k.replace("_differing", "_cells")]}`)
          .join("; "),
        measurements: cmpM,
        evidence: cmpLines.join("\n"),
      });
    } catch (e) {
      out.push({ id: "ER03", title: this.title, status: "fail", detail: `threw: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      const notes: string[] = [];
      for (const p of procs) await p.stop().catch(() => null);
      notes.push(`bun servers stopped: ${procs.length}`);
      if (tpaId) notes.push(`tpa delete ${await deleteTpa(ctx, tpaId)}`);
      if (ref) notes.push(`project delete ${await deleteProject(base, ref)}`);
      out.push({ id: "ER03z", title: `ER03 cleanup: project (${PREFIX}er03-*), issuer, Bun processes`, status: "info", detail: notes.join("; ") });
    }
    return out;
  },
};

export default mod;
