/**
 * SD06 - API_EXTERNAL_URL carries /auth/v1, and SAML lives at /auth/v1/sso/saml/*.
 *
 * The self-hosted docker CHANGELOG (release 0.7.0, 2026-07-07) changed the
 * default API_EXTERNAL_URL in .env.example to end in /auth/v1, "aligning
 * self-hosted with the platform and CLI", and moved the SAML endpoints to
 * /auth/v1/sso/saml/*. Auth builds token issuers, email links and the SAML
 * service-provider URLs from that one variable, so the module reads each:
 *
 *   SD06a  configuration as the containers hold it: API_EXTERNAL_URL in .env,
 *          on the auth container, and GOTRUE_JWT_ISSUER, all equal and ending
 *          in /auth/v1.
 *   SD06b  a real token: an admin-created user signs in with a password
 *          grant through the gateway; the access token's `iss`, header alg and
 *          kid are read, and its ES256 signature is verified against the
 *          gateway's own /auth/v1/.well-known/jwks.json.
 *   SD06c  an email link: POST /auth/v1/admin/generate_link returns the link
 *          Auth would mail. Its path (token redacted) shows whether the
 *          MAILER_URLPATHS_* defaults, which already contain /auth/v1/verify,
 *          are joined to an API_EXTERNAL_URL that now contains /auth/v1 too.
 *   SD06d  SAML before it is enabled (the default): /auth/v1/sso/saml/metadata
 *          reaches Auth and Auth answers saml_provider_disabled; the old
 *          unprefixed /sso/saml/metadata does not reach Auth.
 *   SD06e  SAML enabled the way the self-hosting guide does it (a generated
 *          RSA key as GOTRUE_SAML_PRIVATE_KEY, applied by an override file
 *          instead of editing docker-compose.yml): the metadata document is
 *          served at /auth/v1/sso/saml/metadata and its entityID and ACS
 *          Location are API_EXTERNAL_URL plus /sso/saml/metadata and
 *          /sso/saml/acs.
 *   SD06f  the flow through Envoy with a made-up IdP (a fresh self-signed
 *          certificate, inline metadata, registered with the secret key):
 *          POST /auth/v1/sso for the domain returns a redirect URL to the IdP
 *          carrying a SAMLRequest; the ACS route is open without an apikey and
 *          a garbage SAMLResponse is rejected by Auth, not by Envoy.
 *
 * The IdP is invented, so SD06f shows the SP side and the gateway path only;
 * a real IdP's assertion is not exercised. Destructive (recreates auth with
 * SAML on and leaves it on). Local vantage; needs `make stack up`.
 */
import { generateKeyPairSync, createPublicKey, verify } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { activeLayers, appendEnv, compose, envOf, healthOf, http, inspect, jsonOr, jwtParts, rigOf, scrub, sh, waitFor, type Layer, type Rig } from "../lib/rig";

const ID = "SD06";
const JSON_H = { "content-type": "application/json" };

/** A fresh self-signed certificate (PEM body only) for a made-up IdP; the key is discarded. */
async function idpCert(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "sd06-"));
  const crt = join(dir, "idp.crt");
  const r = await sh(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "/dev/null", "-out", crt, "-subj", "/CN=idp.example.com", "-days", "2"]);
  if (r.code !== 0) throw new Error(`openssl req: ${r.err.slice(0, 200)}`);
  const pem = await Bun.file(crt).text();
  return pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, "").replace(/\s+/g, "");
}

const idpMetadata = (cert: string): string =>
  `<?xml version="1.0"?><md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://idp.example.com/sd06">` +
  `<md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">` +
  `<md:KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>${cert}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>` +
  `<md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>` +
  `<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.example.com/sd06/sso"/>` +
  `</md:IDPSSODescriptor></md:EntityDescriptor>`;

/** Keep scheme, host, path, the names of query or fragment parameters and the value of error_code; drop the other values. */
const redact = (u: string): string => u.replace(/([?&#](?!error_code=)[A-Za-z_]+)=[^&#]*/g, "$1=...");

const mod: TestModule = {
  id: ID,
  title: "API_EXTERNAL_URL carries /auth/v1; SAML is served at /auth/v1/sso/saml/*",
  where: "local",
  requires: [],
  destructive: true,

  async run(ctx: Ctx): Promise<TestResult[]> {
    const r = rigOf(ctx);
    if ("skip" in r) return [{ id: ID, title: this.title, status: "skip", detail: r.skip }];
    const rig: Rig = r.rig;
    const out: TestResult[] = [];
    const sk = rig.env.SUPABASE_SECRET_KEY ?? "";
    const pk = rig.env.SUPABASE_PUBLISHABLE_KEY ?? "";
    const nonce = Math.random().toString(36).slice(2, 8);
    const email = `sd06-${nonce}@example.com`;
    const password = `Pw-${nonce}-${Math.random().toString(36).slice(2, 10)}`;

    // a - configuration
    const authEnv = envOf(await inspect("supabase-auth"));
    const envUrl = rig.env.API_EXTERNAL_URL ?? "";
    const suffixOk = envUrl.endsWith("/auth/v1");
    const same = envUrl === authEnv.API_EXTERNAL_URL && envUrl === authEnv.GOTRUE_JWT_ISSUER;
    out.push({
      id: `${ID}a`,
      title: "API_EXTERNAL_URL in .env, on the auth container and as GOTRUE_JWT_ISSUER: equal, ending in /auth/v1",
      status: suffixOk && same ? "pass" : "fail",
      detail: `.env ${envUrl}; container API_EXTERNAL_URL ${authEnv.API_EXTERNAL_URL}; GOTRUE_JWT_ISSUER ${authEnv.GOTRUE_JWT_ISSUER}; SUPABASE_PUBLIC_URL ${rig.env.SUPABASE_PUBLIC_URL}`,
      measurements: {
        api_external_url: envUrl,
        supabase_public_url: rig.env.SUPABASE_PUBLIC_URL ?? "unset",
        jwt_issuer_equals_api_external_url: authEnv.GOTRUE_JWT_ISSUER === envUrl ? "yes" : "no",
        mailer_urlpath_confirmation: rig.env.MAILER_URLPATHS_CONFIRMATION ?? "unset",
      },
    });

    // b - a real token
    const created = await http(rig, "/auth/v1/admin/users", { method: "POST", headers: { ...JSON_H, apikey: sk }, body: JSON.stringify({ email, password, email_confirm: true }) });
    const grant = await http(rig, "/auth/v1/token?grant_type=password", { method: "POST", headers: { ...JSON_H, apikey: pk }, body: JSON.stringify({ email, password }) });
    const token = String(jsonOr(grant.body)?.access_token ?? "");
    const parts = jwtParts(token);
    const jwks = jsonOr((await http(rig, "/auth/v1/.well-known/jwks.json", { headers: { apikey: pk } })).body);
    const jwk = (jwks?.keys ?? []).find((k: any) => k.kid === parts?.header.kid && k.kty === "EC");
    let sigOk = false;
    if (parts && jwk) {
      const pub = createPublicKey({ key: jwk, format: "jwk" });
      const [h, p, s] = token.split(".");
      sigOk = verify("SHA256", Buffer.from(`${h}.${p}`), { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.from(s!, "base64url"));
    }
    out.push({
      id: `${ID}b`,
      title: "access token iss equals API_EXTERNAL_URL; ES256 signature verifies against the gateway's JWKS",
      status: created.status < 300 && grant.status === 200 && parts?.payload.iss === envUrl && sigOk ? "pass" : "fail",
      detail: `admin create -> ${created.status}; password grant -> ${grant.status}; iss ${parts?.payload.iss ?? "none"}; header alg ${parts?.header.alg ?? "none"}, kid ${parts?.header.kid ? "present" : "absent"}; signature against JWKS key ${sigOk ? "verified" : "not verified"}`,
      measurements: {
        admin_create_status: created.status,
        password_grant_status: grant.status,
        token_iss: String(parts?.payload.iss ?? "none"),
        token_alg: String(parts?.header.alg ?? "none"),
        token_aud: String(parts?.payload.aud ?? "none"),
        jwks_key_count: (jwks?.keys ?? []).length,
        es256_signature_verified: sigOk ? "yes" : "no",
      },
    });

    // c - an email link
    const gl = await http(rig, "/auth/v1/admin/generate_link", { method: "POST", headers: { ...JSON_H, apikey: sk }, body: JSON.stringify({ type: "magiclink", email }) });
    const link = String(jsonOr(gl.body)?.action_link ?? "");
    let linkPath = "none";
    try {
      linkPath = new URL(link).pathname;
    } catch {
      /* leave "none" */
    }
    out.push({
      id: `${ID}c`,
      title: "generate_link: the path of the link Auth would mail",
      status: gl.status === 200 && linkPath !== "none" ? "info" : "fail",
      detail: `generate_link -> ${gl.status}; action_link path ${linkPath} (host ${(() => { try { return new URL(link).host; } catch { return "none"; } })()}); MAILER_URLPATHS_CONFIRMATION is ${rig.env.MAILER_URLPATHS_CONFIRMATION}`,
      measurements: {
        generate_link_status: gl.status,
        action_link_path: linkPath,
        path_doubles_auth_v1: /\/auth\/v1\/auth\/v1\//.test(linkPath) ? "yes" : "no",
      },
    });

    // d - SAML before it is enabled
    const layers0 = await activeLayers();
    const m0 = await http(rig, "/auth/v1/sso/saml/metadata");
    const j0 = jsonOr(m0.body);
    const old0 = await http(rig, "/sso/saml/metadata");
    out.push({
      id: `${ID}d`,
      title: "SAML default (disabled): /auth/v1/sso/saml/metadata reaches Auth; /sso/saml/metadata does not",
      status: layers0.includes("saml") ? "skip" : m0.status === 404 && j0?.error_code === "saml_provider_disabled" && old0.status === 401 ? "pass" : "fail",
      detail: layers0.includes("saml")
        ? "SAML already on from an earlier run; this check needs the default stack"
        : `GET /auth/v1/sso/saml/metadata -> ${m0.status} ${m0.body.slice(0, 100)}; GET /sso/saml/metadata -> ${old0.status} ${old0.body.slice(0, 60)}`,
      measurements: {
        prefixed_metadata_status: m0.status,
        prefixed_metadata_error_code: String(j0?.error_code ?? "none"),
        unprefixed_metadata_status: old0.status,
        unprefixed_metadata_body: old0.body.slice(0, 60),
      },
    });

    // e - enable SAML as the guide does
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "der" }, publicKeyEncoding: { type: "spki", format: "der" } });
    appendEnv(rig, "SAML_PRIVATE_KEY", Buffer.from(privateKey).toString("base64"));
    const layers = Array.from(new Set<Layer>([...(await activeLayers()), "saml"]));
    const up = await compose(rig, layers, ["up", "-d", "--wait", "auth"]);
    const ready = await waitFor(async () => (await healthOf("supabase-auth")) === "healthy", 90_000, 2000);
    const meta = await http(rig, "/auth/v1/sso/saml/metadata", { headers: { apikey: pk } });
    const entityId = meta.body.match(/entityID="([^"]+)"/)?.[1] ?? "none";
    const acs = meta.body.match(/AssertionConsumerService[^>]*Location="([^"]+)"/)?.[1] ?? "none";
    out.push({
      id: `${ID}e`,
      title: "SAML on: metadata at /auth/v1/sso/saml/metadata names API_EXTERNAL_URL + /sso/saml/{metadata,acs}",
      status: up.code === 0 && ready && meta.status === 200 && entityId === `${envUrl}/sso/saml/metadata` && acs === `${envUrl}/sso/saml/acs` ? "pass" : "fail",
      detail: `up exit ${up.code}; metadata -> ${meta.status} ${meta.headers["content-type"] ?? ""}; entityID ${entityId}; ACS Location ${acs}` + (up.code === 0 ? "" : `; stderr tail: ${scrub(rig, up.err.slice(-300))}`),
      measurements: {
        metadata_status: meta.status,
        metadata_content_type: meta.headers["content-type"] ?? "none",
        entity_id: entityId,
        acs_location: acs,
        saml_key_bits: 2048,
      },
    });

    // f - flow through Envoy with a made-up IdP
    let providerId = "";
    let regStatus = -1;
    let ssoStatus = -1;
    let ssoUrl = "";
    let acsStatus = -1;
    let acsBody = "";
    let acsServer = "";
    let acsLocation = "";
    let acsNoKeyReachedAuth = false;
    try {
      const cert = await idpCert();
      const reg = await http(rig, "/auth/v1/admin/sso/providers", {
        method: "POST",
        headers: { ...JSON_H, apikey: sk },
        body: JSON.stringify({ type: "saml", metadata_xml: idpMetadata(cert), domains: [`sd06-${nonce}.example.com`] }),
      });
      regStatus = reg.status;
      providerId = String(jsonOr(reg.body)?.id ?? "");
      const sso = await http(rig, "/auth/v1/sso", { method: "POST", headers: { ...JSON_H, apikey: pk }, body: JSON.stringify({ domain: `sd06-${nonce}.example.com`, skip_http_redirect: true }) });
      ssoStatus = sso.status;
      ssoUrl = String(jsonOr(sso.body)?.url ?? "");
      const acsResp = await http(rig, "/auth/v1/sso/saml/acs", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "SAMLResponse=bm90LWEtcmVzcG9uc2U%3D&RelayState=x" });
      acsStatus = acsResp.status;
      acsBody = acsResp.body.slice(0, 160);
      acsServer = acsResp.headers["server"] ?? "";
      acsLocation = acsResp.headers["location"] ?? "";
      // Reached Auth if the answer is not Envoy's text/plain 401 and Auth's own redirect or JSON came back.
      acsNoKeyReachedAuth = acsResp.status !== 401 && acsResp.status !== 403 && (acsLocation !== "" || /\{/.test(acsResp.body));
    } finally {
      if (providerId) await http(rig, `/auth/v1/admin/sso/providers/${providerId}`, { method: "DELETE", headers: { apikey: sk } }).catch(() => undefined);
    }
    let ssoHost = "none";
    let hasSamlRequest = false;
    try {
      const u = new URL(ssoUrl);
      ssoHost = u.host;
      hasSamlRequest = u.searchParams.has("SAMLRequest");
    } catch {
      /* none */
    }
    out.push({
      id: `${ID}f`,
      title: "through Envoy: register an IdP with the secret key, POST /auth/v1/sso, ACS reachable without an apikey",
      status: regStatus >= 200 && regStatus < 300 && ssoStatus === 200 && hasSamlRequest && acsNoKeyReachedAuth ? "pass" : "fail",
      detail:
        `register IdP -> ${regStatus}; POST /auth/v1/sso -> ${ssoStatus}, redirect host ${ssoHost}, SAMLRequest ${hasSamlRequest ? "present" : "absent"}; ` +
        `POST /auth/v1/sso/saml/acs with no apikey and a garbage SAMLResponse -> ${acsStatus} (server ${acsServer || "none"}), location ${acsLocation ? redact(acsLocation) : "none"}, body "${acsBody}"; IdP deleted afterwards`,
      measurements: {
        register_status: regStatus,
        sso_status: ssoStatus,
        sso_redirect_host: ssoHost,
        sso_has_samlrequest: hasSamlRequest ? "yes" : "no",
        acs_no_apikey_status: acsStatus,
        acs_no_apikey_location: acsLocation ? redact(acsLocation) : "none",
        acs_no_apikey_body: acsBody,
        acs_reached_auth_not_envoy: acsNoKeyReachedAuth ? "yes" : "no",
      },
    });

    return out;
  },
};
export default mod;
