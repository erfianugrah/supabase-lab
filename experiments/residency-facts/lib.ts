/**
 * Shared helpers for residency-facts. Fetching keys via the Management API
 * (W10's pattern) keeps the Makefile free of key plumbing: a test needs only
 * `pat` in requires and PVLAB_REF set.
 */
import { $ } from "bun";
import type { Ctx } from "../../harness/src/types";
import { mgmt } from "../../harness/src/mgmt";

export interface ProjectKeys {
  anon?: string;
  service?: string;
}

export async function getKeys(ctx: Ctx): Promise<ProjectKeys> {
  const r = await mgmt(ctx, "GET", `/projects/${ctx.ref}/api-keys?reveal=true`);
  if (r.status !== 200 || !Array.isArray(r.json)) return {};
  const keys = r.json as Array<{ type?: string; api_key?: string }>;
  return {
    anon: keys.find((k) => k.type === "anon" || k.type === "publishable")?.api_key,
    service: keys.find((k) => k.type === "service_role" || k.type === "secret")?.api_key,
  };
}

/** The project's actual region, read back from the platform - never assumed. */
export async function projectRegion(ctx: Ctx): Promise<string> {
  const r = await mgmt(ctx, "GET", `/projects/${ctx.ref}`);
  const j = (r.json ?? {}) as Record<string, unknown>;
  return typeof j.region === "string" ? j.region : "";
}

export function h(headers: Headers, name: string): string {
  return headers.get(name) ?? "";
}

/**
 * SQL via the shared pooler (session mode, 5432). Direct db.<ref>.supabase.co
 * is IPv6-only, which the local vantage may not have; the pooler is IPv4 and
 * its hostname is derived from the project's actual region, read back from
 * the platform rather than assumed.
 */
export async function psql(ctx: Ctx, sql: string): Promise<{ ok: boolean; out: string }> {
  const region = await projectRegion(ctx);
  if (!region) return { ok: false, out: "could not read project region" };
  // Pooler hostnames carry a shard number (aws-0-<region>, aws-1-<region>).
  // Resolve both rather than assuming the shard.
  for (const shard of [0, 1]) {
    const host = `aws-${shard}-${region}.pooler.supabase.com`;
    const dns = await $`dig +short ${host} A`.quiet().nothrow();
    if (dns.exitCode !== 0 || !dns.stdout.toString().trim()) continue;
    const url = `postgres://postgres.${ctx.ref}:${encodeURIComponent(ctx.dbPassword)}@${host}:5432/postgres?sslmode=require`;
    const p = await $`psql ${url} -X -A -t -c ${sql}`.quiet().nothrow();
    return { ok: p.exitCode === 0, out: (p.stdout.toString() + p.stderr.toString()).trim() };
  }
  return { ok: false, out: `no pooler shard resolved for region ${region} (tried aws-0, aws-1)` };
}
