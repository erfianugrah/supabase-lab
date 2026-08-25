/**
 * R03 - a revoked key is still honoured.
 *
 * Self-contained: mints a token while the active key is still signing, then
 * rotates (creates and promotes a standby), revokes the original, and probes
 * the spoke. The measured sequence is mint -> rotate -> revoke -> observe.
 *
 * The key status is re-read from the hub's signing-keys endpoint immediately
 * before each probe, so "revoked but accepted" is measured on both sides
 * rather than inferred from a PATCH that returned earlier.
 *
 * Every probe records: pgrst_code, cached_kids, hub_jwks_kids, key_status.
 * These four fields exist because capturing only HTTP status codes is
 * exactly what left the original anomaly unexplained.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import {
  PASSWORD,
  keys,
  waitReady,
  listSigningKeys,
  createSigningKey,
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

// Configurable polling: live window was 15 minutes for R03.
const MIN = 60_000;
const WINDOW_MS = parseInt(process.env.KEYROT_R03_WINDOW_MS || String(15 * MIN), 10);
const POLL_INTERVAL_MS = parseInt(process.env.KEYROT_R03_POLL_INTERVAL_MS || String(10_000), 10);

const RUN = Math.random().toString(36).slice(2, 8);
const EMAIL = `r03-${RUN}@lab.invalid`;

interface RevokedProbe {
  pgrst_code: string;
  http_status: number;
  cached_kids: string[];
  hub_jwks_kids: string[];
  old_key_status: string;
}

/** Parse an ISO8601 deadline from a rate-limit "Please wait until ..." message. */
function parseDeadline(text: string): Date | null {
  const m = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/.exec(text);
  return m ? new Date(m[0]) : null;
}

const mod: TestModule = {
  id: "R03",
  title: "A revoked key is still honoured by the spoke",
  where: "local",
  requires: ["pat", "peer"],
  destructive: true, // revokes a signing key on the hub; writes auth config and users
  async run(ctx) {
    const spoke = ctx.peers.spoke;
    if (!spoke) {
      return {
        id: "R03",
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
          id: "R03z",
          title: "key fetch",
          status: "fail",
          detail: "could not read project API keys",
        },
      ];
    }

    // ---- Ensure the spoke trusts the hub. ----
    const tpas = await listTpa(ctx, spoke);
    const existing = tpas.find(
      (t) => t.oidc_issuer_url === hubIssuer || t.jwks_url?.includes(hubHost),
    );
    if (!existing) {
      await clearTpa(ctx, spoke);
      await (await import("../../../harness/src/mgmt")).mgmt(
        ctx,
        "POST",
        `/projects/${spoke}/config/auth/third-party-auth`,
        { oidc_issuer_url: hubIssuer },
      );
    }

    // ---- Identify the active signing key. This is the key whose token
    //      will be tested after revocation. ----
    const initialKeys = await listSigningKeys(ctx, hub);
    const activeKey = initialKeys.find((k) => k.status === "in_use");
    if (!activeKey) {
      return [
        ...results,
        {
          id: "R03z",
          title: "active key",
          status: "fail",
          detail: `no active signing key found. Keys: ${initialKeys.map((k) => `${k.kid}(${k.status})`).join(", ")}`,
        },
      ];
    }

    results.push({
      id: "R03a",
      title: "Initial key state",
      status: "info",
      detail: initialKeys
        .map((k) => `${k.kid.slice(0, 12)}(${k.status})`)
        .join(", "),
      measurements: { total_keys: initialKeys.length },
    });

    // ---- Mint a user and token while the active key is still signing. ----
    await adminCreate(hubHost, hubKeys.service, {
      email: EMAIL,
      password: PASSWORD,
      email_confirm: true,
    });
    const loginResp = await login(hubHost, hubKeys.anon, EMAIL);
    const revokeeToken = accessToken(loginResp);
    if (!revokeeToken) {
      return [
        ...results,
        {
          id: "R03z",
          title: "mint token",
          status: "fail",
          detail: `login failed: HTTP ${loginResp.status}`,
        },
      ];
    }
    const revokeeKid = String(jwtHeader(revokeeToken).kid ?? "?");
    results.push({
      id: "R03b",
      title: "Token minted with the to-be-revoked key",
      status: revokeeKid === activeKey.kid ? "pass" : "fail",
      detail: `token kid=${revokeeKid}, active kid=${activeKey.kid}`,
      measurements: {
        token_matches_active: String(revokeeKid === activeKey.kid),
      },
    });

    // ---- Create or find a standby key to rotate to. ----
    const keysAfterMint = await listSigningKeys(ctx, hub);
    let standby = keysAfterMint.find((k) => k.status === "standby");

    if (!standby) {
      const createAttempt = await createSigningKey(ctx, hub);
      const msg =
        createAttempt.json && typeof createAttempt.json === "object" && !Array.isArray(createAttempt.json)
          ? String((createAttempt.json as Record<string, unknown>).message ?? "")
          : "";
      const deadline = parseDeadline(msg);

      if (deadline) {
        // Rate-limited: wait out the deadline, then retry.
        const waitMs = Math.max(0, deadline.getTime() - Date.now() + 2000);
        const t0 = performance.now();
        if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
        const waitedMs = Math.round(performance.now() - t0);
        const retry = await createSigningKey(ctx, hub);
        results.push({
          id: "R03c",
          title: "Standby key created after rate-limit wait",
          status: retry.status < 300 ? "pass" : "fail",
          detail: `waited ${waitedMs}ms, create HTTP ${retry.status}`,
          measurements: { waited_ms: waitedMs, status: retry.status },
        });
      } else if (createAttempt.status < 300) {
        results.push({
          id: "R03c",
          title: "Standby key created immediately",
          status: "pass",
          detail: `create HTTP ${createAttempt.status}`,
          measurements: { status: createAttempt.status },
        });
      } else {
        return [
          ...results,
          {
            id: "R03z",
            title: "standby create",
            status: "fail",
            detail: `create HTTP ${createAttempt.status}: ${createAttempt.text.slice(0, 200)}`,
          },
        ];
      }
    }

    // Re-read to find the standby (may have just been created).
    const keysPrePromote = await listSigningKeys(ctx, hub);
    standby = keysPrePromote.find((k) => k.status === "standby");
    if (!standby) {
      return [
        ...results,
        {
          id: "R03z",
          title: "standby key",
          status: "fail",
          detail: `no standby key after create. Keys: ${keysPrePromote.map((k) => `${k.kid.slice(0, 12)}(${k.status})`).join(", ")}`,
        },
      ];
    }

    // ---- Promote the standby to active, making the old key previously_used. ----
    const promote = await patchSigningKey(ctx, hub, standby.id, {
      status: "in_use",
    });
    results.push({
      id: "R03d",
      title: "Standby promoted to active",
      status: promote.status < 300 ? "pass" : "fail",
      detail: `promote HTTP ${promote.status}: standby=${standby.kid.slice(0, 12)}`,
      measurements: { status: promote.status },
    });

    // ---- Revoke the old key. ----
    const revoke = await patchSigningKey(ctx, hub, activeKey.id, {
      status: "revoked",
    });
    results.push({
      id: "R03e",
      title: "Old key revoked",
      status: revoke.status < 300 ? "pass" : "fail",
      detail: `revoke HTTP ${revoke.status}: kid=${activeKey.kid.slice(0, 12)}`,
      measurements: { status: revoke.status },
    });

    // Allow the revocation to settle.
    await new Promise((r) => setTimeout(r, 2000));

    // ---- Probe loop: the revoked key is still honoured. ----
    const probeT0 = performance.now();
    const probePoints: RevokedProbe[] = [];

    while (performance.now() - probeT0 < WINDOW_MS) {
      const signingKeys = await listSigningKeys(ctx, hub);
      const tpas = await listTpa(ctx, spoke);
      const hubTpa = tpas.find(
        (t) => t.oidc_issuer_url === hubIssuer || t.jwks_url?.includes(hubHost),
      );
      const jwks = await fetchJwks(hubHost);

      let cachedKids: string[] = [];
      if (hubTpa?.resolved_jwks && typeof hubTpa.resolved_jwks === "object") {
        const rj = hubTpa.resolved_jwks as Record<string, unknown>;
        const keys = Array.isArray(rj.keys) ? rj.keys : [];
        cachedKids = keys.map((k: unknown) =>
          String((k as Record<string, unknown>).kid ?? "?"),
        );
      }

      const probe = await restProbe(spokeHost, spokeKeys.anon, revokeeToken);

      probePoints.push({
        pgrst_code: probe.code ?? "",
        http_status: probe.status,
        cached_kids: cachedKids,
        hub_jwks_kids: jwks.kids,
        old_key_status: keyStatus(signingKeys, activeKey.kid) ?? "not_found",
      });

      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    const probeCount = probePoints.length;
    const revokedAtEveryProbe = probePoints.every(
      (p) => p.old_key_status === "revoked",
    );
    const tokenAccepted = probePoints.every((p) => p.http_status < 400);

    results.push({
      id: "R03f",
      title:
        "Key confirmed revoked at every probe, yet the token keeps working",
      status: probeCount > 0 && revokedAtEveryProbe && tokenAccepted
        ? "pass"
        : "fail",
      detail: probeCount > 0
        ? `${probeCount} probes: key_status=${probePoints.map((p) => p.old_key_status).join(",")}, ` +
          `http_status=${probePoints.map((p) => p.http_status).join(",")}, ` +
          `cached_kids always [${probePoints[0]?.cached_kids?.join(", ") ?? "none"}]`
        : "no probes completed",
      measurements: {
        probe_count: probeCount,
        revoked_at_every_probe: String(revokedAtEveryProbe),
        token_accepted: String(tokenAccepted),
        final_key_status: probePoints.at(-1)?.old_key_status ?? "unknown",
      },
      evidence: probePoints.length > 0
        ? JSON.stringify(probePoints[0]).slice(0, 400)
        : undefined,
    });

    return results;
  },
};
export default mod;
