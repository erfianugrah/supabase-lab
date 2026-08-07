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
  peers?: Record<string, string>;
  orgSlugs?: string[];
  endpoints?: Record<string, string>;
  quiet?: boolean;
}

/**
 * `PVLAB_PEER_SPOKE=abc` -> `{ spoke: "abc" }`. Roles are experiment-defined;
 * the harness only carries them, so adding a three-project experiment needs
 * no change here.
 */
export function readPeers(env: Record<string, string | undefined>): Record<string, string> {
  const peers: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    const m = k.match(/^PVLAB_PEER_([A-Z0-9_]+)$/);
    if (m?.[1] && v) peers[m[1].toLowerCase()] = v;
  }
  return peers;
}

/**
 * `PVLAB_ENDPOINT_POOLER=host` -> `{ pooler: "host" }`. Roles are
 * experiment-defined, exactly as with peers. `PVLAB_ENDPOINT_IPS` is excluded:
 * it predates this and is parsed on its own in buildCtx.
 */
export function readEndpoints(env: Record<string, string | undefined>): Record<string, string> {
  const endpoints: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (k === "PVLAB_ENDPOINT_IPS") continue;
    const m = k.match(/^PVLAB_ENDPOINT_([A-Z0-9_]+)$/);
    if (m?.[1] && v) endpoints[m[1].toLowerCase()] = v;
  }
  return endpoints;
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

/**
 * Pure capability derivation, split out so the gating rules are testable
 * without touching a network or a filesystem. Run 7 shipped a bug here -
 * endpoint IPs were read from an env file that is empty because the runner is
 * replaced during phase 2 - and no test could have caught it.
 */
export function deriveCapabilities(f: {
  dbPassword?: string;
  phzHost?: string;
  endpointIps?: string[];
  anonKey?: string;
  pat?: string;
  peers?: Record<string, string>;
  orgSlugs?: string[];
  endpoints?: Record<string, string>;
  hasPgbench?: boolean;
  hasOpenssl?: boolean;
  lambdaEnabled?: boolean;
  where?: Where;
}): Set<Capability> {
  const caps = new Set<Capability>();
  if (f.dbPassword && f.phzHost) caps.add("db");
  if (f.endpointIps?.length) caps.add("endpoint");
  if (f.anonKey) caps.add("anon-key");
  if (f.pat) caps.add("pat");
  if (f.peers && Object.keys(f.peers).length) caps.add("peer");
  if (f.orgSlugs?.length) caps.add("org");
  if (f.endpoints?.pooler) caps.add("pooler");
  // Both are experiment-specific probe targets read the same way as pooler -
  // present only once the matching tofu toggle was applied AND the invoking
  // shell exported it, so a missing endpoint is a skip, not a probe against
  // an empty string. Vantage-restricted the same way "lambda" is: the second
  // VPC's Lambda is invoked from the orchestrator, the service network's DNS
  // name only resolves from inside the lab VPC (the runner).
  if (f.where === "local" && f.endpoints?.second_vpc_lambda) caps.add("second-vpc");
  if (f.where === "runner" && f.endpoints?.service_network_dns) caps.add("service-network");
  if (f.hasPgbench) caps.add("pgbench");
  if (f.hasOpenssl) caps.add("openssl");
  if (f.where === "local" && f.lambdaEnabled) caps.add("lambda");
  return caps;
}

export async function buildCtx(input: CtxInput): Promise<Ctx> {
  const env = input.where === "runner" ? await runnerEnv() : {};
  const ref = input.ref ?? env.REF ?? process.env.PVLAB_REF ?? "";
  const phzHost = input.phzHost ?? env.PHZ_HOST ?? (ref ? `db.${ref}.supabase.co` : "");
  const dbPassword = input.dbPassword ?? process.env.DB_PASSWORD ?? "";
  const anonKey = input.anonKey ?? process.env.SUPABASE_ANON_KEY ?? undefined;
  const pat = input.pat ?? process.env.SUPABASE_ACCESS_TOKEN ?? undefined;
  let endpointIps =
    input.endpointIps ??
    (process.env.PVLAB_ENDPOINT_IPS
      ? process.env.PVLAB_ENDPOINT_IPS.trim().split(/[\s,]+/).filter(Boolean)
      : env.ENDPOINT_IPS
        ? env.ENDPOINT_IPS.trim().split(/\s+/)
        : []);
  // The runner is replaced during phase 2, before the ENI addresses exist, so
  // its baked-in env can be empty. Resolve the PHZ name instead of silently
  // skipping every endpoint-dependent test.
  if (!endpointIps.length && phzHost && input.where === "runner") {
    const dug = await $`dig +short ${phzHost} A`.quiet().nothrow().text().catch(() => "");
    endpointIps = dug
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^\d+\.\d+\.\d+\.\d+$/.test(l));
  }

  const peers = input.peers ?? readPeers(process.env);
  const orgSlugs =
    input.orgSlugs ??
    (process.env.PVLAB_ORG_SLUGS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

  const endpoints = input.endpoints ?? readEndpoints(process.env);

  const capabilities = deriveCapabilities({
    dbPassword,
    phzHost,
    endpointIps,
    anonKey,
    pat,
    peers,
    orgSlugs,
    endpoints,
    hasPgbench: await has("pgbench"),
    hasOpenssl: await has("openssl"),
    lambdaEnabled: process.env.PVLAB_LAMBDA === "1",
    where: input.where,
  });

  return {
    ref,
    phzHost,
    apiHost: ref ? `${ref}.supabase.co` : "",
    dbPassword,
    anonKey,
    pat,
    region: input.region ?? env.REGION ?? process.env.AWS_REGION ?? "ap-southeast-1",
    endpointIps,
    peers,
    orgSlugs,
    endpoints,
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
