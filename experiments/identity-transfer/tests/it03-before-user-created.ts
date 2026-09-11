/**
 * IT03 - the Before User Created hook on a MANAGED project: which
 * account-resolution decisions run it, what its payload carries, and what it
 * can do about them.
 *
 * It is the only platform lever that sits between "Auth decided this is a new
 * person" and the row being written, so it is the net under an identity remap
 * that misses a user. `triggerBeforeUserCreatedExternal`
 * (internal/api/hooks.go) runs `DetermineAccountLinking` itself and returns
 * early unless the decision is `CreateAccount`, then builds the payload from
 * `structs.Map(userData.Metadata)` - the same map that becomes identity_data -
 * via `SignupParams.Data` and `models.NewUser`, so the provider's custom claims
 * should be reachable at `user.user_metadata.custom_claims`.
 * `BeforeUserCreatedOutput` is an empty struct, so the hook can refuse a signup
 * and cannot alter or link one.
 *
 * ITL3 answered those questions on a throwaway GoTrue. What this module adds
 * is the managed platform's side: that `hook_before_user_created_enabled`,
 * `_uri` and `_secrets` on `PATCH /config/auth` behave the way the rig's
 * environment variables do, and how long a hook config change takes to reach
 * the Auth server - which nothing in /auth/v1/settings reports, so it is polled
 * for with fresh personas.
 *
 *   IT03-setup  point the Keycloak slot at the lab issuer, sign f1 in to
 *               create the user the later cases link against, THEN enable the
 *               hook against the worker's /hook/reject route and poll with
 *               fresh personas until a signup is actually refused.
 *   IT03a       a stranger carrying a transfer_sub claim -> refused, and the
 *               refusal message is the worker's digest of the payload it was
 *               handed: which keys reached user_metadata, and whether the
 *               custom claim was among them.
 *   IT03b       a NEW subject with f1's verified email (LinkAccount) -> a
 *               session. The hook did not run.
 *   IT03c       subject f1 again (AccountExists) -> a session. The hook did
 *               not run.
 *   IT03d       control: the hook off, the SAME persona IT03a was refused for
 *               -> a user. Without it, "refused" is a property of the persona
 *               rather than of the hook.
 *   IT03z       cleanup: users deleted, hook and auth config restored.
 *
 * DESTRUCTIVE: writes auth config incl. the hook (restored in finally),
 * creates users (deleted in finally). Self-skips without ctx.endpoints.issuer.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { mgmt } from "../../../harness/src/mgmt";
import { fetchKeys, sql } from "../../../harness/src/platform";
import { CONFIG_KEYS, note, pointAtIssuer, signIn, type Persona, type SignIn } from "../lib/flow";

const ID = "IT03";
/** How long to wait for a hook config change to reach the Auth server. */
const HOOK_SETTLE_BUDGET_MS = 120_000;

const mod: TestModule = {
  id: ID,
  title: "Before User Created: which decisions run it, what it sees, what it can do",
  where: "local",
  requires: ["pat", "anon-key"],
  destructive: true,

  async run(ctx: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];
    const issuer = ctx.endpoints["issuer"];
    if (!issuer) return [{ id: ID, title: this.title, status: "skip", detail: "PVLAB_ENDPOINT_ISSUER not set (the lab OIDC issuer worker URL)" }];
    const nonce = Math.random().toString(36).slice(2, 8);
    const email = (k: string) => `it03-${nonce}-${k}@example.com`;
    const subj = (k: string) => `it03-${nonce}-${k}`;
    const apikey = ctx.anonKey!;
    const createdUsers = new Set<string>();
    let original: Record<string, unknown> | undefined;

    // A standard-webhooks symmetric secret in the format the config API
    // validates (`^v1,whsec_[A-Za-z0-9+/=]{32,88}`). Generated per run and
    // never recorded: the worker does not verify the signature, so this only
    // has to satisfy the format check.
    const hookSecret = `v1,whsec_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64")}`;
    const setHook = async (enabled: boolean, route: "reject" | "allow" = "reject") =>
      mgmt(ctx, "PATCH", `/projects/${ctx.ref}/config/auth`, {
        hook_before_user_created_enabled: enabled,
        hook_before_user_created_uri: enabled ? `${issuer.replace(/\/$/, "")}/hook/${route}` : "",
        ...(enabled ? { hook_before_user_created_secrets: hookSecret } : {}),
      });

    /** A fresh stranger; one per polling attempt so no attempt reuses a subject. */
    const stranger = (n: number): Persona => ({
      sub: subj(`g${n}`),
      email: email(`g${n}`),
      email_verified: true,
      name: "G",
      claims: { transfer_sub: `TRANSFER-${nonce}-g` },
    });

    /**
     * Sign strangers in until the outcome matches `want`, which is how a hook
     * config change is waited out: nothing in /auth/v1/settings reports it.
     */
    const pollUntil = async (want: "refused" | "created"): Promise<{ s: SignIn; p: Persona; attempts: number; s0: number; got: boolean }> => {
      const t0 = Date.now();
      let attempts = 0;
      let s: SignIn = { authorizeStatus: -1, callbackStatus: -1 };
      let p = stranger(0);
      while (Date.now() - t0 < HOOK_SETTLE_BUDGET_MS) {
        attempts++;
        p = stranger(attempts);
        s = await signIn(ctx, apikey, p);
        if (s.userId) createdUsers.add(s.userId);
        const got = want === "refused" ? !s.userId : !!s.userId;
        if (got) return { s, p, attempts, s0: Math.round((Date.now() - t0) / 1000), got: true };
        await Bun.sleep(3_000);
      }
      return { s, p, attempts, s0: Math.round((Date.now() - t0) / 1000), got: false };
    };

    try {
      const cur = await mgmt(ctx, "GET", `/projects/${ctx.ref}/config/auth`);
      if (cur.status !== 200 || !cur.json) {
        return [{ id: ID, title: this.title, status: "fail", detail: `GET /config/auth HTTP ${cur.status}`, evidence: cur.text.slice(0, 300) }];
      }
      const cfg = cur.json as Record<string, unknown>;
      original = Object.fromEntries(CONFIG_KEYS.map((k) => [k, cfg[k] ?? null]));
      const st = await pointAtIssuer(ctx, apikey, issuer);
      if (!st.settled) {
        out.push({
          id: `${ID}-setup`,
          title: "keycloak slot pointed at the lab issuer",
          status: "fail",
          detail: `PATCH /config/auth HTTP ${st.patchStatus}; external.keycloak never true within ${st.settleS}s`,
          evidence: st.lastBody.slice(0, 300),
        });
        return out;
      }

      // The user the linking cases resolve to, created while the hook is off.
      const f1 = await signIn(ctx, apikey, { sub: subj("f1"), email: email("f"), email_verified: true, name: "F" });
      if (f1.userId) createdUsers.add(f1.userId);

      const enable = await setHook(true, "reject");
      const armed = await pollUntil("refused");
      out.push({
        id: `${ID}-setup`,
        title: "hook enabled against the lab worker",
        status: f1.userId && enable.status < 300 && armed.got ? "pass" : "fail",
        detail: `f1 (hook off) ${note(f1)}; PATCH hook_before_user_created HTTP ${enable.status}; first refused signup after ${armed.s0}s (${armed.attempts} sign-in attempts, one fresh subject each); prior config had the hook ${String(cfg.hook_before_user_created_enabled)}`,
        measurements: {
          hook_patch_status: enable.status,
          hook_settle_s: armed.s0,
          hook_settle_attempts: armed.attempts,
          hook_previously_enabled: String(cfg.hook_before_user_created_enabled),
        },
        evidence: armed.got ? undefined : `last outcome: ${note(armed.s)}`,
      });
      if (!f1.userId || !armed.got) return out;

      // ---- IT03a: the hook ran, and what it was handed --------------------
      const raw = armed.s.errorDescription ?? "";
      let digest = raw;
      try {
        digest = decodeURIComponent(raw);
      } catch {
        // leave it as it arrived; the assertions below will say so
      }
      const um = /\bum=(\S*)/.exec(digest)?.[1] ?? "";
      const cc = /\bcc=(\S*)/.exec(digest)?.[1] ?? "";
      const tsub = /\btsub=(\S*)/.exec(digest)?.[1] ?? "";
      const sawClaim = cc.split("|").includes("transfer_sub") && tsub === `TRANSFER-${nonce}-g`;
      out.push({
        id: `${ID}a`,
        title: "a stranger is refused, and the payload carried the provider custom claim",
        status: sawClaim ? "pass" : "fail",
        detail: `${note(armed.s)}; the hook's own digest of the payload: user_metadata keys [${um}], custom_claims keys [${cc}], transfer_sub ${tsub === `TRANSFER-${nonce}-g` ? "matched the claim the issuer sent" : `was "${tsub}"`}`,
        measurements: {
          session: armed.s.userId ? 1 : 0,
          error_code: armed.s.errorCode ?? "-",
          user_metadata_keys: um || "-",
          custom_claims_keys: cc || "-",
          transfer_sub_visible: String(sawClaim),
        },
        evidence: `callback error_description verbatim: ${raw.slice(0, 400)}`,
      });

      // ---- IT03b: LinkAccount does not run the hook -----------------------
      const f2 = await signIn(ctx, apikey, { sub: subj("f2"), email: email("f"), email_verified: true, name: "F" });
      if (f2.userId) createdUsers.add(f2.userId);
      out.push({
        id: `${ID}b`,
        title: "a new subject linking on a verified email: the hook does not run",
        status: f2.userId === f1.userId ? "pass" : "fail",
        detail: `${note(f2)}; same user as f1: ${String(f2.userId === f1.userId)} - signed in while the hook was refusing every new account`,
        measurements: { session: f2.userId ? 1 : 0, same_user_as_f1: String(f2.userId === f1.userId), error_code: f2.errorCode ?? "-" },
      });

      // ---- IT03c: AccountExists does not run the hook ----------------------
      const f1again = await signIn(ctx, apikey, { sub: subj("f1"), email: email("f"), email_verified: true, name: "F" });
      if (f1again.userId) createdUsers.add(f1again.userId);
      out.push({
        id: `${ID}c`,
        title: "a known subject signing in again: the hook does not run",
        status: f1again.userId === f1.userId ? "pass" : "fail",
        detail: `${note(f1again)}; same user as f1: ${String(f1again.userId === f1.userId)}`,
        measurements: { session: f1again.userId ? 1 : 0, same_user_as_f1: String(f1again.userId === f1.userId), error_code: f1again.errorCode ?? "-" },
      });

      // ---- IT03d: control - the refusal was the hook -----------------------
      const disable = await setHook(false);
      const freed = await pollUntil("created");
      out.push({
        id: `${ID}d`,
        title: "control: hook off, the same persona shape is created",
        status: disable.status < 300 && freed.got ? "pass" : "fail",
        detail: `PATCH hook off HTTP ${disable.status}; ${note(freed.s)} after ${freed.s0}s (${freed.attempts} attempts). The persona IT03a was refused for differs only in the run-scoped subject and email, so the refusal was the hook`,
        measurements: {
          hook_off_patch_status: disable.status,
          hook_off_settle_s: freed.s0,
          hook_off_settle_attempts: freed.attempts,
          session: freed.s.userId ? 1 : 0,
        },
        evidence: freed.got ? undefined : `last outcome: ${note(freed.s)}`,
      });
    } catch (e) {
      out.push({ id: ID, title: this.title, status: "fail", detail: `threw: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      const notes: string[] = [];
      // The hook goes off first: a restore that leaves it armed would refuse
      // every signup on this project until someone noticed.
      const off = await setHook(false);
      notes.push(`hook disabled: HTTP ${off.status}`);
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
      const sweep = await sql(ctx, `delete from auth.users where id in (select user_id from auth.identities where provider = 'keycloak' and provider_id like 'it03-${nonce}-%') or email like 'it03-${nonce}-%@example.com' returning id`);
      notes.push(`deleted ${deleted} user(s) via admin API, ${sweep.rows.length} more by identity-subject sweep`);
      let restored = off.status < 300;
      if (original) {
        const restore = await mgmt(ctx, "PATCH", `/projects/${ctx.ref}/config/auth`, original);
        restored = restored && restore.status < 300;
        notes.push(`auth config restored: HTTP ${restore.status}`);
      }
      out.push({ id: `${ID}z`, title: "cleanup", status: restored && !sweep.error ? "pass" : "fail", detail: notes.join("; ") + (sweep.error ? `; sweep error: ${sweep.error}` : "") });
    }
    return out;
  },
};
export default mod;
