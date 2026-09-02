/**
 * SH03 - refresh takeover across the two GoTrues.
 *
 * Refresh tokens live in auth.refresh_tokens and auth.sessions, which both
 * instances share. So a refresh token minted by one side should be redeemable
 * on the other - and if it is, a client can be repointed from the managed
 * Auth endpoint to a self-hosted one (or back) without a re-login, which is
 * the hinge of any "take Auth in-house" or "portable identity" plan.
 *
 *   SH03a  self-hosted refresh token -> MANAGED /token?grant_type=refresh_token
 *   SH03b  managed refresh token -> SELF-HOSTED /token; alg of the new access
 *          token (the self-hosted side re-signs with what it has)
 *   SH03c  rotation across sides: the managed refresh token redeemed on the
 *          SELF-HOSTED side in SH03b is then presented to the MANAGED side for
 *          the first time. Reuse detection is per schema, so inside the reuse
 *          interval the managed GoTrue tolerates the parent (200 expected) and
 *          outside it refuses; the code is recorded verbatim either way.
 *
 * DESTRUCTIVE: creates a user (deleted in finally).
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import {
  adminCreate,
  adminDelete,
  fetchKeys,
  jwtShape,
  managedAuth,
  passwordGrant,
  randomEmail,
  randomPassword,
  refreshGrant,
  selfHosted,
} from "../lib/sha";

const mod: TestModule = {
  id: "SH03",
  title: "Refresh takeover: each GoTrue redeems the other's refresh tokens",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const S = selfHosted(ctx);
    if (!ctx.ref) return [{ id: "SH03", title: this.title, status: "skip", detail: "no project ref (PVLAB_REF)" }];
    if (!S) return [{ id: "SH03", title: this.title, status: "skip", detail: "no self-hosted GoTrue - run `make gotrue-up` first" }];
    const M = managedAuth(ctx);
    const keys = await fetchKeys(ctx);
    const out: TestResult[] = [];
    let userId = "";
    try {
      const email = randomEmail("sh03");
      const password = randomPassword();
      const created = await adminCreate(M, keys, email, password);
      userId = created.id;
      if (!userId) return [{ id: "SH03", title: this.title, status: "fail", detail: `managed admin create ${created.status} ${created.code}` }];

      const self = await passwordGrant(S, keys, email, password);
      const managed = await passwordGrant(M, keys, email, password);
      if (self.status !== 200 || managed.status !== 200) {
        return [{ id: "SH03", title: this.title, status: "fail", detail: `grants: self-hosted ${self.status} ${self.code}, managed ${managed.status} ${managed.code}` }];
      }

      // SH03a - self-hosted RT redeemed on the managed side.
      const a = await refreshGrant(M, keys, self.refreshToken);
      const aShape = jwtShape(a.accessToken);
      out.push({
        id: "SH03a",
        title: "self-hosted refresh token redeemed by the managed GoTrue",
        status: a.status === 200 ? "pass" : "fail",
        detail: a.status === 200 ? `200; new access token alg ${aShape?.alg}` : `HTTP ${a.status} ${a.code}`,
        measurements: { status: a.status, code: a.code || "none", new_alg: aShape?.alg ?? "none", same_session: aShape && jwtShape(self.accessToken)?.sessionId === aShape.sessionId ? 1 : 0 },
      });

      // SH03b - managed RT redeemed on the self-hosted side.
      const b = await refreshGrant(S, keys, managed.refreshToken);
      const bShape = jwtShape(b.accessToken);
      out.push({
        id: "SH03b",
        title: "managed refresh token redeemed by the self-hosted GoTrue",
        status: b.status === 200 ? "pass" : "fail",
        detail: b.status === 200 ? `200; new access token alg ${bShape?.alg} (re-signed with the self-hosted key)` : `HTTP ${b.status} ${b.code}`,
        measurements: { status: b.status, code: b.code || "none", new_alg: bShape?.alg ?? "none", same_session: bShape && jwtShape(managed.accessToken)?.sessionId === bShape.sessionId ? 1 : 0 },
      });

      // SH03c - reuse across sides: present the ALREADY-REDEEMED managed RT to the managed side.
      const c = await refreshGrant(M, keys, managed.refreshToken);
      const cChild = b.refreshToken ? await refreshGrant(M, keys, b.refreshToken) : { status: 0, code: "no child token", accessToken: "", refreshToken: "" };
      out.push({
        id: "SH03c",
        title: "reuse detection is per schema, not per instance",
        status: "info",
        detail: `already-redeemed managed RT -> managed: ${c.status}${c.code ? ` ${c.code}` : " (parent tolerated inside the reuse interval)"}; the child RT minted by the self-hosted side -> managed: ${cChild.status}${cChild.code ? ` ${cChild.code}` : ""}`,
        measurements: { reused_parent_status: c.status, reused_parent_code: c.code || "none", child_from_self_hosted_status: cChild.status, child_code: cChild.code || "none" },
      });
    } catch (e) {
      out.push({ id: "SH03", title: this.title, status: "fail", detail: `threw: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      if (userId) {
        const st = await adminDelete(M, keys, userId).catch(() => 0);
        out.push({ id: "SH03z", title: "cleanup: delete the probe user", status: st < 300 ? "pass" : "fail", detail: `HTTP ${st}`, measurements: { delete_status: st } });
      }
    }
    return out;
  },
};
export default mod;
