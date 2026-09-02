/**
 * SH05 - the dependency the self-hosted tokens have on the platform: the
 * legacy HS256 key's status.
 *
 * The self-hosted GoTrue signs with the project's legacy HS256 secret, and
 * the managed tier accepts those tokens because that key is `previously_used`
 * rather than `revoked`. The signing-keys docs say revoking a previously used
 * key revokes trust in it. This module does exactly that and measures what
 * happens to a self-hosted token that was valid a second earlier.
 *
 *   SH05a  before: self-hosted token accepted by managed /user and PostgREST
 *   SH05b  PATCH the HS256 key to revoked (status + body verbatim)
 *   SH05c  after: the same token against managed /user and PostgREST, polled
 *          until the answer changes or 120 s pass; time-to-effect recorded
 *   SH05d  the anon and service_role API keys are HS256 JWTs under the same
 *          secret - what happens to a plain anon PostgREST read after the
 *          revoke (this is the reason the platform keeps the key around)
 *
 * IRREVERSIBLE on the project (a revoked key does not come back). Last in id
 * order on purpose; the project is destroyed after the run. Skips unless the
 * HS256 key is currently previously_used.
 */
import { mgmt } from "../../../harness/src/mgmt";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import {
  adminCreate,
  adminDelete,
  ensureProbeTable,
  fetchKeys,
  http,
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

interface KeyRow {
  id?: string;
  algorithm?: string;
  status?: string;
}

const mod: TestModule = {
  id: "SH05",
  title: "Revoke the legacy HS256 key: what dies, and how fast",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const S = selfHosted(ctx);
    if (!ctx.ref) return [{ id: "SH05", title: this.title, status: "skip", detail: "no project ref (PVLAB_REF)" }];
    if (!S) return [{ id: "SH05", title: this.title, status: "skip", detail: "no self-hosted GoTrue - run `make gotrue-up` first" }];
    const M = managedAuth(ctx);
    const keys = await fetchKeys(ctx);
    const list = await mgmt(ctx, "GET", `/projects/${ctx.ref}/config/auth/signing-keys`);
    const rows = ((list.json as { keys?: KeyRow[] } | undefined)?.keys ?? []) as KeyRow[];
    const hs = rows.find((k) => k.algorithm === "HS256");
    if (!hs?.id || hs.status !== "previously_used") {
      return [{ id: "SH05", title: this.title, status: "skip", detail: `HS256 key is ${hs?.status ?? "absent"}, not previously_used - nothing to revoke` }];
    }
    const out: TestResult[] = [];
    let userId = "";
    try {
      const email = randomEmail("sh05");
      const password = randomPassword();
      const created = await adminCreate(M, keys, email, password);
      userId = created.id;
      const self = await passwordGrant(S, keys, email, password);
      await ensureProbeTable(ctx);
      await Bun.sleep(3_000);

      // SH05a - before.
      const beforeUser = await whoami(M, keys, self.accessToken);
      const beforeRest = await restRead(ctx, keys, self.accessToken);
      out.push({
        id: "SH05a",
        title: "before the revoke: self-hosted token trusted",
        status: beforeUser.status === 200 && beforeRest.status === 200 ? "pass" : "fail",
        detail: `managed /user ${beforeUser.status}; PostgREST ${beforeRest.status} rows=${beforeRest.rows}`,
        measurements: { user_status: beforeUser.status, rest_status: beforeRest.status, rest_rows: beforeRest.rows },
      });

      // SH05b - revoke.
      const t0 = Date.now();
      const rev = await mgmt(ctx, "PATCH", `/projects/${ctx.ref}/config/auth/signing-keys/${hs.id}`, { status: "revoked" });
      out.push({
        id: "SH05b",
        title: "PATCH the HS256 key to revoked",
        status: rev.status < 300 ? "pass" : "fail",
        detail: `HTTP ${rev.status}${rev.status >= 300 ? ` ${rev.text.slice(0, 200)}` : ""}`,
        measurements: { status: rev.status, key_status_after: String((rev.json as KeyRow | undefined)?.status ?? "?") },
        evidence: rev.status >= 300 ? rev.text.slice(0, 400) : undefined,
      });
      if (rev.status >= 300) return out;

      // SH05c - poll the same token until rejected.
      let user = await whoami(M, keys, self.accessToken);
      let rest = await restRead(ctx, keys, self.accessToken);
      let userFlipAt: number | string = "never";
      let restFlipAt: number | string = "never";
      while (Date.now() - t0 < 120_000 && (user.status === 200 || rest.status === 200)) {
        await Bun.sleep(3_000);
        if (user.status === 200) {
          user = await whoami(M, keys, self.accessToken);
          if (user.status !== 200) userFlipAt = Math.round((Date.now() - t0) / 1000);
        }
        if (rest.status === 200) {
          rest = await restRead(ctx, keys, self.accessToken);
          if (rest.status !== 200) restFlipAt = Math.round((Date.now() - t0) / 1000);
        }
      }
      if (user.status !== 200 && userFlipAt === "never") userFlipAt = 0;
      if (rest.status !== 200 && restFlipAt === "never") restFlipAt = 0;
      out.push({
        id: "SH05c",
        title: "after the revoke: the same self-hosted token",
        status: user.status !== 200 && rest.status !== 200 ? "pass" : "fail",
        detail: `managed /user ${user.status}${user.code ? ` ${user.code}` : ""} after ${userFlipAt}s; PostgREST ${rest.status}${rest.code ? ` ${rest.code}` : ""} after ${restFlipAt}s`,
        measurements: {
          user_status: user.status,
          user_code: user.code || "none",
          user_flip_s: userFlipAt,
          rest_status: rest.status,
          rest_code: rest.code || "none",
          rest_flip_s: restFlipAt,
        },
      });

      // SH05d - the legacy anon and service_role API keys are HS256 JWTs under
      // the same secret, so the revoke reaches them too. The newer
      // sb_publishable_ / sb_secret_ keys are not JWTs and are the platform's
      // migration path; both generations are probed against PostgREST and the
      // managed admin API so the collateral is measured, not inferred.
      const anonRest = await http(`https://${ctx.apiHost}/rest/v1/${PROBE_TABLE}?select=id`, { key: keys.anon });
      const anonAuth = await http(`${M}/health`, { key: keys.anon });
      const svcAdmin = await http(`${M}/admin/users?page=1&per_page=1`, { key: keys.service });
      const newKeys = await mgmt(ctx, "GET", `/projects/${ctx.ref}/api-keys?reveal=true`);
      const rows = Array.isArray(newKeys.json) ? (newKeys.json as { type?: string; api_key?: string }[]) : [];
      const publishable = rows.find((k) => k.type === "publishable")?.api_key ?? "";
      const secret = rows.find((k) => k.type === "secret")?.api_key ?? "";
      const pubRest = publishable ? await http(`https://${ctx.apiHost}/rest/v1/${PROBE_TABLE}?select=id`, { key: publishable }) : { status: 0, json: {}, text: "absent", ms: 0 };
      const secAdmin = secret ? await http(`${M}/admin/users?page=1&per_page=1`, { key: secret }) : { status: 0, json: {}, text: "absent", ms: 0 };
      const newSelf = await passwordGrant(S, keys, email, password);
      out.push({
        id: "SH05d",
        title: "collateral: legacy API keys vs the new key generation, and fresh self-hosted grants",
        status: "info",
        detail:
          `legacy anon key: PostgREST ${anonRest.status}, auth health ${anonAuth.status}; legacy service_role key: admin list ${svcAdmin.status}; ` +
          `sb_publishable: PostgREST ${pubRest.status}; sb_secret: admin list ${secAdmin.status}; ` +
          `fresh self-hosted password grant ${newSelf.status}${newSelf.code ? ` ${newSelf.code}` : ""} (mints, but nothing managed will accept it now)`,
        measurements: {
          legacy_anon_rest_status: anonRest.status,
          legacy_anon_auth_health_status: anonAuth.status,
          legacy_service_admin_status: svcAdmin.status,
          publishable_rest_status: pubRest.status,
          secret_admin_status: secAdmin.status,
          fresh_self_grant_status: newSelf.status,
        },
      });
    } catch (e) {
      out.push({ id: "SH05", title: this.title, status: "fail", detail: `threw: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      if (userId) {
        // The legacy service_role key is itself an HS256 JWT under the key
        // this module just revoked, so the admin API answers 403 afterwards
        // (measured). Fall back to SQL through the management endpoint.
        const st = await adminDelete(M, keys, userId).catch(() => 0);
        let via = "admin api";
        let ok = st < 300;
        if (!ok) {
          const r = await sql(ctx, `delete from auth.users where id = '${userId.replace(/[^0-9a-f-]/gi, "")}'`);
          ok = r.status < 300;
          via = `sql fallback (admin api HTTP ${st})`;
        }
        out.push({ id: "SH05z", title: "cleanup: delete the probe user", status: ok ? "pass" : "fail", detail: `${via}${ok ? "" : " - FAILED"}`, measurements: { admin_delete_status: st, cleaned: ok ? 1 : 0 } });
      }
    }
    return out;
  },
};
export default mod;
