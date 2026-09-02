/**
 * The documented figures, pinned with the date they were read.
 *
 * Every module in this experiment compares the runtime against THESE numbers,
 * not against a live fetch of the docs page: a docs page that changes under a
 * run would make "docs vs runtime" mean something different per run, and the
 * point of pinning is that `pvlab --diff` can show which side moved. When the
 * docs change, edit this file and bump DOCS_READ_AT in the same commit.
 *
 * Source: https://supabase.com/docs/guides/functions/limits
 */
export const DOCS_URL = "https://supabase.com/docs/guides/functions/limits";
export const DOCS_READ_AT = "2026-09-02";

export type Plan = "free" | "pro" | "team" | "enterprise";

/** Functions per project. Plan-gated - the only ceiling here that is. */
export const FUNCTIONS_PER_PROJECT: Record<Plan, number | "unlimited"> = {
  free: 100,
  pro: 1000,
  team: 2000,
  enterprise: "unlimited",
};

/**
 * Function size, by WHERE BUNDLING HAPPENS - not by plan. Local bundling
 * (CLI with Docker) gets the larger ceiling; server-side bundling (Management
 * API, Dashboard, and the CLI's --use-api path) gets the smaller one.
 */
export const FUNCTION_SIZE_MB = { cli: 20, api: 5 } as const;

/** Four separate limits that get reported as "the secrets limit". */
export const SECRETS = {
  maxPerProject: 100,
  maxValueChars: 24_576,
  maxValueBytes: 48 * 1024,
  maxNameChars: 256,
  reservedPrefix: "SUPABASE_",
} as const;

export const RUNTIME = {
  memoryMb: 256,
  cpuMs: 2_000,
  wallClockS: { free: 150, paid: 400 },
  idleTimeoutS: 150,
  recursiveRequestsPerMinute: 5_000,
} as const;

/** Outbound ports the runtime refuses (direct SMTP). */
export const BLOCKED_PORTS = [25, 587] as const;

/**
 * Reverse lookup: a reported hard cap identifies the plan it belongs to. A cap
 * of exactly 1000 says "Pro" - worth confirming before treating it as a
 * platform limit, because an org running several projects across several
 * orgs may be hitting it in the one nobody was looking at.
 */
export function planForFunctionCap(cap: number): Plan | undefined {
  for (const [plan, v] of Object.entries(FUNCTIONS_PER_PROJECT) as [Plan, number | "unlimited"][]) {
    if (v === cap) return plan;
  }
  return undefined;
}

/** Normalise whatever the API calls a plan into the docs table's key. */
export function normalisePlan(raw: unknown): Plan | undefined {
  const s = String(raw ?? "").toLowerCase();
  if (s === "free" || s === "pro" || s === "team" || s === "enterprise") return s;
  return undefined;
}
