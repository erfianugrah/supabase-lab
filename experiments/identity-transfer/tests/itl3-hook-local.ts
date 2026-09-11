/**
 * ITL3 - the Before User Created hook: which account-resolution decision arms
 * it, what its payload carries, and what it can do about it.
 *
 * It is the only platform lever between "Auth decided this is a new person"
 * and the row being written, so it is the net under an identity remap that
 * misses someone. `triggerBeforeUserCreatedExternal` (internal/api/hooks.go)
 * runs `DetermineAccountLinking` itself and returns early unless the decision
 * is `CreateAccount`, then builds the payload from
 * `structs.Map(userData.Metadata)` - the same map that becomes identity_data -
 * through `SignupParams.Data` and `models.NewUser`, so the provider's custom
 * claims should arrive at `user.user_metadata.custom_claims`.
 * `BeforeUserCreatedOutput` is an empty struct: the hook can refuse a signup,
 * and cannot alter or link one.
 *
 * The rig's hook URI is fixed at boot, so the worker decides per request on
 * the custom claim (`/hook/decide` refuses when transfer_sub starts with
 * REJECT). That is what makes the negative cases mean something: b and c carry
 * a claim the hook WOULD refuse, down a path where it does not run, so "it did
 * not run" is distinguishable from "it ran and was content".
 *
 *   ITL3a  subject f1, no claim -> created. The base account, and evidence the
 *          hook allows what it is not asked to refuse.
 *   ITL3b  a NEW subject on f1's verified email, carrying a REJECT claim ->
 *          a session. LinkAccount does not run the hook.
 *   ITL3c  subject f1 again, carrying a REJECT claim -> a session.
 *          AccountExists does not run the hook.
 *   ITL3d  a stranger carrying a REJECT claim -> refused, and the refusal
 *          message is the worker's digest of the payload it was handed.
 *   ITL3e  the same stranger shape with a non-REJECT claim -> created. The
 *          refusal in d was the hook reading its payload.
 *
 * Local vantage: needs the rig from local/compose.yml. Self-skips without
 * PVLAB_ENDPOINT_LOCAL_AUTH.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { note } from "../lib/flow";
import { q, rigUp, signInLocal, sweep } from "../lib/local";

const ID = "ITL3";

const mod: TestModule = {
  id: ID,
  title: "Before User Created: armed only by CreateAccount, sees the custom claim, can only refuse",
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
    const prefix = `itl3-${nonce}-`;
    const email = (k: string) => `${prefix}${k}@example.com`;
    const subj = (k: string) => `${prefix}${k}`;
    const reject = `REJECT-${nonce}`;

    try {
      // ---- ITL3a: the base account ----------------------------------------
      const f1 = await signInLocal(base, { sub: subj("f1"), email: email("f"), email_verified: true, name: "F" });
      out.push({
        id: `${ID}a`,
        title: "a signup the hook is not asked to refuse goes through",
        status: f1.userId ? "pass" : "fail",
        detail: `${note(f1)} - the hook ran (CreateAccount) and returned no error`,
        measurements: { session: f1.userId ? 1 : 0, callback_status: f1.callbackStatus },
        evidence: f1.userId ? undefined : `error ${f1.error ?? "-"} / ${f1.errorDescription ?? "-"}`,
      });
      if (!f1.userId) return out;

      // ---- ITL3b: LinkAccount does not arm the hook ------------------------
      const f2 = await signInLocal(base, { sub: subj("f2"), email: email("f"), email_verified: true, name: "F", claims: { transfer_sub: reject } });
      const bIdentities = Number((await q(`select count(*) as n from auth.identities where user_id = '${f1.userId}'`))[0]?.n ?? 0);
      out.push({
        id: `${ID}b`,
        title: "linking on a verified email: the hook does not run",
        status: f2.userId === f1.userId && bIdentities === 2 ? "pass" : "fail",
        detail: `${note(f2)}; same user as f1: ${String(f2.userId === f1.userId)}, identities on that user now ${bIdentities}. It carried a claim the hook refuses, and was not refused`,
        measurements: {
          session: f2.userId ? 1 : 0,
          same_user_as_f1: String(f2.userId === f1.userId),
          identities_on_user: bIdentities,
          error_code: f2.errorCode ?? "-",
        },
      });

      // ---- ITL3c: AccountExists does not arm the hook ----------------------
      const f1again = await signInLocal(base, { sub: subj("f1"), email: email("f"), email_verified: true, name: "F", claims: { transfer_sub: reject } });
      out.push({
        id: `${ID}c`,
        title: "a known subject signing in again: the hook does not run",
        status: f1again.userId === f1.userId ? "pass" : "fail",
        detail: `${note(f1again)}; same user as f1: ${String(f1again.userId === f1.userId)}. Same refusable claim, same silence`,
        measurements: { session: f1again.userId ? 1 : 0, same_user_as_f1: String(f1again.userId === f1.userId), error_code: f1again.errorCode ?? "-" },
      });

      // ---- ITL3d: the hook runs, refuses, and says what it saw --------------
      const g1 = await signInLocal(base, { sub: subj("g1"), email: email("g1"), email_verified: true, name: "G", claims: { transfer_sub: reject } });
      // The message survives the ride back percent-encoded a second time: the
      // fragment parse decodes once, and `=` arrives as %3D even after that.
      const raw = g1.errorDescription ?? "";
      let digest = raw;
      try {
        digest = decodeURIComponent(raw);
      } catch {
        // leave it as it arrived; the assertions below will say so
      }
      const um = /\bum=(\S*)/.exec(digest)?.[1] ?? "";
      const cc = /\bcc=(\S*)/.exec(digest)?.[1] ?? "";
      const tsubSeen = /\btsub=(\S*)/.exec(digest)?.[1] ?? "";
      const sawClaim = cc.split("|").includes("transfer_sub") && tsubSeen === reject;
      const gRows = Number((await q(`select count(*) as n from auth.users where email = '${email("g1")}'`))[0]?.n ?? 0);
      out.push({
        id: `${ID}d`,
        title: "a stranger is refused, and the payload carried the provider custom claim",
        status: !g1.userId && sawClaim ? "pass" : "fail",
        detail: `${note(g1)}; the hook's own digest of what it was handed: user_metadata keys [${um}], custom_claims keys [${cc}], transfer_sub ${tsubSeen === reject ? "matched the claim the issuer sent" : `was "${tsubSeen}"`}; auth.users rows for that address after the refusal: ${gRows}`,
        measurements: {
          session: g1.userId ? 1 : 0,
          error_code: g1.errorCode ?? "-",
          user_metadata_keys: um || "-",
          custom_claims_keys: cc || "-",
          transfer_sub_visible: String(sawClaim),
          user_rows_after_refusal: gRows,
        },
        evidence: `callback error_description verbatim: ${raw.slice(0, 400)}`,
      });

      // ---- ITL3e: control --------------------------------------------------
      const g2 = await signInLocal(base, { sub: subj("g2"), email: email("g2"), email_verified: true, name: "G", claims: { transfer_sub: `TRANSFER-${nonce}-g2` } });
      out.push({
        id: `${ID}e`,
        title: "control: the same shape with a claim the hook accepts is created",
        status: g2.userId && g2.userId !== f1.userId ? "pass" : "fail",
        detail: `${note(g2)}. The persona differs from d only in the value of transfer_sub, so the refusal in d was the hook acting on its payload`,
        measurements: { session: g2.userId ? 1 : 0, new_user: String(!!g2.userId && g2.userId !== f1.userId) },
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
