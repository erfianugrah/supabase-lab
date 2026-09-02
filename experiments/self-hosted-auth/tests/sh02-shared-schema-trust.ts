/**
 * SH02 - one auth schema, two GoTrues: does the managed tier trust what the
 * self-hosted one mints, and do both see the same users.
 *
 * Preconditions: `make gotrue-up` (the self-hosted GoTrue connected as
 * postgres with search_path=auth and the project's legacy HS256 secret).
 *
 *   SH02a  self-hosted GoTrue is up and started clean (health; version)
 *   SH02b  admin-create a user through the SELF-HOSTED GoTrue; the MANAGED
 *          admin list shows it (same auth.users)
 *   SH02c  password grant on the self-hosted GoTrue -> token shape (alg,
 *          iss, aud, role, ttl)
 *   SH02d  that token against the MANAGED tier: GET /auth/v1/user and a
 *          PostgREST read of an authenticated-only table - the trust test
 *   SH02e  password grant on the MANAGED GoTrue for the same user - the hash
 *          is shared; token shape for contrast (ES256)
 *   SH02f  the managed token against the SELF-HOSTED GoTrue /user - the
 *          asymmetry: it holds only the HS256 secret
 *
 * DESTRUCTIVE: creates a user and a probe table; deletes the user in finally
 * (the table is dropped by the project teardown).
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import {
  adminCreate,
  adminDelete,
  adminHasEmail,
  ensureProbeTable,
  fetchKeys,
  http,
  jwtShape,
  managedAuth,
  passwordGrant,
  randomEmail,
  randomPassword,
  restRead,
  selfHosted,
  whoami,
} from "../lib/sha";

const mod: TestModule = {
  id: "SH02",
  title: "Shared auth schema: managed trust in self-hosted tokens, and the reverse",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const S = selfHosted(ctx);
    if (!ctx.ref) return [{ id: "SH02", title: this.title, status: "skip", detail: "no project ref (PVLAB_REF)" }];
    if (!S) return [{ id: "SH02", title: this.title, status: "skip", detail: "no self-hosted GoTrue - run `make gotrue-up` first" }];
    const M = managedAuth(ctx);
    const keys = await fetchKeys(ctx);
    const out: TestResult[] = [];
    let userId = "";
    try {
      // SH02a
      const health = await http(`${S}/health`);
      out.push({
        id: "SH02a",
        title: "self-hosted GoTrue up",
        status: health.status === 200 ? "pass" : "fail",
        detail: health.status === 200 ? `self-hosted ${String(health.json.version)} at ${S}` : `health HTTP ${health.status} ${health.text.slice(0, 120)}`,
        measurements: { self_hosted_version: String(health.json.version ?? "?") },
      });
      if (health.status !== 200) return out;

      // SH02b
      const email = randomEmail("sh02");
      const password = randomPassword();
      const created = await adminCreate(S, keys, email, password);
      userId = created.id;
      const seen = created.id ? await adminHasEmail(M, keys, email) : { status: 0, present: false };
      out.push({
        id: "SH02b",
        title: "user created through the self-hosted GoTrue is visible to the managed one",
        status: created.status === 200 && seen.present ? "pass" : "fail",
        detail: `self-hosted admin create ${created.status}${created.code ? ` ${created.code}` : ""}; managed admin list ${seen.status}, present=${seen.present}`,
        measurements: { create_status: created.status, managed_list_status: seen.status, present_in_managed: seen.present ? 1 : 0 },
      });
      if (!created.id) return out;

      // SH02c
      const self = await passwordGrant(S, keys, email, password);
      const shape = jwtShape(self.accessToken);
      out.push({
        id: "SH02c",
        title: "self-hosted password grant and token shape",
        status: self.status === 200 && shape ? "pass" : "fail",
        detail: shape
          ? `alg ${shape.alg}, iss ${shape.iss}, aud ${shape.aud}, role ${shape.role}, ttl ${shape.ttlS}s`
          : `grant HTTP ${self.status} ${self.code}`,
        measurements: {
          status: self.status,
          alg: shape?.alg ?? "?",
          kid: shape?.kid ? shape.kid.slice(0, 8) : "none",
          iss: shape?.iss ?? "?",
          aud: shape?.aud ?? "?",
          role: shape?.role ?? "?",
          ttl_s: shape?.ttlS ?? 0,
        },
      });
      if (self.status !== 200) return out;

      // SH02d
      await ensureProbeTable(ctx);
      await Bun.sleep(4_000);
      const mUser = await whoami(M, keys, self.accessToken);
      const rest = await restRead(ctx, keys, self.accessToken);
      const anonRest = await restRead(ctx, keys, keys.anon);
      const trusted = mUser.status === 200 && rest.status === 200 && rest.rows === 1 && anonRest.rows === 0;
      out.push({
        id: "SH02d",
        title: "managed Auth and PostgREST accept the self-hosted token",
        status: trusted ? "pass" : "fail",
        detail: `managed /user ${mUser.status}${mUser.code ? ` ${mUser.code}` : ""}; PostgREST authenticated-only read ${rest.status} rows=${rest.rows}${rest.code ? ` ${rest.code}` : ""}; anon control rows=${anonRest.rows}`,
        measurements: {
          managed_user_status: mUser.status,
          managed_user_code: mUser.code || "none",
          rest_status: rest.status,
          rest_rows: rest.rows,
          rest_code: rest.code || "none",
          anon_control_rows: anonRest.rows,
        },
      });

      // SH02e
      const managed = await passwordGrant(M, keys, email, password);
      const mShape = jwtShape(managed.accessToken);
      out.push({
        id: "SH02e",
        title: "managed password grant for the same user (shared hash) and its token shape",
        status: managed.status === 200 && mShape ? "pass" : "fail",
        detail: mShape ? `alg ${mShape.alg} kid ${mShape.kid.slice(0, 8)}, iss ${mShape.iss}, same sub=${mShape.sub === shape?.sub}` : `grant HTTP ${managed.status} ${managed.code}`,
        measurements: {
          status: managed.status,
          alg: mShape?.alg ?? "?",
          kid: mShape?.kid ? mShape.kid.slice(0, 8) : "none",
          same_sub: mShape && shape && mShape.sub === shape.sub ? 1 : 0,
          same_iss: mShape && shape && mShape.iss === shape.iss ? 1 : 0,
        },
      });

      // SH02f
      if (managed.status === 200) {
        const sUser = await whoami(S, keys, managed.accessToken);
        out.push({
          id: "SH02f",
          title: "the managed (ES256) token against the self-hosted GoTrue",
          status: "info",
          detail:
            sUser.status === 200
              ? "self-hosted GoTrue verified the managed token"
              : `self-hosted /user ${sUser.status}${sUser.code ? ` ${sUser.code}` : ""} - it holds only the HS256 secret and cannot verify the platform's ES256 key (SH04 supplies it)`,
          measurements: { self_hosted_user_status: sUser.status, self_hosted_user_code: sUser.code || "none" },
        });
      }
    } catch (e) {
      out.push({ id: "SH02", title: this.title, status: "fail", detail: `threw: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      if (userId) {
        const st = await adminDelete(M, keys, userId).catch(() => 0);
        out.push({ id: "SH02z", title: "cleanup: delete the probe user via the managed admin API", status: st < 300 ? "pass" : "fail", detail: `HTTP ${st}`, measurements: { delete_status: st } });
      }
    }
    return out;
  },
};
export default mod;
