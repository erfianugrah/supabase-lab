/**
 * Throwaway project pair for the region-move modules.
 *
 * The modules create their projects through POST /v1/projects instead of tofu
 * because the create-to-ACTIVE_HEALTHY time in the target region is one of the
 * things RM02 measures; a tofu apply would hide it inside its own polling.
 * Every project this lib creates is named with NAME_PREFIX and recorded in
 * .run/projects.json (gitignored) so RM99, or a later run, can delete it.
 *
 * Lives under lib/ because the registry scans tests/ only.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "pg";
import { mgmt } from "../../../harness/src/mgmt.js";
import type { Ctx } from "../../../harness/src/types.js";

export const EXP_DIR = resolve(import.meta.dir, "..");
export const RUN_DIR = `${EXP_DIR}/.run`;
const STATE = `${RUN_DIR}/projects.json`;
export const NAME_PREFIX = "rm-";

export const SRC_REGION = process.env.RM_SRC_REGION ?? "ap-southeast-1";
export const TGT_REGION = process.env.RM_TGT_REGION ?? "ap-northeast-1";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Proj {
  role: string;
  ref: string;
  name: string;
  region: string;
  password: string;
  size: string;
  createStatus: number;
  /** POST /v1/projects -> first ACTIVE_HEALTHY poll, 5 s poll step. */
  healthySeconds?: number;
  /** POST /v1/projects -> first successful postgres login through the session pooler, 5 s step. */
  connectSeconds?: number;
  poolerHost?: string;
  /** created_at the API reports for the project (a pre-provisioned project predates the POST). */
  createdAt?: string;
}

type State = Record<string, Proj>;

async function load(): Promise<State> {
  if (!existsSync(STATE)) return {};
  return JSON.parse(await readFile(STATE, "utf8")) as State;
}

async function save(s: State): Promise<void> {
  await mkdir(RUN_DIR, { recursive: true });
  await writeFile(STATE, JSON.stringify(s, null, 2));
}

export async function recorded(): Promise<State> {
  return load();
}

export async function forget(role: string): Promise<void> {
  const s = await load();
  delete s[role];
  await save(s);
}

const pw = () => `${crypto.randomUUID().replace(/-/g, "")}Aa1`;

export interface CreateResult {
  status: number;
  text: string;
  proj?: Proj;
}

/** POST /v1/projects. Returns the raw answer so a refusal can be recorded verbatim. */
export async function createProject(
  ctx: Ctx,
  role: string,
  region: string,
  size: string,
): Promise<CreateResult> {
  const org = ctx.orgs.pro;
  if (!org) throw new Error("PVLAB_ORG_PRO not set (ctx.orgs.pro)");
  const password = pw();
  const name = `${NAME_PREFIX}${role}-${Date.now()}`;
  const c = await mgmt(ctx, "POST", "/projects", {
    organization_slug: org,
    name,
    db_pass: password,
    region,
    desired_instance_size: size,
  });
  const ref = (c.json as { ref?: string; id?: string } | undefined)?.ref ?? "";
  if (c.status !== 201 || !ref) return { status: c.status, text: c.text };
  const createdAt = String((c.json as { created_at?: string } | undefined)?.created_at ?? "");
  const proj: Proj = { role, ref, name, region, password, size, createStatus: c.status, createdAt };
  const s = await load();
  s[role] = proj;
  await save(s);
  return { status: c.status, text: c.text, proj };
}

/** Poll every 5 s until ACTIVE_HEALTHY; records the seconds since `t0`. */
export async function waitHealthy(ctx: Ctx, p: Proj, t0: number, maxMs = 900_000): Promise<number> {
  let status = "";
  while (Date.now() - t0 < maxMs) {
    const r = await mgmt(ctx, "GET", `/projects/${p.ref}`);
    status = (r.json as { status?: string } | undefined)?.status ?? `http-${r.status}`;
    if (status === "ACTIVE_HEALTHY") {
      const secs = Math.round((Date.now() - t0) / 100) / 10;
      const s = await load();
      if (s[p.role]) {
        s[p.role]!.healthySeconds = secs;
        await save(s);
      }
      p.healthySeconds = secs;
      return secs;
    }
    await sleep(5_000);
  }
  throw new Error(`${p.ref} not healthy after ${maxMs / 1000} s: ${status}`);
}

/**
 * Poll until a postgres login through the session pooler succeeds; records the
 * seconds since `t0` to the first good login. Status alone is not readiness:
 * on 2026-11-23 POST /v1/projects answered with a project whose status read
 * ACTIVE_HEALTHY on the first poll.
 */
export async function waitConnectable(ctx: Ctx, p: Proj, t0: number, maxMs = 900_000): Promise<number> {
  let last = "";
  while (Date.now() - t0 < maxMs) {
    try {
      await poolerHost(ctx, p);
      const c = await connect(p);
      await c.query("select 1");
      await c.end();
      const secs = Math.round((Date.now() - t0) / 100) / 10;
      const s = await load();
      if (s[p.role]) {
        s[p.role]!.connectSeconds = secs;
        await save(s);
      }
      p.connectSeconds = secs;
      return secs;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    await sleep(5_000);
  }
  throw new Error(`${p.ref} never accepted a login in ${maxMs / 1000} s: ${last}`);
}

/** The shared source/target pair (Micro, SRC_REGION -> TGT_REGION), created once per run. */
export async function ensurePair(ctx: Ctx): Promise<{ src: Proj; tgt: Proj }> {
  const s = await load();
  if (s.src && s.tgt) return { src: s.src, tgt: s.tgt };
  const t0 = Date.now();
  const [a, b] = await Promise.all([
    createProject(ctx, "src", SRC_REGION, "micro"),
    createProject(ctx, "tgt", TGT_REGION, "micro"),
  ]);
  if (!a.proj) throw new Error(`source create: HTTP ${a.status} ${a.text.slice(0, 300)}`);
  if (!b.proj) throw new Error(`target create: HTTP ${b.status} ${b.text.slice(0, 300)}`);
  await Promise.all([waitHealthy(ctx, a.proj, t0), waitHealthy(ctx, b.proj, t0)]);
  await Promise.all([waitConnectable(ctx, a.proj, t0), waitConnectable(ctx, b.proj, t0)]);
  return { src: a.proj, tgt: b.proj };
}

/**
 * Session-mode pooler (port 5432) host for the project's region. The modules
 * connect through it, not the direct host: the orchestrator's resolver returns
 * no address for the IPv6-only db.<ref> name (getaddrinfo with no global IPv6
 * address on the machine, 2026-11-23), and an IPv4 client is the common case.
 */
export async function poolerHost(ctx: Ctx, p: Proj): Promise<string> {
  if (p.poolerHost) return p.poolerHost;
  const r = await mgmt(ctx, "GET", `/projects/${p.ref}/config/database/pooler`);
  const arr = Array.isArray(r.json) ? (r.json as Array<{ db_host?: string }>) : [];
  const host = arr[0]?.db_host ?? "";
  if (!host) throw new Error(`no pooler config for ${p.ref}: HTTP ${r.status} ${r.text.slice(0, 200)}`);
  p.poolerHost = host;
  const s = await load();
  if (s[p.role]) {
    s[p.role]!.poolerHost = host;
    await save(s);
  }
  return host;
}

export const poolerUser = (p: Proj) => `postgres.${p.ref}`;

export async function connect(p: Proj): Promise<Client> {
  if (!p.poolerHost) throw new Error(`${p.ref}: poolerHost not resolved yet`);
  const c = new Client({
    host: p.poolerHost,
    port: 5432,
    user: poolerUser(p),
    password: p.password,
    database: "postgres",
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();
  return c;
}

/** `GET /config/disk` size_gb, or -1 when unreadable. */
export async function diskGb(ctx: Ctx, p: Proj): Promise<number> {
  const g = await mgmt(ctx, "GET", `/projects/${p.ref}/config/disk`);
  return Number((g.json as { attributes?: { size_gb?: number } } | undefined)?.attributes?.size_gb ?? -1);
}

/**
 * Grow the disk (one POST; disk changes have a cooldown of hours) and wait until
 * the config reads the new size, the project is ACTIVE_HEALTHY and a login works.
 * The 2026-11-23 first RM02 run filled the default disk while seeding toward
 * 1 GB ("could not extend file ...: No space left on device"). Returns seconds.
 */
export async function growDisk(ctx: Ctx, p: Proj, gb: number): Promise<number> {
  const t0 = Date.now();
  const cur = await mgmt(ctx, "GET", `/projects/${p.ref}/config/disk`);
  const attrs = (cur.json as { attributes?: Record<string, unknown> } | undefined)?.attributes ?? {};
  const put = await mgmt(ctx, "POST", `/projects/${p.ref}/config/disk`, { attributes: { ...attrs, size_gb: gb } });
  if (put.status >= 300) throw new Error(`disk resize ${p.ref} to ${gb} GB: HTTP ${put.status} ${put.text.slice(0, 200)}`);
  for (let i = 0; i < 90; i++) {
    await sleep(10_000);
    const st = String(((await mgmt(ctx, "GET", `/projects/${p.ref}`)).json as { status?: string } | undefined)?.status ?? "");
    if ((await diskGb(ctx, p)) === gb && st === "ACTIVE_HEALTHY") break;
  }
  await waitConnectable(ctx, p, Date.now());
  return Math.round((Date.now() - t0) / 1000);
}

export async function deleteProject(ctx: Ctx, p: Proj): Promise<number> {
  if (!p.name.startsWith(NAME_PREFIX)) throw new Error(`refusing to delete ${p.name}`);
  const r = await mgmt(ctx, "DELETE", `/projects/${p.ref}`);
  if (r.status < 300 || r.status === 404) await forget(p.role);
  return r.status;
}
