/**
 * X02 - does a token issued by one project work against another.
 *
 * This is the claim a tiered-tenancy design rests on: if a tenant can be moved
 * from a shared project to its own without re-authenticating, the token it
 * already holds has to be accepted by both.
 *
 * The design is one token under three trust states, in order, so acceptance is
 * attributable to the trust configuration and nothing else:
 *
 *   1. no trust configured on the spoke  -> must be REFUSED (PGRST301)
 *   2. hub registered as the spoke's IdP -> must be ACCEPTED
 *   3. trust deleted again               -> must return to REFUSED
 *
 * State 1 is the negative control, and it is stronger than the usual "an anon
 * key gets nothing" check: an anon bearer is signed by a key the target DOES
 * trust and is refused by RLS, which proves nothing about signature
 * validation. Here the bytes of the bearer are identical in all three states,
 * so the only variable is whether the target trusts the issuer.
 *
 * State 3 also answers an operational question the guide currently cannot:
 * how long a revoked issuer keeps working, i.e. whether de-provisioning a
 * tenant's trust is immediate or eventually-consistent.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";

const API = "https://api.supabase.com/v1";

async function mgmt(ctx: Ctx, method: string, path: string, body?: unknown) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${ctx.pat}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  try {
    return { status: res.status, json: JSON.parse(text), text };
  } catch {
    return { status: res.status, json: undefined, text };
  }
}

async function keys(ctx: Ctx, ref: string) {
  const r = await mgmt(ctx, "GET", `/projects/${ref}/api-keys?reveal=true`);
  const arr = Array.isArray(r.json) ? (r.json as Record<string, string>[]) : [];
  const pick = (name: string) => arr.find((k) => k.name === name)?.api_key;
  return { anon: pick("anon"), service: pick("service_role") };
}

async function sql(ctx: Ctx, ref: string, query: string) {
  return mgmt(ctx, "POST", `/projects/${ref}/database/query`, { query });
}

async function listTpa(ctx: Ctx, ref: string): Promise<Record<string, unknown>[]> {
  const r = await mgmt(ctx, "GET", `/projects/${ref}/config/auth/third-party-auth`);
  return Array.isArray(r.json) ? (r.json as Record<string, unknown>[]) : [];
}

async function clearTpa(ctx: Ctx, ref: string) {
  for (const t of await listTpa(ctx, ref)) {
    if (typeof t.id === "string") {
      await mgmt(ctx, "DELETE", `/projects/${ref}/config/auth/third-party-auth/${t.id}`);
    }
  }
}

/**
 * Seeding is a truncate-then-insert, not an upsert: `id` is a bigserial, so an
 * `on conflict do nothing` insert never conflicts and a second run of the
 * suite would silently double every row count this test asserts on.
 */
const SCHEMA = `
create table if not exists public.items (
  id bigserial primary key, tenant_id text not null, body text not null);
alter table public.items enable row level security;
drop policy if exists tenant_isolation on public.items;
create policy tenant_isolation on public.items
  using (tenant_id = (auth.jwt() -> 'app_metadata' ->> 'tenant_id'))
  with check (tenant_id = (auth.jwt() -> 'app_metadata' ->> 'tenant_id'));
grant usage on schema public to authenticated;
grant select, insert, update, delete on public.items to authenticated;
grant usage, select on sequence public.items_id_seq to authenticated;
truncate public.items;
`;

interface Read {
  status: number;
  rows?: unknown[];
  code?: string;
  text: string;
}

async function restRead(host: string, anon: string, bearer: string): Promise<Read> {
  const res = await fetch(`https://${host}/rest/v1/items?select=tenant_id,body&order=id`, {
    headers: { apikey: anon, Authorization: `Bearer ${bearer}` },
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let rows: unknown[] | undefined;
  let code: string | undefined;
  try {
    const j = JSON.parse(text);
    if (Array.isArray(j)) rows = j;
    else code = typeof j.code === "string" ? j.code : undefined;
  } catch {
    /* non-json */
  }
  return { status: res.status, rows, code, text };
}

/** A refusal is a token the key set cannot verify - not an empty result set. */
const refused = (r: Read) => r.rows === undefined && r.status >= 400;

/** Poll until the predicate holds, so propagation latency is measured, not assumed. */
async function until(
  probe: () => Promise<Read>,
  ok: (r: Read) => boolean,
  budgetMs: number,
  // 500ms, not the obvious 3s: the poll interval IS the error bar on
  // accept_ms/revoke_ms, and "trust takes effect in under a second" is a
  // materially different operational claim from "within three seconds".
  stepMs = 500,
): Promise<{ held: boolean; ms: number; last: Read }> {
  const t0 = performance.now();
  let last = await probe();
  if (ok(last)) return { held: true, ms: Math.round(performance.now() - t0), last };
  while (performance.now() - t0 < budgetMs) {
    await new Promise((r) => setTimeout(r, stepMs));
    last = await probe();
    if (ok(last)) return { held: true, ms: Math.round(performance.now() - t0), last };
  }
  return { held: false, ms: Math.round(performance.now() - t0), last };
}

const mod: TestModule = {
  id: "X02",
  title: "Cross-project token portability under three trust states",
  where: "local",
  requires: ["pat"],
  destructive: true, // creates schema, users and auth config on both projects
  async run(ctx) {
    const spoke = process.env.XPROJ_SPOKE_REF;
    if (!spoke) {
      return {
        id: "X02",
        title: this.title,
        status: "skip",
        detail: "XPROJ_SPOKE_REF not set - this experiment needs both projects",
      };
    }
    const results: TestResult[] = [];
    const hub = ctx.ref;
    const hubIssuer = `https://${hub}.supabase.co/auth/v1`;

    // State 1 starts from no trust at all, whatever X01 left behind.
    await clearTpa(ctx, spoke);

    await sql(ctx, hub, SCHEMA);
    await sql(ctx, spoke, SCHEMA);
    await sql(
      ctx,
      hub,
      `insert into public.items(tenant_id,body) values ('tenant-a','a1'),('tenant-a','a2'),('tenant-b','b1');`,
    );

    const hubKeys = await keys(ctx, hub);
    const spokeKeys = await keys(ctx, spoke);
    if (!hubKeys.anon || !hubKeys.service || !spokeKeys.anon) {
      return [
        ...results,
        { id: "X02z", title: "key fetch", status: "fail", detail: "could not read project API keys" },
      ];
    }

    // Two tenants, tenant_id in app_metadata because that object is
    // admin-only; a client-writable claim would let a tenant widen its scope.
    const mkUser = (tenant: string) =>
      fetch(`https://${hub}.supabase.co/auth/v1/admin/users`, {
        method: "POST",
        headers: {
          apikey: hubKeys.service!,
          Authorization: `Bearer ${hubKeys.service}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: `${tenant}@lab.invalid`,
          password: "LabPassword123!",
          email_confirm: true,
          app_metadata: { tenant_id: tenant },
        }),
        signal: AbortSignal.timeout(20000),
      });
    await mkUser("tenant-a");
    await mkUser("tenant-b");

    const login = async (tenant: string) => {
      const r = await fetch(`https://${hub}.supabase.co/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: { apikey: hubKeys.anon!, "Content-Type": "application/json" },
        body: JSON.stringify({ email: `${tenant}@lab.invalid`, password: "LabPassword123!" }),
        signal: AbortSignal.timeout(20000),
      });
      const j = (await r.json().catch(() => ({}))) as Record<string, string>;
      return j.access_token;
    };
    const tokA = await login("tenant-a");
    const tokB = await login("tenant-b");
    if (!tokA || !tokB) {
      return [
        ...results,
        { id: "X02z", title: "hub login", status: "fail", detail: "could not obtain hub tokens" },
      ];
    }

    const onHubA = await restRead(`${hub}.supabase.co`, hubKeys.anon, tokA);
    results.push({
      id: "X02a",
      title: "Tenant A reads its own rows on the issuing project",
      status: onHubA.rows?.length === 2 ? "pass" : "fail",
      detail: `${onHubA.rows?.length ?? 0} rows, code=${onHubA.code ?? "none"}`,
      measurements: { rows: onHubA.rows?.length ?? 0, status: onHubA.status },
    });

    const onHubB = await restRead(`${hub}.supabase.co`, hubKeys.anon, tokB);
    results.push({
      id: "X02b",
      title: "Tenant B cannot see tenant A's rows (RLS)",
      status: onHubB.rows?.length === 1 ? "pass" : "fail",
      detail: `${onHubB.rows?.length ?? 0} rows returned`,
      measurements: { rows: onHubB.rows?.length ?? 0 },
    });

    // ---- State 1: the negative control. Same token, no trust configured.
    const preTrust = await restRead(`${spoke}.supabase.co`, spokeKeys.anon, tokA);
    results.push({
      id: "X02c",
      title: "Control: before trust is configured, the other project refuses the token",
      status: refused(preTrust) ? "pass" : "fail",
      detail: refused(preTrust)
        ? `refused: HTTP ${preTrust.status} ${preTrust.code ?? ""}`.trim()
        : `NOT refused (${preTrust.rows?.length ?? 0} rows) - a later acceptance would prove nothing`,
      measurements: {
        status: preTrust.status,
        code: preTrust.code ?? "none",
        rows: preTrust.rows?.length ?? -1,
      },
      evidence: preTrust.text.slice(0, 200),
    });

    // ---- State 2: register the hub as the spoke's third-party issuer.
    const tpa = await mgmt(ctx, "POST", `/projects/${spoke}/config/auth/third-party-auth`, {
      oidc_issuer_url: hubIssuer,
    });
    const tpaId = typeof tpa.json?.id === "string" ? (tpa.json.id as string) : undefined;
    const tpaResolved = tpa.json?.resolved_jwks != null || tpa.json?.resolved_at != null;
    results.push({
      id: "X02d",
      title: "Spoke trusts the hub issuer (oidc_issuer_url)",
      status: tpa.status < 300 && tpaId ? "pass" : "fail",
      detail: `create HTTP ${tpa.status}, resolved_on_create=${tpaResolved}`,
      measurements: { status: tpa.status, resolved_on_create: String(tpaResolved) },
      evidence: tpa.text.slice(0, 300),
    });

    const accepted = await until(
      () => restRead(`${spoke}.supabase.co`, spokeKeys.anon, tokA),
      (r) => r.rows !== undefined,
      90000,
    );
    results.push({
      id: "X02e",
      title: "The same token, unchanged, is accepted by the other project",
      status: accepted.held ? "pass" : "fail",
      detail: accepted.held
        ? `accepted after ${accepted.ms}ms, ${accepted.last.rows?.length ?? 0} rows (spoke empty until the slice is copied)`
        : `still refused after ${accepted.ms}ms: ${accepted.last.code ?? accepted.last.text.slice(0, 80)}`,
      measurements: {
        accept_ms: accepted.ms,
        status: accepted.last.status,
        code: accepted.last.code ?? "none",
        rows: accepted.last.rows?.length ?? -1,
      },
      evidence: accepted.last.text.slice(0, 200),
    });

    // Promotion: copy the tenant's slice, then re-read with the unchanged token.
    await sql(
      ctx,
      spoke,
      `insert into public.items(tenant_id,body) values ('tenant-a','a1'),('tenant-a','a2');`,
    );
    const afterCopy = await restRead(`${spoke}.supabase.co`, spokeKeys.anon, tokA);
    results.push({
      id: "X02f",
      title: "After copying the slice, the same token reads it - no re-login",
      status: afterCopy.rows?.length === 2 ? "pass" : "fail",
      detail: `${afterCopy.rows?.length ?? 0} rows with the original token`,
      measurements: { rows: afterCopy.rows?.length ?? 0, status: afterCopy.status },
    });

    // ---- State 3: revoke trust. The token must stop working, and how fast
    // it stops is the de-provisioning fact the guide is missing.
    if (tpaId) {
      await mgmt(ctx, "DELETE", `/projects/${spoke}/config/auth/third-party-auth/${tpaId}`);
    } else {
      await clearTpa(ctx, spoke);
    }
    const revoked = await until(
      () => restRead(`${spoke}.supabase.co`, spokeKeys.anon, tokA),
      refused,
      120000,
    );
    results.push({
      id: "X02g",
      title: "Deleting the trust stops the token working",
      status: revoked.held ? "pass" : "fail",
      detail: revoked.held
        ? `refused ${revoked.ms}ms after delete: HTTP ${revoked.last.status} ${revoked.last.code ?? ""}`.trim()
        : `still accepted ${revoked.ms}ms after delete - trust removal is not immediate`,
      measurements: {
        revoke_ms: revoked.ms,
        status: revoked.last.status,
        code: revoked.last.code ?? "none",
        rows: revoked.last.rows?.length ?? -1,
      },
      evidence: revoked.last.text.slice(0, 200),
    });

    return results;
  },
};
export default mod;
