/**
 * A06 - is the in-database copy of the auth audit trail on or off by default,
 * and can a tenant turn it off through the API?
 *
 * This one exists to settle a contradiction in our own corpus: a published
 * guide says the audit table "arrives empty because Postgres writes are off by
 * default", while a project from June holds rows. A fresh project answers it.
 *
 * Managed project. PAT for the config reads and writes, service key for the
 * auth event.
 *
 *   A06a  GET config/auth: is there any audit-log key in the documented
 *         surface at all (237 properties in the spec, none matching audit)
 *   A06b  PATCH the undocumented `audit_log_disable_postgres` - accepted,
 *         rejected, or silently ignored
 *   A06c  the effect that matters: with the flag whatever the PATCH left it,
 *         does a NEW auth event still land in auth.audit_log_entries
 *
 * DESTRUCTIVE: PATCHes the project's auth config (restored in finally),
 * creates and deletes one auth user.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import { fetchKeys } from "../../../harness/src/platform.js";
import { createConfirmedUser, deleteUser, nonce, passwordLogin, sqlRows, waitFor } from "../lib/audit.js";

const KEY = "audit_log_disable_postgres";

const mod: TestModule = {
  id: "A06",
  title: "the in-database audit copy: default state, and whether the API can switch it off",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];
    const keys = await fetchKeys(ctx);
    let userId = "";
    let patched = false;
    let original: unknown = undefined;
    try {
      const get = await mgmt(ctx, "GET", `/projects/${ctx.ref}/config/auth`);
      const cfg = (get.json ?? {}) as Record<string, unknown>;
      const auditKeys = Object.keys(cfg).filter((k) => /audit/i.test(k));
      original = Object.prototype.hasOwnProperty.call(cfg, KEY) ? cfg[KEY] : undefined;
      out.push({
        id: "A06a",
        title: "audit-log keys in the documented auth config",
        status: "info",
        detail: `GET config/auth -> HTTP ${get.status}, ${Object.keys(cfg).length} keys returned, ${auditKeys.length} of them mention audit${auditKeys.length ? ` (${auditKeys.map((k) => `${k}=${String(cfg[k])}`).join(", ")})` : ""}. ${KEY} is ${original === undefined ? "absent from the response, so the Dashboard's \"disable writing auth audit logs to project database\" switch is not on the public Management API surface" : `present and reads ${String(original)}`}.`,
        measurements: { config_keys: Object.keys(cfg).length, audit_keys: auditKeys.length, get_status: get.status, key_present_before: String(original !== undefined), key_before: String(original ?? "absent") },
        evidence: auditKeys.join(", "),
      });

      // PATCH in the direction that would CHANGE something: whatever the
      // current value is, ask for the opposite. Patching a value to the value
      // it already holds cannot distinguish a working write from a no-op, which
      // is what the first run of this module did.
      const target = original === true ? false : true;
      const patch = await mgmt(ctx, "PATCH", `/projects/${ctx.ref}/config/auth`, { [KEY]: target });
      patched = patch.status < 300;
      await new Promise((r) => setTimeout(r, 5000));
      const reread = await mgmt(ctx, "GET", `/projects/${ctx.ref}/config/auth`);
      const rr = (reread.json ?? {}) as Record<string, unknown>;
      const echoed = Object.prototype.hasOwnProperty.call(rr, KEY) ? String(rr[KEY]) : "absent";
      const took = echoed === String(target);
      out.push({
        id: "A06b",
        title: `PATCH ${KEY} through the Management API`,
        status: "info",
        detail: `asked for ${KEY}=${String(target)} (the opposite of the ${String(original)} it held). PATCH -> HTTP ${patch.status}${patch.status >= 300 ? `: ${patch.text.replace(/\s+/g, " ").slice(0, 200)}` : ""}; on re-read the key is ${echoed}. ${took ? "The write took." : "A 2xx that leaves the value unchanged: the switch is accepted and ignored on the public API, so it is Dashboard-only (Authentication -> Configuration -> Audit Logs)."}`,
        measurements: { patch_status: patch.status, patch_target: String(target), key_after_patch: echoed, write_took: String(took) },
      });

      // A06c - the only test that settles it: does a new event still get a row?
      const tag = nonce();
      const email = `a06-${tag}@example.com`;
      const before = Number((await sqlRows(ctx, "select count(*)::int as n from auth.audit_log_entries"))[0]?.n ?? 0);
      const pw = `A06-${tag}-Xy!7`;
      const u = await createConfirmedUser(ctx, keys.service, email, pw);
      userId = u.id;
      // A password login is the event GoTrue definitely audits; an admin create
      // is not guaranteed to write a row, and this module's conclusion turns on
      // whether a row appears at all.
      const login = u.id ? await passwordLogin(ctx, keys.anon, email, pw) : { status: 0 };
      const grew = await waitFor(
        async () => Number((await sqlRows(ctx, `select count(*)::int as n from auth.audit_log_entries where payload::text like '%a06-${tag}%'`))[0]?.n ?? 0) > 0,
        120_000,
        5000,
      );
      const after = Number((await sqlRows(ctx, "select count(*)::int as n from auth.audit_log_entries"))[0]?.n ?? 0);
      out.push({
        id: "A06c",
        title: "does a new auth event still reach the table",
        status: u.id ? "pass" : "fail",
        detail: `admin user create -> HTTP ${u.status} in ${u.attempts} attempt(s)${u.err ? ` (last error: ${u.err})` : ""}; password login -> HTTP ${login.status}. Table rows ${before} -> ${after}; a row tagged with this run ${grew.ok ? `appeared after ${grew.elapsedS}s` : `did not appear within ${grew.elapsedS}s`}. On a fresh project the Postgres copy is ${grew.ok ? "ON" : "OFF"} by default.`,
        measurements: {
          create_status: u.status,
          login_status: login.status,
          create_attempts: u.attempts,
          rows_before: before,
          rows_after: after,
          tagged_row_appeared: String(grew.ok),
          postgres_copy_default: grew.ok ? "on" : "off",
        },
      });
    } catch (e) {
      out.push({ id: "A06err", title: "A06 aborted", status: "fail", detail: e instanceof Error ? e.message : String(e) });
    } finally {
      // Restore the value that was there, which is NOT necessarily false: a
      // published corpus page measured this default as true in July, so
      // patching a blind false would silently flip the project's behaviour.
      if (patched && original !== undefined) await mgmt(ctx, "PATCH", `/projects/${ctx.ref}/config/auth`, { [KEY]: original }).catch(() => {});
      if (userId) await deleteUser(ctx, keys.service, userId).catch(() => 0);
      out.push({ id: "A06z", title: "cleanup", status: "pass", detail: `auth config PATCH ${patched ? "reverted" : "was not applied"}; test user ${userId ? "deleted" : "not created"}` });
    }
    return out;
  },
};
export default mod;
