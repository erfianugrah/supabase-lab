/**
 * The project pair every module in this experiment measures: one OrioleDB
 * project and one heap control, created with the same compute size and region,
 * through the Management API, and deleted at the end.
 *
 * Creation: `POST /v1/projects` with `postgres_engine: "17-oriole"`. The
 * published OpenAPI document (read 2026-10-10) types `postgres_engine` on the
 * create body as `null` and deprecated, but the API accepted the value and the
 * project came up as an OrioleDB project (OR01 reads the engine back). The
 * heap control omits the field.
 *
 * Lifecycle: `ensurePair()` creates the pair once per process (the modules run
 * sequentially in one process), `teardownPair()` deletes it. OR99 calls the
 * teardown, and a `beforeExit` / SIGINT / SIGTERM hook calls it too, so a run
 * limited with `--only` still cleans up. To reuse an existing pair instead
 * (iterating on a module), export `PVLAB_PEER_ORIOLE`, `PVLAB_PEER_HEAP` and
 * `DB_PASSWORD`; reused projects are never deleted.
 *
 * Connections go through the session-mode pooler (port 5432, IPv4): the
 * direct host is IPv6-only without the IPv4 add-on. The `postgres` role on a
 * hosted project is not a superuser and holds no `pg_checkpoint`, so
 * `CHECKPOINT` is unavailable (measured, OR01).
 */
import { Client } from "pg";
import { mgmt } from "../../../harness/src/mgmt";
import type { Ctx, TestResult } from "../../../harness/src/types";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * TestModule contract: a module that cannot get its projects skips with a reason
 * instead of throwing. `PVLAB_ORG_PRO` creates the projects; `PVLAB_PEER_<LABEL>`
 * (ORIOLE and HEAP for the pair) reuses existing ones. Returns the skip result
 * when neither is available for every label, otherwise undefined.
 */
export function skipWithoutOrg(ctx: Ctx, id: string, title: string, labels: string[] = ["oriole", "heap"]): TestResult[] | undefined {
  if (ctx.orgs.pro) return undefined;
  const missing = labels.filter((l) => !ctx.peers[l]);
  if (!missing.length) return undefined;
  return [{ id, title, status: "skip", detail: `PVLAB_ORG_PRO not set (and no PVLAB_PEER_${missing.map((m) => m.toUpperCase()).join(", PVLAB_PEER_")} to reuse)` }];
}

export type Role = "oriole" | "heap";

/** Labels of extra OrioleDB projects (scratch, conv_a, conv_b): ones a module may wedge. */
export type ExtraLabel = string;

export interface Proj {
  role: Role | ExtraLabel;
  ref: string;
  name: string;
  password: string;
  host: string;
  /** Created by this process (and so deleted by it). */
  owned: boolean;
}

export const REGION = process.env.OR_REGION ?? "ap-southeast-1";
export const SIZE = process.env.OR_SIZE ?? "small";
export const NAME_PREFIX = process.env.OR_NAME_PREFIX ?? "pvlab-orioledb";

let pair: Record<Role, Proj> | undefined;
const extras = new Map<string, Promise<Proj>>();
const extraProjs: Proj[] = [];
let creating: Promise<Record<Role, Proj>> | undefined;
let hooked = false;

interface Created {
  ref?: string;
  id?: string;
}

async function waitHealthy(ctx: Ctx, ref: string, maxIters = 90): Promise<string> {
  let status = "";
  for (let i = 0; i < maxIters && status !== "ACTIVE_HEALTHY"; i++) {
    await sleep(10_000);
    const p = await mgmt(ctx, "GET", `/projects/${ref}`);
    status = String((p.json as { status?: string } | undefined)?.status ?? "");
  }
  return status;
}

/** `connectionString` carries the pooler host; the API spells the key both ways. */
async function poolerHost(ctx: Ctx, ref: string): Promise<string> {
  for (let i = 0; i < 12; i++) {
    const r = await mgmt(ctx, "GET", `/projects/${ref}/config/database/pooler`);
    const rows = Array.isArray(r.json) ? (r.json as Array<Record<string, unknown>>) : [];
    const cs = String(rows[0]?.connectionString ?? rows[0]?.connection_string ?? "");
    const m = /@([^:/]+):/.exec(cs);
    if (m?.[1]) return m[1];
    await sleep(10_000);
  }
  throw new Error("pooler host not readable from /config/database/pooler");
}

async function create(ctx: Ctx, role: Role | ExtraLabel, stamp: number, oriole = role === "oriole"): Promise<Proj> {
  const org = ctx.orgs.pro ?? "";
  const name = `${NAME_PREFIX}-${role}-${stamp}`;
  const password = `${crypto.randomUUID().replace(/-/g, "")}Aa1`;
  const body: Record<string, unknown> = {
    organization_slug: org,
    name,
    db_pass: password,
    region_selection: { type: "specific", code: REGION },
    desired_instance_size: SIZE,
  };
  if (oriole) body.postgres_engine = "17-oriole";
  const r = await mgmt(ctx, "POST", "/projects", body);
  const ref = (r.json as Created | undefined)?.ref ?? (r.json as Created | undefined)?.id ?? "";
  if (r.status !== 201 || !ref) throw new Error(`create ${role}: HTTP ${r.status}: ${r.text.slice(0, 300)}`);
  return { role, ref, name, password, host: "", owned: true };
}

export function connString(p: Proj, port = 5432): { host: string; port: number; user: string; password: string; database: string } {
  return { host: p.host, port, user: `postgres.${p.ref}`, password: p.password, database: "postgres" };
}

export async function connect(p: Proj, port = 5432): Promise<Client> {
  // The pooler refused a connection (econnrefused) once mid-run on 2026-10-10, so
  // retry a few times before giving up.
  let last: unknown;
  for (let i = 0; i < 4; i++) {
    const c = new Client({
      ...connString(p, port),
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 15_000,
    });
    // A server that kills the backend (OR08) makes the socket emit 'error'; with no
    // listener that event ends the whole process and loses the run's artifact
    // (it did, on 2026-10-10).
    c.on("error", () => undefined);
    try {
      await c.connect();
      await c.query("set statement_timeout = 0");
      return c;
    } catch (e) {
      last = e;
      await c.end().catch(() => undefined);
      await sleep(3_000 * (i + 1));
    }
  }
  throw last;
}

export async function withConn<T>(p: Proj, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = await connect(p);
  try {
    return await fn(c);
  } finally {
    await c.end().catch(() => undefined);
  }
}

async function waitConnectable(p: Proj, maxMs = 180_000): Promise<void> {
  const deadline = Date.now() + maxMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      await withConn(p, (c) => c.query("select 1"));
      return;
    } catch (e) {
      last = (e as Error).message;
      await sleep(5_000);
    }
  }
  throw new Error(`${p.role} not connectable through the pooler: ${last}`);
}

export async function ensurePair(ctx: Ctx): Promise<Record<Role, Proj>> {
  if (pair) return pair;
  if (creating) return creating;
  creating = (async () => {
    const reuseO = ctx.peers.oriole;
    const reuseH = ctx.peers.heap;
    let out: Record<Role, Proj>;
    if (reuseO && reuseH) {
      if (!ctx.dbPassword) throw new Error("reusing PVLAB_PEER_ORIOLE/HEAP needs DB_PASSWORD");
      out = {
        oriole: { role: "oriole", ref: reuseO, name: "(reused)", password: ctx.dbPassword, host: "", owned: false },
        heap: { role: "heap", ref: reuseH, name: "(reused)", password: ctx.dbPassword, host: "", owned: false },
      };
    } else {
      if (!ctx.orgs.pro) throw new Error("PVLAB_ORG_PRO is required to create the pair");
      const stamp = Date.now();
      const [o, h] = await Promise.allSettled([create(ctx, "oriole", stamp), create(ctx, "heap", stamp)]);
      if (o.status !== "fulfilled" || h.status !== "fulfilled") {
        // One create landed and the other did not: delete the one that did.
        for (const x of [o, h]) if (x.status === "fulfilled") await mgmt(ctx, "DELETE", `/projects/${x.value.ref}`);
        const why = [o, h].find((x) => x.status === "rejected") as PromiseRejectedResult;
        throw new Error(String(why.reason));
      }
      out = { oriole: o.value, heap: h.value };
      pair = out; // registered before waiting, so a failure below still tears down
    }
    hookExit(ctx);
    pair = out;
    for (const p of [out.oriole, out.heap]) {
      const st = await waitHealthy(ctx, p.ref);
      if (st !== "ACTIVE_HEALTHY") throw new Error(`${p.role} did not reach ACTIVE_HEALTHY (last ${st || "unknown"})`);
      p.host = await poolerHost(ctx, p.ref);
    }
    await Promise.all([waitConnectable(out.oriole), waitConnectable(out.heap)]);
    // The heap control was created with a 2 GB disk and the OrioleDB project with 8 GB
    // (OR01a, 2026-10-10); OR_HEAP_DISK_GB sets the control's disk so the two match.
    const want = Number(process.env.OR_HEAP_DISK_GB ?? "0");
    if (want > 0 && out.heap.owned) {
      const put = await mgmt(ctx, "POST", `/projects/${out.heap.ref}/config/disk`, {
        attributes: { type: "gp3", size_gb: want, iops: 3000, throughput_mibps: 125 },
      });
      if (put.status >= 300) throw new Error(`disk resize to ${want} GB: HTTP ${put.status} ${put.text.slice(0, 200)}`);
      for (let i = 0; i < 60; i++) {
        await sleep(10_000);
        const g = await mgmt(ctx, "GET", `/projects/${out.heap.ref}/config/disk`);
        const sz = (g.json as { attributes?: { size_gb?: number } } | undefined)?.attributes?.size_gb;
        const st = String(((await mgmt(ctx, "GET", `/projects/${out.heap.ref}`)).json as { status?: string } | undefined)?.status ?? "");
        if (sz === want && st === "ACTIVE_HEALTHY") break;
      }
      await waitConnectable(out.heap);
    }
    return out;
  })();
  try {
    return await creating;
  } catch (e) {
    await teardownPair(ctx);
    throw e;
  }
}

/**
 * An extra OrioleDB project for statements that can wedge the server (OR06
 * features, OR07 replication and Realtime, OR08 conversion). Created on first
 * use, deleted with the pair. `PVLAB_PEER_<LABEL>` reuses an existing one.
 */
export async function ensureExtra(ctx: Ctx, label: ExtraLabel): Promise<Proj> {
  const have = extras.get(label);
  if (have) return have;
  const p = (async () => {
    const reuse = ctx.peers[label];
    let proj: Proj;
    if (reuse) {
      proj = { role: label, ref: reuse, name: "(reused)", password: ctx.dbPassword, host: "", owned: false };
    } else {
      if (!ctx.orgs.pro) throw new Error("PVLAB_ORG_PRO is required to create an extra project");
      proj = await create(ctx, label, Date.now(), true);
    }
    extraProjs.push(proj);
    hookExit(ctx);
    const st = await waitHealthy(ctx, proj.ref);
    if (st !== "ACTIVE_HEALTHY") throw new Error(`${label} did not reach ACTIVE_HEALTHY (last ${st || "unknown"})`);
    proj.host = await poolerHost(ctx, proj.ref);
    await waitConnectable(proj);
    return proj;
  })();
  extras.set(label, p);
  return p;
}

export function currentPair(): Record<Role, Proj> | undefined {
  return pair;
}

/** Delete the projects this process created and wait until both are gone from the listing. */
export async function teardownPair(ctx: Ctx): Promise<{ deleted: string[]; stillListed: string[] }> {
  const deleted: string[] = [];
  const stillListed: string[] = [];
  const p = pair;
  pair = undefined;
  creating = undefined;
  const all = [...(p ? [p.oriole, p.heap] : []), ...extraProjs.splice(0)];
  extras.clear();
  if (!all.length) return { deleted, stillListed };
  for (const proj of all) {
    if (!proj.owned) continue;
    const r = await mgmt(ctx, "DELETE", `/projects/${proj.ref}`);
    if (r.status >= 200 && r.status < 300) deleted.push(proj.role);
    else ctx.log(`delete ${proj.role}: HTTP ${r.status} ${r.text.slice(0, 120)}`);
  }
  const owned = all.filter((x) => x.owned);
  for (let i = 0; i < 30 && owned.length; i++) {
    const l = await mgmt(ctx, "GET", "/projects");
    const refs = new Set((Array.isArray(l.json) ? (l.json as Array<{ ref?: string; id?: string }>) : []).map((x) => x.ref ?? x.id ?? ""));
    const left = owned.filter((x) => refs.has(x.ref));
    if (!left.length) return { deleted, stillListed: [] };
    if (i === 29) stillListed.push(...left.map((x) => x.role));
    await sleep(5_000);
  }
  return { deleted, stillListed };
}

function hookExit(ctx: Ctx): void {
  if (hooked) return;
  hooked = true;
  // Last resort: a stray socket error must not end the process before the artifact is written.
  process.on("uncaughtException", (e) => console.log(`  (uncaught, ignored: ${String((e as Error)?.message ?? e).slice(0, 160)})`));
  const sweep = async () => {
    if (pair || extraProjs.length) await teardownPair(ctx);
  };
  process.on("beforeExit", () => {
    void sweep();
  });
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      void sweep().finally(() => process.exit(130));
    });
  }
}

/** Run a statement on a connection and return the error text instead of throwing. */
export async function tryQuery(c: Client, text: string, params?: unknown[]): Promise<{ ok: boolean; rows: Record<string, unknown>[]; error: string }> {
  try {
    const r = await c.query(text, params as unknown[] | undefined);
    return { ok: true, rows: (r as { rows: Record<string, unknown>[] }).rows ?? [], error: "" };
  } catch (e) {
    return { ok: false, rows: [], error: (e as Error).message.replace(/\s+/g, " ").slice(0, 240) };
  }
}
