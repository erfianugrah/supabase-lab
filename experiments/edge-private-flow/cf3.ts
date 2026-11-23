// cf3: Cloudflare pieces for run 3 (CLOUDFLARE_EMAIL + CLOUDFLARE_API_KEY).
//   bun cf3.ts up    - our OWN CA uploaded (BYO CA, Enterprise zone) and bound
//                      to the OWN hostname only; a named Cloudflare Tunnel whose
//                      hostname routes to a local origin, with a proxied CNAME;
//                      an Access service token + non_identity policy + app on
//                      the tunnel hostname.
//   bun cf3.ts down  - removes all of it.
// State: evidence/cf3.json; secrets in certs/ (tunnel token, service token).
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const ZONE = process.env.CF_ZONE_NAME ?? "erfi.dev";
const OWN = `epf-own.${ZONE}`;
const TUN = `epf-tun.${ZONE}`;
const dir = import.meta.dir;
const statePath = `${dir}/evidence/cf3.json`;

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

const z = (await cf("GET", `/zones?name=${ZONE}`))[0];
const zoneId = z.id;
const acct = z.account.id;
const assoc = `/zones/${zoneId}/certificate_authorities/hostname_associations`;

if (process.argv[2] === "up") {
  const s: Record<string, unknown> = { zone: ZONE, own: OWN, tun: TUN };

  const ca = await cf("POST", `/accounts/${acct}/mtls_certificates`, {
    ca: true,
    name: "lab-epf own ca",
    certificates: readFileSync(`${dir}/certs/own-ca.crt`, "utf8"),
  });
  s.caId = ca.id;
  await cf("PUT", assoc, { hostnames: [OWN], mtls_certificate_id: ca.id });
  const check = await cf("GET", `${assoc}?mtls_certificate_id=${ca.id}`);
  console.log(`own CA ${ca.id} bound to ${JSON.stringify(check.hostnames)}`);
  writeFileSync(statePath, JSON.stringify(s, null, 2));

  const tunnel = await cf("POST", `/accounts/${acct}/cfd_tunnel`, { name: "lab-epf", config_src: "cloudflare" });
  s.tunnelId = tunnel.id;
  writeFileSync(statePath, JSON.stringify(s, null, 2));
  await cf("PUT", `/accounts/${acct}/cfd_tunnel/${tunnel.id}/configurations`, {
    config: { ingress: [{ hostname: TUN, service: "http://localhost:8787" }, { service: "http_status:404" }] },
  });
  const token = await cf("GET", `/accounts/${acct}/cfd_tunnel/${tunnel.id}/token`);
  writeFileSync(`${dir}/certs/tunnel-token.txt`, String(token));
  const dns = await cf("POST", `/zones/${zoneId}/dns_records`, {
    type: "CNAME", name: TUN, content: `${tunnel.id}.cfargotunnel.com`, proxied: true, comment: "lab-epf tunnel",
  });
  s.dnsId = dns.id;
  console.log(`tunnel ${tunnel.id} -> ${TUN} (dns ${dns.id})`);
  writeFileSync(statePath, JSON.stringify(s, null, 2));

  const tok = await cf("POST", `/accounts/${acct}/access/service_tokens`, { name: "lab-epf tun" });
  writeFileSync(`${dir}/certs/tun-token.json`, JSON.stringify({ id: tok.client_id, secret: tok.client_secret }));
  s.serviceTokenId = tok.id;
  const pol = await cf("POST", `/accounts/${acct}/access/policies`, {
    name: "lab-epf tun token", decision: "non_identity", include: [{ service_token: { token_id: tok.id } }],
  });
  s.policyId = pol.id;
  const app = await cf("POST", `/accounts/${acct}/access/apps`, {
    name: "lab-epf tun", domain: TUN, type: "self_hosted", session_duration: "24h",
    app_launcher_visible: false, policies: [{ id: pol.id, precedence: 1 }],
  });
  s.appId = app.id;
  console.log(`access app ${app.id} on ${TUN}`);
  writeFileSync(statePath, JSON.stringify(s, null, 2));
} else if (process.argv[2] === "down") {
  if (!existsSync(statePath)) throw new Error("no evidence/cf3.json");
  const s = JSON.parse(readFileSync(statePath, "utf8"));
  const t = async (label: string, f: () => Promise<unknown>) => {
    try { await f(); console.log(`removed ${label}`); } catch (e) { console.log(`${label}: ${e}`); }
  };
  if (s.appId) await t("access app", () => cf("DELETE", `/accounts/${acct}/access/apps/${s.appId}`));
  if (s.policyId) await t("access policy", () => cf("DELETE", `/accounts/${acct}/access/policies/${s.policyId}`));
  if (s.serviceTokenId) await t("service token", () => cf("DELETE", `/accounts/${acct}/access/service_tokens/${s.serviceTokenId}`));
  if (s.dnsId) await t("tunnel dns", () => cf("DELETE", `/zones/${zoneId}/dns_records/${s.dnsId}`));
  if (s.tunnelId) await t("tunnel", () => cf("DELETE", `/accounts/${acct}/cfd_tunnel/${s.tunnelId}?cascade=true`));
  if (s.caId) {
    await t("own CA hostname", () => cf("PUT", assoc, { hostnames: [], mtls_certificate_id: s.caId }));
    await t("own CA", () => cf("DELETE", `/accounts/${acct}/mtls_certificates/${s.caId}`));
  }
} else {
  console.log("usage: bun cf3.ts up|down");
}
