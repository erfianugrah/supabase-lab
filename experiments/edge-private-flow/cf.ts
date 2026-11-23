// cf: Cloudflare pieces for the gateway arms, created and removed via the API
// (CLOUDFLARE_EMAIL + CLOUDFLARE_API_KEY, the same credential iap-lockdown's
// OpenTofu uses).
//   bun cf.ts up    - client cert from the Cloudflare-managed CA, mTLS on the
//                     GW hostname (MERGED into the zone's existing associations),
//                     Access service token + non_identity policy + self-hosted
//                     app on the SVC hostname.
//   bun cf.ts down  - removes all of it and restores the previous associations.
// State: evidence/cf.json (ids) and certs/ (cert, key, service token secret).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const ZONE = process.env.CF_ZONE_NAME ?? "erfi.dev";
const GW = `epf-gw.${ZONE}`;
const SVC = `epf-svc.${ZONE}`;
const dir = import.meta.dir;
const statePath = `${dir}/evidence/cf.json`;

async function cf(method: string, path: string, body?: unknown) {
  const r = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: {
      "X-Auth-Email": process.env.CLOUDFLARE_EMAIL!,
      "X-Auth-Key": process.env.CLOUDFLARE_API_KEY!,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j: any = await r.json();
  if (!j.success) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(j.errors)}`);
  return j.result;
}

const zones: any[] = await cf("GET", `/zones?name=${ZONE}`);
const zoneId = zones[0].id;
const acct = zones[0].account.id;
const assoc = `/zones/${zoneId}/certificate_authorities/hostname_associations`;

if (process.argv[2] === "up") {
  const state: Record<string, unknown> = { zone: ZONE, gw: GW, svc: SVC };

  // client cert signed by the Cloudflare-managed CA
  execFileSync("sh", ["-c", `cd ${dir}/certs && openssl ecparam -name prime256v1 -genkey -noout -out gw-client.key && openssl req -new -key gw-client.key -subj "/CN=lab-edge-function-gw" -out gw-client.csr`]);
  const cc = await cf("POST", `/zones/${zoneId}/client_certificates`, { csr: readFileSync(`${dir}/certs/gw-client.csr`, "utf8"), validity_days: 30 });
  writeFileSync(`${dir}/certs/gw-client.crt`, cc.certificate);
  state.clientCertId = cc.id;
  state.clientCertCA = cc.certificate_authority?.name;
  console.log(`client cert ${cc.id} (${cc.signature}, CA ${cc.certificate_authority?.name})`);

  // mTLS on the GW hostname, merged with whatever the zone already has
  const before = (await cf("GET", assoc)).hostnames ?? [];
  state.prevHostnames = before;
  const merged = [...new Set([...before, GW])];
  await cf("PUT", assoc, { hostnames: merged });
  console.log(`mTLS hostnames: ${before.length} before -> ${merged.length} after`);

  // Access: service token + non_identity policy + self-hosted app on SVC
  const tok = await cf("POST", `/accounts/${acct}/access/service_tokens`, { name: "lab-epf svc" });
  writeFileSync(`${dir}/certs/svc-token.json`, JSON.stringify({ id: tok.client_id, secret: tok.client_secret }));
  state.serviceTokenId = tok.id;
  const pol = await cf("POST", `/accounts/${acct}/access/policies`, {
    name: "lab-epf svc token",
    decision: "non_identity",
    include: [{ service_token: { token_id: tok.id } }],
  });
  state.policyId = pol.id;
  const app = await cf("POST", `/accounts/${acct}/access/apps`, {
    name: "lab-epf svc",
    domain: SVC,
    type: "self_hosted",
    session_duration: "24h",
    app_launcher_visible: false,
    policies: [{ id: pol.id, precedence: 1 }],
  });
  state.appId = app.id;
  console.log(`access app ${app.id} on ${SVC}`);
  writeFileSync(statePath, JSON.stringify(state, null, 2));
} else if (process.argv[2] === "down") {
  if (!existsSync(statePath)) throw new Error("no evidence/cf.json");
  const s = JSON.parse(readFileSync(statePath, "utf8"));
  const tryDo = async (label: string, f: () => Promise<unknown>) => {
    try { await f(); console.log(`removed ${label}`); } catch (e) { console.log(`${label}: ${e}`); }
  };
  await tryDo("access app", () => cf("DELETE", `/accounts/${acct}/access/apps/${s.appId}`));
  await tryDo("access policy", () => cf("DELETE", `/accounts/${acct}/access/policies/${s.policyId}`));
  await tryDo("service token", () => cf("DELETE", `/accounts/${acct}/access/service_tokens/${s.serviceTokenId}`));
  const now: string[] = (await cf("GET", assoc)).hostnames ?? [];
  await tryDo("mTLS hostname", () => cf("PUT", assoc, { hostnames: now.filter((h) => h !== s.gw) }));
  await tryDo("client cert", () => cf("DELETE", `/zones/${zoneId}/client_certificates/${s.clientCertId}`));
} else {
  console.log("usage: bun cf.ts up|down");
}
