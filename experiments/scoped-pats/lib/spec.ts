/**
 * The Management API OpenAPI document declares, per operation,
 * `x-fga-permissions`: a list of permission-name lists (read 2026-10-10 from
 * https://api.supabase.com/api/v1-json). The reading used here is DNF: the
 * outer list is OR, each inner list is AND. That reading is itself a
 * hypothesis; SP02 compares it with what a scoped token is actually refused.
 *
 * Probes are generated from the document at run time so a new endpoint is
 * picked up without an edit, and so the doc's claim and the observed
 * refusal are compared on the same operation.
 */
import { classifyBody } from "../../../harness/src/mgmt.js";

export const SPEC_URL = process.env.PVLAB_SP_SPEC_URL ?? "https://api.supabase.com/api/v1-json";

export type Needs = string[][];

export interface Op {
  method: string;
  path: string;
  operationId: string;
  needs: Needs | null;
  oauthScope: string | null;
  pathParams: string[];
  requiredQuery: string[];
  internal: boolean;
}

export interface Spec {
  ops: Op[];
  pathCount: number;
  sha256: string;
  bytes: number;
}

export async function fetchSpec(): Promise<Spec | { error: string }> {
  const res = await fetch(SPEC_URL, { headers: { "User-Agent": "pvlab-scoped-pats/1.0" }, signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  const cls = classifyBody(res.headers.get("content-type"), text);
  if (res.status !== 200 || !cls.json || Array.isArray(cls.json)) return { error: `HTTP ${res.status}` };
  const doc = cls.json as { paths?: Record<string, Record<string, unknown>> };
  const ops: Op[] = [];
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const [method, raw] of Object.entries(item)) {
      const o = raw as {
        operationId?: string;
        parameters?: Array<{ name: string; in: string; required?: boolean }>;
        "x-fga-permissions"?: Needs;
        "x-oauth-scope"?: string;
        "x-internal"?: boolean;
        responses?: unknown;
      };
      if (!o || typeof o !== "object" || !o.responses) continue;
      const ps = o.parameters ?? [];
      ops.push({
        method: method.toUpperCase(),
        path,
        operationId: o.operationId ?? "",
        needs: o["x-fga-permissions"] ?? null,
        oauthScope: o["x-oauth-scope"] ?? null,
        pathParams: ps.filter((p) => p.in === "path").map((p) => p.name),
        requiredQuery: ps.filter((p) => p.in === "query" && p.required).map((p) => p.name),
        internal: o["x-internal"] === true,
      });
    }
  }
  const hash = new Bun.CryptoHasher("sha256").update(text).digest("hex");
  return { ops, pathCount: Object.keys(doc.paths ?? {}).length, sha256: hash.slice(0, 16), bytes: text.length };
}

export interface Probe {
  id: string;
  method: "GET" | "POST";
  /** Path with `{ref}` / `{slug}` placeholders, relative to /v1. */
  template: string;
  query?: string;
  body?: unknown;
  needs: Needs;
}

/** Paths a read-only sweep must not touch even with a GET. */
const SKIP = [/claim-token/, /\/oauth\//, /project-claim/];

/**
 * GET operations whose only path parameters are `ref` / `slug`, with no
 * required query parameter, plus explicit probes the spec cannot express.
 */
export function buildProbes(ops: Op[]): Probe[] {
  const probes: Probe[] = [];
  for (const o of ops) {
    if (o.method !== "GET" || !o.needs) continue;
    if (o.pathParams.some((p) => p !== "ref" && p !== "slug")) continue;
    if (o.requiredQuery.length) continue;
    if (SKIP.some((re) => re.test(o.path))) continue;
    probes.push({
      id: o.operationId || `${o.method} ${o.path}`,
      method: "GET",
      template: o.path.replace(/^\/v1/, ""),
      needs: o.needs,
    });
  }
  const q = ops.find((o) => o.method === "POST" && o.path === "/v1/projects/{ref}/database/query/read-only");
  if (q?.needs) {
    probes.push({
      id: "sql-select-readonly-endpoint",
      method: "POST",
      template: "/projects/{ref}/database/query/read-only",
      body: { query: "select 1 as one" },
      needs: q.needs,
    });
  }
  const w = ops.find((o) => o.method === "POST" && o.path === "/v1/projects/{ref}/database/query");
  if (w?.needs) {
    probes.push({
      id: "sql-select-write-endpoint",
      method: "POST",
      template: "/projects/{ref}/database/query",
      body: { query: "select 1 as one" },
      needs: w.needs,
    });
  }
  // The reveal flag is a query parameter, not a separate operation. Docs: "API
  // Key Secrets for revealing keys" (personal-access-tokens guide).
  probes.push({
    id: "api-keys-reveal",
    method: "GET",
    template: "/projects/{ref}/api-keys",
    query: "reveal=true",
    needs: [["api_gateway_keys_read", "api_gateway_keys_secret_read"]],
  });
  return probes.sort((a, b) => a.id.localeCompare(b.id, "en"));
}

export function allowed(needs: Needs, grants: ReadonlySet<string>): boolean {
  return needs.some((all) => all.every((g) => grants.has(g)));
}

export const declaredNames = (needs: Needs): Set<string> => new Set(needs.flat());
