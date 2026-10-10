/**
 * SD02 - sb_publishable_ and sb_secret_ keys pass through Envoy.
 *
 * The 2026 self-hosted compose gives Envoy two opaque keys (SUPABASE_PUBLISHABLE_KEY,
 * SUPABASE_SECRET_KEY) and two internal ES256 JWTs (ANON_KEY_ASYMMETRIC,
 * SERVICE_ROLE_KEY_ASYMMETRIC). volumes/api/envoy/lds.template.yaml checks the
 * `apikey` header against the four values (plus the two legacy HS256 JWTs) on
 * the protected routes and swaps an opaque key for the matching ES256 JWT
 * before the request reaches PostgREST or Auth. This module sends every key
 * kind at six routes and reads what the upstream did.
 *
 *   SD02a  the gate: no key and a made-up sb_ key get the Envoy 401 on every
 *          protected route; the body is Envoy's own text/plain, not GoTrue's
 *          or PostgREST's JSON.
 *   SD02b  the matrix: status per key kind per route. Publishable and legacy
 *          anon behave alike (settings 200, OpenAPI and /pg 403), secret and
 *          legacy service_role behave alike (everything 200).
 *   SD02c  what the upstream saw: PostgREST's request.jwt.claims for each
 *          opaque key. Role is the discriminator: the secret key must arrive
 *          as service_role and read an RLS-protected row, the publishable key
 *          as anon and read none.
 *   SD02d  what utils/add-new-auth-keys.sh changed in docker-compose.yml
 *          (the stack is a copy of the pinned docker/ tree, so the diff is
 *          exact).
 *
 * The probe table and function are created through /pg/query with the secret
 * key itself, so the setup is also a use of the path under test.
 *
 * Local vantage; needs `make stack up`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { http, jsonOr, rigOf, scrub, waitFor, type Rig } from "../lib/rig";

const ID = "SD02";

type KeyKind = "none" | "bogus" | "publishable" | "secret" | "legacy_anon" | "legacy_service";

function keyOf(rig: Rig, k: KeyKind): string | null {
  switch (k) {
    case "none":
      return null;
    case "bogus":
      return "sb_secret_" + "x".repeat(22) + "_" + "y".repeat(8);
    case "publishable":
      return rig.env.SUPABASE_PUBLISHABLE_KEY ?? null;
    case "secret":
      return rig.env.SUPABASE_SECRET_KEY ?? null;
    case "legacy_anon":
      return rig.env.ANON_KEY ?? null;
    case "legacy_service":
      return rig.env.SERVICE_ROLE_KEY ?? null;
  }
}

const hdr = (k: string | null): Record<string, string> => (k ? { apikey: k } : {});
const JSON_H = { "content-type": "application/json" };

const mod: TestModule = {
  id: ID,
  title: "sb_publishable_ / sb_secret_ keys pass through Envoy to PostgREST and Auth",
  where: "local",
  requires: [],

  async run(ctx: Ctx): Promise<TestResult[]> {
    const r = rigOf(ctx);
    if ("skip" in r) return [{ id: ID, title: this.title, status: "skip", detail: r.skip }];
    const rig = r.rig;
    const out: TestResult[] = [];
    const sk = keyOf(rig, "secret");
    if (!sk || !keyOf(rig, "publishable")) return [{ id: ID, title: this.title, status: "skip", detail: "opaque keys absent from work/stack/.env" }];

    // Probe objects, created through the gateway with the secret key.
    const setup = await http(rig, "/pg/query", {
      method: "POST",
      headers: { ...JSON_H, apikey: sk },
      body: JSON.stringify({
        query: `drop table if exists public.sd_probe;
create table public.sd_probe(id int primary key, note text);
insert into public.sd_probe values (1, 'row');
alter table public.sd_probe enable row level security;
grant select on public.sd_probe to anon, authenticated, service_role;
create or replace function public.sd_claims() returns json language sql stable as $$ select current_setting('request.jwt.claims', true)::json $$;
grant execute on function public.sd_claims() to anon, authenticated, service_role;
notify pgrst, 'reload schema';`,
      }),
    });
    if (setup.status !== 200) {
      return [{ id: ID, title: this.title, status: "fail", detail: `setup through /pg/query with the secret key -> ${setup.status}: ${scrub(rig, setup.body.slice(0, 200))}` }];
    }
    // Schema cache reload is asynchronous: wait for the observable, not the 200.
    const cached = await waitFor(async () => (await http(rig, "/rest/v1/sd_probe?select=id", { headers: hdr(sk) })).status === 200, 30_000, 1000);
    if (!cached) return [{ id: ID, title: this.title, status: "fail", detail: "PostgREST schema cache did not pick up public.sd_probe within 30 s" }];

    const routes = {
      settings: (k: string | null) => http(rig, "/auth/v1/settings", { headers: hdr(k) }),
      openapi: (k: string | null) => http(rig, "/rest/v1/", { headers: hdr(k) }),
      pg: (k: string | null) => http(rig, "/pg/query", { method: "POST", headers: { ...JSON_H, ...hdr(k) }, body: '{"query":"select 1 as one"}' }),
      rls_read: (k: string | null) => http(rig, "/rest/v1/sd_probe?select=id", { headers: hdr(k) }),
      rpc_claims: (k: string | null) => http(rig, "/rest/v1/rpc/sd_claims", { method: "POST", headers: { ...JSON_H, ...hdr(k) }, body: "{}" }),
      storage: (k: string | null) => http(rig, "/storage/v1/bucket", { headers: hdr(k) }),
    } as const;
    type RouteName = keyof typeof routes;

    const kinds: KeyKind[] = ["none", "bogus", "publishable", "secret", "legacy_anon", "legacy_service"];
    const grid: Record<KeyKind, Record<RouteName, { status: number; body: string; ct: string; server: string }>> = {} as any;
    for (const k of kinds) {
      grid[k] = {} as any;
      for (const [name, f] of Object.entries(routes) as [RouteName, (k: string | null) => Promise<any>][]) {
        const resp = await f(keyOf(rig, k));
        grid[k][name] = { status: resp.status, body: resp.body, ct: resp.headers["content-type"] ?? "", server: resp.headers["server"] ?? "" };
      }
    }

    // a - the gate
    const protectedRoutes: RouteName[] = ["settings", "openapi", "pg", "rls_read", "rpc_claims"];
    const gateOk = (["none", "bogus"] as KeyKind[]).every((k) =>
      protectedRoutes.every((n) => grid[k][n].status === 401 && /text\/plain/.test(grid[k][n].ct) && grid[k][n].body === "Unauthorized" && /envoy/.test(grid[k][n].server)),
    );
    out.push({
      id: `${ID}a`,
      title: "no key and a made-up sb_secret_ key get Envoy's own 401 on the five protected routes",
      status: gateOk ? "pass" : "fail",
      detail: `none: ${protectedRoutes.map((n) => grid.none[n].status).join("/")}; made-up sb_secret_: ${protectedRoutes.map((n) => grid.bogus[n].status).join("/")}; body "${grid.none.settings.body}", content-type ${grid.none.settings.ct}, server ${grid.none.settings.server}`,
      measurements: {
        none: protectedRoutes.map((n) => `${n} ${grid.none[n].status}`).join("; "),
        bogus_sb_secret: protectedRoutes.map((n) => `${n} ${grid.bogus[n].status}`).join("; "),
        storage_route_no_key: `HTTP ${grid.none.storage.status}`,
      },
    });

    // b - the matrix
    const row = (k: KeyKind) =>
      (["settings", "openapi", "pg", "rls_read", "rpc_claims", "storage"] as RouteName[]).map((n) => `${n} ${grid[k][n].status}`).join("; ");
    const rlsRows = (k: KeyKind) => (jsonOr(grid[k].rls_read.body) ?? []).length;
    const expected: Record<string, boolean> = {
      pub_settings_200: grid.publishable.settings.status === 200,
      pub_openapi_403: grid.publishable.openapi.status === 403,
      pub_pg_403: grid.publishable.pg.status === 403,
      sec_settings_200: grid.secret.settings.status === 200,
      sec_openapi_200: grid.secret.openapi.status === 200,
      sec_pg_200: grid.secret.pg.status === 200,
      anon_openapi_403: grid.legacy_anon.openapi.status === 403,
      svc_openapi_200: grid.legacy_service.openapi.status === 200,
    };
    const failedExp = Object.entries(expected).filter(([, v]) => !v).map(([k]) => k);
    out.push({
      id: `${ID}b`,
      title: "status per key kind per route",
      status: failedExp.length === 0 ? "pass" : "fail",
      detail: failedExp.length ? `unexpected: ${failedExp.join(", ")}` : "publishable behaves as legacy anon, secret as legacy service_role, on all six routes' gate decisions",
      measurements: {
        publishable: row("publishable"),
        secret: row("secret"),
        legacy_anon: row("legacy_anon"),
        legacy_service: row("legacy_service"),
        rls_rows_publishable: rlsRows("publishable"),
        rls_rows_secret: rlsRows("secret"),
        rls_rows_legacy_anon: rlsRows("legacy_anon"),
        rls_rows_legacy_service: rlsRows("legacy_service"),
      },
    });

    // c - what PostgREST saw
    const claims = (k: KeyKind) => jsonOr(grid[k].rpc_claims.body) as Record<string, unknown> | null;
    const cs = claims("secret");
    const cp = claims("publishable");
    const roleS = String(cs?.role ?? "none");
    const roleP = String(cp?.role ?? "none");
    const sawKeyValue = [cs, cp].some((c) => c && JSON.stringify(c).includes("sb_"));
    out.push({
      id: `${ID}c`,
      title: "PostgREST sees role service_role for the secret key and anon for the publishable key",
      status: roleS === "service_role" && roleP === "anon" && rlsRows("secret") === 1 && rlsRows("publishable") === 0 && !sawKeyValue ? "pass" : "fail",
      detail:
        `request.jwt.claims role: secret key -> ${roleS}, publishable key -> ${roleP}; ` +
        `RLS-protected table with no policy returned ${rlsRows("secret")} row(s) for the secret key and ${rlsRows("publishable")} for the publishable key; ` +
        `claim names seen for the secret key: ${Object.keys(cs ?? {}).sort().join(",")}`,
      measurements: {
        role_secret_key: roleS,
        role_publishable_key: roleP,
        claims_secret_key: Object.keys(cs ?? {}).sort().join(","),
        iss_secret_key: String(cs?.iss ?? "absent"),
        opaque_value_in_claims: sawKeyValue ? "yes" : "no",
      },
    });

    // d - what the key script changed in the compose file (the stack is a copy of the pinned docker/)
    const pristine = join(rig.dir, "..", "supabase", "docker", "docker-compose.yml");
    const a = readFileSync(pristine, "utf8").split("\n");
    const b = readFileSync(join(rig.dir, "docker-compose.yml"), "utf8").split("\n");
    const changed = a.length === b.length ? a.map((l, i) => (l !== b[i] ? b[i]!.trim().split(":")[0]! : "")).filter(Boolean) : ["line count differs"];
    out.push({
      id: `${ID}d`,
      title: "utils/add-new-auth-keys.sh edits docker-compose.yml: which lines it uncomments",
      status: changed.length ? "info" : "fail",
      detail: `lines differing from the pinned docker-compose.yml: ${changed.join(", ") || "none"}`,
      measurements: { compose_lines_changed_by_key_script: changed.length, compose_keys_uncommented: changed.join(",") },
    });
    return out;
  },
};
export default mod;
