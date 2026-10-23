/**
 * SD10 - Edge Functions through Envoy with the sb_publishable_ / sb_secret_ keys.
 *
 * The functions route is the one place Envoy does not rewrite `apikey` into a
 * JWT. Its last Lua filter (volumes/api/envoy/lds.template.yaml at the pin)
 * strips any client `sb-api-key` header, answers 401 itself for an unknown sb_
 * key ("Invalid API key") or an apikey/Bearer sb_ disagreement ("Conflicting API
 * keys"), and for the two configured keys adds an `sb-api-key` header carrying
 * the asymmetric anon or service_role JWT, leaving `apikey` and
 * `Authorization` as the client sent them. The main router
 * (volumes/functions/main/index.ts) checks a JWT only when
 * FUNCTIONS_VERIFY_JWT=true (`.env.example` ships false) and deletes
 * `sb-api-key` before the user function runs. The shipped `hello` function
 * wraps its handler in `withSupabase({ auth: ["publishable", "secret"] })` from
 * @supabase/server, which matches `apikey` against SUPABASE_PUBLISHABLE_KEYS /
 * SUPABASE_SECRET_KEYS from the container environment.
 *
 *   SD10a  `hello`, FUNCTIONS_VERIFY_JWT=false (the default): status, error
 *          code and source of the answer per credential.
 *   SD10b  supabase-js `functions.invoke("hello")` with each key, and signed
 *          in with the publishable key.
 *   SD10c  a probe function written into volumes/functions for the run: what
 *          the user function receives (header kinds, never values), the key
 *          names in its environment, and a call from inside the function to
 *          `${SUPABASE_URL}/rest/v1` with the secret and the publishable key
 *          from that environment (table with RLS on and no policy, one row).
 *   SD10d  `hello` again with FUNCTIONS_VERIFY_JWT=true (functions container
 *          recreated alone, .env restored in a finally block).
 *
 * Destructive (rewrites .env for SD10d). Local vantage; needs a running stack.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { activeLayers, cname, compose, healthOf, http, jsonOr, reload, rigOf, scrub, sql, waitFor, type Rig } from "../lib/rig";

const ID = "SD10";
const PROBE = "sd10-probe";

/** One line per answer: status, who answered, and the error code if any. */
function describe(rig: Rig, r: { status: number; headers: Record<string, string>; body: string }): string {
  const j = jsonOr(r.body);
  const src = j?.source ? `from ${j.source}` : r.headers["sb-error-code"] ? "from the main router" : r.headers["x-envoy-upstream-service-time"] ? "from the function" : "from Envoy";
  const code = j?.code ?? r.headers["sb-error-code"] ?? "";
  const text = j?.message ?? (j ? "" : r.body);
  return scrub(rig, `${r.status} ${src}${code ? ` code ${code}` : ""}${text ? ` "${String(text).slice(0, 160)}"` : ""}`);
}

async function hello(rig: Rig, cases: Record<string, Record<string, string>>): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [name, headers] of Object.entries(cases)) out[name] = describe(rig, await http(rig, "/functions/v1/hello", { method: "POST", headers, timeoutMs: 120_000 }));
  return out;
}

const PROBE_SRC = `// Written by SD10 for one run and removed afterwards. Reports kinds, never values.
const kind = (v: string | null | undefined): string => {
  if (v == null || v === "") return "absent";
  const b = v.startsWith("Bearer ") ? "Bearer " : "";
  const t = b ? v.slice(7) : v;
  const k = t.startsWith("sb_publishable_") ? "sb_publishable" : t.startsWith("sb_secret_") ? "sb_secret" : /^eyJ[^.]*\\.[^.]*\\./.test(t) ? "JWT(" + JSON.parse(atob(t.split(".")[0].replace(/-/g, "+").replace(/_/g, "/"))).alg + ")" : "other";
  return b + k;
};
const keys = (name: string): string => {
  try {
    const o = JSON.parse(Deno.env.get(name) ?? "{}");
    return Object.entries(o).map(([k, v]) => k + ":" + kind(String(v)).replace(/^sb_/, "")).join(",") || "empty";
  } catch { return "unparsable"; }
};
const first = (name: string): string => { try { return Object.values(JSON.parse(Deno.env.get(name) ?? "{}"))[0] as string ?? ""; } catch { return ""; } };
async function rest(key: string): Promise<string> {
  if (!key) return "no key in env";
  const r = await fetch(Deno.env.get("SUPABASE_URL") + "/rest/v1/sd10_probe?select=id", { headers: { apikey: key } });
  const t = await r.text();
  return r.status + " rows " + (Array.isArray(JSON.parse(t || "null")) ? JSON.parse(t).length : t.slice(0, 80));
}
Deno.serve(async (req) => Response.json({
  apikey: kind(req.headers.get("apikey")),
  authorization: kind(req.headers.get("authorization")),
  sb_api_key_header: req.headers.has("sb-api-key") ? "present" : "absent",
  env_publishable_keys: keys("SUPABASE_PUBLISHABLE_KEYS"),
  env_secret_keys: keys("SUPABASE_SECRET_KEYS"),
  env_anon_key: kind(Deno.env.get("SUPABASE_ANON_KEY")),
  env_service_role_key: kind(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")),
  env_supabase_url: Deno.env.get("SUPABASE_URL") ?? "absent",
  rest_with_env_secret_key: await rest(first("SUPABASE_SECRET_KEYS")),
  rest_with_env_publishable_key: await rest(first("SUPABASE_PUBLISHABLE_KEYS")),
}));
`;

async function makeUser(rig: Rig, secret: string): Promise<{ id: string; token: string; email: string; password: string } | string> {
  const email = `sd10-${Date.now()}@example.com`;
  const password = `pw-${crypto.randomUUID()}`;
  const c = await http(rig, "/auth/v1/admin/users", { method: "POST", headers: { apikey: secret, "content-type": "application/json" }, body: JSON.stringify({ email, password, email_confirm: true }) });
  const id = jsonOr(c.body)?.id;
  if (c.status !== 200 || !id) return `admin create user ${c.status}`;
  const g = await http(rig, "/auth/v1/token?grant_type=password", { method: "POST", headers: { apikey: secret, "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  const token = jsonOr(g.body)?.access_token;
  if (g.status !== 200 || !token) return `password grant ${g.status}`;
  return { id, token, email, password };
}

const mod: TestModule = {
  id: ID,
  title: "Edge Functions through Envoy with sb_publishable_ and sb_secret_ keys",
  where: "local",
  requires: [],
  destructive: true,

  async run(ctx: Ctx): Promise<TestResult[]> {
    const r = rigOf(ctx);
    if ("skip" in r) return [{ id: ID, title: this.title, status: "skip", detail: r.skip }];
    const rig = r.rig;
    const P = rig.env.SUPABASE_PUBLISHABLE_KEY ?? "";
    const S = rig.env.SUPABASE_SECRET_KEY ?? "";
    if (!P.startsWith("sb_publishable_") || !S.startsWith("sb_secret_"))
      return [{ id: ID, title: this.title, status: "skip", detail: "opaque keys not set in .env (run `make stack`)" }];
    const out: TestResult[] = [];
    const user = await makeUser(rig, S);
    const tok = typeof user === "string" ? "" : user.token;
    const cases: Record<string, Record<string, string>> = {
      apikey_publishable: { apikey: P },
      apikey_secret: { apikey: S },
      no_credentials: {},
      bearer_publishable_only: { authorization: `Bearer ${P}` },
      apikey_and_bearer_same_publishable: { apikey: P, authorization: `Bearer ${P}` },
      apikey_made_up_sb_secret: { apikey: "sb_secret_sd10notarealkey0000000000" },
      apikey_publishable_bearer_secret: { apikey: P, authorization: `Bearer ${S}` },
      apikey_legacy_anon: { apikey: rig.env.ANON_KEY ?? "" },
      apikey_legacy_service_role: { apikey: rig.env.SERVICE_ROLE_KEY ?? "" },
      bearer_legacy_anon_only: { authorization: `Bearer ${rig.env.ANON_KEY ?? ""}` },
      client_sb_api_key_header_only: { "sb-api-key": rig.env.SERVICE_ROLE_KEY_ASYMMETRIC ?? "" },
      apikey_publishable_bearer_user_jwt: { apikey: P, authorization: `Bearer ${tok}` },
      bearer_user_jwt_only: { authorization: `Bearer ${tok}` },
    };
    const verify0 = rig.env.FUNCTIONS_VERIFY_JWT ?? "unset";

    try {
      // a - default VERIFY_JWT
      const a = await hello(rig, cases);
      const okA =
        /^200/.test(a.apikey_publishable!) &&
        /^200/.test(a.apikey_secret!) &&
        /^401 from @supabase\/server code MISSING_CREDENTIALS/.test(a.no_credentials!) &&
        /^401 from Envoy "Invalid API key"/.test(a.apikey_made_up_sb_secret!) &&
        /^401 from Envoy "Conflicting API keys"/.test(a.apikey_publishable_bearer_secret!);
      out.push({
        id: `${ID}a`,
        title: `hello with FUNCTIONS_VERIFY_JWT=${verify0}: both sb_ keys in apikey get 200; Envoy refuses an unknown sb_ key and an apikey/Bearer sb_ conflict; everything else is the function's own 401`,
        status: okA ? "pass" : "fail",
        detail: Object.entries(a).map(([k, v]) => `${k}: ${v}`).join(" | "),
        measurements: { functions_verify_jwt: verify0, ...a },
      });

      // b - supabase-js
      const ver = String(jsonOr(readFileSync(Bun.resolveSync("@supabase/supabase-js/package.json", import.meta.dir), "utf8"))?.version ?? "unknown");
      const inv = async (key: string, signIn?: { email: string; password: string }): Promise<string> => {
        const c = createClient(rig.gw, key, { auth: { persistSession: false, autoRefreshToken: false } });
        if (signIn) {
          const si = await c.auth.signInWithPassword(signIn);
          if (si.error) return scrub(rig, `sign-in failed: ${si.error.message}`);
        }
        const { data, error } = await c.functions.invoke("hello", { body: {} });
        if (!error) return `ok ${JSON.stringify(data).slice(0, 80)}`;
        const resp = (error as { context?: Response }).context;
        const body = resp ? await resp.text().catch(() => "") : "";
        return scrub(rig, `${error.name} status ${resp?.status ?? "?"} code ${jsonOr(body)?.code ?? "?"}`);
      };
      const b: Record<string, string> = {
        publishable_key: await inv(P),
        secret_key: await inv(S),
        publishable_key_signed_in: typeof user === "string" ? `no user: ${user}` : await inv(P, { email: user.email, password: user.password }),
      };
      out.push({
        id: `${ID}b`,
        title: `supabase-js ${ver} functions.invoke("hello"): result per key (the client sends the key as apikey and as Bearer, or the session JWT as Bearer once signed in)`,
        status: Object.values(b).every((v) => v.startsWith("ok")) ? "pass" : "fail",
        detail: Object.entries(b).map(([k, v]) => `${k}: ${v}`).join(" | "),
        measurements: { supabase_js_version: ver, ...b },
      });

      // c - probe function
      const fdir = join(rig.dir, "volumes", "functions", PROBE);
      mkdirSync(fdir, { recursive: true });
      writeFileSync(join(fdir, "index.ts"), PROBE_SRC);
      await sql(`drop table if exists public.sd10_probe; create table public.sd10_probe (id int primary key); insert into public.sd10_probe values (1);
        alter table public.sd10_probe enable row level security; grant select on public.sd10_probe to anon, authenticated, service_role; notify pgrst, 'reload schema';`);
      await new Promise((res) => setTimeout(res, 1500));
      const seen: Record<string, string> = {};
      const probeCases: Record<string, Record<string, string>> = { apikey_publishable: { apikey: P }, apikey_secret: { apikey: S }, apikey_and_bearer_same_publishable: { apikey: P, authorization: `Bearer ${P}` }, apikey_publishable_bearer_user_jwt: { apikey: P, authorization: `Bearer ${tok}` }, no_credentials: {} };
      for (const [name, headers] of Object.entries(probeCases)) {
        const resp = await http(rig, `/functions/v1/${PROBE}`, { method: "POST", headers, timeoutMs: 120_000 });
        seen[name] = scrub(rig, `${resp.status} ${resp.body.slice(0, 900)}`);
      }
      const pj = jsonOr(seen.apikey_publishable!.replace(/^\d+ /, ""));
      out.push({
        id: `${ID}c`,
        title: "what a user function receives: apikey as sent, no sb-api-key header (the router deletes it); both sb_ keys in its env; from inside, the env secret key reads an RLS table's row and the env publishable key reads none",
        status: pj && pj.sb_api_key_header === "absent" && /^200 rows 1$/.test(pj.rest_with_env_secret_key ?? "") && /^200 rows 0$/.test(pj.rest_with_env_publishable_key ?? "") ? "pass" : "fail",
        detail: Object.entries(seen).map(([k, v]) => `${k}: ${v}`).join(" | "),
        measurements: seen,
      });
      rmSync(fdir, { recursive: true, force: true });
      await sql("drop table if exists public.sd10_probe; notify pgrst, 'reload schema';");

      // d - VERIFY_JWT=true
      const envFile = join(rig.dir, ".env");
      const original = readFileSync(envFile, "utf8");
      const layers = await activeLayers();
      try {
        writeFileSync(envFile, original.replace(/^FUNCTIONS_VERIFY_JWT=.*$/m, "FUNCTIONS_VERIFY_JWT=true"));
        reload(rig);
        const up = await compose(rig, layers, ["up", "-d", "--no-deps", "--wait", "functions"]);
        await waitFor(async () => (await healthOf("supabase-edge-functions")) === "healthy", 90_000, 2000);
        const d = await hello(rig, cases);
        const okD = /^200/.test(d.apikey_publishable!) && /^200/.test(d.apikey_secret!) && /^401 from the main router code UNAUTHORIZED_NO_AUTH_HEADER/.test(d.no_credentials!);
        out.push({
          id: `${ID}d`,
          title: "hello with FUNCTIONS_VERIFY_JWT=true: the main router verifies the gateway-minted JWT for sb_ keys; results per credential",
          status: up.code === 0 && okD ? "pass" : "fail",
          detail: `functions container ${cname("supabase-edge-functions")} recreated, up exit ${up.code} | ` + Object.entries(d).map(([k, v]) => `${k}: ${v}`).join(" | "),
          measurements: { functions_verify_jwt: "true", ...d },
        });
      } finally {
        writeFileSync(envFile, original);
        reload(rig);
        await compose(rig, layers, ["up", "-d", "--no-deps", "--wait", "functions"]);
      }
    } finally {
      rmSync(join(rig.dir, "volumes", "functions", PROBE), { recursive: true, force: true });
      await sql("drop table if exists public.sd10_probe;").catch(() => {});
      if (typeof user !== "string") await http(rig, `/auth/v1/admin/users/${user.id}`, { method: "DELETE", headers: { apikey: S } }).catch(() => {});
    }
    return out;
  },
};
export default mod;
