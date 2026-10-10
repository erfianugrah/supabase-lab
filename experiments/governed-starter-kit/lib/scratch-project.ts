/**
 * A self-provisioned throwaway project for the K06/K07 modules, so the MCP
 * checks never touch kit-live or kit-ready (K07 runs DROP and TRUNCATE).
 *
 * The name prefix comes from PVLAB_PROJECT_PREFIX (default `kit-mcp-`) and every
 * destructive step re-reads the project name and refuses a project that does not
 * carry the prefix. `PVLAB_PEER_MCP=<ref>` adopts a project that already exists
 * (kept on teardown), which is how a module is re-run against one project while
 * it is being developed; the prefix check still applies to it.
 */
import type { Ctx } from "../../../harness/src/types";
import { mgmt } from "../../../harness/src/mgmt";
import { DEPARTMENTS_SQL, newPassword, REQUESTS_SQL, USERS } from "./seed";

export const prefix = (): string => process.env.PVLAB_PROJECT_PREFIX || "kit-mcp-";
export const REGION = "ap-southeast-1";

export interface Scratch {
  ref: string;
  name: string;
  adopted: boolean;
  url: string;
  publishableKey: string;
  secretKey: string;
  /** user email -> password, generated this run */
  users: Record<string, string>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Management API call that waits out a 429 (or the HTML interstitial) and a timed-out request a few times. */
export async function api(ctx: Ctx, method: string, path: string, body?: unknown) {
  let last: unknown;
  for (let i = 0; i < 5; i++) {
    try {
      const r = await mgmt(ctx, method, path, body, 60_000);
      if (r.status !== 429 && !r.throttled) return r;
    } catch (e) {
      last = e; // timeout or connection error: retry
    }
    await sleep(15_000 * (i + 1));
  }
  if (last) throw last;
  return mgmt(ctx, method, path, body, 60_000);
}

/** SQL through the Management API as the table owner; retries the first-write lag on a fresh project. */
export async function sql(ctx: Ctx, ref: string, query: string): Promise<unknown> {
  for (let attempt = 1; ; attempt++) {
    const r = await api(ctx, "POST", `/projects/${ref}/database/query`, { query });
    if (r.status === 200 || r.status === 201) return r.json ?? [];
    if (attempt >= 6 || (r.status < 500 && r.status !== 429)) {
      throw new Error(`sql http ${r.status}: ${r.text.slice(0, 300)}`);
    }
    await sleep(5_000 * attempt);
  }
}

async function projectName(ctx: Ctx, ref: string): Promise<string> {
  const r = await api(ctx, "GET", `/projects/${ref}`);
  return String((r.json as { name?: string } | undefined)?.name ?? "");
}

/**
 * Create (or adopt) the project and make it ready. A project this call created
 * is deleted again if readiness fails, so a throw never leaves one behind.
 */
export async function provision(ctx: Ctx, label: string, sqlFiles: string[], readFile: (p: string) => string, seed = true): Promise<Scratch> {
  const created: { ref: string; name: string } = { ref: "", name: "" };
  try {
    return await provisionInner(ctx, label, sqlFiles, readFile, seed, created);
  } catch (e) {
    if (created.ref && created.name.startsWith(prefix())) {
      const d = await api(ctx, "DELETE", `/projects/${created.ref}`).catch(() => undefined);
      ctx.log(`provision failed; deleted ${created.name}: http ${d?.status ?? "n/a"}`);
    }
    throw e;
  }
}

async function provisionInner(ctx: Ctx, label: string, sqlFiles: string[], readFile: (p: string) => string, seed: boolean, created: { ref: string; name: string }): Promise<Scratch> {
  const org = ctx.orgs.team ?? "";
  if (!org) throw new Error("PVLAB_ORG_TEAM not set");
  const adoptRef = ctx.peers.mcp ?? "";
  let ref = adoptRef;
  let name = "";
  const t0 = Date.now();
  if (adoptRef) {
    name = await projectName(ctx, adoptRef);
  } else {
    name = `${prefix()}${label}-${t0.toString(36)}`;
    const c = await api(ctx, "POST", "/projects", {
      organization_slug: org,
      name,
      db_pass: `${crypto.randomUUID()}Aa1!`,
      region: REGION,
    });
    ref = String((c.json as { ref?: string } | undefined)?.ref ?? "");
    if (c.status !== 201 || !ref) throw new Error(`create: http ${c.status} ${c.text.slice(0, 200)}`);
    created.ref = ref;
    created.name = name;
  }
  if (!name.startsWith(prefix())) throw new Error(`refusing project "${name}": name lacks the ${prefix()} prefix`);
  ctx.log(`project ${name} (${adoptRef ? "adopted" : "created"})`);

  for (let i = 0; i < 90; i++) {
    const h = await api(ctx, "GET", `/projects/${ref}/health?services=db&services=rest&services=auth`);
    const st = Array.isArray(h.json) ? [...new Set((h.json as { status?: string }[]).map((x) => x.status))].join(",") : "";
    if (st === "ACTIVE_HEALTHY") break;
    if (i === 89) throw new Error(`not healthy after 15 min (${st})`);
    await sleep(10_000);
  }
  await sleep(20_000); // ACTIVE_HEALTHY is not write-ready (AGENTS.md)

  const keysRes = await api(ctx, "GET", `/projects/${ref}/api-keys?reveal=true`);
  const keys = (Array.isArray(keysRes.json) ? keysRes.json : []) as { type?: string; name?: string; api_key?: string }[];
  const publishableKey = keys.find((k) => k.type === "publishable")?.api_key ?? "";
  const secretKey = keys.find((k) => k.type === "secret")?.api_key ?? keys.find((k) => k.name === "service_role")?.api_key ?? "";
  if (!publishableKey || !secretKey) throw new Error("no publishable/secret key returned");
  const url = `https://${ref}.supabase.co`;

  // The SQL files are idempotent, so an adopted project gets them too.
  for (const f of sqlFiles) await sql(ctx, ref, readFile(f));
  const users: Record<string, string> = {};
  if (!seed) return { ref, name, adopted: !!adoptRef, url, publishableKey, secretKey, users };
  await sql(ctx, ref, DEPARTMENTS_SQL);
  const adminHdr = { apikey: secretKey, Authorization: `Bearer ${secretKey}`, "Content-Type": "application/json" };
  for (const u of USERS) {
    const password = newPassword();
    const r = await fetch(`${url}/auth/v1/admin/users`, {
      method: "POST",
      headers: adminHdr,
      body: JSON.stringify({
        email: u.email,
        password,
        email_confirm: true,
        app_metadata: { department: u.department, role: u.role },
        user_metadata: { display_name: u.name },
      }),
    });
    if (r.ok) users[u.email] = password;
    else if (r.status === 422 && adoptRef) {
      // adopted project: reset the password so this run knows it
      const list = (await (await fetch(`${url}/auth/v1/admin/users?per_page=50`, { headers: adminHdr })).json()) as { users?: { id: string; email: string }[] };
      const id = list.users?.find((x) => x.email === u.email)?.id;
      if (!id) throw new Error(`cannot find ${u.email}`);
      await fetch(`${url}/auth/v1/admin/users/${id}`, { method: "PUT", headers: adminHdr, body: JSON.stringify({ password }) });
      users[u.email] = password;
    } else throw new Error(`create ${u.email}: http ${r.status} ${(await r.text()).slice(0, 200)}`);
  }
  await sql(ctx, ref, REQUESTS_SQL);
  return { ref, name, adopted: !!adoptRef, url, publishableKey, secretKey, users };
}

/** Delete the project unless it was adopted; the prefix is checked again first. */
export async function teardown(ctx: Ctx, s: Scratch | undefined): Promise<string> {
  if (!s) return "nothing to delete";
  if (s.adopted) return `adopted project ${s.name} kept`;
  const name = await projectName(ctx, s.ref);
  if (!name.startsWith(prefix())) return `REFUSED to delete "${name}": prefix mismatch`;
  const d = await api(ctx, "DELETE", `/projects/${s.ref}`);
  return `deleted ${name}: http ${d.status}`;
}

export async function passwordToken(s: Scratch, email: string): Promise<string> {
  const r = await fetch(`${s.url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: s.publishableKey, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: s.users[email] }),
  });
  const j = (await r.json()) as { access_token?: string };
  if (!j.access_token) throw new Error(`sign-in ${email}: http ${r.status}`);
  return j.access_token;
}

export function claimsOf(jwt: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString()) as Record<string, unknown>;
}
export function headerOf(jwt: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(jwt.split(".")[0] ?? "", "base64url").toString()) as Record<string, unknown>;
}
