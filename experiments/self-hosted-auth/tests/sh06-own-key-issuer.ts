/**
 * SH06 - the self-hosted GoTrue as an issuer in its own right.
 *
 * SH02-SH05 rested the self-hosted tokens on the project's legacy HS256
 * secret, which the platform can revoke. This module gives the self-hosted
 * GoTrue its own ES256 key (`make gotrue-up OWNKEY=1`), publishes the public
 * half as a JWKS from an Edge Function on the project, registers that URL as
 * a third-party auth issuer, and asks whether the managed tier trusts the
 * result - and whether it still does after the legacy HS256 key is revoked.
 *
 *   SH06a  the JWKS Edge Function serves the self-hosted public key
 *   SH06b  third-party auth registration with jwks_url resolves
 *   SH06c  self-hosted password grant mints ES256 with the own kid
 *   SH06d  that token against managed PostgREST (polled: a first-time issuer
 *          kid took ~30 s in edge-resilience W01/W05) and managed /auth/v1/user
 *   SH06e  the same token against Storage (`GET /storage/v1/bucket`) - whether
 *          a third-party token is honoured outside the Data API was an open
 *          question in the corpus
 *   SH06f  revoke the legacy HS256 signing key; the own-key token against
 *          PostgREST with the legacy anon apikey and with the sb_publishable
 *          key - independence from the legacy secret, or not
 *
 * Needs PVLAB_ENDPOINT_SELFHOSTED_GOTRUE_MODE=ownkey and
 * PVLAB_ENDPOINT_OWNKEY_PUBLIC_JWK (base64 of the public JWK JSON), both
 * exported by the Makefile. IRREVERSIBLE on the project (SH06f revokes a key);
 * run alone on a fresh project and destroy after. DESTRUCTIVE: deploys one
 * function, one third-party integration and one user; removes all three.
 */
import { mgmt } from "../../../harness/src/mgmt";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { cleanupPrefix, deployViaApi, invokeWhenLive } from "../../edge-function-limits/lib/ef";
import {
  adminCreate,
  adminDelete,
  ensureProbeTable,
  fetchKeys,
  http,
  jwtShape,
  managedAuth,
  passwordGrant,
  PROBE_TABLE,
  randomEmail,
  randomPassword,
  restRead,
  selfHosted,
  sql,
  whoami,
} from "../lib/sha";

const P = "pvlab-sh06-";

interface KeyRow {
  id?: string;
  algorithm?: string;
  status?: string;
}

const mod: TestModule = {
  id: "SH06",
  title: "Self-hosted GoTrue with its own ES256 key, trusted through third-party auth",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const S = selfHosted(ctx);
    if (!ctx.ref) return [{ id: "SH06", title: this.title, status: "skip", detail: "no project ref (PVLAB_REF)" }];
    if (!S) return [{ id: "SH06", title: this.title, status: "skip", detail: "no self-hosted GoTrue - run `make gotrue-up OWNKEY=1` first" }];
    if (ctx.endpoints["selfhosted_gotrue_mode"] !== "ownkey" || !ctx.endpoints["ownkey_public_jwk"]) {
      return [{ id: "SH06", title: this.title, status: "skip", detail: "self-hosted GoTrue is not in own-key mode - run `make gotrue-up OWNKEY=1`" }];
    }
    const M = managedAuth(ctx);
    const keys = await fetchKeys(ctx);
    const publicJwk = JSON.parse(Buffer.from(ctx.endpoints["ownkey_public_jwk"]!, "base64").toString("utf8")) as { kid?: string };
    const out: TestResult[] = [];
    const slug = `${P}jwks`;
    let tpaId = "";
    let userId = "";
    try {
      // SH06a - publish the JWKS from an Edge Function on the project.
      await cleanupPrefix(ctx, P);
      const jwks = JSON.stringify({ keys: [publicJwk] });
      const src = `Deno.serve(() => new Response(${JSON.stringify(jwks)}, { headers: { "Content-Type": "application/json" } }));\n`;
      const dep = await deployViaApi(ctx, slug, [{ name: "index.ts", content: src }], { entrypoint_path: "index.ts", name: slug, verify_jwt: false });
      const served = dep.status < 300 ? await invokeWhenLive(ctx, slug, 90_000) : undefined;
      const servedKid = (() => {
        try {
          return ((JSON.parse(served?.text ?? "{}") as { keys?: { kid?: string }[] }).keys ?? [])[0]?.kid ?? "";
        } catch {
          return "";
        }
      })();
      const jwksUrl = `https://${ctx.apiHost}/functions/v1/${slug}`;
      out.push({
        id: "SH06a",
        title: "JWKS served from an Edge Function on the project",
        status: dep.status < 300 && served?.status === 200 && servedKid === publicJwk.kid ? "pass" : "fail",
        detail: `deploy ${dep.status}; GET ${served?.status ?? "n/a"} kid ${servedKid ? servedKid.slice(0, 8) : "none"}`,
        measurements: { deploy_status: dep.status, get_status: served?.status ?? 0, kid_matches: servedKid === publicJwk.kid ? 1 : 0, jwks_url: jwksUrl },
      });
      if (served?.status !== 200) return out;

      // SH06b - register the issuer.
      const t0 = Date.now();
      const reg = await mgmt(ctx, "POST", `/projects/${ctx.ref}/config/auth/third-party-auth`, { jwks_url: jwksUrl });
      const regJson = (reg.json ?? {}) as { id?: string; resolved_at?: string | null; type?: string };
      tpaId = regJson.id ?? "";
      out.push({
        id: "SH06b",
        title: "third-party auth registration (jwks_url)",
        status: reg.status === 201 && tpaId ? "pass" : "fail",
        detail: `HTTP ${reg.status}; type ${regJson.type ?? "?"}; resolved_at ${regJson.resolved_at ?? "null"}`,
        measurements: { status: reg.status, resolved_on_create: regJson.resolved_at ? 1 : 0, type: regJson.type ?? "?" },
        evidence: reg.status >= 300 ? reg.text.slice(0, 300) : undefined,
      });
      if (!tpaId) return out;

      // SH06c - mint with the own key.
      const email = randomEmail("sh06");
      const password = randomPassword();
      const created = await adminCreate(M, keys, email, password);
      userId = created.id;
      const self = await passwordGrant(S, keys, email, password);
      const shape = jwtShape(self.accessToken);
      out.push({
        id: "SH06c",
        title: "self-hosted password grant with the own key",
        status: self.status === 200 && shape?.alg === "ES256" && shape.kid === publicJwk.kid ? "pass" : "fail",
        detail: shape ? `alg ${shape.alg} kid ${shape.kid.slice(0, 8)} (own kid ${String(publicJwk.kid).slice(0, 8)}), iss ${shape.iss}` : `grant HTTP ${self.status} ${self.code}`,
        measurements: { status: self.status, alg: shape?.alg ?? "?", kid_is_own: shape?.kid === publicJwk.kid ? 1 : 0, iss: shape?.iss ?? "?" },
      });
      if (self.status !== 200) return out;

      // SH06d - managed PostgREST (polled) and managed GoTrue.
      await ensureProbeTable(ctx);
      let rest = await restRead(ctx, keys, self.accessToken);
      let acceptedAt: number | string = "never";
      while (Date.now() - t0 < 120_000 && rest.status !== 200) {
        await Bun.sleep(5_000);
        rest = await restRead(ctx, keys, self.accessToken);
      }
      if (rest.status === 200) acceptedAt = Math.round((Date.now() - t0) / 1000);
      const mUser = await whoami(M, keys, self.accessToken);
      out.push({
        id: "SH06d",
        title: "own-key token against managed PostgREST and managed Auth",
        status: rest.status === 200 && rest.rows === 1 ? "pass" : "fail",
        detail: `PostgREST ${rest.status} rows=${rest.rows}${rest.code ? ` ${rest.code}` : ""}, accepted ${acceptedAt} s after the registration; managed /auth/v1/user ${mUser.status}${mUser.code ? ` ${mUser.code}` : ""}`,
        measurements: { rest_status: rest.status, rest_rows: rest.rows, rest_code: rest.code || "none", accepted_after_s: acceptedAt, managed_user_status: mUser.status, managed_user_code: mUser.code || "none" },
      });

      // SH06e - Storage with a third-party token.
      const anonStorage = await http(`https://${ctx.apiHost}/storage/v1/bucket`, { key: keys.anon });
      const ownStorage = await http(`https://${ctx.apiHost}/storage/v1/bucket`, { key: keys.anon, bearer: self.accessToken });
      const managedGrant = await passwordGrant(M, keys, email, password);
      const managedStorage = await http(`https://${ctx.apiHost}/storage/v1/bucket`, { key: keys.anon, bearer: managedGrant.accessToken });
      out.push({
        id: "SH06e",
        title: "Storage with the own-key (third-party) token vs a managed token",
        status: "info",
        detail: `GET /storage/v1/bucket: anon ${anonStorage.status}; own-key bearer ${ownStorage.status}${ownStorage.status >= 300 ? ` ${String(ownStorage.json.message ?? ownStorage.json.error ?? "").slice(0, 80)}` : ""}; managed bearer ${managedStorage.status}`,
        measurements: { anon_status: anonStorage.status, ownkey_status: ownStorage.status, ownkey_body: ownStorage.status >= 300 ? ownStorage.text.slice(0, 120) : "ok", managed_status: managedStorage.status },
      });

      // SH06f - revoke the legacy HS256 key; does the own-key token survive.
      const list = await mgmt(ctx, "GET", `/projects/${ctx.ref}/config/auth/signing-keys`);
      const hs = (((list.json as { keys?: KeyRow[] } | undefined)?.keys ?? []) as KeyRow[]).find((k) => k.algorithm === "HS256");
      if (!hs?.id || hs.status !== "previously_used") {
        out.push({ id: "SH06f", title: "revoke the legacy HS256 key", status: "skip", detail: `HS256 key is ${hs?.status ?? "absent"}` });
      } else {
        const rev = await mgmt(ctx, "PATCH", `/projects/${ctx.ref}/config/auth/signing-keys/${hs.id}`, { status: "revoked" });
        await Bun.sleep(10_000);
        const withAnon = await restRead(ctx, keys, self.accessToken);
        const newKeys = await mgmt(ctx, "GET", `/projects/${ctx.ref}/api-keys?reveal=true`);
        const publishable = (Array.isArray(newKeys.json) ? (newKeys.json as { type?: string; api_key?: string }[]) : []).find((k) => k.type === "publishable")?.api_key ?? "";
        const withPub = publishable
          ? await http(`https://${ctx.apiHost}/rest/v1/${PROBE_TABLE}?select=id`, { key: publishable, bearer: self.accessToken })
          : { status: 0, json: {}, text: "no publishable key", ms: 0 };
        const pubRows = Array.isArray(withPub.json) ? (withPub.json as unknown[]).length : 0;
        const fresh = await passwordGrant(S, keys, email, password);
        out.push({
          id: "SH06f",
          title: "after revoking the legacy HS256 key: the own-key token",
          status: rev.status < 300 && withPub.status === 200 && pubRows === 1 ? "pass" : "fail",
          detail:
            `revoke ${rev.status}; own-key token + legacy anon apikey -> ${withAnon.status}${withAnon.code ? ` ${withAnon.code}` : ""}; ` +
            `own-key token + sb_publishable apikey -> ${withPub.status} rows=${pubRows}; fresh self-hosted grant ${fresh.status}${fresh.code ? ` ${fresh.code}` : ""}`,
          measurements: {
            revoke_status: rev.status,
            legacy_anon_apikey_status: withAnon.status,
            legacy_anon_apikey_code: withAnon.code || "none",
            publishable_apikey_status: withPub.status,
            publishable_apikey_rows: pubRows,
            fresh_self_grant_status: fresh.status,
          },
        });
      }
    } catch (e) {
      out.push({ id: "SH06", title: this.title, status: "fail", detail: `threw: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      const notes: string[] = [];
      if (tpaId) notes.push(`tpa delete ${(await mgmt(ctx, "DELETE", `/projects/${ctx.ref}/config/auth/third-party-auth/${tpaId}`).catch(() => ({ status: 0 }))).status}`);
      if (userId) {
        const st = await adminDelete(M, keys, userId).catch(() => 0);
        if (st >= 300 || st === 0) {
          const r = await sql(ctx, `delete from auth.users where id = '${userId.replace(/[^0-9a-f-]/gi, "")}'`);
          notes.push(`user delete via sql ${r.status} (admin api ${st})`);
        } else notes.push(`user delete ${st}`);
      }
      const c = await cleanupPrefix(ctx, P).catch(() => ({ deleted: 0, left: ["cleanup threw"] }));
      notes.push(`functions deleted ${c.deleted}${c.left.length ? ` LEFT ${c.left.join(",")}` : ""}`);
      out.push({ id: "SH06z", title: "cleanup", status: c.left.length ? "fail" : "pass", detail: notes.join("; ") });
    }
    return out;
  },
};
export default mod;
