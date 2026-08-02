/**
 * Builds the run context and probes capabilities, so tests never hand-roll
 * "is this available" checks.
 */
import { $ } from "bun";
import type { Capability, Ctx, Where } from "./types";

async function has(cmd: string): Promise<boolean> {
  try {
    await $`which ${cmd}`.quiet();
    return true;
  } catch {
    return false;
  }
}

async function version(cmd: string, args: string[]): Promise<string> {
  try {
    const out = await $`${cmd} ${args}`.quiet().text();
    return out.trim().split("\n")[0] ?? "unknown";
  } catch {
    return "absent";
  }
}

export interface CtxInput {
  where: Where;
  ref?: string;
  phzHost?: string;
  dbPassword?: string;
  anonKey?: string;
  pat?: string;
  region?: string;
  endpointIps?: string[];
  quiet?: boolean;
}

/**
 * On the runner, /etc/pvlab/env carries the facts written at provisioning time.
 * Locally they come from flags/env. Either way the shape is identical.
 */
async function runnerEnv(): Promise<Record<string, string>> {
  const f = Bun.file("/etc/pvlab/env");
  if (!(await f.exists())) return {};
  const out: Record<string, string> = {};
  for (const line of (await f.text()).split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z_]+)=["']?([^"'\n]*)["']?\s*$/);
    if (m?.[1]) out[m[1]] = m[2] ?? "";
  }
  return out;
}

export async function buildCtx(input: CtxInput): Promise<Ctx> {
  const env = input.where === "runner" ? await runnerEnv() : {};
  const ref = input.ref ?? env.REF ?? process.env.PVLAB_REF ?? "";
  const phzHost = input.phzHost ?? env.PHZ_HOST ?? (ref ? `db.${ref}.supabase.co` : "");
  const dbPassword = input.dbPassword ?? process.env.DB_PASSWORD ?? "";
  const anonKey = input.anonKey ?? process.env.SUPABASE_ANON_KEY ?? undefined;
  const pat = input.pat ?? process.env.SUPABASE_ACCESS_TOKEN ?? undefined;
  let endpointIps =
    input.endpointIps ?? (env.ENDPOINT_IPS ? env.ENDPOINT_IPS.trim().split(/\s+/) : []);
  // The runner is replaced during phase 2, before the ENI addresses exist, so
  // its baked-in env can be empty. Resolve the PHZ name instead of silently
  // skipping every endpoint-dependent test.
  if (!endpointIps.length && phzHost) {
    const dug = await $`dig +short ${phzHost} A`.quiet().nothrow().text().catch(() => "");
    endpointIps = dug
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^\d+\.\d+\.\d+\.\d+$/.test(l));
  }

  const capabilities = new Set<Capability>();
  if (dbPassword && phzHost) capabilities.add("db");
  if (endpointIps.length) capabilities.add("endpoint");
  if (anonKey) capabilities.add("anon-key");
  if (pat) capabilities.add("pat");
  if (await has("pgbench")) capabilities.add("pgbench");
  if (await has("openssl")) capabilities.add("openssl");
  if (input.where === "local" && process.env.PVLAB_LAMBDA === "1") capabilities.add("lambda");

  return {
    ref,
    phzHost,
    apiHost: ref ? `${ref}.supabase.co` : "",
    dbPassword,
    anonKey,
    pat,
    region: input.region ?? env.REGION ?? process.env.AWS_REGION ?? "ap-southeast-1",
    endpointIps,
    capabilities,
    where: input.where,
    log: (m) => {
      if (!input.quiet) console.log(`  ${m}`);
    },
  };
}

export async function toolVersions(): Promise<Record<string, string>> {
  return {
    bun: Bun.version,
    psql: await version("psql", ["--version"]),
    pgbench: await version("pgbench", ["--version"]),
    openssl: await version("openssl", ["version"]),
  };
}
