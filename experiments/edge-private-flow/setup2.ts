// setup2: run 2 additions on top of setup.ts. Needs `bun cf.ts up` and the
// gateway Worker deployed first. Env: SUPABASE_ACCESS_TOKEN.
import { readFileSync } from "node:fs";

const dir = import.meta.dir;
const S = JSON.parse(readFileSync(`${dir}/evidence/state.json`, "utf8"));
const CF = JSON.parse(readFileSync(`${dir}/evidence/cf.json`, "utf8"));
const svc = JSON.parse(readFileSync(`${dir}/certs/svc-token.json`, "utf8"));
const c = (f: string) => readFileSync(`${dir}/certs/${f}`, "utf8");
const PAT = process.env.SUPABASE_ACCESS_TOKEN!;

async function mgmt(method: string, path: string, body?: unknown) {
  const r = await fetch(`https://api.supabase.com/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${PAT}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${(await r.text()).slice(0, 300)}`);
  return r.status === 204 ? null : r.json().catch(() => null);
}

await mgmt("POST", `/projects/${S.ref}/database/query`, {
  query: `
create or replace function public.seen_headers() returns json
  language sql stable security invoker set search_path = '' as $$
  select json_build_object(
    'cf-connecting-ip', h ->> 'cf-connecting-ip',
    'x-forwarded-for', h ->> 'x-forwarded-for',
    'x-real-ip', h ->> 'x-real-ip',
    'cf-worker', h ->> 'cf-worker',
    'x-gw-secret-present', (h ->> 'x-gw-secret') is not null)
  from (select current_setting('request.headers', true)::json as h) s
$$;
grant execute on function public.seen_headers() to anon, authenticated;
notify pgrst, 'reload schema';`,
});
console.log("sql: public.seen_headers()");

await mgmt("POST", `/projects/${S.ref}/secrets`, [
  { name: "GW_CERT", value: c("gw-client.crt") },
  { name: "GW_KEY", value: c("gw-client.key") },
  { name: "GW_URL", value: `https://${CF.gw}` },
  { name: "SVC_URL", value: `https://${CF.svc}` },
  { name: "SVC_ID", value: svc.id },
  { name: "SVC_SECRET", value: svc.secret },
  { name: "V1_CERT", value: c("v1.crt") },
  { name: "V1_KEY", value: c("v1.key") },
  { name: "EXPLICIT_CERT", value: c("client.crt") },
  { name: "EXPLICIT_KEY", value: c("client.key") },
]);
console.log("function secrets set (gateway, service token, v1, explicit-ec)");
