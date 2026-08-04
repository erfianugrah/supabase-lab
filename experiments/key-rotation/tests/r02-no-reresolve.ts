/**
 * R02 - the consumer does not re-resolve the issuer's JWKS.
 *
 * After the hub rotates its signing key, the spoke's cached kid set stays
 * exactly as it was at trust-creation time. A token signed by the NEW key
 * is rejected with PGRST301 even though the hub is now publishing that kid.
 * A token signed by the OLD key keeps working throughout.
 *
 * Every probe records all four fields that make the anomaly explicable:
 *   pgrst_code   - the PostgREST error code from the spoke (not just HTTP status)
 *   cached_kids  - the spoke's third-party-auth resolved_jwks kid set
 *   hub_jwks_kids - the hub's published JWKS kid set
 *   key_status   - the token's own signing key status re-read at that moment
 *
 * Capturing only HTTP status codes is exactly what left the original anomaly
 * unexplained; this module captures enough to distinguish "the spoke never
 * re-resolved" from "the hub hasn't published the new kid yet" from "the key
 * was revoked".
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import {
  PASSWORD,
  keys,
  waitReady,
  listSigningKeys,
  patchSigningKey,
  adminCreate,
  login,
  jwtHeader,
  restProbe,
  listTpa,
  clearTpa,
  fetchJwks,
  keyStatus,
  accessToken,
} from "../lib/rotation";

// Configurable polling: the live windows were 20 minutes for R02. Defaults
// match a real run; override with env for fast iteration.
const MIN = 60_000;
const WINDOW_MS = parseInt(process.env.KEYROT_R02_WINDOW_MS || String(20 * MIN), 10);
const POLL_INTERVAL_MS = parseInt(process.env.KEYROT_R02_POLL_INTERVAL_MS || String(10_000), 10);

const RUN = Math.random().toString(36).slice(2, 8);
const EMAIL = `r02-${RUN}@lab.invalid`;

interface ProbePoint {
  // Token signed by old key -> spoke
  old_pgrst_code: string;
  old_http_status: number;
  // Token signed by new key -> spoke
  new_pgrst_code: string;
  new_http_status: number;
  // Spoke's cached kids from the third-party-auth integration
  cached_kids: string[];
  // Hub's published JWKS kids from /.well-known/jwks.json
  hub_jwks_kids: string[];
  // Each key's status at probe time
  old_key_status: string;
  new_key_status: string;
}

const mod: TestModule = {
  id: "R02",
  title: "The consumer does not re-resolve the issuer's JWKS after rotation",
  where: "local",
  requires: ["pat", "peer"],
  destructive: true, // promotes a signing key on the hub; writes auth config, users and schema on both projects
  async run(ctx) {
    const spoke = ctx.peers.spoke;
    if (!spoke) {
      return {
        id: "R02",
        title: this.title,
        status: "skip",
        detail: "PVLAB_PEER_SPOKE not set - this experiment needs two projects",
      };
    }
    const results: TestResult[] = [];
    const hub = ctx.ref;
    const hubHost = `${hub}.supabase.co`;
    const spokeHost = `${spoke}.supabase.co`;
    const hubIssuer = `https://${hubHost}/auth/v1`;

    await waitReady(ctx, hub);
    await waitReady(ctx, spoke);

    const hubKeys = await keys(ctx, hub);
    const spokeKeys = await keys(ctx, spoke);
    if (!hubKeys.anon || !hubKeys.service || !spokeKeys.anon) {
      return [
        ...results,
        {
          id: "R02z",
          title: "key fetch",
          status: "fail",
          detail: "could not read project API keys",
        },
      ];
    }

    // ---- Clean slate on the spoke. ----
    await clearTpa(ctx, spoke);

    // ---- Register the hub as the spoke's IdP. ----
    const tpaCreate = await (await import("../../../harness/src/mgmt")).mgmt(
      ctx,
      "POST",
      `/projects/${spoke}/config/auth/third-party-auth`,
      { oidc_issuer_url: hubIssuer },
    );
    const tpaId =
      tpaCreate.json && typeof tpaCreate.json === "object" && !Array.isArray(tpaCreate.json)
        ? String((tpaCreate.json as Record<string, unknown>).id ?? "")
        : "";

    results.push({
      id: "R02a",
      title: "Spoke trusts the hub issuer",
      status: tpaCreate.status < 300 && tpaId ? "pass" : "fail",
      detail: `create HTTP ${tpaCreate.status}, id=${tpaId.slice(0, 12)}`,
      measurements: { status: tpaCreate.status },
      evidence: tpaCreate.text.slice(0, 300),
    });

    // ---- Create a user on the hub and get a token. ----
    await adminCreate(hubHost, hubKeys.service, {
      email: EMAIL,
      password: PASSWORD,
      email_confirm: true,
    });
    const preLogin = await login(hubHost, hubKeys.anon, EMAIL);
    const oldToken = accessToken(preLogin);
    if (!oldToken) {
      return [
        ...results,
        {
          id: "R02z",
          title: "hub login",
          status: "fail",
          detail: `pre-rotation login failed: HTTP ${preLogin.status}`,
        },
      ];
    }
    const oldKid = String(jwtHeader(oldToken).kid ?? "?");

    // ---- Find the standby key (created by R01) and promote it. ----
    const initialKeys = await listSigningKeys(hubHost, hubKeys.service);
    const standby = initialKeys.find((k) => k.status === "standby");

    if (!standby) {
      return [
        ...results,
        {
          id: "R02z",
          title: "standby key",
          status: "skip",
          detail:
            "no standby signing key found - R01 must run first to create one. " +
            `Keys present: ${initialKeys.map((k) => `${k.kid}(${k.status})`).join(", ")}`,
        },
      ];
    }

    const oldKeyBeforePromote = initialKeys.find((k) => k.status === "active");
    results.push({
      id: "R02b",
      title: "Pre-rotation key state",
      status: "info",
      detail: `active=${oldKeyBeforePromote?.kid ?? "?"}, standby=${standby.kid}`,
      measurements: {
        old_kid: oldKid,
        standby_kid: standby.kid,
        active_matches_old: String(oldKid === (oldKeyBeforePromote?.kid ?? "")),
      },
    });

    // ---- Promote the standby to active. ----
    const promote = await patchSigningKey(hubHost, hubKeys.service, standby.id, {
      status: "active",
    });
    results.push({
      id: "R02c",
      title: "Standby key promoted to active",
      status: promote.status < 300 ? "pass" : "fail",
      detail: `promote HTTP ${promote.status}: standby=${standby.kid}`,
      measurements: { status: promote.status },
    });

    // ---- Wait for the hub's JWKS to publish the new kid. ----
    const jwksWaitT0 = performance.now();
    let hubJwks = await fetchJwks(hubHost);
    const jwksBudget = 300000; // 5 minutes for the hub to publish
    while (
      !hubJwks.kids.includes(standby.kid) &&
      performance.now() - jwksWaitT0 < jwksBudget
    ) {
      await new Promise((r) => setTimeout(r, 5000));
      hubJwks = await fetchJwks(hubHost);
    }
    const jwksPropagationMs = Math.round(performance.now() - jwksWaitT0);

    results.push({
      id: "R02d",
      title: "Hub JWKS includes the new kid after rotation",
      status: hubJwks.kids.includes(standby.kid) ? "pass" : "fail",
      detail: hubJwks.kids.includes(standby.kid)
        ? `new kid ${standby.kid} in JWKS after ${jwksPropagationMs}ms; kids=[${hubJwks.kids.join(", ")}]`
        : `new kid ${standby.kid} still not in JWKS after ${jwksPropagationMs}ms; kids=[${hubJwks.kids.join(", ")}]`,
      measurements: {
        propagation_ms: jwksPropagationMs,
        jwks_kid_count: hubJwks.kids.length,
        new_kid_published: String(hubJwks.kids.includes(standby.kid)),
      },
    });

    // ---- Get a token signed by the new key. ----
    const postLogin = await login(hubHost, hubKeys.anon, EMAIL);
    const newToken = accessToken(postLogin);
    const newKid = newToken ? String(jwtHeader(newToken).kid ?? "?") : "?";

    results.push({
      id: "R02e",
      title: "Token signatures after rotation",
      status: newToken && newKid === standby.kid ? "pass" : "fail",
      detail: `old token kid=${oldKid}, new token kid=${newKid}, standby kid=${standby.kid}`,
      measurements: {
        new_token_signed_by_standby: String(newKid === standby.kid),
        old_token_signed_by_active: String(oldKid === (oldKeyBeforePromote?.kid ?? "")),
      },
    });

    // ---- Probe loop: the spoke never re-resolves. ----
    const probeT0 = performance.now();
    const probePoints: ProbePoint[] = [];

    while (performance.now() - probeT0 < WINDOW_MS) {
      const signingKeys = await listSigningKeys(hubHost, hubKeys.service);
      const tpas = await listTpa(ctx, spoke);
      const hubTpa = tpas.find(
        (t) => t.oidc_issuer_url === hubIssuer || t.jwks_url?.includes(hubHost),
      );
      const jwks = await fetchJwks(hubHost);

      // Extract cached kids from the spoke's resolved JWKS.
      let cachedKids: string[] = [];
      if (hubTpa?.resolved_jwks && typeof hubTpa.resolved_jwks === "object") {
        const rj = hubTpa.resolved_jwks as Record<string, unknown>;
        const keys = Array.isArray(rj.keys) ? rj.keys : [];
        cachedKids = keys.map((k: unknown) =>
          String((k as Record<string, unknown>).kid ?? "?"),
        );
      }

      const oldProbe = await restProbe(spokeHost, spokeKeys.anon, oldToken);
      const newProbe = newToken
        ? await restProbe(spokeHost, spokeKeys.anon, newToken)
        : { status: -1, code: "no_token", text: "" };

      probePoints.push({
        old_pgrst_code: oldProbe.code ?? `HTTP_${oldProbe.status}`,
        old_http_status: oldProbe.status,
        new_pgrst_code: newProbe.code ?? `HTTP_${newProbe.status}`,
        new_http_status: newProbe.status,
        cached_kids: cachedKids,
        hub_jwks_kids: jwks.kids,
        old_key_status: keyStatus(signingKeys, oldKid) ?? "not_found",
        new_key_status: keyStatus(signingKeys, standby.kid) ?? "not_found",
      });

      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    const probeCount = probePoints.length;

    // ---- Assertions on the probe data. ----
    const cachedKidsAllSame = probePoints.every(
      (p) =>
        JSON.stringify(p.cached_kids) ===
        JSON.stringify(probePoints[0]?.cached_kids),
    );
    const cachedKidsConstant = probeCount > 0 && cachedKidsAllSame;
    const oldTokenAccepted = probePoints.every((p) => p.old_http_status < 400);
    const newTokenRefused = probePoints.every((p) =>
      p.new_pgrst_code.includes("PGRST301"),
    );
    const hubJwksHasStandby = probePoints.every((p) =>
      p.hub_jwks_kids.includes(standby.kid),
    );

    results.push({
      id: "R02f",
      title:
        "Spoke never re-resolves: cached kid set constant throughout the window",
      status: probeCount > 0 && cachedKidsConstant ? "pass" : "fail",
      detail: cachedKidsConstant
        ? `${probeCount} probes over ${Math.round(WINDOW_MS / 60000)}min, cached kids stayed [${probePoints[0]?.cached_kids?.join(", ") ?? "none"}]`
        : `${probeCount} probes, cached kids changed or zero probes`,
      measurements: {
        probe_count: probeCount,
        cached_kids_constant: String(cachedKidsConstant),
        initial_cached_count: probePoints[0]?.cached_kids.length ?? 0,
        initial_cached_first: probePoints[0]?.cached_kids[0] ?? "none",
      },
    });

    results.push({
      id: "R02g",
      title: "Old token (signed by previously_used key) still accepted by the spoke",
      status: probeCount > 0 && oldTokenAccepted ? "pass" : "fail",
      detail: oldTokenAccepted
        ? `accepted at all ${probeCount} probe points`
        : `refused at some point: codes [${probePoints.map((p) => p.old_pgrst_code).join(", ")}]`,
      measurements: {
        probe_count: probeCount,
        old_token_accepted: String(oldTokenAccepted),
        old_key_status_final: probePoints.at(-1)?.old_key_status ?? "unknown",
      },
    });

    results.push({
      id: "R02h",
      title: "New token (signed by new key) refused by the spoke with PGRST301",
      status: probeCount > 0 && newTokenRefused ? "pass" : "fail",
      detail: newTokenRefused
        ? `PGRST301 at all ${probeCount} probe points - spoke never re-resolved`
        : `not PGRST301 at some point: codes [${probePoints.map((p) => p.new_pgrst_code).join(", ")}]`,
      measurements: {
        probe_count: probeCount,
        new_token_refused: String(newTokenRefused),
        new_key_status_final: probePoints.at(-1)?.new_key_status ?? "unknown",
      },
    });

    results.push({
      id: "R02i",
      title: "Hub JWKS includes the new kid throughout the probe window",
      status: hubJwksHasStandby ? "pass" : "fail",
      detail: hubJwksHasStandby
        ? `kid ${standby.kid} in hub JWKS at all ${probeCount} probe points`
        : `kid ${standby.kid} missing from hub JWKS at some point`,
      measurements: {
        hub_has_standby_kid: String(hubJwksHasStandby),
      },
    });

    return results;
  },
};
export default mod;