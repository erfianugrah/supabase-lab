/**
 * Shared plumbing for compute-surface: one throwaway Micro project on the Pro
 * organization (named `compute-surface-<tag>-<ms>`), a raw v2 Management API
 * call that keeps status, error code and body verbatim, and the gate reading
 * of a v2 compute answer.
 *
 * The prefix is long on purpose: the lab org holds long-lived projects whose
 * names start with `cs-`, and `make cleanup` deletes by prefix.
 */
import { mgmt } from "../../../harness/src/mgmt";
import type { Ctx } from "../../../harness/src/types";
import { mgmtPatient, sleep } from "../../observability-surface/lib/ob";

export const PREFIX = "compute-surface-";
export const REGION = "ap-southeast-1";

export interface CsProject {
  ref: string;
  name: string;
  healthyMs: number;
  /** compute_instance add-on variant read back from billing/addons. */
  instanceSize: string;
}

/** Create a Micro project, wait for ACTIVE_HEALTHY, read the size back. Deletes it on failure. */
export async function makeMicro(ctx: Ctx, tag: string): Promise<CsProject> {
  const org = ctx.orgs.pro;
  if (!org) throw new Error("PVLAB_ORG_PRO not set");
  const t0 = Date.now();
  const name = `${PREFIX}${tag}-${t0.toString(36)}`;
  const create = await mgmtPatient(ctx, "POST", "/projects", {
    organization_slug: org,
    name,
    db_pass: `${crypto.randomUUID()}Aa1!`,
    region: REGION,
    desired_instance_size: "micro",
  });
  const ref = (create.json as { ref?: string; id?: string } | undefined)?.ref ?? (create.json as { id?: string } | undefined)?.id ?? "";
  if (create.status !== 201 || !ref) throw new Error(`create HTTP ${create.status}: ${create.text.slice(0, 300)}`);
  ctx.log(`created ${name} (${ref})`);
  try {
    let status = "";
    const deadline = Date.now() + 12 * 60_000;
    while (Date.now() < deadline && status !== "ACTIVE_HEALTHY") {
      await sleep(10_000);
      const g = await mgmt(ctx, "GET", `/projects/${ref}`);
      status = String((g.json as { status?: string } | undefined)?.status ?? "");
    }
    if (status !== "ACTIVE_HEALTHY") throw new Error(`not healthy: ${status}`);
    const healthyMs = Date.now() - t0;
    const addons = await mgmtPatient(ctx, "GET", `/projects/${ref}/billing/addons`);
    const sel = ((addons.json as { selected_addons?: { type: string; variant?: { id?: string } }[] } | undefined)?.selected_addons ?? []).find(
      (a) => a.type === "compute_instance",
    );
    return { ref, name, healthyMs, instanceSize: sel?.variant?.id ?? `unknown (addons HTTP ${addons.status})` };
  } catch (e) {
    await dropProject(ctx, ref);
    throw e;
  }
}

export async function dropProject(ctx: Ctx, ref: string): Promise<number> {
  if (!ref) return 0;
  let status = 0;
  for (let i = 0; i < 6; i++) {
    const r = await mgmt(ctx, "DELETE", `/projects/${ref}`).catch(() => ({ status: 0 }) as { status: number });
    status = r.status;
    if (status < 300 || status === 404) return status;
    await sleep(status === 429 ? 15_000 : 3_000);
  }
  return status;
}

export interface RawAnswer {
  status: number;
  /** `error.code` from the JSON body, "" when absent. */
  code: string;
  /** Body as received (trimmed to 600 characters). */
  body: string;
  contentType: string;
}

/**
 * One v2 call, no retries beyond a throttle wait, body kept verbatim. The v2
 * prefix sits outside `mgmtBase` (which ends in /v1), as in
 * observability-surface's `runAdvisors`. `auth: false` sends no
 * Authorization header (the route-exists control).
 */
export async function v2(ctx: Ctx, method: string, path: string, body?: unknown, auth = true): Promise<RawAnswer> {
  const base = (ctx.mgmtBase ?? process.env.SUPABASE_MGMT_BASE_URL ?? "https://api.supabase.com/v1").replace(/\/v1$/, "");
  const send = () =>
    fetch(`${base}/v2${path}`, {
      method,
      headers: {
        ...(auth ? { Authorization: `Bearer ${ctx.pat}` } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
  let res = await send();
  for (let i = 0; i < 4 && res.status === 429; i++) {
    await res.arrayBuffer();
    await sleep(15_000);
    res = await send();
  }
  const text = await res.text();
  let code = "";
  try {
    code = String((JSON.parse(text) as { error?: { code?: string } }).error?.code ?? "");
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, code, body: text.slice(0, 600), contentType: res.headers.get("content-type") ?? "" };
}

export type Gate = "closed" | "open" | "unclear";

/** closed: 404 compute_not_enabled. open: a 2xx. Anything else is unclear and gets read by hand. */
export function gateOf(a: Pick<RawAnswer, "status" | "code">): Gate {
  if (a.status === 404 && a.code === "compute_not_enabled") return "closed";
  if (a.status >= 200 && a.status < 300) return "open";
  return "unclear";
}
