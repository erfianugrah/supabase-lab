/**
 * Shared assembly for the realtime-surface modules (RT01-RT05).
 *
 * Self-provisioning, like bu-attribution and sfp-platforms: `withProject`
 * creates a throwaway project on the Pro org (`ctx.orgs.pro`), runs the
 * module against it and deletes it in `finally`. No OpenTofu state. Setting
 * `PVLAB_PEER_RT=<ref>` reuses an existing project instead (never deleted),
 * which is how a module is iterated on without paying for a create per run;
 * every module's DDL is idempotent for that reason.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Client as PgClient } from "pg";
import { mgmt } from "../../../harness/src/mgmt";
import { fetchKeys, sql } from "../../../harness/src/platform";
import type { Ctx, TestResult } from "../../../harness/src/types";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 300);

export interface Proj {
  ref: string;
  url: string;
  host: string;
  anon: string;
  service: string;
  /** Ctx with `ref` set, for harness helpers such as `sql()`. */
  ctx: Ctx;
  /** true when the module created it (and therefore deletes it). */
  owned: boolean;
  dbPass: string;
}

/** Management call that waits out a throttle instead of recording it as a failure. */
export async function mg(ctx: Ctx, method: string, path: string, body?: unknown) {
  let r = await mgmt(ctx, method, path, body);
  for (let i = 0; i < 6 && (r.throttled || r.status === 429); i++) {
    await sleep(15_000);
    r = await mgmt(ctx, method, path, body);
  }
  return r;
}

export async function waitHealthy(ctx: Ctx, ref: string, maxMs = 15 * 60_000): Promise<string> {
  const end = Date.now() + maxMs;
  let status = "";
  while (Date.now() < end && status !== "ACTIVE_HEALTHY") {
    await sleep(10_000);
    const p = await mg(ctx, "GET", `/projects/${ref}`);
    status = String((p.json as { status?: string } | undefined)?.status ?? "");
  }
  return status;
}

/**
 * Self-skip contract: a module that needs a project but has neither the Pro
 * org (`PVLAB_ORG_PRO`) nor a reusable project (`PVLAB_PEER_RT`) returns this
 * skip row instead of a "module threw" failure. Null means the module can run.
 */
export function skipWithoutOrg(ctx: Ctx, id: string, title: string): TestResult[] | null {
  if (ctx.orgs.pro || ctx.peers.rt) return null;
  return [{ id, title, status: "skip", detail: "PVLAB_ORG_PRO not set (and no PVLAB_PEER_RT project to reuse)" }];
}

export async function withProject<T>(ctx: Ctx, label: string, fn: (p: Proj) => Promise<T>): Promise<T> {
  const org = ctx.orgs.pro ?? "";
  if (!org) throw new Error("PVLAB_ORG_PRO not set");
  let ref = ctx.peers.rt ?? "";
  const dbPass = process.env.PVLAB_RT_DBPASS || `${crypto.randomUUID()}Aa1!`;
  let owned = false;
  try {
    if (!ref) {
      const create = await mg(ctx, "POST", "/projects", {
        organization_slug: org,
        name: `rt-${label}-${Date.now()}`,
        db_pass: dbPass,
        region: "ap-southeast-1",
      });
      ref = String((create.json as { ref?: string } | undefined)?.ref ?? "");
      if (create.status !== 201 || !ref) throw new Error(`create HTTP ${create.status}: ${create.text.slice(0, 200)}`);
      owned = true;
      ctx.log(`[${label}] created project`);
      const st = await waitHealthy(ctx, ref);
      if (st !== "ACTIVE_HEALTHY") throw new Error(`project not healthy: ${st}`);
    }
    const pctx: Ctx = { ...ctx, ref };
    let keys: Awaited<ReturnType<typeof fetchKeys>> | undefined;
    for (let i = 0; i < 12 && !keys; i++) {
      try {
        keys = await fetchKeys(pctx);
      } catch {
        await sleep(10_000);
      }
    }
    if (!keys) throw new Error("api keys never appeared");
    const host = `${ref}.${ctx.apiHostSuffix ?? "supabase.co"}`;
    const proj: Proj = { ref, url: `https://${host}`, host, anon: keys.anon, service: keys.service, ctx: pctx, owned, dbPass };
    return await fn(proj);
  } finally {
    if (ref && owned) {
      const d = await mg(ctx, "DELETE", `/projects/${ref}`);
      ctx.log(`[${label}] delete project HTTP ${d.status}`);
    }
  }
}

export async function ddl(p: Proj, query: string): Promise<void> {
  const r = await sql(p.ctx, query);
  if (r.status >= 300) throw new Error(`sql HTTP ${r.status}: ${r.error}`);
}

export async function rows(p: Proj, query: string): Promise<Record<string, unknown>[]> {
  const r = await sql(p.ctx, query);
  if (r.status >= 300) throw new Error(`sql HTTP ${r.status}: ${r.error}`);
  return r.rows;
}

/**
 * Direct session on the shared pooler (IPv4-reachable), so a module can issue
 * many short statements without spending Management API budget. Each
 * statement autocommits, so `now()` differs per statement. Needs the DB
 * password the project was created with (`PVLAB_RT_DBPASS` when reusing a
 * project through `PVLAB_PEER_RT`).
 */
export async function pgConnect(p: Proj): Promise<PgClient> {
  const r = await mg(p.ctx, "GET", `/projects/${p.ref}/config/database/pooler`);
  const arr = Array.isArray(r.json)
    ? (r.json as Array<{ database_type?: string; db_host?: string; db_user?: string; db_name?: string }>)
    : [];
  const e = arr.find((x) => x.database_type === "PRIMARY") ?? arr[0];
  if (!e?.db_host) throw new Error("no pooler entry");
  // The entry lists transaction mode on 6543; session mode is 5432 on the same host.
  const c = new PgClient({
    host: e.db_host,
    port: 5432,
    user: e.db_user ?? `postgres.${p.ref}`,
    database: e.db_name ?? "postgres",
    password: p.dbPass,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15_000,
  });
  await c.connect();
  return c;
}

/* ---------- auth user + clients ---------- */

export interface TestUser {
  id: string;
  email: string;
  password: string;
  token: string;
}

export async function makeUser(p: Proj, tag: string): Promise<TestUser> {
  const email = `rt-${tag}-${Date.now()}@example.com`;
  const password = `${crypto.randomUUID()}Aa1!`;
  let id = "";
  for (let i = 0; i < 6 && !id; i++) {
    const res = await fetch(`${p.url}/auth/v1/admin/users`, {
      method: "POST",
      headers: { apikey: p.service, Authorization: `Bearer ${p.service}`, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, email_confirm: true }),
    });
    const j = (await res.json().catch(() => ({}))) as { id?: string };
    id = j.id ?? "";
    if (!id) await sleep(5000);
  }
  if (!id) throw new Error("admin create user failed");
  const c = anonClient(p);
  const { data, error } = await c.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw new Error(`sign-in failed: ${error?.message}`);
  await c.removeAllChannels();
  return { id, email, password, token: data.session.access_token };
}

export type ClientOpts = { realtime?: Record<string, unknown> };

export function anonClient(p: Proj, opts: ClientOpts = {}): SupabaseClient {
  return createClient(p.url, p.anon, {
    auth: { persistSession: false, autoRefreshToken: false },
    ...(opts.realtime ? { realtime: opts.realtime as never } : {}),
  });
}

/**
 * A client signed in as the user. The session matters: with only a header or
 * `realtime.setAuth(token)`, supabase-js swaps the realtime token back to the
 * anon key on its next token refresh and `httpSend` then answers 401/403
 * (measured 2026-10-10, RT04), which is a client-construction artefact, not
 * platform behaviour.
 */
export async function userClient(p: Proj, u: TestUser, opts: ClientOpts = {}): Promise<SupabaseClient> {
  const c = anonClient(p, opts);
  const { error } = await c.auth.signInWithPassword({ email: u.email, password: u.password });
  if (error) throw new Error(`sign-in failed: ${error.message}`);
  return c;
}

export function serviceClient(p: Proj): SupabaseClient {
  return createClient(p.url, p.service, { auth: { persistSession: false, autoRefreshToken: false } });
}

/* ---------- channel helpers ---------- */

export interface SubState {
  status: string;
  err: string;
  events: Array<Record<string, any>>;
  subscribedAtMs: number;
  statusLog: Array<{ t: number; status: string; err?: string }>;
  /** `system` channel events (the server reports subscription problems here). */
  system: string[];
}

export function newState(): SubState {
  return { status: "", err: "", events: [], subscribedAtMs: -1, statusLog: [], system: [] };
}

/** Wait for a subscribe callback to settle on SUBSCRIBED or a terminal error. */
export function subscribeAndWait(
  channel: ReturnType<SupabaseClient["channel"]>,
  st: SubState,
  timeoutMs = 20_000,
): Promise<void> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (!st.status) st.status = "NO_CALLBACK";
      resolve();
    }, timeoutMs);
    channel.subscribe((status, err) => {
      st.status = status;
      st.err = err ? errText(err) : st.err;
      st.statusLog.push({ t: Date.now(), status, ...(err ? { err: errText(err) } : {}) });
      if (status === "SUBSCRIBED") st.subscribedAtMs = Date.now() - t0;
      if (status === "SUBSCRIBED" || status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

/**
 * Poll until the project's Realtime tenant accepts a join. A freshly healthy
 * project can refuse the WebSocket for a short while.
 */
export async function waitRealtime(p: Proj, maxMs = 120_000): Promise<number> {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const c = anonClient(p);
    const st = newState();
    const ch = c.channel(`ready-${Date.now()}`);
    await subscribeAndWait(ch, st, 10_000);
    const joined = st.statusLog.some((l) => l.status === "SUBSCRIBED"); // removeAllChannels then overwrites st.status with CLOSED
    await c.removeAllChannels();
    await c.realtime.disconnect();
    if (joined) return Date.now() - t0;
    await sleep(5000);
  }
  return -1;
}

/**
 * End-to-end readiness for Postgres Changes on one table: subscribe, insert a
 * canary row every 10 s (`insertSql(k)` for the k-th insert, k from 1), and
 * return the ms until the first event arrives (-1 on timeout) with the index
 * of the canary insert that arrived. A subscribe that answers SUBSCRIBED
 * proves the join, not that the change stream is wired to the table.
 */
export async function waitCdc(
  p: Proj,
  table: string,
  insertSql: (k: number) => string,
  maxMs = 240_000,
): Promise<{ ms: number; inserts: number; firstDeliveredInsert: number; events: number }> {
  const c = anonClient(p);
  const st = newState();
  const ch = c.channel(`cdc-ready-${table}-${Date.now()}`);
  const marks: number[] = [];
  (ch as any).on("postgres_changes", { event: "INSERT", schema: "public", table }, (e: Record<string, any>) => {
    marks.push(Number(e.new?.seq ?? e.new?.n));
    st.events.push(e);
  });
  await subscribeAndWait(ch, st, 20_000);
  const t0 = Date.now();
  let last = 0;
  let k = 0;
  while (Date.now() - t0 < maxMs && st.events.length === 0) {
    if (Date.now() - last > 10_000) {
      k++;
      await ddl(p, insertSql(k));
      last = Date.now();
    }
    await sleep(250);
  }
  const ms = st.events.length ? Date.now() - t0 : -1;
  await sleep(1500);
  const firstMark = marks[0];
  const out = { ms, inserts: k, firstDeliveredInsert: Math.abs(Number(firstMark ?? 0)), events: st.events.length };
  await c.removeAllChannels();
  await c.realtime.disconnect();
  return out;
}

export interface MessagesWarm {
  /** `realtime.messages` existed / partitions listed when the project first turned healthy */
  preExists: boolean;
  prePartitions: number;
  realtimeReadyMs: number;
  /** ms from the first Realtime join until a partition for today (UTC) existed; -1 if never */
  partitionMs: number;
}

/**
 * On a project that has never had a Realtime connection, `realtime.messages`
 * has no partition for today until the Realtime service has set the tenant up:
 * the first private join answered `MissingPartition` and `realtime.send`
 * persisted nothing (RT03/RT04 first run, 2026-10-10). Connect once, then wait
 * for today's partition, and report what was there before.
 */
export async function warmMessages(p: Proj, maxMs = 180_000): Promise<MessagesWarm> {
  const probe = `select to_regclass('realtime.messages') is not null as ex,
    coalesce((select count(*) from pg_inherits i where i.inhparent = to_regclass('realtime.messages')), 0)::int as parts,
    to_regclass('realtime.messages_' || to_char(now() at time zone 'utc', 'YYYY_MM_DD')) is not null as today`;
  const pre = (await rows(p, probe))[0] ?? {};
  const realtimeReadyMs = await waitRealtime(p);
  const t0 = Date.now();
  let partitionMs = -1;
  while (Date.now() - t0 < maxMs) {
    const r = (await rows(p, probe))[0] ?? {};
    if (r.today === true) {
      partitionMs = Date.now() - t0;
      break;
    }
    await sleep(5000);
  }
  return { preExists: pre.ex === true, prePartitions: Number(pre.parts ?? 0), realtimeReadyMs, partitionMs };
}

export const bytesEq =(a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

export const ids = (evs: Array<Record<string, any>>, pick: (e: Record<string, any>) => unknown): number[] =>
  evs.map((e) => Number(pick(e))).sort((a, b) => a - b);

/**
 * Drop every policy on `realtime.messages` so a module's RLS result is its own
 * policies alone. Permissive policies OR together: a leftover `with check (true)`
 * from an earlier module on a reused project made RT04's "read-only topic" look
 * writable (2026-10-10).
 */
export const dropMessagePolicies = `do $$ declare r record; begin
  for r in select policyname from pg_policies where schemaname = 'realtime' and tablename = 'messages' loop
    execute format('drop policy %I on realtime.messages', r.policyname);
  end loop;
end $$;`;
