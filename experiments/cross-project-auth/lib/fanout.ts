/**
 * Self-provisioned project pair for the fan-out modules (X04-X07, X99).
 *
 * A tenant-per-project layout: project A issues identity (its Auth) and holds
 * half of a tenant's rows; project B trusts A through third-party auth
 * (`oidc_issuer_url`, the shape X01 showed resolving on create) and holds the
 * other half. One A-issued token reads both Data APIs.
 *
 * Unlike X01-X03 there is no OpenTofu state: two Pro-org projects are created
 * through POST /v1/projects on first use, memoised for the process, and X99
 * deletes both. Name prefix PVLAB_XF_PREFIX (default "pvlab-xf-");
 * `lib/fanout-cleanup.ts` lists or deletes leftovers by prefix. When
 * PVLAB_REFS_FILE is set, each created ref is appended to it as soon as the
 * create call answers, so a run that dies still leaves a record outside git.
 *
 * Data (tenant "tenant-a" unless noted), same table shape on both projects:
 *   public.fan_items (id uuid pk, tenant_id text, created_at timestamptz, body text, src text)
 *   RLS: select to authenticated using tenant_id = jwt app_metadata.tenant_id
 *   index (tenant_id, created_at desc, id desc)
 *   - SLOTS timestamps 250 ms apart, each placed on A or B by a fixed hash;
 *   - every 10th slot is a cluster of three rows within ONE millisecond
 *     (+0, +1, +2 microseconds) spread over both projects;
 *   - every 25th slot has a twin on the other project with the IDENTICAL
 *     created_at (an exact cross-project tie, broken by id);
 *   - TENANT_B_ROWS rows of "tenant-b" on each project, never visible to A's user.
 *   A also holds public.fan_all = the union of both projects' rows, same RLS,
 *   which is the single-project baseline "the same rows in one place".
 */
import type { Ctx, TestResult } from "../../../harness/src/types.js";
import { mgmt, mgmtBase } from "../../../harness/src/mgmt.js";
import { appendFile } from "node:fs/promises";
import type { Row } from "./merge.js";

export const REGION = "ap-southeast-1";
export const SLOTS = 1000;
export const TENANT_B_ROWS = 300;
export const FN_SLUG = "fanout";
export const prefix = (): string => process.env.PVLAB_XF_PREFIX || "pvlab-xf-";
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Proj {
  role: "a" | "b";
  ref: string;
  host: string;
  url: string;
  anon: string;
  service: string;
  createMs: number;
  pgVersion: string;
  compute: string;
}

export interface Pair {
  a: Proj;
  b: Proj;
  /** tenant-a and tenant-b access tokens, issued by A. */
  tokA: string;
  tokB: string;
  /** Rows of tenant-a seeded on each project, and the union. */
  seeded: { a: number; b: number; all: number; ties: number; clusters: number };
  /** Ground truth: every tenant-a row, newest first by (created_at, id), read as postgres on A. */
  truth: Row[];
  tpaId: string;
  setupNotes: string[];
}

const created: Partial<Record<"a" | "b", string>> = {};
let cached: Promise<Pair> | null = null;
let current: Pair | null = null;

export const createdRefs = (): string[] => Object.values(created).filter((x): x is string => !!x);
export const currentPair = (): Pair | null => current;

export function skipWithoutPro(ctx: Ctx, id: string): TestResult[] | null {
  if (ctx.orgs.pro) return null;
  return [{ id, title: id, status: "skip", detail: "PVLAB_ORG_PRO not set: no Pro org to create the projects in" }];
}

export function ensurePair(ctx: Ctx): Promise<Pair> {
  if (!cached) cached = build(ctx);
  return cached;
}

/** Replace every created ref so evidence text carries no identifier. */
export function redact(s: string): string {
  let out = s;
  for (const [role, ref] of Object.entries(created)) if (ref) out = out.replaceAll(ref, `<ref-${role}>`);
  return out;
}
export const brief = (s: string, n = 200): string => redact(s).replace(/\s+/g, " ").slice(0, n);

// ---------------------------------------------------------------------------
// SQL and REST helpers
// ---------------------------------------------------------------------------

export async function sql(ctx: Ctx, ref: string, query: string): Promise<{ status: number; rows: Record<string, unknown>[]; error?: string }> {
  for (let i = 0; ; i++) {
    const r = await mgmt(ctx, "POST", `/projects/${ref}/database/query`, { query }, 120_000);
    if ((r.throttled || r.status === 429) && i < 6) {
      await sleep(10_000 * (i + 1));
      continue;
    }
    if (r.status < 300) return { status: r.status, rows: (Array.isArray(r.json) ? r.json : []) as Record<string, unknown>[] };
    return { status: r.status, rows: [], error: String((r.json as { message?: string } | undefined)?.message ?? r.text).slice(0, 400) };
  }
}

async function sqlOk(ctx: Ctx, ref: string, query: string): Promise<Record<string, unknown>[]> {
  const r = await sql(ctx, ref, query);
  if (r.status >= 300) throw new Error(`setup SQL failed (${r.status}): ${redact(r.error ?? "")}`);
  return r.rows;
}

export interface Rest {
  status: number;
  body: string;
  json?: unknown;
  ms: number;
}

export async function rest(url: string, init: { apikey: string; bearer?: string; method?: string; body?: unknown; headers?: Record<string, string>; timeoutMs?: number }): Promise<Rest> {
  const headers: Record<string, string> = { apikey: init.apikey, Authorization: `Bearer ${init.bearer ?? init.apikey}`, ...(init.headers ?? {}) };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  const t0 = performance.now();
  try {
    const res = await fetch(url, {
      method: init.method ?? "GET",
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(init.timeoutMs ?? 20_000),
    });
    const body = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      json = undefined;
    }
    return { status: res.status, body, json, ms: Math.round((performance.now() - t0) * 10) / 10 };
  } catch (e) {
    return { status: 0, body: e instanceof Error ? `${e.name}: ${e.message}` : String(e), ms: Math.round((performance.now() - t0) * 10) / 10 };
  }
}

export const codeOf = (r: Rest): string => ((r.json as { code?: string } | undefined)?.code ?? "") || (r.status >= 300 || r.status === 0 ? `HTTP${r.status}` : "");

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

/** Nearest-rank percentile; -1 on an empty sample. */
export function pct(xs: number[], p: number): number {
  if (!xs.length) return -1;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return Math.round((s[i] ?? -1) * 10) / 10;
}

export function summary(prefix: string, xs: number[]): Record<string, number> {
  return {
    [`${prefix}n`]: xs.length,
    [`${prefix}p50_ms`]: pct(xs, 50),
    [`${prefix}p95_ms`]: pct(xs, 95),
    [`${prefix}p99_ms`]: pct(xs, 99),
    [`${prefix}max_ms`]: pct(xs, 100),
  };
}

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

async function createProject(ctx: Ctx, role: "a" | "b", stamp: number): Promise<{ ref: string; t0: number }> {
  const org = ctx.orgs.pro ?? "";
  const t0 = Date.now();
  for (let i = 0; ; i++) {
    const res = await mgmt(ctx, "POST", "/projects", {
      organization_slug: org,
      name: `${prefix()}${stamp}-${role}`,
      db_pass: `${crypto.randomUUID().replaceAll("-", "")}Aa1!`,
      region: REGION,
    });
    const ref = ((res.json as { ref?: string; id?: string } | undefined)?.ref ?? (res.json as { id?: string } | undefined)?.id ?? "") as string;
    if (res.status === 201 && ref) {
      created[role] = ref;
      if (process.env.PVLAB_REFS_FILE) await appendFile(process.env.PVLAB_REFS_FILE, `${ref} ${prefix()}${stamp}-${role} created ${new Date().toISOString()}\n`);
      return { ref, t0 };
    }
    if ((res.throttled || res.status === 429) && i < 5) {
      await sleep(15_000 * (i + 1));
      continue;
    }
    throw new Error(`create project ${role}: HTTP ${res.status} ${res.text.slice(0, 200)}`);
  }
}

async function ready(ctx: Ctx, role: "a" | "b", ref: string, t0: number): Promise<Proj> {
  let status = "";
  for (let i = 0; i < 120 && status !== "ACTIVE_HEALTHY"; i++) {
    if (i > 0) await sleep(10_000);
    const p = await mgmt(ctx, "GET", `/projects/${ref}`);
    status = ((p.json as { status?: string } | undefined)?.status ?? "") as string;
  }
  if (status !== "ACTIVE_HEALTHY") throw new Error(`project ${role} not healthy: ${status}`);
  let version = "";
  for (let i = 0; i < 24 && !version; i++) {
    const r = await sql(ctx, ref, "select version() as v");
    version = (r.rows[0]?.v as string | undefined) ?? "";
    if (!version) await sleep(5_000);
  }
  if (!version) throw new Error(`project ${role}: database never answered the management query`);
  const k = await mgmt(ctx, "GET", `/projects/${ref}/api-keys?reveal=true`);
  const rows = (Array.isArray(k.json) ? k.json : []) as { name: string; api_key?: string }[];
  const anon = rows.find((x) => x.name === "anon")?.api_key ?? "";
  const service = rows.find((x) => x.name === "service_role")?.api_key ?? "";
  if (!anon || !service) throw new Error(`project ${role}: legacy anon/service_role keys absent`);
  // Compute size is read back, not assumed: the create call sends none.
  const add = await mgmt(ctx, "GET", `/projects/${ref}/billing/addons`);
  const sel = ((add.json as { selected_addons?: { type?: string; variant?: { id?: string } }[] } | undefined)?.selected_addons ?? []) as {
    type?: string;
    variant?: { id?: string };
  }[];
  const compute = sel.find((x) => x.type === "compute_instance")?.variant?.id ?? `unread (HTTP ${add.status})`;
  return { role, ref, host: `${ref}.supabase.co`, url: `https://${ref}.supabase.co`, anon, service, createMs: Date.now() - t0, pgVersion: version.split(" on ")[0] ?? version, compute };
}

const SCHEMA = (table: string) => `
create table if not exists public.${table} (
  id uuid primary key,
  tenant_id text not null,
  created_at timestamptz not null,
  body text not null,
  src text not null);
create index if not exists ${table}_keyset on public.${table} (tenant_id, created_at desc, id desc);
alter table public.${table} enable row level security;
drop policy if exists tenant_read on public.${table};
create policy tenant_read on public.${table} for select to authenticated
  using (tenant_id = (select auth.jwt() -> 'app_metadata' ->> 'tenant_id'));
grant usage on schema public to authenticated;
grant select on public.${table} to authenticated;
`;

interface SeedRow {
  id: string;
  tenant: string;
  ts: string;
  src: "a" | "b";
}

const BASE_MS = Date.parse("2026-10-01T00:00:00Z");

/** Microsecond-precision timestamptz literal. */
function tsLit(ms: number, micros: number): string {
  const d = new Date(ms);
  const iso = d.toISOString(); // ...T..:..:..mmmZ
  const frac = String(d.getUTCMilliseconds() * 1000 + micros).padStart(6, "0");
  return `${iso.slice(0, 19)}.${frac}+00`;
}

/** Deterministic placement hash: which project a slot lands on. */
const side = (k: number): "a" | "b" => ((k * 7919 + 13) % 11 < 5 ? "a" : "b");
const other = (s: "a" | "b"): "a" | "b" => (s === "a" ? "b" : "a");

export function seedRows(): { rows: SeedRow[]; ties: number; clusters: number } {
  const rows: SeedRow[] = [];
  let ties = 0;
  let clusters = 0;
  for (let k = 0; k < SLOTS; k++) {
    // 250 ms apart, plus a sub-millisecond offset so most rows carry microseconds.
    const ms = BASE_MS - k * 250;
    const micro = (k % 7) * 13 + 100;
    const s = side(k);
    rows.push({ id: crypto.randomUUID(), tenant: "tenant-a", ts: tsLit(ms, micro), src: s });
    if (k % 10 === 0) {
      clusters++;
      rows.push({ id: crypto.randomUUID(), tenant: "tenant-a", ts: tsLit(ms, micro + 1), src: other(s) });
      rows.push({ id: crypto.randomUUID(), tenant: "tenant-a", ts: tsLit(ms, micro + 2), src: s });
    }
    if (k % 25 === 0) {
      ties++;
      rows.push({ id: crypto.randomUUID(), tenant: "tenant-a", ts: tsLit(ms, micro), src: other(s) });
    }
  }
  for (const s of ["a", "b"] as const) {
    for (let i = 0; i < TENANT_B_ROWS; i++) rows.push({ id: crypto.randomUUID(), tenant: "tenant-b", ts: tsLit(BASE_MS - i * 333, 7), src: s });
  }
  return { rows, ties, clusters };
}

const values = (rows: SeedRow[]) => rows.map((r) => `('${r.id}','${r.tenant}','${r.ts}','body-${r.id.slice(0, 8)}','${r.src}')`).join(",\n");

async function insert(ctx: Ctx, ref: string, table: string, rows: SeedRow[]) {
  for (let i = 0; i < rows.length; i += 800) {
    await sqlOk(ctx, ref, `insert into public.${table} (id, tenant_id, created_at, body, src) values ${values(rows.slice(i, i + 800))};`);
  }
}

/** Ask PostgREST to reload and poll until `path` stops answering PGRST205. */
async function awaitExposed(ctx: Ctx, p: Proj, table: string): Promise<number> {
  await sql(ctx, p.ref, "notify pgrst, 'reload schema'");
  const t0 = Date.now();
  while (Date.now() - t0 < 90_000) {
    const r = await rest(`${p.url}/rest/v1/${table}?select=id&limit=1`, { apikey: p.service });
    if (r.status === 200) return Math.round((Date.now() - t0) / 1000);
    await sleep(2_000);
  }
  return -1;
}

async function user(p: Proj, tenant: string): Promise<string> {
  const email = `xf-${tenant}-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const password = `${crypto.randomUUID()}Aa1!`;
  // First admin write on a fresh project can 500 (AGENTS.md, provisioning): retry.
  let c: Rest | undefined;
  for (let i = 0; i < 8; i++) {
    c = await rest(`${p.url}/auth/v1/admin/users`, {
      apikey: p.service,
      method: "POST",
      body: { email, password, email_confirm: true, app_metadata: { tenant_id: tenant } },
    });
    if (c.status === 200 || c.status === 201) break;
    await sleep(5_000);
  }
  if (!c || (c.status !== 200 && c.status !== 201)) throw new Error(`admin create user: HTTP ${c?.status} ${brief(c?.body ?? "")}`);
  const s = await rest(`${p.url}/auth/v1/token?grant_type=password`, { apikey: p.anon, method: "POST", body: { email, password } });
  const token = (s.json as { access_token?: string } | undefined)?.access_token ?? "";
  if (!token) throw new Error(`password grant: HTTP ${s.status} ${brief(s.body)}`);
  return token;
}

export async function listTpa(ctx: Ctx, ref: string): Promise<{ id?: string }[]> {
  const r = await mgmt(ctx, "GET", `/projects/${ref}/config/auth/third-party-auth`);
  return Array.isArray(r.json) ? (r.json as { id?: string }[]) : [];
}

export async function createTpa(ctx: Ctx, pair: { a: Proj; b: Proj }): Promise<{ status: number; id: string; text: string }> {
  const r = await mgmt(ctx, "POST", `/projects/${pair.b.ref}/config/auth/third-party-auth`, { oidc_issuer_url: `${pair.a.url}/auth/v1` });
  return { status: r.status, id: ((r.json as { id?: string } | undefined)?.id ?? "") as string, text: r.text };
}

export async function deleteTpa(ctx: Ctx, ref: string, id: string): Promise<number> {
  return (await mgmt(ctx, "DELETE", `/projects/${ref}/config/auth/third-party-auth/${id}`)).status;
}

/** Poll `probe` every `stepMs` until `ok`, return ms waited (-1 on budget exhausted). */
export async function until(probe: () => Promise<Rest>, ok: (r: Rest) => boolean, budgetMs: number, stepMs = 500): Promise<{ ms: number; last: Rest }> {
  const t0 = performance.now();
  let last = await probe();
  while (!ok(last)) {
    if (performance.now() - t0 > budgetMs) return { ms: -1, last };
    await sleep(stepMs);
    last = await probe();
  }
  return { ms: Math.round(performance.now() - t0), last };
}

/** The tenant-a read of one project's fan_items, all rows (below max-rows). */
export const readAll = (p: Proj, bearer: string, table = "fan_items") =>
  rest(`${p.url}/rest/v1/${table}?select=id,tenant_id,src&limit=1000`, { apikey: p.anon, bearer });

async function build(ctx: Ctx): Promise<Pair> {
  if (!ctx.orgs.pro) throw new Error("PVLAB_ORG_PRO not set");
  const notes: string[] = [];
  const stamp = Date.now();
  const ca = await createProject(ctx, "a", stamp);
  const cb = await createProject(ctx, "b", stamp);
  const [a, b] = await Promise.all([ready(ctx, "a", ca.ref, ca.t0), ready(ctx, "b", cb.ref, cb.t0)]);

  await sqlOk(ctx, a.ref, SCHEMA("fan_items") + SCHEMA("fan_all"));
  await sqlOk(ctx, b.ref, SCHEMA("fan_items"));
  const seed = seedRows();
  await insert(ctx, a.ref, "fan_items", seed.rows.filter((r) => r.src === "a"));
  await insert(ctx, b.ref, "fan_items", seed.rows.filter((r) => r.src === "b"));
  await insert(ctx, a.ref, "fan_all", seed.rows);
  await sqlOk(ctx, a.ref, "analyze public.fan_items; analyze public.fan_all;");
  await sqlOk(ctx, b.ref, "analyze public.fan_items;");
  notes.push(`exposed after a=${await awaitExposed(ctx, a, "fan_all")}s b=${await awaitExposed(ctx, b, "fan_items")}s`);

  const tokA = await user(a, "tenant-a");
  const tokB = await user(a, "tenant-b");

  const truthRows = await sqlOk(
    ctx,
    a.ref,
    "select id::text as id, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US') as ts from public.fan_all where tenant_id = 'tenant-a' order by created_at desc, id desc",
  );
  const truth: Row[] = truthRows.map((r) => ({ id: String(r.id), created_at: `${String(r.ts)}+00:00` }));
  const ta = seed.rows.filter((r) => r.tenant === "tenant-a");

  current = {
    a,
    b,
    tokA,
    tokB,
    seeded: { a: ta.filter((r) => r.src === "a").length, b: ta.filter((r) => r.src === "b").length, all: ta.length, ties: seed.ties, clusters: seed.clusters },
    truth,
    tpaId: "",
    setupNotes: notes,
  };
  return current;
}

// ---------------------------------------------------------------------------
// Edge Function on A: the same merge code (lib/merge.ts) plus a handler.
// ---------------------------------------------------------------------------

// Any path containing "/hang" is a target that accepts the request and does
// not answer for HANG_MS: X07's "never answers" leg, without an address literal.
export const HANG_MS = 20_000;
const HANDLER = `
Deno.serve(async (req: Request) => {
  if (new URL(req.url).pathname.includes("/hang")) {
    await new Promise((r) => setTimeout(r, ${HANG_MS}));
    return new Response("late", { status: 504 });
  }
  const t0 = performance.now();
  const b = await req.json();
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\\s+/i, "");
  const r = await fanout(b.targets, bearer, b.qs, b.limit, { policy: b.policy, timeoutMs: b.timeoutMs, exact: b.exact !== false });
  return Response.json({ ...r, inner_ms: Math.round((performance.now() - t0) * 10) / 10, region: Deno.env.get("SB_REGION") ?? null });
});
`;

export async function edgeSource(): Promise<string> {
  const merge = await Bun.file(new URL("./merge.ts", import.meta.url)).text();
  return `${merge}\n${HANDLER}`;
}

export async function deployFn(ctx: Ctx, p: Proj): Promise<{ status: number; text: string }> {
  const form = new FormData();
  form.append("file", new Blob([await edgeSource()]), "index.ts");
  // verify_jwt false: the function does not verify the caller; each Data API
  // it calls verifies the forwarded token itself.
  form.append("metadata", JSON.stringify({ name: FN_SLUG, entrypoint_path: "index.ts", verify_jwt: false }));
  const res = await fetch(`${mgmtBase(ctx)}/projects/${p.ref}/functions/deploy?slug=${FN_SLUG}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ctx.pat}` },
    body: form,
    signal: AbortSignal.timeout(180_000),
  });
  return { status: res.status, text: (await res.text()).slice(0, 300) };
}

export interface EdgeCall {
  status: number;
  ms: number;
  inner_ms: number;
  region: string;
  servedBy: string;
  ok: boolean;
  partial: boolean;
  rows: Row[];
  legs: { name: string; status: number; ms: number; rows: number; code?: string; err?: string }[];
  error?: string;
  raw?: string;
}

export async function callFn(
  p: Proj,
  bearer: string,
  body: { targets: unknown[]; qs: string; limit: number; policy: string; timeoutMs: number; exact?: boolean },
  timeoutMs = 30_000,
): Promise<EdgeCall> {
  const t0 = performance.now();
  try {
    const res = await fetch(`${p.url}/functions/v1/${FN_SLUG}`, {
      method: "POST",
      headers: { apikey: p.anon, Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    const ms = Math.round((performance.now() - t0) * 10) / 10;
    let j: Partial<EdgeCall> & { region?: string | null } = {};
    try {
      j = JSON.parse(text);
    } catch {
      /* non-json */
    }
    return {
      status: res.status,
      ms,
      inner_ms: j.inner_ms ?? -1,
      region: j.region ?? "",
      servedBy: res.headers.get("x-sb-edge-region") ?? "",
      ok: res.status === 200 && j.ok === true,
      partial: j.partial === true,
      rows: (j.rows ?? []) as Row[],
      legs: j.legs ?? [],
      error: j.error,
      raw: res.status === 200 ? undefined : text.slice(0, 200),
    };
  } catch (e) {
    const ms = Math.round((performance.now() - t0) * 10) / 10;
    return { status: 0, ms, inner_ms: -1, region: "", servedBy: "", ok: false, partial: false, rows: [], legs: [], error: e instanceof Error ? e.message : String(e) };
  }
}

/** Delete both projects (idempotent) and wait until the listing drops them. */
export async function teardownPair(ctx: Ctx): Promise<{ deleted: Record<string, number>; goneS: number }> {
  const deleted: Record<string, number> = {};
  for (const [role, ref] of Object.entries(created)) if (ref) deleted[role] = (await mgmt(ctx, "DELETE", `/projects/${ref}`)).status;
  const refs = createdRefs();
  const t0 = Date.now();
  let goneS = -1;
  while (Date.now() - t0 < 300_000) {
    const l = await mgmt(ctx, "GET", "/projects");
    const arr = (Array.isArray(l.json) ? l.json : []) as { id?: string; ref?: string }[];
    if (l.status === 200 && !arr.some((x) => refs.includes(x.ref ?? x.id ?? ""))) {
      goneS = Math.round((Date.now() - t0) / 1000);
      break;
    }
    await sleep(10_000);
  }
  return { deleted, goneS };
}
