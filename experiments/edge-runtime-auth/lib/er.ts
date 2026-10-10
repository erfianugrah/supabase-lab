/**
 * Shared plumbing for the edge-runtime-auth modules: a self-provisioned
 * project, JWT helpers, and a credential probe that records the response
 * shape (status, whether the handler ran, which layer refused).
 *
 * Project naming: the prefix comes from ER_PROJECT_PREFIX so a run can tag its
 * projects for teardown by name; the default is generic.
 */
import { createHmac } from "node:crypto";
import { mgmt } from "../../../harness/src/mgmt";
import type { Ctx } from "../../../harness/src/types";

export const PREFIX = process.env.ER_PROJECT_PREFIX || "er-";
export const REGION = "ap-southeast-1";

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function b64url(input: Uint8Array | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeJwt(token: string): { header: Record<string, unknown>; payload: Record<string, unknown> } {
  const [h, p] = token.split(".");
  const dec = (s: string | undefined) => JSON.parse(Buffer.from(s ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
  return { header: dec(h), payload: dec(p) };
}

/** A legacy-style HS256 JWT: no `kid` in the header, signed with the project's shared JWT secret. */
export function mintHs256(secret: string, claims: Record<string, unknown>): string {
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(claims));
  const sig = createHmac("sha256", secret).update(`${head}.${body}`).digest();
  return `${head}.${body}.${b64url(sig)}`;
}

/** Percentile by nearest rank on a copy; empty input gives -1. */
export function percentile(values: number[], p: number): number {
  if (!values.length) return -1;
  const s = [...values].sort((a, b) => a - b);
  const rank = Math.min(s.length, Math.max(1, Math.ceil((p / 100) * s.length)));
  return s[rank - 1]!;
}

/** The ctx a self-provisioned project needs: ref and the host derived from it. */
export function projectCtx(ctx: Ctx, ref: string): Ctx {
  return { ...ctx, ref, apiHost: `${ref}.${ctx.apiHostSuffix ?? "supabase.co"}` };
}

async function retryMgmt(ctx: Ctx, method: string, path: string, body?: unknown, tries = 6) {
  let r = await mgmt(ctx, method, path, body);
  for (let i = 0; i < tries && (r.throttled || r.status === 429); i++) {
    await sleep(15_000);
    r = await mgmt(ctx, method, path, body);
  }
  return r;
}

export async function createProject(ctx: Ctx, org: string, label: string): Promise<{ ref: string; status: number; createMs: number; text: string }> {
  const t0 = Date.now();
  const r = await retryMgmt(ctx, "POST", "/projects", {
    organization_slug: org,
    name: `${PREFIX}${label}-${t0}`,
    db_pass: `${crypto.randomUUID()}Aa1!`,
    region: REGION,
  });
  const ref = ((r.json as { ref?: string } | undefined)?.ref ?? "") as string;
  return { ref, status: r.status, createMs: Date.now() - t0, text: r.text.slice(0, 300) };
}

/**
 * ACTIVE_HEALTHY is not readiness (AGENTS.md): wait for the status, then for the
 * keys listing to carry both generations, then for the Auth health endpoint.
 */
export async function waitProjectReady(ctx: Ctx, ref: string, maxMs = 20 * 60_000): Promise<{ ok: boolean; seconds: number; status: string }> {
  const t0 = Date.now();
  let status = "";
  while (Date.now() - t0 < maxMs) {
    const p = await retryMgmt(ctx, "GET", `/projects/${ref}`);
    status = ((p.json as { status?: string } | undefined)?.status ?? "") as string;
    if (status === "ACTIVE_HEALTHY") break;
    await sleep(10_000);
  }
  if (status !== "ACTIVE_HEALTHY") return { ok: false, seconds: Math.round((Date.now() - t0) / 1000), status };
  const pc = projectCtx(ctx, ref);
  while (Date.now() - t0 < maxMs) {
    const keys = await retryMgmt(pc, "GET", `/projects/${ref}/api-keys?reveal=true`);
    const rows = Array.isArray(keys.json) ? (keys.json as { type?: string; name?: string }[]) : [];
    const haveAll = ["anon", "service_role"].every((n) => rows.some((k) => k.name === n)) && rows.some((k) => k.type === "publishable") && rows.some((k) => k.type === "secret");
    if (haveAll) {
      const h = await fetch(`https://${pc.apiHost}/auth/v1/health`, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
      if (h?.status === 200 || h?.status === 401) return { ok: true, seconds: Math.round((Date.now() - t0) / 1000), status };
    }
    await sleep(10_000);
  }
  return { ok: false, seconds: Math.round((Date.now() - t0) / 1000), status };
}

export async function deleteProject(ctx: Ctx, ref: string): Promise<number> {
  let st = 0;
  for (let i = 0; i < 6; i++) {
    const r = await mgmt(ctx, "DELETE", `/projects/${ref}`).catch(() => ({ status: 0, throttled: false }) as { status: number; throttled: boolean });
    st = r.status;
    if ((st >= 200 && st < 300) || st === 404) return st;
    await sleep(r.throttled || st === 429 ? 15_000 : 5_000);
  }
  return st;
}

export interface Keys {
  anon: string;
  service: string;
  publishable: string;
  secret: string;
}

export async function revealKeys(ctx: Ctx): Promise<Keys> {
  const r = await retryMgmt(ctx, "GET", `/projects/${ctx.ref}/api-keys?reveal=true`);
  const rows = Array.isArray(r.json) ? (r.json as { name?: string; type?: string; api_key?: string }[]) : [];
  const byName = (n: string) => rows.find((k) => k.name === n)?.api_key ?? "";
  const byType = (t: string) => rows.find((k) => k.type === t && k.name === "default")?.api_key ?? rows.find((k) => k.type === t)?.api_key ?? "";
  const keys = { anon: byName("anon"), service: byName("service_role"), publishable: byType("publishable"), secret: byType("secret") };
  if (!keys.anon || !keys.service || !keys.publishable || !keys.secret) throw new Error(`api-keys incomplete (HTTP ${r.status})`);
  return keys;
}

/** Observed shape of one credentialed request. */
export interface Observed {
  status: number;
  ran: boolean;
  /** x-supabase-server-error response header: the library refused. */
  serverError: string;
  /** Layer that refused, "" when the handler ran. */
  refusedBy: "" | "library" | "gateway" | "other";
  authMode: string;
  gatewayMessage: string;
  /** First 300 characters of the response body. */
  body: string;
  ms: number;
}

export async function probe(url: string, headers: Record<string, string>, timeoutMs = 20_000): Promise<Observed> {
  const t0 = performance.now();
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      /* non-JSON body */
    }
    const ran = res.headers.get("x-er-handler") === "ran";
    const serverError = res.headers.get("x-supabase-server-error") ?? "";
    const refusedBy: Observed["refusedBy"] = ran ? "" : serverError ? "library" : res.status === 401 || res.status === 403 ? "gateway" : "other";
    return {
      status: res.status,
      ran,
      serverError,
      refusedBy,
      authMode: ran ? String(json.authMode ?? "") : "",
      gatewayMessage: !ran && !serverError ? String(json.message ?? json.msg ?? json.error ?? text.slice(0, 60)).slice(0, 60) : "",
      body: text.slice(0, 300),
      ms: Math.round(performance.now() - t0),
    };
  } catch (e) {
    return { status: 0, ran: false, serverError: "", refusedBy: "other", authMode: "", gatewayMessage: `ERR:${(e instanceof Error ? e.message : String(e)).slice(0, 50)}`, body: "", ms: Math.round(performance.now() - t0) };
  }
}

/** One short cell: "200 ran:user", "401 lib:INVALID_JWT", "401 gw:Invalid JWT". */
export function cell(o: Observed): string {
  if (o.ran) return `${o.status} ran:${o.authMode || "?"}`;
  if (o.refusedBy === "library") return `${o.status} lib:${o.serverError}`;
  if (o.refusedBy === "gateway") return `${o.status} gw:${o.gatewayMessage}`;
  return `${o.status} other:${o.gatewayMessage}`;
}
