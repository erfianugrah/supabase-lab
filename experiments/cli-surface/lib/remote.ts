/**
 * Self-provisioning remote project for the linked-project modules: a throwaway
 * project named `pvlab-cli-<tag>-<ts>` on the Free org, created through the
 * Management API and deleted in the caller's `finally`. No OpenTofu state, the
 * same pattern as bu-attribution and sfp-platforms.
 */
import { mgmt } from "../../../harness/src/mgmt";
import { fetchKeys, sql } from "../../../harness/src/platform";
import type { Ctx } from "../../../harness/src/types";
import { sleep } from "./cli";

export interface RemoteProject {
  ref: string;
  name: string;
  dbPass: string;
  createdMs: number;
  healthyMs: number;
  ctx: Ctx;
}

export async function createProject(ctx: Ctx, org: string, tag: string, region = "ap-southeast-1"): Promise<RemoteProject> {
  const t0 = Date.now();
  const name = `pvlab-cli-${tag}-${t0}`;
  const dbPass = `${crypto.randomUUID()}Aa1!`;
  const r = await mgmt(ctx, "POST", "/projects", { organization_slug: org, name, db_pass: dbPass, region });
  const ref = (r.json as { ref?: string; id?: string } | undefined)?.ref ?? "";
  if (r.status !== 201 || !ref) throw new Error(`project create HTTP ${r.status}: ${r.text.slice(0, 200)}`);
  const createdMs = Date.now() - t0;
  let status = "";
  for (let i = 0; i < 90 && status !== "ACTIVE_HEALTHY"; i++) {
    await sleep(10_000);
    const p = await mgmt(ctx, "GET", `/projects/${ref}`);
    status = String((p.json as { status?: string } | undefined)?.status ?? "");
  }
  if (status !== "ACTIVE_HEALTHY") throw new Error(`project ${name} not healthy after 15 min (last status ${status})`);
  return { ref, name, dbPass, createdMs, healthyMs: Date.now() - t0, ctx: { ...ctx, ref, region } };
}

export async function deleteProject(ctx: Ctx, p: RemoteProject | undefined): Promise<boolean> {
  if (!p) return true;
  for (let i = 0; i < 3; i++) {
    const r = await mgmt(ctx, "DELETE", `/projects/${p.ref}`);
    if (r.status === 200 || r.status === 404) return true;
    await sleep(5_000);
  }
  return false;
}

export async function remoteSql(p: RemoteProject, query: string): Promise<{ ok: boolean; error: string }> {
  const r = await sql(p.ctx, query, 120_000);
  return { ok: r.status < 300, error: r.error };
}

export async function serviceKey(p: RemoteProject): Promise<string> {
  return (await fetchKeys(p.ctx)).service;
}

/** One entry of `supabase config pull --dry-run` text output. */
export interface ConfigDiffEntry {
  key: string;
  tags: string[];
  local: string;
  remote: string;
}

export function parseConfigDiff(text: string): { entries: ConfigDiffEntry[]; summary: string; scope: string; notes: string[] } {
  const lines = text.split("\n");
  const entries: ConfigDiffEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(/^([a-z0-9_.\-"]+) \[([^\]]+)\]\s*$/i);
    if (!m) continue;
    const loc = lines[i + 1]?.match(/^\s+local:\s*(.*)$/);
    const rem = lines[i + 2]?.match(/^\s+remote:\s*(.*)$/);
    entries.push({ key: m[1]!, tags: m[2]!.split(",").map((s) => s.trim()), local: loc?.[1] ?? "", remote: rem?.[1] ?? "" });
  }
  return {
    entries,
    summary: lines.find((l) => /differences? found|no differences|up to date/i.test(l)) ?? "",
    scope: lines.find((l) => /^Comparison scope:/.test(l)) ?? "",
    notes: lines.filter((l) => /^Note:/.test(l)),
  };
}
