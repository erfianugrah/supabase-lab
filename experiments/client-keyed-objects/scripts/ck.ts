#!/usr/bin/env bun
/**
 * Orchestration for client-keyed-objects (the Makefile calls these).
 *
 *   bun scripts/ck.ts onprem-prepare <name> <file|s3>   copy docker/ out of the pinned clone into work/stacks/<name>
 *   bun scripts/ck.ts onprem-up <name>                  docker compose -p ck-<name> up -d --wait (own ports, own project)
 *   bun scripts/ck.ts onprem-down <name>                down -v, remove bind-mounted data, keep nothing
 *   bun scripts/ck.ts run-init <target...>              work/run/run.json + fixtures
 *   bun scripts/ck.ts setup <target...>                 migrations, per-target config, seed users/tenants, key service config
 *   bun scripts/ck.ts keysvc-up | keysvc-down           the operator's key service container
 *   bun scripts/ck.ts managed-up | managed-down         provision / delete the two managed projects (ck- prefix)
 *   bun scripts/ck.ts sweep                             list ck- projects left behind
 *
 * Nothing secret is printed. Generated keys, passwords and KEKs live under
 * work/ (gitignored) and are deleted by the clean targets.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "../../../harness/src/types";
import { EXP_DIR, type HarnessTarget, type RunInfo, type TargetState, http, jsonOr, jwtPayload, mgmtRetry, runClient, sh, signIn, sleep } from "../lib/ckrun";

const WORK = join(EXP_DIR, "work");
// CK_SLOT lets a second run (its own run dir, key service and port) proceed
// beside another one, e.g. a self-hosted re-run while a managed run is busy.
const SLOT = process.env.CK_SLOT ? `-${process.env.CK_SLOT}` : "";
const RUN = join(WORK, `run${SLOT}`);
const PIN = "8617532ae1a41571d5d557cd24c6f5f2565d9230";
const SRC = join(WORK, "supabase");
const KEYSVC_DIR = join(WORK, `keysvc${SLOT}`);
const KEYSVC_PORT = 8790 + (SLOT ? 1 : 0);
const KEYSVC_CONTAINER = `ck-keysvc${SLOT}`;
export const PREFIX = "ck-";
/** Storage server version the managed platform reported on 2026-10-10 (storage-surface SS01a); CK13 re-reads it live. */
const STORAGE_IMAGE = "public.ecr.aws/supabase/storage-api:v1.80.2";
const PORTS = { gw: 8100, pg: 5532, txn: 6643 };
const MANAGED = [
  { name: "region-a", region: "ap-southeast-1" },
  { name: "region-b", region: "eu-central-1" },
];
const HOOK_URI = "pg-functions://postgres/app/custom_access_token_hook";
const JWT_EXP = 300;
const FILE_LIMIT = 5 * 1024 * 1024 * 1024;

const ctx = { pat: process.env.SUPABASE_ACCESS_TOKEN ?? "", endpoints: {}, peers: {}, orgs: {} } as unknown as Ctx;
const log = (m: string) => console.log(m);
const die = (m: string): never => {
  console.error(m);
  process.exit(1);
};
const rand = (n = 24) => Buffer.from(crypto.getRandomValues(new Uint8Array(n))).toString("base64url");

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m) out[m[1]!] = m[2]!.replace(/^"(.*)"$/, "$1");
  }
  return out;
}

function setEnv(file: string, kv: Record<string, string>): void {
  const lines = readFileSync(file, "utf8").split("\n");
  for (const [k, v] of Object.entries(kv)) {
    const i = lines.findIndex((l) => l.startsWith(`${k}=`));
    if (i >= 0) lines[i] = `${k}=${v}`;
    else lines.push(`${k}=${v}`);
  }
  writeFileSync(file, lines.join("\n"));
}

const writeJson = (p: string, v: unknown) => {
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, JSON.stringify(v, null, 2));
};
const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, "utf8")) as T;
const targetPath = (n: string) => join(RUN, "targets", `${n}.json`);
const statePath = (n: string) => join(RUN, "state", `${n}.json`);

// ------------------------------------------------------------- self-hosted

async function fetchPinned() {
  if (!existsSync(join(SRC, ".git"))) {
    const r = await sh(["git", "clone", "--no-checkout", "--filter=blob:none", "https://github.com/supabase/supabase.git", SRC]);
    if (r.code) die(r.err);
  }
  await sh(["git", "-C", SRC, "fetch", "--depth", "1", "origin", PIN]);
  const r = await sh(["git", "-C", SRC, "checkout", "--quiet", "--force", PIN]);
  if (r.code) die(r.err);
}

const stackDir = (name: string) => join(WORK, "stacks", name);
const project = (name: string) => `ck-${name}`;
const composeFiles = (backend: string) => [
  "-f",
  "docker-compose.yml",
  ...(backend === "s3" ? ["-f", "docker-compose.s3.yml"] : []),
  "-f",
  join(EXP_DIR, "compose", "docker-compose.ck.yml"),
  "-f",
  join(EXP_DIR, "compose", backend === "s3" ? "docker-compose.ck-s3.yml" : "docker-compose.ck-file.yml"),
];

async function onpremPrepare(name: string, backend: "file" | "s3") {
  await fetchPinned();
  const dir = stackDir(name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  let r = await sh(["cp", "-R", `${join(SRC, "docker")}/.`, `${dir}/`]);
  if (r.code) die(r.err);
  writeFileSync(join(dir, ".env"), readFileSync(join(dir, ".env.example")));
  // The upstream key scripts, as the self-hosting guide runs them. Their
  // stdout carries generated secrets, so it is discarded.
  r = await sh(["sh", "utils/generate-keys.sh", "--update-env"], { cwd: dir });
  if (r.code) die(`generate-keys: ${r.err.slice(0, 300)}`);
  r = await sh(["sh", "utils/add-new-auth-keys.sh", "--update-env"], { cwd: dir });
  if (r.code) die(`add-new-auth-keys: ${r.err.slice(0, 300)}`);
  // Run beside another stack: no fixed container names, own host ports.
  const compose = readFileSync(join(dir, "docker-compose.yml"), "utf8")
    .split("\n")
    .filter((l) => !/^\s*container_name:/.test(l))
    .join("\n")
    .replace("- ${POSTGRES_PORT}:5432", "- ${CK_PG_HOST_PORT}:5432");
  writeFileSync(join(dir, "docker-compose.yml"), compose);
  const pub = `http://localhost:${PORTS.gw}`;
  setEnv(join(dir, ".env"), {
    API_GW_HTTP_PORT: String(PORTS.gw),
    SUPABASE_PUBLIC_URL: pub,
    API_EXTERNAL_URL: `${pub}/auth/v1`,
    SITE_URL: pub,
    JWT_EXPIRY: String(JWT_EXP),
    ENABLE_EMAIL_AUTOCONFIRM: "true",
    PGRST_DB_SCHEMAS: "public,graphql_public,app",
    POOLER_PROXY_PORT_TRANSACTION: String(PORTS.txn),
    POOLER_TENANT_ID: `ck-${name}`,
    CK_PG_HOST_PORT: String(PORTS.pg),
    CK_STORAGE_IMAGE: STORAGE_IMAGE,
    CK_FILE_SIZE_LIMIT: String(FILE_LIMIT),
  });
  const env = parseEnv(readFileSync(join(dir, ".env"), "utf8"));
  const t: HarnessTarget = {
    name,
    kind: "compose",
    client: {
      name,
      region: name,
      url: pub,
      storageUrl: `${pub}/storage/v1`,
      anonKey: env.ANON_KEY!,
      s3: { endpoint: `${pub}/storage/v1/s3`, region: env.REGION!, accessKeyId: env.STORAGE_TENANT_ID! },
      keyServiceUrl: `http://127.0.0.1:${KEYSVC_PORT}`,
      bucket: "assets",
    },
    serviceKey: env.SERVICE_ROLE_KEY!,
    s3Service: { accessKeyId: env.S3_PROTOCOL_ACCESS_KEY_ID!, secretAccessKey: env.S3_PROTOCOL_ACCESS_KEY_SECRET! },
    issuer: `${pub}/auth/v1`,
    compose: { project: project(name), stackDir: dir, backend, dbContainer: `${project(name)}-db-1`, storageImage: STORAGE_IMAGE },
    dockerRewrite: { from: pub, to: `http://host.docker.internal:${PORTS.gw}` },
  };
  writeJson(targetPath(name), t);
  log(`prepared ${dir} (backend ${backend}; secrets not printed)`);
}

async function onpremUp(name: string) {
  const t = readJson<HarnessTarget>(targetPath(name));
  const up = () => sh(["docker", "compose", "-p", project(name), ...composeFiles(t.compose!.backend), "up", "-d", "--wait"], { cwd: stackDir(name), timeoutMs: 900_000 });
  let r = await up();
  // The db healthcheck allows 10 x 5 s; a first init on a busy Docker VM can
  // take longer, and compose then gives up on every dependant. Retry twice.
  for (let i = 0; i < 2 && r.code && /db-1 is unhealthy|dependency db failed/.test(r.err); i++) {
    log(`db not healthy in time; retrying up (${i + 1})`);
    await sleep(15_000);
    r = await up();
  }
  // PostgREST stays unhealthy until the migrations create the exposed `app`
  // schema ("schema \"app\" does not exist"); that one is expected here.
  const unhealthy = [...new Set([...r.err.matchAll(/container (\S+) is unhealthy/g)].map((m) => m[1]))];
  if (r.code && !(unhealthy.length === 1 && unhealthy[0] === `${project(name)}-rest-1`)) die(`compose up: ${r.err.slice(-1500)}`);
  log(`${project(name)} up on :${PORTS.gw}${unhealthy.length ? " (rest waits for the app schema)" : ""}`);
}

async function onpremDown(name: string) {
  const dir = stackDir(name);
  if (!existsSync(dir)) return log(`${dir} absent`);
  const backend = existsSync(targetPath(name)) ? readJson<HarnessTarget>(targetPath(name)).compose?.backend ?? "s3" : "s3";
  await sh(["docker", "compose", "-p", project(name), ...composeFiles(backend), "down", "-v", "--remove-orphans"], { cwd: dir, timeoutMs: 600_000 });
  // Bind-mounted data is written by container users; remove it from a container.
  await sh(["docker", "run", "--rm", "-v", `${dir}/volumes:/v`, "oven/bun:1.3-alpine", "sh", "-c", "rm -rf /v/db/data /v/storage /v/minio"]);
  rmSync(dir, { recursive: true, force: true });
  log(`${project(name)} down; ${dir} removed`);
}

// ------------------------------------------------------------- managed

async function orgSlug(): Promise<string> {
  const o = process.env.PVLAB_ORG_PRO ?? "";
  if (!o) die("PVLAB_ORG_PRO not set");
  return o;
}

async function managedUp() {
  if (!ctx.pat) die("SUPABASE_ACCESS_TOKEN not set");
  const org = await orgSlug();
  const t0 = Date.now();
  const made: { name: string; region: string; ref: string; dbPass: string }[] = [];
  for (const m of MANAGED) {
    const dbPass = `${rand(18)}Aa1`;
    const r = await mgmtRetry(ctx, "POST", "/projects", { organization_slug: org, name: `${PREFIX}${m.name}-${t0}`, db_pass: dbPass, region: m.region });
    const ref = String((r.json as { ref?: string } | undefined)?.ref ?? "");
    if (r.status !== 201 || !ref) die(`create ${m.name}: HTTP ${r.status} ${r.text.slice(0, 200)}`);
    made.push({ ...m, ref, dbPass });
    // Record the ref immediately so managed-down can delete even if the rest fails.
    writeJson(join(RUN, "managed.json"), made);
    log(`created ${m.name} (${m.region})`);
  }
  for (const m of made) {
    const deadline = Date.now() + 15 * 60_000;
    let status = "";
    while (Date.now() < deadline && status !== "ACTIVE_HEALTHY") {
      await sleep(10_000);
      status = String(((await mgmtRetry(ctx, "GET", `/projects/${m.ref}`)).json as { status?: string } | undefined)?.status ?? "");
    }
    if (status !== "ACTIVE_HEALTHY") die(`${m.name} not healthy: ${status}`);
    const k = await mgmtRetry(ctx, "GET", `/projects/${m.ref}/api-keys?reveal=true`);
    const keys = (Array.isArray(k.json) ? k.json : []) as { name?: string; api_key?: string }[];
    const anon = keys.find((x) => x.name === "anon")?.api_key ?? "";
    const service = keys.find((x) => x.name === "service_role")?.api_key ?? "";
    if (!anon || !service) die(`${m.name}: legacy keys not returned`);
    const url = `https://${m.ref}.supabase.co`;
    const t: HarnessTarget = {
      name: m.name,
      kind: "managed",
      client: {
        name: m.name,
        region: m.region,
        url,
        storageUrl: `https://${m.ref}.storage.supabase.co/storage/v1`,
        anonKey: anon,
        s3: { endpoint: `https://${m.ref}.storage.supabase.co/storage/v1/s3`, region: m.region, accessKeyId: m.ref },
        keyServiceUrl: `http://127.0.0.1:${KEYSVC_PORT}`,
        bucket: "assets",
      },
      serviceKey: service,
      s3Service: { accessKeyId: m.ref, secretAccessKey: anon, sessionToken: service },
      issuer: `${url}/auth/v1`,
      managed: { ref: m.ref, dbPass: m.dbPass },
    };
    writeJson(targetPath(m.name), t);
    // ACTIVE_HEALTHY is not readiness: wait for Auth, REST and Storage.
    const ready = async () => {
      const a = await http(`${url}/auth/v1/health`, { headers: { apikey: anon } });
      const s = await http(`${url}/storage/v1/bucket`, { headers: { apikey: service, authorization: `Bearer ${service}` } });
      return a.status === 200 && s.status === 200;
    };
    const rd = Date.now() + 10 * 60_000;
    while (Date.now() < rd && !(await ready().catch(() => false))) await sleep(5_000);
    log(`${m.name} ready`);
  }
}

async function managedDown() {
  const p = join(RUN, "managed.json");
  if (!existsSync(p)) return log("no managed.json; nothing to delete");
  for (const m of readJson<{ name: string; ref: string }[]>(p)) {
    const r = await mgmtRetry(ctx, "DELETE", `/projects/${m.ref}`);
    log(`delete ${m.name}: HTTP ${r.status}`);
  }
  rmSync(p);
}

/** Slug of the first Pro-plan org the PAT can see, on stdout for `$(...)` capture only (never logged). */
async function proOrg() {
  const r = await mgmtRetry(ctx, "GET", "/organizations");
  const orgs = (Array.isArray(r.json) ? r.json : []) as { slug?: string; id?: string }[];
  const pro: string[] = [];
  for (const o of orgs) {
    const slug = o.slug ?? o.id ?? "";
    const d = await mgmtRetry(ctx, "GET", `/organizations/${slug}`);
    if (String((d.json as { plan?: string } | undefined)?.plan ?? "") === "pro") pro.push(slug);
  }
  console.error(`${orgs.length} orgs visible, ${pro.length} on the pro plan`);
  if (!pro.length) die("no Pro-plan org visible to this PAT");
  process.stdout.write(pro[0]!);
}

async function sweep() {
  const r = await mgmtRetry(ctx, "GET", "/projects");
  const left = ((Array.isArray(r.json) ? r.json : []) as { name: string; status: string }[]).filter((p) => p.name.startsWith(PREFIX));
  log(left.length ? left.map((p) => `${p.name} ${p.status}`).join("\n") : `no ${PREFIX} projects (HTTP ${r.status})`);
}

/** Per-target platform config on managed: auth hook, short JWT expiry, autoconfirm, exposed schema, storage. Defaults recorded first. */
async function managedConfig(t: HarnessTarget): Promise<Record<string, string | number>> {
  const ref = t.managed!.ref;
  const out: Record<string, string | number> = {};
  const st0 = await mgmtRetry(ctx, "GET", `/projects/${ref}/config/storage`);
  const s0 = (st0.json ?? {}) as { fileSizeLimit?: number; features?: { s3Protocol?: { enabled?: boolean } } };
  out.storage_default_file_size_limit = Number(s0.fileSizeLimit ?? -1);
  out.storage_default_s3_protocol = String(s0.features?.s3Protocol?.enabled ?? "absent");
  const sp = await mgmtRetry(ctx, "PATCH", `/projects/${ref}/config/storage`, { fileSizeLimit: FILE_LIMIT, features: { s3Protocol: { enabled: true } } });
  out.storage_patch_status = sp.status;
  const st1 = (await mgmtRetry(ctx, "GET", `/projects/${ref}/config/storage`)).json as typeof s0;
  out.storage_file_size_limit = Number(st1?.fileSizeLimit ?? -1);
  out.storage_s3_protocol = String(st1?.features?.s3Protocol?.enabled ?? "absent");
  const a0 = ((await mgmtRetry(ctx, "GET", `/projects/${ref}/config/auth`)).json ?? {}) as Record<string, unknown>;
  out.auth_default_jwt_exp = Number(a0.jwt_exp ?? -1);
  out.auth_default_mailer_autoconfirm = String(a0.mailer_autoconfirm);
  const ap = await mgmtRetry(ctx, "PATCH", `/projects/${ref}/config/auth`, {
    jwt_exp: JWT_EXP,
    mailer_autoconfirm: true,
    hook_custom_access_token_enabled: true,
    hook_custom_access_token_uri: HOOK_URI,
  });
  out.auth_patch_status = ap.status;
  if (ap.status >= 300) log(`auth config PATCH ${ap.status}: ${ap.text.slice(0, 200)}`);
  const pg0 = ((await mgmtRetry(ctx, "GET", `/projects/${ref}/postgrest`)).json ?? {}) as { db_schema?: string };
  out.postgrest_default_db_schema = String(pg0.db_schema ?? "");
  const pp = await mgmtRetry(ctx, "PATCH", `/projects/${ref}/postgrest`, { db_schema: "public,graphql_public,app" });
  out.postgrest_patch_status = pp.status;
  return out;
}

// ------------------------------------------------------------- setup

async function applyMigrations(t: HarnessTarget): Promise<string> {
  const migDir = join(EXP_DIR, "supabase", "migrations");
  if (t.kind === "compose") {
    // `up --wait` can return while the db container still runs its init
    // scripts (pg_isready answers the temporary server), and Auth and Storage
    // create their schemas on their own start. Wait for all three.
    const ready = "select to_regclass('auth.users') is not null and to_regclass('storage.s3_multipart_uploads_parts') is not null";
    const t0 = Date.now();
    for (;;) {
      const r = await sh(["docker", "exec", t.compose!.dbContainer, "psql", "-U", "postgres", "-d", "postgres", "-At", "-c", ready]);
      if (r.code === 0 && r.out.trim() === "t") break;
      if (Date.now() - t0 > 600_000) die(`database not ready: ${r.err.slice(0, 200)}`);
      await sleep(2_000);
    }
    for (const f of readdirSync(migDir).filter((x) => x.endsWith(".sql")).sort()) {
      const r = await sh(["docker", "exec", "-i", t.compose!.dbContainer, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-1", "-q"], {
        stdin: readFileSync(join(migDir, f), "utf8"),
      });
      if (r.code) die(`${f}: ${r.err.slice(0, 400)}`);
    }
    return "psql";
  }
  // Managed: the Supabase CLI against the session pooler.
  const pool = await mgmtRetry(ctx, "GET", `/projects/${t.managed!.ref}/config/database/pooler`);
  const rows = (Array.isArray(pool.json) ? pool.json : []) as { db_host?: string; database_type?: string }[];
  const host = (rows.find((x) => x.database_type === "PRIMARY") ?? rows[0])?.db_host;
  if (!host) die("no pooler host");
  // No password in --db-url (argv, visible in ps): the CLI resolves a missing
  // password from PGPASSWORD (libpq order: URL, PGPASSWORD, .pgpass).
  const url = `postgresql://postgres.${t.managed!.ref}@${host}:5432/postgres`;
  for (let i = 0; i < 5; i++) {
    const r = await sh(["supabase", "db", "push", "--db-url", url, "--workdir", EXP_DIR, "--yes", "--include-all"], { timeoutMs: 300_000, env: { PGPASSWORD: t.managed!.dbPass } });
    if (r.code === 0) return "supabase db push";
    log(`db push attempt ${i + 1} failed: ${(r.err + r.out).replaceAll(t.managed!.dbPass, "<pw>").slice(-300)}`);
    await sleep(15_000);
  }
  return die("db push failed");
}

async function svc(t: HarnessTarget, method: string, path: string, body?: unknown, profile = "app") {
  const r = await http(`${t.client.url}${path}`, {
    method,
    headers: {
      apikey: t.serviceKey,
      authorization: `Bearer ${t.serviceKey}`,
      "content-type": "application/json",
      "accept-profile": profile,
      "content-profile": profile,
      prefer: "return=representation",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (r.status >= 300) die(`${method} ${path} on ${t.name}: ${r.status} ${r.body.slice(0, 200)}`);
  return jsonOr(r.body);
}

async function seed(t: HarnessTarget): Promise<TargetState> {
  const users = {} as TargetState["users"];
  for (const role of ["owner", "editor", "viewer", "outsider"] as const) {
    const email = `ck-${role}-${Date.now()}@lab.test`;
    const password = rand(18);
    const u = await svc(t, "POST", "/auth/v1/admin/users", { email, password, email_confirm: true });
    users[role] = { email, password, id: String(u.id) };
  }
  const [p, o] = (await svc(t, "POST", "/rest/v1/tenants", [
    { name: "tenant-primary", home_region: t.client.region },
    { name: "tenant-other", home_region: t.client.region },
  ])) as { id: string }[];
  await svc(t, "POST", "/rest/v1/memberships", [
    { tenant_id: p!.id, user_id: users.owner.id, role: "owner" },
    { tenant_id: p!.id, user_id: users.editor.id, role: "editor" },
    { tenant_id: p!.id, user_id: users.viewer.id, role: "viewer" },
    { tenant_id: o!.id, user_id: users.outsider.id, role: "owner" },
  ]);
  const [rp, ro] = (await svc(t, "POST", "/rest/v1/records", [
    { tenant_id: p!.id, title: "record-primary", created_by: users.owner.id },
    { tenant_id: o!.id, title: "record-other", created_by: users.outsider.id },
  ])) as { id: string }[];
  return { tenants: { primary: p!.id, other: o!.id }, users, records: { primary: rp!.id, other: ro!.id }, assets: {} };
}

/** Wait until a freshly issued token has the configured lifetime and the hook claim (managed config is not instant). */
async function earlyToken(t: HarnessTarget, st: TargetState): Promise<{ token: string; exp: number; lifetime: number; waitedS: number }> {
  const t0 = Date.now();
  for (;;) {
    const s = await signIn(t, st.users.viewer.email, st.users.viewer.password);
    if (s.status === 200) {
      const p = jwtPayload(s.j.access_token);
      const lifetime = Number(p.exp) - Number(p.iat);
      if (lifetime === JWT_EXP && Array.isArray(p.tenant_ids)) return { token: s.j.access_token, exp: Number(p.exp), lifetime, waitedS: Math.round((Date.now() - t0) / 1000) };
    }
    if (Date.now() - t0 > 10 * 60_000) die(`${t.name}: token lifetime / hook claim never took effect (last status ${s.status})`);
    await sleep(10_000);
  }
}

function keysvcConfig(names: string[]) {
  const cfgP = join(KEYSVC_DIR, "config.json");
  const keksP = join(KEYSVC_DIR, "keks.json");
  const cfg = existsSync(cfgP) ? readJson<{ targets: Record<string, unknown>; tenants: Record<string, string> }>(cfgP) : { targets: {}, tenants: {} };
  const keks = existsSync(keksP) ? readJson<Record<string, { key_id: string; kek_b64: string }>>(keksP) : {};
  for (const n of names) {
    const t = readJson<HarnessTarget>(targetPath(n));
    const st = readJson<TargetState>(statePath(n));
    const rw = (u: string) => (t.dockerRewrite ? u.replace(t.dockerRewrite.from, t.dockerRewrite.to) : u);
    cfg.targets[n] = {
      issuer: t.issuer,
      auth_url: rw(`${t.client.url}/auth/v1`),
      jwks_url: rw(`${t.client.url}/auth/v1/.well-known/jwks.json`),
      rest_url: rw(`${t.client.url}/rest/v1`),
      apikey: t.client.anonKey,
    };
    for (const tid of [st.tenants.primary, st.tenants.other]) {
      cfg.tenants[tid] = n;
      keks[tid] ??= { key_id: `kek-${tid.slice(0, 8)}-v1`, kek_b64: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64") };
    }
  }
  writeJson(cfgP, cfg);
  writeJson(keksP, keks);
}

async function setup(names: string[]) {
  for (const n of names) {
    const t = readJson<HarnessTarget>(targetPath(n));
    const info: Record<string, string | number> = {};
    // Migrations first: the auth hook and the exposed schema name objects
    // that must exist when the platform config points at them.
    info.migrations_via = await applyMigrations(t);
    if (t.kind === "managed") Object.assign(info, await managedConfig(t));
    // PostgREST picks the new schema up on its own schedule (reload notify,
    // or its reconnect backoff when the schema did not exist at start).
    const t0 = Date.now();
    for (;;) {
      const r = await http(`${t.client.url}/rest/v1/tenants?select=id&limit=1`, {
        headers: { apikey: t.serviceKey, authorization: `Bearer ${t.serviceKey}`, "accept-profile": "app" },
      });
      if (r.status === 200) break;
      if (Date.now() - t0 > 180_000) die(`${n}: Data API never served app.tenants (last ${r.status} ${r.body.slice(0, 120)})`);
      await sleep(2_000);
    }
    info.data_api_ready_after_s = Math.round((Date.now() - t0) / 1000);
    const st = await seed(t);
    const e = await earlyToken(t, st);
    st.earlyToken = { token: e.token, exp: e.exp };
    info.token_lifetime_s = e.lifetime;
    info.config_effective_after_s = e.waitedS;
    st.setup = info;
    writeJson(statePath(n), st);
    log(`${n}: migrations (${info.migrations_via}), seed, hook claim and ${e.lifetime}s tokens in place`);
  }
  keysvcConfig(names);
}

async function runInit(names: string[]) {
  const fx = await runClient({ cmd: "fixtures", dir: join(WORK, "fixtures") }, { timeoutMs: 600_000 });
  if (!fx.result.big) die(`fixtures: ${JSON.stringify(fx.result).slice(0, 300)}`);
  rmSync(join(RUN, "state"), { recursive: true, force: true });
  const run: Omit<RunInfo, "dir"> = {
    targets: names,
    fixtures: { big: fx.result.big, mid: fx.result.mid },
    keysvc: { url: `http://127.0.0.1:${KEYSVC_PORT}`, container: KEYSVC_CONTAINER, configDir: KEYSVC_DIR },
  };
  writeJson(join(RUN, "run.json"), run);
  rmSync(KEYSVC_DIR, { recursive: true, force: true });
  log(`run dir ${RUN}: targets ${names.join(", ")}`);
}

async function keysvcUp() {
  mkdirSync(KEYSVC_DIR, { recursive: true });
  let r = await sh(["docker", "build", "-q", "-t", "ck-keysvc:local", join(EXP_DIR, "keysvc")], { timeoutMs: 600_000 });
  if (r.code) die(`build: ${r.err.slice(-500)}`);
  await sh(["docker", "rm", "-f", KEYSVC_CONTAINER]);
  r = await sh([
    "docker", "run", "-d", "--name", KEYSVC_CONTAINER, "--add-host", "host.docker.internal:host-gateway",
    "-p", `127.0.0.1:${KEYSVC_PORT}:8790`, "-v", `${KEYSVC_DIR}:/config:ro`, "ck-keysvc:local",
  ]);
  if (r.code) die(`run: ${r.err.slice(-500)}`);
  for (let i = 0; i < 30; i++) {
    if ((await http(`http://127.0.0.1:${KEYSVC_PORT}/health`)).status === 200) return log("keysvc up");
    await sleep(1000);
  }
  die("keysvc did not answer /health");
}

async function keysvcDown() {
  await sh(["docker", "rm", "-f", KEYSVC_CONTAINER]);
  // KEKs are per run: delete them with the service.
  rmSync(KEYSVC_DIR, { recursive: true, force: true });
  log("keysvc removed, KEKs deleted");
}

const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
  case "onprem-prepare":
    await onpremPrepare(args[0]!, (args[1] ?? "s3") as "file" | "s3");
    break;
  case "onprem-up":
    await onpremUp(args[0]!);
    break;
  case "onprem-down":
    await onpremDown(args[0]!);
    break;
  case "run-init":
    await runInit(args);
    break;
  case "setup":
    await setup(args);
    break;
  case "keysvc-up":
    await keysvcUp();
    break;
  case "keysvc-down":
    await keysvcDown();
    break;
  case "managed-up":
    await managedUp();
    break;
  case "managed-down":
    await managedDown();
    break;
  case "sweep":
    await sweep();
    break;
  case "pro-org":
    await proOrg();
    break;
  default:
    die(`unknown command ${cmd}`);
}
