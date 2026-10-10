/**
 * AU04 - SAML SSO canary without a third-party IdP.
 *
 * A SAML SSO provider is registered from metadata XML (no URL fetch), so the
 * IdP never has to be reachable by Supabase: the browser carries the
 * AuthnRequest to the IdP and the signed Response back to the Auth server's
 * ACS. This module plays the browser and the IdP: it reads the AuthnRequest ID
 * out of the SP-initiated redirect, has lib/saml-idp.mjs (xml-crypto, in a
 * container) sign a Response for it, and POSTs that to the ACS.
 *
 *   AU04a  setup: saml_enabled, create the SSO provider through the Management
 *          API (status, body keys), read the SP metadata
 *   AU04b  SP-initiated sign-in with a valid signed assertion (n=4 latencies);
 *          user, identity provider label, replay of the same Response
 *   AU04c  negative controls: bad signature, unsigned, wrong audience, expired,
 *          wrong recipient, IdP-initiated (no InResponseTo): outcome each
 *
 * What this does not cover: a real IdP's own availability, metadata URL
 * refresh, and encrypted assertions. The "IdP" is the test itself, so a pass
 * here says the Auth server accepts a well-formed, correctly signed Response,
 * not that any particular vendor's IdP interoperates.
 *
 * DESTRUCTIVE: au-* project (deleted in `finally`). Requires docker
 * (a local oven/bun image) and openssl.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inflateRawSync } from "node:zlib";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import { authFetch, cell, destroyProject, jwtPayload, patchAuthConfig, provisionProject, SITE_URL, type Rig } from "../lib/rig.js";

const IMAGE = "oven/bun:1";
const IDP_SCRIPT = resolve(import.meta.dir, "../lib/saml-idp.mjs");
const DOMAIN = "pvlab-idp.example.com";
const IDP_ENTITY = "https://pvlab-idp.example.com/idp";

async function run(cmd: string[], timeoutMs = 240_000): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => p.kill(), timeoutMs);
  const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  clearTimeout(timer);
  return { code, out: o + e };
}

interface Landing {
  status: number;
  userId?: string;
  provider?: string;
  email?: string;
  error?: string;
  errorCode?: string;
  errorDescription?: string;
  body?: string;
}

async function postAcs(acs: string, samlResponse: string, relayState: string): Promise<Landing> {
  const res = await fetch(acs, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ SAMLResponse: samlResponse, ...(relayState ? { RelayState: relayState } : {}) }).toString(),
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
  const loc = res.headers.get("location");
  if (!loc) return { status: res.status, body: (await res.text()).replace(/\s+/g, " ").slice(0, 300) };
  const l = new URL(loc);
  const frag = new URLSearchParams(l.hash.replace(/^#/, ""));
  const pick = (k: string) => frag.get(k) ?? l.searchParams.get(k) ?? undefined;
  const access = pick("access_token");
  if (access) {
    const p = jwtPayload(access);
    return { status: res.status, userId: String(p.sub ?? ""), email: String(p.email ?? ""), provider: (p.app_metadata as { provider?: string } | undefined)?.provider };
  }
  return { status: res.status, error: pick("error"), errorCode: pick("error_code"), errorDescription: pick("error_description") };
}

const mod: TestModule = {
  id: "AU04",
  title: "SAML SSO canary with a lab-signed IdP response",
  where: "local",
  requires: ["pat", "org"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const results: TestResult[] = [];
    const pro = ctx.orgs.pro ?? "";
    if (!pro) return [{ id: "AU04", title: this.title, status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    if ((await run(["docker", "image", "inspect", IMAGE])).code !== 0) {
      return [{ id: "AU04", title: this.title, status: "skip", detail: `docker image ${IMAGE} not present` }];
    }
    let rig: Rig | undefined;
    let dir = "";
    try {
      dir = await mkdtemp(join(tmpdir(), "au-saml-"));
      const mk = async (name: string) => {
        const g = await run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, `${name}.key`), "-out", join(dir, `${name}.crt`), "-subj", "/CN=pvlab-idp", "-days", "2"]);
        if (g.code !== 0) throw new Error(`openssl failed: ${g.out.slice(-200)}`);
      };
      await mk("idp");
      await mk("other");
      const keyPem = await Bun.file(join(dir, "idp.key")).text();
      const certPem = await Bun.file(join(dir, "idp.crt")).text();
      const otherKeyPem = await Bun.file(join(dir, "other.key")).text();
      const certB64 = certPem.replace(/-----[A-Z ]+-----|\s/g, "");
      await Bun.write(join(dir, "saml-idp.mjs"), await Bun.file(IDP_SCRIPT).text());
      await writeFile(join(dir, "package.json"), JSON.stringify({ name: "w", private: true, type: "module" }));
      const inst = await run(["docker", "run", "--rm", "-v", `${dir}:/w`, "-w", "/w", IMAGE, "bun", "add", "xml-crypto"]);
      if (inst.code !== 0) throw new Error(`bun add xml-crypto failed: ${inst.out.slice(-300)}`);

      rig = await provisionProject(ctx, pro, "au04", { pro: true });
      const r = rig;
      const metadataXml =
        `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${IDP_ENTITY}"><md:IDPSSODescriptor WantAuthnRequestsSigned="false" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">` +
        `<md:KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>${certB64}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>` +
        `<md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>` +
        `<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://${DOMAIN}/sso"/></md:IDPSSODescriptor></md:EntityDescriptor>`;

      // ---- AU04a: setup ----
      const en = await patchAuthConfig(r, { saml_enabled: true, site_url: SITE_URL }, (s) => s.saml_enabled === true, 60_000);
      const create = await mgmt(r.ctx, "POST", `/projects/${r.ref}/config/auth/sso/providers`, {
        type: "saml",
        metadata_xml: metadataXml,
        domains: [DOMAIN],
        attribute_mapping: { keys: { email: { name: "email" }, sub: { name: "sub" } } },
      });
      const providerId = String((create.json as { id?: string } | undefined)?.id ?? "");
      const spMeta = await fetch(`https://${r.ctx.apiHost}/auth/v1/sso/saml/metadata`, { headers: { apikey: r.keys.publishable! } });
      const spXml = await spMeta.text();
      const spEntity = spXml.match(/entityID="([^"]+)"/)?.[1] ?? "";
      const acs = spXml.match(/AssertionConsumerService[^>]*Location="([^"]+)"/)?.[1] ?? `https://${r.ctx.apiHost}/auth/v1/sso/saml/acs`;
      results.push({
        id: "AU04a",
        title: "AU04a: enable SAML, create SSO provider from metadata XML",
        status: create.status === 201 && providerId && spEntity ? "pass" : "fail",
        detail: `saml_enabled patch HTTP ${en.status} settled=${en.settled}; provider create HTTP ${create.status}${create.status === 201 ? "" : " " + create.text.slice(0, 300)}; SP metadata HTTP ${spMeta.status}`,
        measurements: {
          saml_enabled_patch_status: en.status,
          saml_enabled_settled: String(en.settled),
          provider_create_status: create.status,
          provider_response_keys: cell(Object.keys((create.json as object) ?? {}).sort().join(",")),
          sp_metadata_status: spMeta.status,
          sp_entity_id_matches_project_url: String(spEntity === `https://${r.ctx.apiHost}/auth/v1/sso/saml/metadata`),
          acs_matches_project_url: String(acs === `https://${r.ctx.apiHost}/auth/v1/sso/saml/acs`),
        },
      });
      if (create.status !== 201 || !spEntity) throw new Error(`cannot continue: provider create HTTP ${create.status}`);

      // One SP-initiated attempt: request the SSO redirect, read the AuthnRequest ID,
      // have the lab IdP sign a Response for it, POST it to the ACS.
      const attempt = async (variant: string, email: string, opts: { reuse?: { response: string; relay: string }; idpInitiated?: boolean } = {}): Promise<{ landing: Landing; ssoStatus: number; response: string; relay: string; ms: number }> => {
        const t0 = performance.now();
        let relay = "";
        let inResponseTo = "";
        let ssoStatus = 0;
        if (opts.reuse) {
          const landing = await postAcs(acs, opts.reuse.response, opts.reuse.relay);
          return { landing, ssoStatus: 0, response: opts.reuse.response, relay: opts.reuse.relay, ms: Math.round(performance.now() - t0) };
        }
        if (!opts.idpInitiated) {
          const sso = await authFetch(r, "POST", "/sso", { key: r.keys.publishable, body: { domain: DOMAIN, redirect_to: SITE_URL, skip_http_redirect: true } });
          ssoStatus = sso.status;
          const url = String(sso.json?.url ?? "");
          if (!url) return { landing: { status: sso.status, body: sso.text.slice(0, 300) }, ssoStatus, response: "", relay: "", ms: Math.round(performance.now() - t0) };
          const u = new URL(url);
          relay = u.searchParams.get("RelayState") ?? "";
          const reqXml = inflateRawSync(Buffer.from(u.searchParams.get("SAMLRequest") ?? "", "base64")).toString("utf8");
          inResponseTo = reqXml.match(/\sID="([^"]+)"/)?.[1] ?? "";
        }
        const spec = Buffer.from(JSON.stringify({ keyPem, certPem, otherKeyPem, issuer: IDP_ENTITY, audience: spEntity, acs, inResponseTo, email, sub: `sub-${email}`, variant })).toString("base64");
        const g = await run(["docker", "run", "--rm", "-e", `SPEC_B64=${spec}`, "-v", `${dir}:/w`, "-w", "/w", IMAGE, "bun", "saml-idp.mjs"]);
        const line = g.out.split("\n").find((l) => l.startsWith("RESULT:"));
        if (!line) throw new Error(`idp script: ${g.out.slice(-300)}`);
        const response = line.slice(7);
        const t1 = performance.now();
        const landing = await postAcs(acs, response, relay);
        return { landing, ssoStatus, response, relay, ms: Math.round(performance.now() - t1) };
      };
      const verdict = (l: Landing) => {
        if (l.userId) return `session (${l.provider})`;
        const d = l.errorDescription ?? l.error ?? l.body ?? "";
        return `${l.status} ${l.errorCode ?? ""} ${d.length > 200 ? `${d.slice(0, 50)} ... ${d.slice(-100)}` : d}`.trim();
      };

      // ---- AU04b: valid sign-in, latency, replay ----
      const email = `saml-user@${DOMAIN}`;
      const first = await attempt("ok", email);
      const lat: number[] = [first.ms];
      const users = new Set<string>([first.landing.userId ?? ""]);
      for (let i = 0; i < 3; i++) {
        const a = await attempt("ok", email);
        lat.push(a.ms);
        users.add(a.landing.userId ?? "");
      }
      const replay = await attempt("ok", email, { reuse: { response: first.response, relay: first.relay } });
      const udata = first.landing.userId ? await authFetch(r, "GET", `/admin/users/${first.landing.userId}`) : undefined;
      results.push({
        id: "AU04b",
        title: "AU04b: SP-initiated sign-in with a valid signed assertion; replay",
        status: first.landing.userId && users.size === 1 && !replay.landing.userId ? "pass" : "fail",
        detail: `first: ${verdict(first.landing)}; replay of the same Response: ${verdict(replay.landing)}`,
        measurements: {
          sso_redirect_status: first.ssoStatus,
          acs_post_ms_first: lat[0] ?? -1,
          acs_post_ms_max_of_4: Math.max(...lat),
          signins_attempted: lat.length,
          same_user_every_time: String(users.size === 1 && !users.has("")),
          app_metadata_provider: cell(first.landing.provider),
          user_email: cell(udata?.json?.email),
          identity_provider: cell(udata?.json?.identities?.[0]?.provider),
          replay_signed_in: String(Boolean(replay.landing.userId)),
          replay_error: cell(replay.landing.errorDescription ?? replay.landing.error ?? replay.landing.body),
        },
      });

      // ---- AU04c: negative controls ----
      const m: Record<string, string | number> = {};
      const notes: string[] = [];
      for (const v of ["badsig", "unsigned", "wrongaud", "expired", "wrongrecipient"]) {
        const a = await attempt(v, email);
        m[`${v}_signed_in`] = String(Boolean(a.landing.userId));
        const desc = a.landing.errorDescription ?? a.landing.error ?? a.landing.body ?? "";
        m[`${v}_outcome`] = cell(`${a.landing.status} ${a.landing.errorCode ?? ""} ${desc.slice(0, 40)}`.trim());
        m[`${v}_description_chars`] = desc.length;
        m[`${v}_description_tail`] = cell(desc.slice(-150));
        m[`${v}_description_echoes_response_xml`] = String(/<samlp:Response|<saml:Assertion/.test(desc));
        notes.push(`${v}: ${verdict(a.landing)}`);
      }
      const other = await attempt("ok", "someone@example.org");
      m.other_domain_email_signed_in = String(Boolean(other.landing.userId));
      m.other_domain_email_outcome = cell(verdict(other.landing).slice(0, 120));
      notes.push(`other-domain email: ${verdict(other.landing)}`);
      const idp = await attempt("ok", email, { idpInitiated: true });
      m.idp_initiated_signed_in = String(Boolean(idp.landing.userId));
      m.idp_initiated_outcome = cell(verdict(idp.landing).slice(0, 120));
      notes.push(`IdP-initiated: ${verdict(idp.landing)}`);
      results.push({
        id: "AU04c",
        title: "AU04c: SAML negative controls (signature, audience, expiry, recipient, IdP-initiated)",
        status: "info",
        detail: notes.join(" | "),
        measurements: m,
      });
    } catch (e) {
      results.push({ id: "AU04-error", title: "AU04-error", status: "fail", detail: String((e as Error)?.stack ?? e).slice(0, 600) });
    } finally {
      const cleanup: string[] = [];
      if (rig) cleanup.push(`project delete HTTP ${await destroyProject(ctx, rig.ref)}`);
      if (dir) {
        // the container installed node_modules as root; remove through docker first
        await run(["docker", "run", "--rm", "-v", `${dir}:/w`, IMAGE, "sh", "-c", "rm -rf /w/* /w/.[!.]*"]).catch(() => undefined);
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
        cleanup.push("scratch dir removed");
      }
      results.push({ id: "AU04z", title: "AU04z: cleanup", status: cleanup.some((c) => /HTTP [45]/.test(c)) ? "fail" : "info", detail: cleanup.join("; ") });
    }
    return results;
  },
};
export default mod;
