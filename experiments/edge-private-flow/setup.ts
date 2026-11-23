// setup: everything the flow needs on the Supabase side, after `make apply`.
// Env: SUPABASE_ACCESS_TOKEN, REF, UPSTREAM_JWT_URL. Writes evidence/state.json
// (gitignored: holds the lab user's token and the front secret).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const PAT = process.env.SUPABASE_ACCESS_TOKEN!;
const REF = process.env.REF!;
const UPSTREAM = process.env.UPSTREAM_JWT_URL ?? "";
if (!PAT || !REF) throw new Error("SUPABASE_ACCESS_TOKEN and REF required");
const URL_ = `https://${REF}.supabase.co`;
const certs = (f: string) => readFileSync(`${import.meta.dir}/certs/${f}`, "utf8");

async function mgmt(method: string, path: string, body?: unknown) {
  const r = await fetch(`https://api.supabase.com/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${PAT}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json: unknown = text;
  try { json = JSON.parse(text); } catch { /* keep text */ }
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${text.slice(0, 300)}`);
  return json as any;
}
const sql = (query: string) => mgmt("POST", `/projects/${REF}/database/query`, { query });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 1. wait for the project
for (let i = 0; ; i++) {
  const p = await mgmt("GET", `/projects/${REF}`);
  console.log(`status ${p.status}`);
  if (p.status === "ACTIVE_HEALTHY") break;
  if (i > 60) throw new Error("project never became healthy");
  await sleep(10_000);
}

// 2. keys
const keys: any[] = await mgmt("GET", `/projects/${REF}/api-keys?reveal=true`);
const publishable = keys.find((k) => k.type === "publishable")?.api_key;
const secret = keys.find((k) => k.type === "secret")?.api_key;
const anon = keys.find((k) => k.name === "anon")?.api_key;
console.log(`keys: publishable=${!!publishable} secret=${!!secret} anon=${!!anon}`);

// 3. asymmetric signing key, so the upstream can verify against a public JWKS
let jwks = await (await fetch(`${URL_}/auth/v1/.well-known/jwks.json`)).json();
console.log(`jwks keys before: ${jwks.keys?.length ?? 0}`);
const signing: any = await mgmt("GET", `/projects/${REF}/config/auth/signing-keys`);
const list: any[] = signing.keys ?? signing;
const inUse = list.find((k) => k.status === "in_use");
console.log(`signing keys: ${list.map((k) => `${k.algorithm}:${k.status}`).join(", ")}`);
if (inUse?.algorithm === "HS256") {
  const sk = list.find((k) => k.status === "standby" && k.algorithm !== "HS256")
    ?? await mgmt("POST", `/projects/${REF}/config/auth/signing-keys`, { algorithm: "ES256" });
  await mgmt("PATCH", `/projects/${REF}/config/auth/signing-keys/${sk.id}`, { status: "in_use" });
  console.log(`rotated to ${sk.algorithm} ${sk.id}`);
  for (let i = 0; i < 40; i++) {
    jwks = await (await fetch(`${URL_}/auth/v1/.well-known/jwks.json`)).json();
    if (jwks.keys?.some((k: any) => k.kid === sk.id)) break;
    await sleep(10_000);
  }
  console.log(`jwks keys after: ${jwks.keys?.length ?? 0}`);
}

// 4. lab user + token
const email = `lab-epf-${Date.now()}@example.com`;
const password = crypto.randomUUID();
const adm = await fetch(`${URL_}/auth/v1/admin/users`, {
  method: "POST",
  headers: { apikey: secret, authorization: `Bearer ${secret}`, "content-type": "application/json" },
  body: JSON.stringify({ email, password, email_confirm: true }),
});
console.log(`admin create user ${adm.status}`);
const tok = await (await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
  method: "POST",
  headers: { apikey: publishable, "content-type": "application/json" },
  body: JSON.stringify({ email, password }),
})).json();
const accessToken: string = tok.access_token;
const hdr = JSON.parse(Buffer.from(accessToken.split(".")[0], "base64url").toString());
console.log(`user token alg=${hdr.alg} kid=${hdr.kid ?? "-"}`);

// 5. RLS gated on the front-door header
const front = crypto.randomUUID().replaceAll("-", "");
await sql(`
create schema if not exists private;
create table if not exists private.gw (secret text not null);
delete from private.gw; insert into private.gw values ('${front}');
revoke all on schema private from anon, authenticated;
create or replace function public.via_front() returns boolean
  language sql stable security definer set search_path = '' as $$
  select coalesce(current_setting('request.headers', true)::json ->> 'x-gw-secret', '') = (select secret from private.gw limit 1)
$$;
create table if not exists public.items (id int primary key, name text);
insert into public.items values (1, 'one'), (2, 'two') on conflict do nothing;
alter table public.items enable row level security;
drop policy if exists via_front on public.items;
create policy via_front on public.items for select to anon, authenticated using (public.via_front());
grant select on public.items to anon, authenticated;
`);
console.log("rls: items gated on x-gw-secret");

// 6. function secrets
await mgmt("POST", `/projects/${REF}/secrets`, [
  { name: "FRONT_SECRET", value: front },
  { name: "BADSSL_CERT", value: certs("badssl-client.crt") },
  { name: "BADSSL_KEY", value: certs("badssl-client.key") },
  { name: "CLIENT_CERT", value: certs("client-named.crt") },
  { name: "CLIENT_KEY", value: certs("client-named.key") },
  { name: "UPSTREAM_JWT_URL", value: UPSTREAM },
]);
console.log("function secrets set");

mkdirSync(`${import.meta.dir}/evidence`, { recursive: true });
writeFileSync(`${import.meta.dir}/evidence/state.json`, JSON.stringify({
  ref: REF, url: URL_, publishable, anon, front, accessToken, alg: hdr.alg, upstream: UPSTREAM,
}, null, 2));
console.log("state -> evidence/state.json");
