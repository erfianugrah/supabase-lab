/**
 * Self-provisioning helper for experiments/client-retries.
 *
 * A module creates one throwaway project on the Pro org (`PVLAB_ORG_PRO`),
 * seeds the fixture below, runs, and deletes it in `finally`. Names carry the
 * `CR_PROJECT_PREFIX` so a leak is recognisable in the org listing.
 */
import type { Ctx } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import { fetchKeys, sql, type ProjectKeys } from "../../../harness/src/platform.js";

export const CR_PROJECT_PREFIX = process.env.PVLAB_CR_PREFIX ?? "cr-retries-";
export const REGION = "ap-southeast-1";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Provisioned {
  ref: string;
  /** Child context with `ref`/`apiHost` set so harness helpers (sql, fetchKeys) target the project. */
  pctx: Ctx;
  keys: ProjectKeys;
  /** `https://<ref>.supabase.co` */
  baseUrl: string;
  provisionS: number;
}

/** Fixture: a readable table, a writable table, a stable RPC, all open to anon. */
const FIXTURE = [
  "create table if not exists public.cr_probe (id int primary key, note text)",
  "insert into public.cr_probe values (1, 'one'), (2, 'two') on conflict do nothing",
  "grant select on public.cr_probe to anon, authenticated",
  "create table if not exists public.cr_writes (id bigint generated always as identity primary key, tag text, at timestamptz default now())",
  "grant select, insert, update, delete on public.cr_writes to anon, authenticated",
  "create or replace function public.cr_ping() returns text language sql stable as $$ select 'pong' $$",
  "grant execute on function public.cr_ping() to anon, authenticated",
  "notify pgrst, 'reload schema'",
];

export async function provision(ctx: Ctx, tag: string): Promise<Provisioned | { error: string; ref?: string }> {
  const org = ctx.orgs.pro ?? "";
  if (!org) return { error: "PVLAB_ORG_PRO not set" };
  const t0 = Date.now();
  const create = await mgmt(ctx, "POST", "/projects", {
    organization_slug: org,
    name: `${CR_PROJECT_PREFIX}${tag}-${t0}`,
    db_pass: `${crypto.randomUUID()}Aa1!`,
    region: REGION,
    desired_instance_size: "micro",
  });
  const ref = (create.json as { ref?: string } | undefined)?.ref ?? "";
  if (create.status !== 201 || !ref) return { error: `create: HTTP ${create.status}: ${create.text.slice(0, 200)}` };
  let status = "";
  for (let i = 0; i < 90 && status !== "ACTIVE_HEALTHY"; i++) {
    await sleep(10_000);
    const p = await mgmt(ctx, "GET", `/projects/${ref}`);
    status = String((p.json as { status?: string } | undefined)?.status ?? "");
  }
  if (status !== "ACTIVE_HEALTHY") return { error: `not healthy after 15 min (status ${status})`, ref };
  const pctx: Ctx = { ...ctx, ref, apiHost: `${ref}.${ctx.apiHostSuffix ?? "supabase.co"}` };
  for (const s of FIXTURE) {
    const r = await sql(pctx, s);
    if (r.status >= 300) return { error: `fixture "${s.slice(0, 50)}": HTTP ${r.status} ${r.error}`, ref };
  }
  const keys = await fetchKeys(pctx);
  // The REST layer needs a moment after `notify pgrst`; wait on the request path.
  const base = `https://${pctx.apiHost}`;
  for (let i = 0; i < 30; i++) {
    const r = await fetch(`${base}/rest/v1/cr_probe?select=id`, { headers: { apikey: keys.anon } });
    if (r.status === 200) break;
    await sleep(2000);
  }
  return { ref, pctx, keys, baseUrl: base, provisionS: Math.round((Date.now() - t0) / 1000) };
}

export async function destroy(ctx: Ctx, ref: string): Promise<number> {
  if (!ref) return 0;
  const del = await mgmt(ctx, "DELETE", `/projects/${ref}`).catch(() => null);
  return del?.status ?? 0;
}

/** Admin-create a confirmed user (no email is sent) and return its credentials. */
export async function makeUser(p: Provisioned): Promise<{ email: string; password: string; id: string }> {
  const email = `cr-${Date.now()}@example.com`;
  const password = `${crypto.randomUUID()}Aa1!`;
  const r = await fetch(`${p.baseUrl}/auth/v1/admin/users`, {
    method: "POST",
    headers: { apikey: p.keys.service, authorization: `Bearer ${p.keys.service}`, "content-type": "application/json" },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const j = (await r.json()) as { id?: string };
  if (r.status >= 300 || !j.id) throw new Error(`admin create user: HTTP ${r.status}`);
  return { email, password, id: j.id };
}

/** Number of rows in cr_writes, read with the service key (bypasses the proxy). */
export async function writeCount(p: Provisioned, tag?: string): Promise<number> {
  const q = tag ? `select count(*)::int as n from public.cr_writes where tag = '${tag.replace(/'/g, "''")}'` : "select count(*)::int as n from public.cr_writes";
  const r = await sql(p.pctx, q);
  return Number(r.rows[0]?.n ?? -1);
}
