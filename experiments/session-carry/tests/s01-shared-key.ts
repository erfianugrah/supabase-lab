/**
 * S01 - "import the same signing key into both projects, same kid": what the
 * hosted platform actually allows, and what the target does with the source's
 * token as a result.
 *
 * The plan under test assumes a self-supplied private key can be imported into
 * both projects under one kid, so the target accepts access tokens the source
 * already issued. First live run (2026-09-25) refuted the premise: a kid is
 * unique across the platform, so the second import answers 409. This module
 * now records that and the nearest thing the platform does allow:
 *
 *   S01a  import a self-supplied key into the source, promote to in_use
 *   S01b  import the SAME kid into the target - refused?
 *   S01x  same kid into a project in ANOTHER org (optional peer `xorg`) -
 *         is uniqueness per org or platform-wide?
 *   S01c  same private material under a FRESH kid into the target, promote
 *   S01d  source issues tokens with the imported kid
 *   S01e  target JWKS publishes the target's kid for that material
 *   S01f  target PostgREST with the source's token
 *   S01g  target Auth /user with the source's token
 *   S01h  target refresh with the source refresh token, no rows copied
 *
 * S01f/g are the question the plan turns on: do the verifiers route by kid
 * (refuse) or try any key whose material verifies (accept)?
 */
import type { TestModule, TestResult } from "../../../harness/src/types";
import {
  authReq,
  errText,
  generateEs256Jwk,
  header,
  host,
  importSigningKey,
  makeRoom,
  jwksKids,
  keys,
  login,
  newSession,
  pollUntil,
  restRead,
  skipNoPeer,
  str,
  waitReady,
} from "../lib/carry";
import { patchSigningKey } from "../../key-rotation/lib/rotation";
import type { Ctx } from "../../../harness/src/types";

/**
 * The create endpoint answered 429 once (2026-09-25, ad-hoc probe; a create
 * on the same project a minute later was 201). Cause not measured. Retry that
 * and nothing else - a 409 or 422 is data.
 */
async function importRetrying(ctx: Ctx, ref: string, jwk: Record<string, unknown>) {
  let r = await importSigningKey(ctx, ref, jwk);
  for (let i = 0; r.status === 429 && i < 6; i++) {
    await new Promise((x) => setTimeout(x, 20000));
    r = await importSigningKey(ctx, ref, jwk);
  }
  return r;
}

const mod: TestModule = {
  id: "S01",
  title: "One imported signing key on both projects",
  where: "local",
  requires: ["pat", "peer"],
  destructive: true, // rotates the signing key on both projects
  async run(ctx) {
    const src = ctx.ref;
    const dst = ctx.peers.target;
    if (!dst) return skipNoPeer("S01", this.title);
    await waitReady(ctx, src);
    await waitReady(ctx, dst);
    const results: TestResult[] = [];

    // Re-runs accumulate previously_used keys; see makeRoom.
    const freed = [await makeRoom(ctx, src), await makeRoom(ctx, dst)];
    if (freed.some(Boolean)) {
      results.push({
        id: "S01-",
        title: "Revoked the oldest previously_used key to stay under the 3-key cap",
        status: "info",
        detail: `source=${freed[0]?.slice(0, 8) ?? "-"} target=${freed[1]?.slice(0, 8) ?? "-"}`,
      });
    }

    const jwk = await generateEs256Jwk();
    const kid = String(jwk.kid);

    const a = await importRetrying(ctx, src, jwk);
    const aid = str((a.json as Record<string, unknown> | undefined)?.id);
    const ap = aid ? await patchSigningKey(ctx, src, aid, { status: "in_use" }) : undefined;
    results.push({
      id: "S01a",
      title: "Imported key and promoted to in_use on the source",
      status: a.status < 300 && ap && ap.status < 300 && aid === kid ? "pass" : "fail",
      detail: `import HTTP ${a.status}, kid preserved=${String(aid === kid)}, promote HTTP ${ap?.status ?? "not attempted"}`,
      measurements: { import_status: a.status, promote_status: ap?.status ?? 0 },
      evidence: a.status >= 300 ? a.text.slice(0, 300) : undefined,
    });
    if (!ap || ap.status >= 300) return results;

    const b = await importRetrying(ctx, dst, jwk);
    results.push({
      id: "S01b",
      title: "Platform refuses the same kid on a second project",
      status: b.status === 409 ? "pass" : "fail",
      detail: `HTTP ${b.status}`,
      measurements: { status: b.status },
      evidence: b.text.slice(0, 300),
    });

    const xorg = ctx.peers.xorg;
    if (xorg) {
      const fresh = await generateEs256Jwk();
      const x = await importRetrying(ctx, xorg, { ...fresh, kid });
      results.push({
        id: "S01x",
        title: "Same kid refused on a project in a different organization",
        status: x.status === 409 ? "pass" : "fail",
        detail: `HTTP ${x.status} (different key material, same kid)`,
        measurements: { status: x.status },
        evidence: x.text.slice(0, 300),
      });
    }

    const kid2 = crypto.randomUUID();
    const c = await importRetrying(ctx, dst, { ...jwk, kid: kid2 });
    const cid = str((c.json as Record<string, unknown> | undefined)?.id);
    const cp = cid ? await patchSigningKey(ctx, dst, cid, { status: "in_use" }) : undefined;
    results.push({
      id: "S01c",
      title: "Same private material under a fresh kid is accepted on the target",
      status: c.status < 300 && cp && cp.status < 300 ? "pass" : "fail",
      detail: `import HTTP ${c.status}, promote HTTP ${cp?.status ?? "not attempted"}`,
      measurements: { import_status: c.status, promote_status: cp?.status ?? 0 },
      evidence: c.status >= 300 ? c.text.slice(0, 300) : undefined,
    });
    if (!cp || cp.status >= 300) return results;

    const sk = await keys(ctx, src);
    const dk = await keys(ctx, dst);
    if (!sk.anon || !sk.service || !dk.anon) {
      results.push({ id: "S01z", title: "key fetch", status: "fail", detail: "could not read API keys" });
      return results;
    }
    const s = await newSession(src, { anon: sk.anon, service: sk.service }, "s01");
    if ("error" in s) {
      results.push({ id: "S01z", title: "source session", status: "fail", detail: s.error });
      return results;
    }
    let access = s.access;
    const issueMs = await pollUntil(async () => {
      if (header(access).kid === kid) return true;
      const l = await login(host(src), sk.anon!, s.email);
      access = str(l.json.access_token) ?? access;
      return header(access).kid === kid;
    }, 600000);
    results.push({
      id: "S01d",
      title: "Source issues tokens signed with the imported kid",
      status: issueMs >= 0 ? "pass" : "fail",
      detail: issueMs >= 0 ? `after ${issueMs}ms of polling (5s step)` : "not within 600s",
      measurements: { ms: issueMs },
    });
    if (issueMs < 0) return results;

    // Give the verifier every chance: wait until the target publishes its
    // kid for this material before asking whether it accepts the token.
    const jwksMs = await pollUntil(async () => (await jwksKids(dst)).includes(kid2), 600000, 10000);
    results.push({
      id: "S01e",
      title: "Target JWKS publishes its kid for the shared material",
      status: jwksMs >= 0 ? "pass" : "fail",
      detail: jwksMs >= 0 ? `after ${jwksMs}ms (10s step)` : "not within 600s",
      measurements: { ms: jwksMs },
    });

    const rest = await restRead(host(dst), dk.anon, access, "rpc/nonexistent_probe");
    results.push({
      id: "S01f",
      title: "Target PostgREST refuses the source token (same material, different kid)",
      // 401 = refused on the JWT. 404 would mean accepted and routed.
      status: rest.status === 401 ? "pass" : "fail",
      detail: `HTTP ${rest.status} code=${rest.code ?? "none"}`,
      measurements: { status: rest.status, code: rest.code ?? "none" },
      evidence: rest.text.slice(0, 200),
    });

    const u = await authReq(dst, "GET", "/user", dk.anon, access);
    results.push({
      id: "S01g",
      title: "Target Auth /user refuses the source token (same material, different kid)",
      status: u.status >= 400 ? "pass" : "fail",
      detail: errText(u),
      measurements: { status: u.status, error_code: String(u.json.error_code ?? "none") },
    });

    const r = await authReq(dst, "POST", "/token?grant_type=refresh_token", dk.anon, undefined, {
      refresh_token: s.refresh,
    });
    results.push({
      id: "S01h",
      title: "Target refuses the source refresh token (no rows copied)",
      status: r.status === 400 && r.json.error_code === "refresh_token_not_found" ? "pass" : "fail",
      detail: errText(r),
      measurements: { status: r.status, error_code: String(r.json.error_code ?? "none") },
    });
    return results;
  },
};
export default mod;
