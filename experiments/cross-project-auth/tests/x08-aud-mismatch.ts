/**
 * X08 - does the spoke enforce the token's audience?
 *
 * Every earlier cross-project token carried GoTrue's default
 * `aud: "authenticated"`, so "B accepts A's token" said nothing about whether
 * any verifier checks `aud`. Here A (the hub) issues tokens whose `aud` is
 * something else, through a custom access token hook (a Postgres function on
 * A that rewrites `aud` from the user's app_metadata), and each token is
 * presented to every surface of both projects.
 *
 * SIDE: the lib/fanout.ts pair. B trusts A via `oidc_issuer_url` (reused from
 * X04 when it ran first, created here otherwise). VERIFIERS: PostgREST,
 * Storage (private bucket, storage.objects policy on the tenant claim) and
 * Realtime (private topic `tenant:tenant-a`, realtime.messages policy on the
 * same claim) on A and on B, plus GoTrue's own `/auth/v1/user` on A. KEYS:
 * each project's legacy anon JWT as `apikey`; the bearer (or Realtime
 * `access_token`) is the A-issued user token under test.
 *
 *   X08a  setup: trust on B, fixtures, hook installed and live.
 *   X08b  control: a default-aud token (hook in the path, no override) on all seven cells.
 *   X08c  admin API: create a user with `aud` set; what the password grant then does.
 *   X08d  aud = "spoke-api" (string).
 *   X08e  aud = ["spoke-api"] (array without "authenticated").
 *   X08f  aud = ["authenticated", "spoke-api"].
 *   X08g  aud removed by the hook.
 *
 * DESTRUCTIVE: writes auth config, schema, storage and users on the pair; X99 deletes it.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { awaitSpoke, claimSet, ensureFixtures, ensureHook, ensureTrust, matrix, matrixLine, matrixMeasurements, mint, passwordGrant, SPOKE_AUD } from "../lib/audprobe.js";
import { ensurePair, skipWithoutPro } from "../lib/fanout.js";

const VARIANTS: { id: string; title: string; override: unknown }[] = [
  { id: "X08d", title: 'aud = "spoke-api" (string)', override: SPOKE_AUD },
  { id: "X08e", title: 'aud = ["spoke-api"] (array, no "authenticated")', override: [SPOKE_AUD] },
  { id: "X08f", title: 'aud = ["authenticated", "spoke-api"]', override: ["authenticated", SPOKE_AUD] },
  { id: "X08g", title: "aud claim removed by the hook", override: "__drop__" },
];

const claimsText = (c: Record<string, string | number>) =>
  Object.entries(c)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");

const mod: TestModule = {
  id: "X08",
  title: "Audience mismatch: hub tokens with aud other than 'authenticated' at the spoke's PostgREST, Storage and Realtime",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const skip = skipWithoutPro(ctx, "X08");
    if (skip) return skip;
    const out: TestResult[] = [];
    const p = await ensurePair(ctx);

    const trust = await ensureTrust(ctx, p);
    const fa = await ensureFixtures(ctx, p.a);
    const fb = await ensureFixtures(ctx, p.b);
    const spoke = await awaitSpoke(p, p.tokA);
    const hk = await ensureHook(ctx, p.a);
    out.push({
      id: "X08a",
      title: "Setup: trust on B, Storage/Realtime fixtures on both, aud hook live on A",
      status: hk.liveMs >= 0 && spoke.restMs >= 0 && spoke.storageMs >= 0 && spoke.realtimeMs >= 0 ? "pass" : "fail",
      detail: `trust ${trust.existing ? `reused (${trust.existing})` : `created HTTP ${trust.created}`}; fixtures A ${JSON.stringify(fa)} B ${JSON.stringify(fb)}; B first accepted the pre-hook tenant-a token: REST ${spoke.restMs} ms, Storage ${spoke.storageMs} ms, Realtime ${spoke.realtimeMs} ms (from the same start; ${spoke.last || "no refusals"}); hook SQL ${hk.sql}${hk.sqlError ? ` ${hk.sqlError}` : ""}, config PATCH ${hk.patch}${hk.patchText ? ` ${hk.patchText}` : ""}, override visible in a fresh token after ${hk.liveMs} ms (3 s poll; ${hk.liveLast || "first try"})`,
      measurements: {
        tpa_created_status: trust.created,
        tpa_existing: trust.existing,
        b_accept_rest_ms: spoke.restMs,
        b_accept_storage_ms: spoke.storageMs,
        b_accept_realtime_ms: spoke.realtimeMs,
        hook_sql_status: hk.sql,
        hook_patch_status: hk.patch,
        hook_live_ms: hk.liveMs,
      },
    });

    // X08b - control: default aud, minted with the hook in the path.
    const ctl = await mint(p.a, { tenant_id: "tenant-a" });
    if (!ctl.token) {
      out.push({ id: "X08b", title: "Control: default-aud token", status: "fail", detail: `create ${ctl.createStatus} grant ${ctl.grantStatus} ${ctl.grantText}` });
    } else {
      const m = await matrix(p, ctl.token);
      const all = Object.values(m).every((c) => c.ok);
      out.push({
        id: "X08b",
        title: 'Control: aud "authenticated" (hook in path, no override) on all seven cells',
        status: all ? "pass" : "fail",
        detail: matrixLine(m),
        measurements: { ...matrixMeasurements(m), aud: claimSet(ctl.token).aud },
        evidence: claimsText(claimSet(ctl.token)),
      });
    }

    // X08c - the admin API's own aud field.
    const adm = await mint(p.a, { tenant_id: "tenant-a" }, { aud: SPOKE_AUD });
    let admDetail = `admin create HTTP ${adm.createStatus}${adm.createText ? ` ${adm.createText}` : ""}, user.aud in response ${JSON.stringify(adm.createAud)}; password grant HTTP ${adm.grantStatus}${adm.grantText ? ` ${adm.grantText}` : ""}`;
    const admM: Record<string, string | number> = { create_status: adm.createStatus, create_user_aud: adm.createAud, grant_status: adm.grantStatus };
    let admEvidence = "";
    if (adm.token) {
      const m = await matrix(p, adm.token);
      Object.assign(admM, matrixMeasurements(m), { aud: claimSet(adm.token).aud });
      admDetail += `; ${matrixLine(m)}`;
      admEvidence = claimsText(claimSet(adm.token));
    }
    out.push({ id: "X08c", title: 'Admin API: create user with aud "spoke-api", then password grant', status: "info", detail: admDetail, measurements: admM, evidence: admEvidence || undefined });

    for (const v of VARIANTS) {
      const t = await mint(p.a, { tenant_id: "tenant-a", aud_override: v.override });
      if (!t.token) {
        // A refusal to issue is itself the result (the hook output failed GoTrue's checks).
        const again = t.createStatus < 300 ? await passwordGrant(p.a, t.email, t.password) : undefined;
        out.push({
          id: v.id,
          title: v.title,
          status: "info",
          detail: `no token: create HTTP ${t.createStatus}; password grant HTTP ${t.grantStatus} ${t.grantText}${again ? `; retry HTTP ${again.status} ${again.text}` : ""}`,
          measurements: { create_status: t.createStatus, grant_status: t.grantStatus, grant_body: t.grantText },
        });
        continue;
      }
      const cs = claimSet(t.token);
      const m = await matrix(p, t.token);
      out.push({
        id: v.id,
        title: v.title,
        status: "info",
        detail: `token aud ${cs.aud}; ${matrixLine(m)}`,
        measurements: { aud: cs.aud, grant_status: t.grantStatus, ...matrixMeasurements(m) },
        evidence: claimsText(cs),
      });
    }
    return out;
  },
};
export default mod;
