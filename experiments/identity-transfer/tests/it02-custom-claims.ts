/**
 * IT02 - a provider custom claim of the `transfer_sub` shape: where it lands,
 * whether it moves the account-resolution decision, and how long it survives.
 *
 * Apple's parser copies `transfer_sub` out of the ID token into the provider
 * claims' custom-claims map and nowhere else
 * (internal/api/provider/oidc.go: `data.Metadata.CustomClaims["transfer_sub"]`).
 * `DetermineAccountLinking` takes only (emails, aud, providerName, sub) and
 * opens on `FindIdentityByIdAndProvider(tx, sub, providerName)`
 * (internal/models/linking.go), so nothing reads the claim back. Apple is not
 * mintable in a lab; the Keycloak provider copies every non-standard userinfo
 * claim into the SAME field (internal/api/provider/keycloak.go), and everything
 * downstream - `structs.Map(userData.Metadata)` into identity_data and
 * raw_user_meta_data (internal/api/external.go) - is shared code, so a lab
 * claim named `transfer_sub` travels the identical path.
 *
 * This is the MANAGED-vantage twin of ITL2, which answered the same questions
 * on a throwaway GoTrue. What it adds is whether the managed platform agrees.
 *
 *   IT02-setup  point the Keycloak slot at the lab issuer.
 *   IT02a       subject e1 with a transfer_sub claim, first sign-in -> where
 *               the claim is stored: identity_data.custom_claims and
 *               auth.users.raw_user_meta_data.custom_claims.
 *   IT02b       a NEW subject e2 carrying a transfer_sub whose value is e1's
 *               subject, and an email that matches nothing -> a new user. The
 *               claim that names the old identity does not find it. This is
 *               the post-transfer Hide My Email shape.
 *   IT02c       subject e1 signs in again with NO transfer_sub -> whether the
 *               stored claim survives. identity_data is replaced wholesale in
 *               the AccountExists branch and raw_user_meta_data is merged
 *               key-wise (models.User.UpdateUserMetaData), so the question is
 *               whether the top-level custom_claims key is overwritten.
 *   IT02z       cleanup: users deleted, auth config restored.
 *
 * DESTRUCTIVE: writes auth config (restored in finally), creates users
 * (deleted in finally). Self-skips without ctx.endpoints.issuer.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { mgmt } from "../../../harness/src/mgmt";
import { fetchKeys, sql } from "../../../harness/src/platform";
import { CONFIG_KEYS, note, pointAtIssuer, signIn } from "../lib/flow";

const ID = "IT02";

const mod: TestModule = {
  id: ID,
  title: "A transfer_sub-shaped provider claim: where it lands and how long it lasts",
  where: "local",
  requires: ["pat", "anon-key"],
  destructive: true,

  async run(ctx: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];
    const issuer = ctx.endpoints["issuer"];
    if (!issuer) return [{ id: ID, title: this.title, status: "skip", detail: "PVLAB_ENDPOINT_ISSUER not set (the lab OIDC issuer worker URL)" }];
    const nonce = Math.random().toString(36).slice(2, 8);
    const email = (k: string) => `it02-${nonce}-${k}@example.com`;
    const subj = (k: string) => `it02-${nonce}-${k}`;
    const apikey = ctx.anonKey!;
    const createdUsers = new Set<string>();
    let original: Record<string, unknown> | undefined;

    /** Both stored copies of the provider claims for one user, in one read. */
    const claimRow = async (id: string) =>
      (
        await sql(
          ctx,
          `select i.identity_data->'custom_claims'->>'transfer_sub' as identity_tsub,
                  i.identity_data->>'sub' as identity_sub,
                  u.raw_user_meta_data->'custom_claims'->>'transfer_sub' as meta_tsub,
                  (u.raw_user_meta_data ? 'custom_claims') as meta_has_custom_claims,
                  u.email as users_email
           from auth.users u join auth.identities i on i.user_id = u.id
           where u.id = '${id}' and i.provider = 'keycloak'`,
        )
      ).rows[0] ?? {};

    try {
      const cur = await mgmt(ctx, "GET", `/projects/${ctx.ref}/config/auth`);
      if (cur.status !== 200 || !cur.json) {
        return [{ id: ID, title: this.title, status: "fail", detail: `GET /config/auth HTTP ${cur.status}`, evidence: cur.text.slice(0, 300) }];
      }
      const cfg = cur.json as Record<string, unknown>;
      original = Object.fromEntries(CONFIG_KEYS.map((k) => [k, cfg[k] ?? null]));
      const st = await pointAtIssuer(ctx, apikey, issuer);
      out.push({
        id: `${ID}-setup`,
        title: "keycloak slot pointed at the lab issuer",
        status: st.patchStatus < 300 && st.settled ? "pass" : "fail",
        detail: `PATCH /config/auth HTTP ${st.patchStatus}; /auth/v1/settings external.keycloak true after ${st.settleS}s (${st.reads} reads)`,
        measurements: { patch_status: st.patchStatus, settle_s: st.settleS, settle_reads: st.reads },
        evidence: st.settled ? undefined : st.lastBody.slice(0, 300),
      });
      if (!st.settled) return out;

      // ---- IT02a: the claim arrives ---------------------------------------
      const tsub = `TRANSFER-${nonce}-e1`;
      const e1 = await signIn(ctx, apikey, { sub: subj("e1"), email: email("e1"), email_verified: true, name: "E", claims: { transfer_sub: tsub } });
      if (e1.userId) createdUsers.add(e1.userId);
      const a = e1.userId ? await claimRow(e1.userId) : {};
      const aPass = !!e1.userId && a.identity_tsub === tsub && a.meta_tsub === tsub;
      out.push({
        id: `${ID}a`,
        title: "a custom claim is stored on both the identity and the user",
        status: aPass ? "pass" : "fail",
        detail: `${note(e1)}; identity_data.custom_claims.transfer_sub ${a.identity_tsub === tsub ? "matches" : `is ${String(a.identity_tsub ?? "absent")}`}; raw_user_meta_data.custom_claims.transfer_sub ${a.meta_tsub === tsub ? "matches" : `is ${String(a.meta_tsub ?? "absent")}`}`,
        measurements: {
          session: e1.userId ? 1 : 0,
          identity_data_transfer_sub: a.identity_tsub === tsub ? "present" : "absent",
          user_metadata_transfer_sub: a.meta_tsub === tsub ? "present" : "absent",
        },
      });

      // ---- IT02b: the claim does not resolve the account -------------------
      // e2 is a stranger whose transfer_sub names e1's subject, with an email
      // that matches nothing - the post-transfer Hide My Email shape.
      const e2 = await signIn(ctx, apikey, { sub: subj("e2"), email: email("e2"), email_verified: true, name: "E", claims: { transfer_sub: subj("e1") } });
      if (e2.userId) createdUsers.add(e2.userId);
      const bNewUser = !!e1.userId && !!e2.userId && e2.userId !== e1.userId;
      out.push({
        id: `${ID}b`,
        title: "a transfer_sub naming the old identity does not find it: a new user",
        status: bNewUser ? "pass" : "fail",
        detail: `${note(e2)}; same user as e1: ${String(e2.userId === e1.userId)} (transfer_sub carried e1's subject and the email matched nothing)`,
        measurements: {
          session: e2.userId ? 1 : 0,
          new_user: String(bNewUser),
          callback_status: e2.callbackStatus,
        },
      });

      // ---- IT02c: does the stored claim survive its absence? ---------------
      const e1again = await signIn(ctx, apikey, { sub: subj("e1"), email: email("e1"), email_verified: true, name: "E" });
      if (e1again.userId) createdUsers.add(e1again.userId);
      const c = e1.userId ? await claimRow(e1.userId) : {};
      const gone = c.identity_tsub == null && c.meta_tsub == null;
      out.push({
        id: `${ID}c`,
        title: "sign in again without the claim: the stored copy is not durable",
        status: !!e1again.userId && e1again.userId === e1.userId && gone ? "pass" : "fail",
        detail: `${note(e1again)}; same user as e1: ${String(e1again.userId === e1.userId)}; after a sign-in carrying no transfer_sub, identity_data.custom_claims.transfer_sub is ${String(c.identity_tsub ?? "absent")} and raw_user_meta_data.custom_claims.transfer_sub is ${String(c.meta_tsub ?? "absent")} (raw_user_meta_data still has a custom_claims key: ${String(c.meta_has_custom_claims)})`,
        measurements: {
          same_user: String(e1again.userId === e1.userId),
          identity_data_transfer_sub_after: c.identity_tsub === tsub ? "present" : "absent",
          user_metadata_transfer_sub_after: c.meta_tsub === tsub ? "present" : "absent",
          user_metadata_has_custom_claims_key: String(c.meta_has_custom_claims),
        },
      });
    } catch (e) {
      out.push({ id: ID, title: this.title, status: "fail", detail: `threw: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      const notes: string[] = [];
      const keys = await fetchKeys(ctx).catch(() => undefined);
      let deleted = 0;
      if (keys) {
        for (const id of createdUsers) {
          const r = await fetch(`https://${ctx.apiHost}/auth/v1/admin/users/${id}`, {
            method: "DELETE",
            headers: { apikey: keys.service, Authorization: `Bearer ${keys.service}` },
            signal: AbortSignal.timeout(30_000),
          });
          if (r.status < 300) deleted++;
        }
      }
      // Sweep by identity subject as well as email: a refused sign-in leaves a
      // user whose email column is NULL (IT01e).
      const sweep = await sql(ctx, `delete from auth.users where id in (select user_id from auth.identities where provider = 'keycloak' and provider_id like 'it02-${nonce}-%') or email like 'it02-${nonce}-%@example.com' returning id`);
      notes.push(`deleted ${deleted} user(s) via admin API, ${sweep.rows.length} more by identity-subject sweep`);
      let restored = true;
      if (original) {
        const restore = await mgmt(ctx, "PATCH", `/projects/${ctx.ref}/config/auth`, original);
        restored = restore.status < 300;
        notes.push(`auth config restored: HTTP ${restore.status}`);
      }
      out.push({ id: `${ID}z`, title: "cleanup", status: restored && !sweep.error ? "pass" : "fail", detail: notes.join("; ") + (sweep.error ? `; sweep error: ${sweep.error}` : "") });
    }
    return out;
  },
};
export default mod;
