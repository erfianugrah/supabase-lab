/**
 * ITL1 - after the identity remap, which stored copies of the subject and the
 * email move on their own, and which have to be moved by hand.
 *
 * IT01d measured that rewriting `auth.identities.provider_id` lands the new
 * subject on the old user. It left open what the rest of the row set does,
 * which is the part a migration runbook gets wrong: `auth.users` carries its
 * own copy of the provider claims in `raw_user_meta_data`, and `auth.users
 * .email` is what the project mails.
 *
 * The AccountExists branch of `createAccountFromExternalIdentity`
 * (internal/api/external.go) replaces `identity_data` wholesale and calls
 * `UpdateUserMetaData`, which merges key-wise (internal/models/user.go); it
 * touches `user.Email` nowhere. So the prediction is that the metadata copies
 * repair themselves on the next sign-in and the primary email does not. This
 * module reads all of them either side of that sign-in.
 *
 *   ITL1a  subject c1 with email c signs in.
 *   ITL1b  SQL rewrites provider_id to c2 only (NOT identity_data), then c2
 *          signs in with a new email -> same user, and the lookup is shown to
 *          be the provider_id column alone (FindIdentityByIdAndProvider,
 *          internal/models/identity.go), not identity_data.sub.
 *   ITL1c  every stored copy, before and after that sign-in.
 *
 * Local vantage: needs the rig from local/compose.yml. Self-skips without
 * PVLAB_ENDPOINT_LOCAL_AUTH.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { note } from "../lib/flow";
import { q, rigUp, signInLocal, sweep } from "../lib/local";

const ID = "ITL1";

const mod: TestModule = {
  id: ID,
  title: "After the remap: which stored copies of the subject and email move",
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
    const prefix = `itl1-${nonce}-`;
    const email = (k: string) => `${prefix}${k}@example.com`;
    const subj = (k: string) => `${prefix}${k}`;

    /** Every stored copy of the subject and the email, for one user. */
    const copies = async (id: string) =>
      (
        await q(`select u.email                                   as users_email,
                        u.raw_user_meta_data->>'sub'              as meta_sub,
                        u.raw_user_meta_data->>'provider_id'      as meta_provider_id,
                        u.raw_user_meta_data->>'email'            as meta_email,
                        i.provider_id                             as identity_provider_id,
                        i.identity_data->>'sub'                   as identity_sub,
                        i.identity_data->>'email'                 as identity_email,
                        (select count(*) from auth.identities x where x.user_id = u.id) as identities
                 from auth.users u join auth.identities i on i.user_id = u.id
                 where u.id = '${id}' and i.provider = 'keycloak'`)
      )[0] ?? {};

    try {
      // ---- ITL1a ----------------------------------------------------------
      const c1 = await signInLocal(base, { sub: subj("c1"), email: email("c"), email_verified: true, name: "C" });
      out.push({
        id: `${ID}a`,
        title: "first sign-in on the local rig",
        status: c1.userId ? "pass" : "fail",
        detail: note(c1),
        measurements: { session: c1.userId ? 1 : 0, callback_status: c1.callbackStatus },
        evidence: c1.userId ? undefined : `authorize ${c1.authorizeStatus}, error ${c1.error ?? "-"}`,
      });
      if (!c1.userId) return out;

      // ---- ITL1b: rewrite provider_id ONLY ---------------------------------
      // IT01d rewrote identity_data.sub as well. Leaving it stale here asks a
      // second question: which of the two the lookup actually reads.
      const remap = await q(`update auth.identities set provider_id = '${subj("c2")}' where provider = 'keycloak' and provider_id = '${subj("c1")}' returning user_id::text`);
      const before = await copies(c1.userId);
      const c2 = await signInLocal(base, { sub: subj("c2"), email: email("c2"), email_verified: true, name: "C" });
      const after = await copies(c1.userId);
      const same = c2.userId === c1.userId;
      out.push({
        id: `${ID}b`,
        title: "rewriting provider_id alone is enough: the lookup does not read identity_data.sub",
        status: remap.length === 1 && same && Number(after.identities) === 1 ? "pass" : "fail",
        detail: `remap updated ${remap.length} row(s), leaving identity_data.sub at the OLD subject (${String(before.identity_sub)}); c2 then signed in with a different email: ${note(c2)}; same user as c1: ${String(same)}, identities on that user: ${String(after.identities)}`,
        measurements: {
          remap_rows: remap.length,
          identity_data_sub_left_stale: String(before.identity_sub === subj("c1")),
          same_user: String(same),
          identities_on_user: Number(after.identities ?? 0),
        },
      });

      // ---- ITL1c: the stored copies ---------------------------------------
      const tag = (v: unknown, kind: "sub" | "email") => {
        if (v == null) return "null";
        if (kind === "sub") return v === subj("c2") ? "new" : v === subj("c1") ? "old" : "other";
        return v === email("c2") ? "new" : v === email("c") ? "old" : "other";
      };
      const selfHealed =
        tag(before.meta_sub, "sub") === "old" &&
        tag(after.meta_sub, "sub") === "new" &&
        tag(after.meta_provider_id, "sub") === "new" &&
        tag(after.identity_sub, "sub") === "new";
      const emailStale = tag(after.users_email, "email") === "old";
      out.push({
        id: `${ID}c`,
        title: "the claim copies repair themselves on the next sign-in; auth.users.email does not",
        status: selfHealed && emailStale ? "pass" : "fail",
        detail:
          `after the SQL rewrite and before the sign-in: raw_user_meta_data.sub ${tag(before.meta_sub, "sub")}, .provider_id ${tag(before.meta_provider_id, "sub")}, identity_data.sub ${tag(before.identity_sub, "sub")}, auth.users.email ${tag(before.users_email, "email")}. ` +
          `After it: raw_user_meta_data.sub ${tag(after.meta_sub, "sub")}, .provider_id ${tag(after.meta_provider_id, "sub")}, .email ${tag(after.meta_email, "email")}, identity_data.sub ${tag(after.identity_sub, "sub")}, identity_data.email ${tag(after.identity_email, "email")}, auth.users.email ${tag(after.users_email, "email")}`,
        measurements: {
          meta_sub_before: tag(before.meta_sub, "sub"),
          meta_sub_after: tag(after.meta_sub, "sub"),
          meta_provider_id_after: tag(after.meta_provider_id, "sub"),
          meta_email_after: tag(after.meta_email, "email"),
          identity_sub_after: tag(after.identity_sub, "sub"),
          identity_email_after: tag(after.identity_email, "email"),
          users_email_after: tag(after.users_email, "email"),
          token_email_after: c2.email === email("c2") ? "new" : c2.email === email("c") ? "old" : "other",
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
