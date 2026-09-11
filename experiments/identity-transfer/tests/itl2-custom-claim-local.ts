/**
 * ITL2 - a transfer_sub-shaped provider claim on the local rig: where it is
 * stored, that it moves no decision, and how long it survives.
 *
 * Apple's parser copies `transfer_sub` into the provider claims' custom-claims
 * map and nowhere else (internal/api/provider/oidc.go). The Keycloak provider
 * copies every non-standard userinfo claim into the same field
 * (internal/api/provider/keycloak.go), and everything downstream -
 * `structs.Map(userData.Metadata)` into identity_data and raw_user_meta_data -
 * is shared, so a lab claim named transfer_sub travels the identical path.
 * `DetermineAccountLinking` takes (emails, aud, providerName, sub) and nothing
 * else off the token (internal/models/linking.go), so nothing reads it back.
 *
 *   ITL2a  subject e1 carrying transfer_sub -> where the claim is stored.
 *   ITL2b  a NEW subject whose transfer_sub names e1's subject, with an email
 *          that matches nothing -> a new user. The post-transfer Hide My Email
 *          shape: the claim that names the old identity does not find it.
 *   ITL2c  e1 signs in again with NO transfer_sub -> whether the stored copy
 *          survives. identity_data is replaced wholesale in the AccountExists
 *          branch and raw_user_meta_data is merged key-wise, so the question is
 *          whether the top-level custom_claims key is overwritten.
 *
 * Local vantage: needs the rig from local/compose.yml. Self-skips without
 * PVLAB_ENDPOINT_LOCAL_AUTH.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { note } from "../lib/flow";
import { q, rigUp, signInLocal, sweep } from "../lib/local";

const ID = "ITL2";

const mod: TestModule = {
  id: ID,
  title: "A transfer_sub-shaped claim: stored on both rows, reads nothing, survives nothing",
  where: "local",
  requires: [],
  destructive: true,

  async run(ctx: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];
    // The rig is a probe target like any other (AGENTS.md: ctx.endpoints),
    // so an absent one is a skip with a reason rather than a failure.
    const base = ctx.endpoints["local_auth"] ?? "";
    if (!base) return [{ id: ID, title: this.title, status: "skip", detail: "PVLAB_ENDPOINT_LOCAL_AUTH not set (run `make local-up`)" }];
    if (!(await rigUp(base))) return [{ id: ID, title: this.title, status: "skip", detail: `local GoTrue not answering at ${base}/health` }];

    const nonce = Math.random().toString(36).slice(2, 8);
    const prefix = `itl2-${nonce}-`;
    const email = (k: string) => `${prefix}${k}@example.com`;
    const subj = (k: string) => `${prefix}${k}`;
    // Must not start with REJECT: the rig's hook refuses those (worker
    // /hook/decide), which is ITL3's business, not this module's.
    const tsub = `TRANSFER-${nonce}-e1`;

    const claims = async (id: string) =>
      (
        await q(`select i.identity_data->'custom_claims'->>'transfer_sub' as identity_tsub,
                        (i.identity_data ? 'custom_claims')               as identity_has_cc,
                        u.raw_user_meta_data->'custom_claims'->>'transfer_sub' as meta_tsub,
                        (u.raw_user_meta_data ? 'custom_claims')          as meta_has_cc
                 from auth.users u join auth.identities i on i.user_id = u.id
                 where u.id = '${id}' and i.provider = 'keycloak'`)
      )[0] ?? {};

    try {
      // ---- ITL2a ----------------------------------------------------------
      const e1 = await signInLocal(base, { sub: subj("e1"), email: email("e1"), email_verified: true, name: "E", claims: { transfer_sub: tsub } });
      const a = e1.userId ? await claims(e1.userId) : {};
      const aPass = !!e1.userId && a.identity_tsub === tsub && a.meta_tsub === tsub;
      out.push({
        id: `${ID}a`,
        title: "the claim is stored on the identity AND on the user",
        status: aPass ? "pass" : "fail",
        detail: `${note(e1)}; identity_data.custom_claims.transfer_sub ${a.identity_tsub === tsub ? "matches" : `is ${String(a.identity_tsub ?? "absent")}`}; raw_user_meta_data.custom_claims.transfer_sub ${a.meta_tsub === tsub ? "matches" : `is ${String(a.meta_tsub ?? "absent")}`}`,
        measurements: {
          session: e1.userId ? 1 : 0,
          identity_data_transfer_sub: a.identity_tsub === tsub ? "present" : "absent",
          user_metadata_transfer_sub: a.meta_tsub === tsub ? "present" : "absent",
        },
      });
      if (!e1.userId) return out;

      // ---- ITL2b ----------------------------------------------------------
      const e2 = await signInLocal(base, { sub: subj("e2"), email: email("e2"), email_verified: true, name: "E", claims: { transfer_sub: subj("e1") } });
      const bNew = !!e2.userId && e2.userId !== e1.userId;
      out.push({
        id: `${ID}b`,
        title: "a transfer_sub naming the old identity does not find it",
        status: bNew ? "pass" : "fail",
        detail: `${note(e2)}; same user as e1: ${String(e2.userId === e1.userId)} - the claim carried e1's exact subject and the email matched nothing`,
        measurements: { session: e2.userId ? 1 : 0, new_user: String(bNew), callback_status: e2.callbackStatus },
      });

      // ---- ITL2c ----------------------------------------------------------
      const again = await signInLocal(base, { sub: subj("e1"), email: email("e1"), email_verified: true, name: "E" });
      const c = await claims(e1.userId);
      const gone = c.identity_tsub == null && c.meta_tsub == null;
      out.push({
        id: `${ID}c`,
        title: "one sign-in without the claim and the stored copy is gone",
        status: again.userId === e1.userId && gone ? "pass" : "fail",
        detail: `${note(again)}; same user as e1: ${String(again.userId === e1.userId)}; identity_data.custom_claims.transfer_sub is now ${String(c.identity_tsub ?? "absent")} (custom_claims key present: ${String(c.identity_has_cc)}), raw_user_meta_data.custom_claims.transfer_sub is now ${String(c.meta_tsub ?? "absent")} (key present: ${String(c.meta_has_cc)})`,
        measurements: {
          same_user: String(again.userId === e1.userId),
          identity_data_transfer_sub_after: c.identity_tsub === tsub ? "present" : "absent",
          user_metadata_transfer_sub_after: c.meta_tsub === tsub ? "present" : "absent",
          identity_data_has_custom_claims_key: String(c.identity_has_cc),
          user_metadata_has_custom_claims_key: String(c.meta_has_cc),
        },
      });
    } catch (e) {
      out.push({ id: ID, title: this.title, status: "fail", detail: `threw: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      const n = await sweep(prefix).catch(() => -1);
      out.push({ id: `${ID}z`, title: "cleanup", status: n >= 0 ? "pass" : "fail", detail: n >= 0 ? `deleted ${n} user(s) by run prefix` : "sweep failed" });
    }
    return out;
  },
};
export default mod;
