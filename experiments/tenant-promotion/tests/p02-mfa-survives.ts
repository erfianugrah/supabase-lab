/**
 * P02 - MFA survives promotion.
 *
 * Enrol a real TOTP factor on the shared project, verify it with a computed
 * code, promote the auth rows, then verify the SAME secret at the dedicated
 * project and record the resulting AAL. A TOTP secret that needs to be
 * re-enrolled after promotion breaks every MFA-requiring client.
 */
import { createHmac } from "node:crypto";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import {
  PASSWORD,
  adminCreate,
  claims,
  copyTable,
  resyncSequence,
  keys,
  login,
  refreshSession,
  sql,
  sqlstate,
  waitReady,
} from "../lib/promote";

const EMAIL = "p02-mfa@lab.invalid";

// ---- base32 decode (RFC 4648, padded) ----
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32Decode(s: string): Uint8Array {
  const input = s.toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  const out = new Uint8Array(Math.floor((input.length * 5) / 8));
  let bits = 0;
  let buf = 0;
  let idx = 0;
  for (const ch of input) {
    const val = B32.indexOf(ch);
    if (val === -1) continue;
    buf = (buf << 5) | val;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[idx++] = (buf >>> bits) & 0xff;
    }
  }
  return out;
}

// ---- TOTP (RFC 6238, SHA1, 6 digits, 30s step) ----
function totp(secretB32: string, ts = Date.now()): string {
  const key = base32Decode(secretB32);
  const counter = Math.floor(ts / 1000 / 30);
  const counterBuf = new Uint8Array(8);
  const dv = new DataView(counterBuf.buffer);
  dv.setBigUint64(0, BigInt(counter));
  // JS DataView is big-endian by default for setBigUint64
  const hmac = createHmac("sha1", key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const bin =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return String(bin % 1000000).padStart(6, "0");
}

async function authPost(
  host: string,
  apikey: string,
  bearer: string,
  path: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
  const res = await fetch(`https://${host}/auth/v1${path}`, {
    method: "POST",
    headers: {
      apikey,
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* non-json */
  }
  return { status: res.status, json, text };
}

const mod: TestModule = {
  id: "P02",
  title: "MFA: TOTP factor survives promotion",
  where: "local",
  requires: ["pat", "peer"],
  destructive: true, // creates user, enrols factor, copies auth rows
  async run(ctx) {
    const dedicated = ctx.peers.dedicated;
    const shared = ctx.ref;
    if (!dedicated) {
      return {
        id: "P02",
        title: this.title,
        status: "skip",
        detail: "PVLAB_PEER_DEDICATED not set - this experiment needs two projects",
      };
    }
    const results: TestResult[] = [];

    await waitReady(ctx, shared);
    await waitReady(ctx, dedicated);

    // Clean slate.
    await sql(ctx, shared, `delete from auth.users where lower(email) = '${EMAIL}'`);
    await sql(ctx, dedicated, `delete from auth.users where lower(email) = '${EMAIL}'`);

    const sharedKeys = await keys(ctx, shared);
    const dedKeys = await keys(ctx, dedicated);
    if (!sharedKeys.anon || !sharedKeys.service || !dedKeys.anon || !dedKeys.service) {
      return [
        ...results,
        { id: "P02z", title: "key fetch", status: "fail", detail: "could not read project API keys" },
      ];
    }

    // Create user on shared.
    await adminCreate(`${shared}.supabase.co`, sharedKeys.service, {
      email: EMAIL,
      password: PASSWORD,
      email_confirm: true,
    });

    // Login to get an aal1 token.
    const l = await login(`${shared}.supabase.co`, sharedKeys.anon, EMAIL);
    const tok = typeof l.json.access_token === "string" ? l.json.access_token : undefined;
    const refTok =
      typeof l.json.refresh_token === "string" ? l.json.refresh_token : undefined;
    if (!tok || !refTok) {
      return [
        ...results,
        {
          id: "P02z",
          title: "user login",
          status: "fail",
          detail: `login HTTP ${l.status}: ${l.text.slice(0, 100)}`,
        },
      ];
    }
    const sub = claims(tok).sub;
    const preAal = claims(tok).aal;
    results.push({
      id: "P02a",
      title: "Pre-MFA token carries aal1",
      status: preAal === "aal1" ? "pass" : "fail",
      detail: `aal=${String(preAal ?? "absent")} sub=${String(sub ?? "?").slice(0, 12)}`,
      measurements: { aal: String(preAal ?? "none") },
    });

    // Enrol a TOTP factor on shared.
    const enrolled = await authPost(
      `${shared}.supabase.co`,
      sharedKeys.anon,
      tok,
      "/factors",
      { factor_type: "totp", friendly_name: "p02-test" },
    );
    const factorId =
      typeof enrolled.json.id === "string" ? enrolled.json.id : undefined;
    const totpData = (enrolled.json.totp ?? {}) as Record<string, unknown>;
    const secret = typeof totpData.secret === "string" ? totpData.secret : undefined;
    const qr = typeof totpData.qr_code === "string" ? totpData.qr_code.slice(0, 40) : "none";
    results.push({
      id: "P02b",
      title: "TOTP factor enrolled on the shared project",
      status: enrolled.status < 300 && factorId && secret ? "pass" : "fail",
      detail: factorId
        ? `factor_id=${factorId.slice(0, 8)} secret_len=${secret?.length ?? 0}`
        : `enrol failed: HTTP ${enrolled.status} ${enrolled.text.slice(0, 100)}`,
      measurements: {
        status: enrolled.status,
        factor_id: String(factorId ?? "none").slice(0, 12),
        has_secret: String(!!secret),
      },
      evidence: qr,
    });
    if (!factorId || !secret) return results;

    // Challenge + compute code + verify on shared.
    const chal = await authPost(
      `${shared}.supabase.co`,
      sharedKeys.anon,
      tok,
      `/factors/${factorId}/challenge`,
      {},
    );
    const chalId =
      typeof chal.json.id === "string" ? chal.json.id : undefined;
    results.push({
      id: "P02c",
      title: "TOTP challenge created on shared",
      status: chal.status < 300 && chalId ? "pass" : "fail",
      detail: `challenge HTTP ${chal.status}`,
      measurements: { status: chal.status },
    });
    if (!chalId) return results;

    const code = totp(secret);
    const verified = await authPost(
      `${shared}.supabase.co`,
      sharedKeys.anon,
      tok,
      `/factors/${factorId}/verify`,
      { code, challenge_id: chalId },
    );
    const verifiedTok =
      typeof verified.json.access_token === "string"
        ? verified.json.access_token
        : undefined;
    const postMfaAal = verifiedTok ? claims(verifiedTok).aal : undefined;
    results.push({
      id: "P02d",
      title: "TOTP verification succeeds on shared, token carries aal2",
      status: verified.status < 300 && postMfaAal === "aal2" ? "pass" : "fail",
      detail: `verify HTTP ${verified.status} aal=${String(postMfaAal ?? "absent")}`,
      measurements: {
        status: verified.status,
        aal: String(postMfaAal ?? "none"),
        code_len: code.length,
      },
      evidence: verified.text.slice(0, 200),
    });

    // ---- Promote: copy auth rows to dedicated. ----
    const userWhere = `email = '${EMAIL}'`;
    const uidQ = await sql(
      ctx,
      shared,
      `select id::text from auth.users where ${userWhere}`,
    );
    const uid = String(uidQ.rows?.[0]?.id ?? "");
    const factorWhere = `user_id = '${uid}'`;

    await copyTable(ctx, shared, dedicated, "auth", "users", userWhere);
    await copyTable(
      ctx,
      shared,
      dedicated,
      "auth",
      "identities",
      `user_id = '${uid}'`,
    );
    await copyTable(
      ctx,
      shared,
      dedicated,
      "auth",
      "sessions",
      `user_id = '${uid}'`,
    );
    await copyTable(
      ctx,
      shared,
      dedicated,
      "auth",
      "refresh_tokens",
      `user_id = '${uid}'`,
    );

    // Sequence resync: without it the tenant's NEXT refresh collides on an
    // id the copy already landed. See lib/promote.ts resyncSequence.
    await resyncSequence(ctx, dedicated, "auth.refresh_tokens_id_seq", "auth", "refresh_tokens");
    const mfaCopy = await copyTable(
      ctx,
      shared,
      dedicated,
      "auth",
      "mfa_factors",
      factorWhere,
    );
    results.push({
      id: "P02e",
      title: "auth.mfa_factors row copied to dedicated",
      status: mfaCopy.result.status < 300 && mfaCopy.read >= 1 ? "pass" : "fail",
      detail: `${mfaCopy.read} row(s) over ${mfaCopy.cols} columns`,
      measurements: { read: mfaCopy.read, sqlstate: sqlstate(mfaCopy.result) },
      evidence: mfaCopy.result.error?.slice(0, 200),
    });

    // ---- Refresh the original token at dedicated, then verify the SAME
    //      secret still works there. ----
    const refAtDed = await refreshSession(
      `${dedicated}.supabase.co`,
      dedKeys.anon,
      refTok,
    );
    const dedTok =
      typeof refAtDed.json.access_token === "string"
        ? refAtDed.json.access_token
        : undefined;
    if (!dedTok) {
      results.push({
        id: "P02f",
        title: "Refresh at dedicated after promotion",
        status: "fail",
        detail: `refresh HTTP ${refAtDed.status}: ${refAtDed.text.slice(0, 100)}`,
        measurements: { status: refAtDed.status },
      });
      return results;
    }

    // Compute a NEW TOTP code from the SAME secret at the dedicated project.
    const dedChal = await authPost(
      `${dedicated}.supabase.co`,
      dedKeys.anon,
      dedTok,
      `/factors/${factorId}/challenge`,
      {},
    );
    const dedChalId =
      typeof dedChal.json.id === "string" ? dedChal.json.id : undefined;
    if (!dedChalId) {
      results.push({
        id: "P02f",
        title: "Challenge at dedicated after promotion",
        status: "fail",
        detail: `challenge HTTP ${dedChal.status}: ${dedChal.text.slice(0, 100)}`,
        measurements: { status: dedChal.status },
      });
      return results;
    }
    // Small delay to ensure the TOTP counter has advanced if we're at a boundary.
    await new Promise((r) => setTimeout(r, 1500));
    const code2 = totp(secret);
    const dedVerified = await authPost(
      `${dedicated}.supabase.co`,
      dedKeys.anon,
      dedTok,
      `/factors/${factorId}/verify`,
      { code: code2, challenge_id: dedChalId },
    );
    const dedVerifiedTok =
      typeof dedVerified.json.access_token === "string"
        ? dedVerified.json.access_token
        : undefined;
    const dedAal = dedVerifiedTok ? claims(dedVerifiedTok).aal : undefined;
    results.push({
      id: "P02f",
      title: "Same TOTP secret verifies at the dedicated project after promotion",
      status: dedVerified.status < 300 ? "pass" : "fail",
      detail: `verify HTTP ${dedVerified.status} aal=${String(dedAal ?? "absent")}`,
      measurements: {
        status: dedVerified.status,
        aal: String(dedAal ?? "none"),
        code_len: code2.length,
      },
      evidence: dedVerified.text.slice(0, 200),
    });

    return results;
  },
};
export default mod;