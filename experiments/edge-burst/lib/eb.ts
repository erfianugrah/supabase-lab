/**
 * Shared project, deploy and invocation plumbing for the edge-burst modules.
 *
 * One paid-org Micro per process in PVLAB_EB_REGION (default ap-northeast-1),
 * created on first use and memoised; EB99 deletes it. Every module calls
 * `ensureProject`, so any subset of EB01..EB03 runs on its own. Leftovers
 * are found by the name prefix PVLAB_EB_PREFIX (default "ef-burst-"): `make
 * sweep` lists them, `make sweep DELETE=1` deletes.
 *
 * The Management API is shared with other sessions on the same token
 * (about 120 requests per minute): `mgmtPatient` waits out a 429 or a
 * Cloudflare interstitial (honouring `retry-after`), and every poll here is
 * 5 s apart or slower.
 */
import { mgmt, mgmtBase, type MgmtResponse } from "../../../harness/src/mgmt.js";
import type { Ctx, TestResult } from "../../../harness/src/types.js";
import { coloOf, type Answer, type Fire } from "./load.js";

export const REGION = process.env.PVLAB_EB_REGION || "ap-northeast-1";
export const prefix = (): string => process.env.PVLAB_EB_PREFIX || "ef-burst-";
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 300);

export const NOOP_SLUG = "eb-noop";
export const RPC_SLUG = "eb-rpc";

export interface EbProject {
  ref: string;
  host: string;
  anon: string;
  pgVersion: string;
  createS: number;
  reused: boolean;
  /** Plan of the organization the project was created in ("unknown" for a reused project). */
  plan: string;
}

let cached: Promise<EbProject> | undefined;
let created: { ref: string } | undefined;

export const createdProject = (): { ref: string } | undefined => created;

export function skipWithout(ctx: Ctx, id: string, title: string): TestResult[] | null {
  if (!ctx.orgs.pro && !process.env.PVLAB_EB_REF) return [{ id, title, status: "skip", detail: "PVLAB_ORG_PRO not set: no Pro org to create the project in" }];
  return null;
}

/** Replace the project ref with a placeholder. */
export function scrub(s: string): string {
  return created ? s.split(created.ref).join("<ref>") : s;
}

/** mgmt() that waits out a 429 or an HTML interstitial, honouring retry-after (seconds) when present. */
export async function mgmtPatient(ctx: Ctx, method: string, path: string, body?: unknown, timeoutMs = 60_000, tries = 6): Promise<MgmtResponse> {
  let r: MgmtResponse | undefined;
  for (let i = 0; i < tries; i++) {
    try {
      r = await mgmt(ctx, method, path, body, timeoutMs);
    } catch (e) {
      r = { status: 0, text: errText(e), throttled: false };
    }
    if (r.status !== 429 && !r.throttled && r.status !== 0 && r.status < 502) return r;
    const ra = Number((r.json as { retry_after?: number } | undefined)?.retry_after ?? NaN);
    await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 15_000);
  }
  return r!;
}

export async function sql(ctx: Ctx, ref: string, query: string): Promise<{ status: number; rows: Record<string, unknown>[]; error: string }> {
  const r = await mgmtPatient(ctx, "POST", `/projects/${ref}/database/query`, { query }, 120_000);
  if (r.status < 300) return { status: r.status, rows: (Array.isArray(r.json) ? r.json : []) as Record<string, unknown>[], error: "" };
  return { status: r.status, rows: [], error: String((r.json as { message?: string } | undefined)?.message ?? r.text).slice(0, 300) };
}

async function statusOf(ctx: Ctx, ref: string): Promise<string> {
  const p = await mgmtPatient(ctx, "GET", `/projects/${ref}`);
  return String((p.json as { status?: string } | undefined)?.status ?? "");
}

export function ensureProject(ctx: Ctx): Promise<EbProject> {
  cached ??= create(ctx);
  return cached;
}

/** Micro project, the trivial SQL function the rpc arm calls, both functions deployed and answering. */
async function create(ctx: Ctx): Promise<EbProject> {
  const t0 = Date.now();
  let ref = process.env.PVLAB_EB_REF ?? "";
  const reused = Boolean(ref);
  let plan = "unknown";
  if (!reused) {
    const org = ctx.orgs.pro ?? "";
    if (!org) throw new Error("PVLAB_ORG_PRO not set");
    // The role is named `pro`, but the slug is whatever was passed: record the plan it actually has.
    plan = String((((await mgmtPatient(ctx, "GET", `/organizations/${org}`)).json ?? {}) as { plan?: string }).plan ?? "unknown");
    const res = await mgmtPatient(ctx, "POST", "/projects", {
      organization_slug: org,
      name: `${prefix()}${t0}`,
      db_pass: `${crypto.randomUUID().replaceAll("-", "")}Aa1!`,
      region: REGION,
      desired_instance_size: "micro",
    });
    ref = String((res.json as { ref?: string; id?: string } | undefined)?.ref ?? (res.json as { id?: string } | undefined)?.id ?? "");
    if (res.status !== 201 || !ref) throw new Error(`create project: HTTP ${res.status} ${res.text.slice(0, 200)}`);
    // Registered before any wait, so EB99 can delete a project that never got healthy.
    created = { ref };
    console.error(`[EB] created micro project in ${REGION}`);
  }
  let status = "";
  for (let i = 0; i < 90 && status !== "ACTIVE_HEALTHY"; i++) {
    if (i > 0) await sleep(10_000);
    status = await statusOf(ctx, ref);
  }
  if (status !== "ACTIVE_HEALTHY") throw new Error(`project not healthy: ${status}`);
  // ACTIVE_HEALTHY is not readiness: retry the first query.
  let version = "";
  for (let i = 0; i < 24 && !version; i++) {
    const r = await sql(ctx, ref, "select version() as v");
    version = String(r.rows[0]?.v ?? "");
    if (!version) await sleep(5_000);
  }
  if (!version) throw new Error("database never answered the management query");
  const fn = await sql(
    ctx,
    ref,
    `create or replace function public.eb_ping() returns int language sql stable as $$ select 1 $$;
     grant execute on function public.eb_ping() to anon, authenticated, service_role;
     notify pgrst, 'reload schema';`,
  );
  if (fn.error) throw new Error(`create eb_ping: ${fn.status} ${fn.error}`);

  const keys = await mgmtPatient(ctx, "GET", `/projects/${ref}/api-keys?reveal=true`);
  const rows = (Array.isArray(keys.json) ? keys.json : []) as { name?: string; api_key?: string }[];
  const anon = rows.find((k) => k.name === "anon")?.api_key ?? "";
  if (!anon) throw new Error(`no legacy anon key (api-keys HTTP ${keys.status})`);

  for (const [slug, src] of [
    [NOOP_SLUG, NOOP_SRC],
    [RPC_SLUG, RPC_SRC],
  ] as const) {
    const d = await deploy(ctx, ref, slug, src);
    if (d.status >= 300) throw new Error(`deploy ${slug}: HTTP ${d.status} ${scrub(d.text).slice(0, 200)}`);
    // A deploy is not done on its status: read it back.
    let present = false;
    for (let i = 0; i < 12 && !present; i++) {
      await sleep(5_000);
      present = (await mgmtPatient(ctx, "GET", `/projects/${ref}/functions/${slug}`)).status === 200;
    }
    if (!present) throw new Error(`${slug} absent from GET /functions after deploy`);
  }
  return { ref, host: `${ref}.supabase.co`, anon, pgVersion: version.split(" on ")[0] ?? version, createS: Math.round((Date.now() - t0) / 1000), reused, plan };
}

/** Delete the project and wait until the listing drops it (polls every 10 s). */
export async function deleteProject(ctx: Ctx, ref: string): Promise<{ deleteStatus: number; goneS: number }> {
  const del = await mgmtPatient(ctx, "DELETE", `/projects/${ref}`);
  const t0 = Date.now();
  while (Date.now() - t0 < 300_000) {
    const l = await mgmtPatient(ctx, "GET", "/projects");
    const arr = (Array.isArray(l.json) ? l.json : []) as { id?: string; ref?: string }[];
    if (l.status === 200 && !arr.some((x) => (x.ref ?? x.id) === ref)) return { deleteStatus: del.status, goneS: Math.round((Date.now() - t0) / 1000) };
    await sleep(10_000);
  }
  return { deleteStatus: del.status, goneS: -1 };
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/** Arm 1: no I/O, small JSON. */
export const NOOP_SRC = `Deno.serve(() => new Response(JSON.stringify({ ok: true, region: Deno.env.get("SB_REGION") ?? null }), { headers: { "Content-Type": "application/json" } }));
`;

/**
 * Arm 2: one supabase-js rpc() to a trivial SQL function, client created once
 * per isolate. Answers 200 whatever the rpc returned and reports the rpc's
 * status in the body, so an HTTP status other than 200 is the platform's,
 * not the database's.
 */
export const RPC_SRC = `import { createClient } from "npm:@supabase/supabase-js@2.118.0";
const key = Deno.env.get("SUPABASE_ANON_KEY") ?? JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") ?? "{}").default ?? "";
const sb = createClient(Deno.env.get("SUPABASE_URL") ?? "", key, { auth: { persistSession: false, autoRefreshToken: false } });
Deno.serve(async () => {
  const t0 = performance.now();
  try {
    const { error, status } = await sb.rpc("eb_ping");
    return Response.json({ ok: !error, rpc: status, rpc_ms: Math.round(performance.now() - t0), rpc_err: error ? String(error.code ?? error.message).slice(0, 120) : undefined, region: Deno.env.get("SB_REGION") ?? null });
  } catch (e) {
    return Response.json({ ok: false, rpc: null, rpc_err: String(e).slice(0, 120), region: Deno.env.get("SB_REGION") ?? null });
  }
});
`;

/** POST /functions/deploy (server-side bundling), verify_jwt false. */
export async function deploy(ctx: Ctx, ref: string, slug: string, src: string): Promise<{ status: number; text: string }> {
  for (let i = 0; i < 4; i++) {
    const form = new FormData();
    form.append("file", new Blob([src]), "index.ts");
    form.append("metadata", JSON.stringify({ name: slug, entrypoint_path: "index.ts", verify_jwt: false }));
    const res = await fetch(`${mgmtBase(ctx)}/projects/${ref}/functions/deploy?slug=${encodeURIComponent(slug)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ctx.pat}` },
      body: form,
      signal: AbortSignal.timeout(180_000),
    });
    const text = await res.text();
    if (res.status !== 429) return { status: res.status, text };
    await sleep(15_000);
  }
  return { status: 429, text: "throttled four times" };
}

/**
 * One invocation of `slug` pinned to REGION with `x-region`, legacy anon key
 * as apikey and bearer, keep-alive (Bun's default pooling).
 */
export function fireFor(p: EbProject, slug: string, timeoutMs = 30_000): Fire {
  const url = `https://${p.host}/functions/v1/${slug}`;
  const headers = { apikey: p.anon, Authorization: `Bearer ${p.anon}`, "x-region": REGION };
  return async (): Promise<Answer> => {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      const text = await res.text();
      return { status: res.status, contentType: res.headers.get("content-type") ?? "", text, region: res.headers.get("x-sb-edge-region") ?? "", colo: coloOf(res.headers.get("cf-ray")) };
    } catch (e) {
      return { status: 0, contentType: "", text: "", region: "", colo: "", err: errText(e) };
    }
  };
}

/** Header names and the routing values of one invocation, for the setup row. */
export async function headerProbe(p: EbProject, slug: string): Promise<Record<string, string>> {
  const res = await fetch(`https://${p.host}/functions/v1/${slug}`, {
    headers: { apikey: p.anon, Authorization: `Bearer ${p.anon}`, "x-region": REGION },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.text();
  const names = [...res.headers.keys()].sort().join(",");
  return {
    status: String(res.status),
    x_sb_edge_region: res.headers.get("x-sb-edge-region") ?? "",
    cf_colo: coloOf(res.headers.get("cf-ray")),
    server: res.headers.get("server") ?? "",
    sb_gateway_version: res.headers.get("sb-gateway-version") ?? "",
    header_names: names,
    body: scrub(body).slice(0, 200),
  };
}
