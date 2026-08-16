/**
 * W09 - auth store replication (fresh logins after cutover)
 *
 * Encodes the mechanics from manual drilling (2026-08-15):
 * - copy_data=false skips the initial-sync worker (which stalls in 'd' for
 *   auth.*). Per W14 the wall is platform-managed schemas - auth.* and
 *   storage.* do not replicate at ANY tested size - not the micro worker
 *   ceiling; the earlier exhaustion hypothesis was disproved (ALTER SYSTEM
 *   is permission-denied regardless).
 * - The recovery sequence for a wedged subscription is:
 *     ALTER SUBSCRIPTION <s> DISABLE;
 *     ALTER SUBSCRIPTION <s> SET (slot_name = none);
 *     DROP SUBSCRIPTION <s>;
 *   each as a single statement.
 * - password_hash is NOT portable via admin API - documented as the backfill
 *   limitation in step 6.
 *
 * Pass criteria: all outcomes recorded verbatim; the module passes with ANY
 * measured behavior as long as steps 2-6 each produced recorded evidence.
 * The behavior IS the finding.
 */
import type { TestModule, Ctx, TestResult } from "../../../harness/src/types";
import { mgmt } from "../../../harness/src/mgmt";

const mod: TestModule = {
  id: "W09",
  title: "auth store replication (fresh logins after cutover)",
  where: "local",
  requires: ["pat", "anon-key", "peer"],
  destructive: true,

  async run(ctx: Ctx): Promise<TestResult> {
    const primary = ctx.ref;
    const standby = ctx.peers["standby"];
    const standbyAnon = ctx.endpoints["standby_anon"];
    const dbPw = ctx.dbPassword;
    const measurements: Record<string, string | number> = {};

    if (!standby || !standbyAnon || !dbPw || !ctx.serviceKey) {
      return {
        id: "W09",
        title: this.title,
        status: "skip",
        detail: `missing peer/endpoints/keys: standby=${standby ?? "absent"}, standby_anon=${standbyAnon ? "set" : "absent"}, dbPassword=${dbPw ? "set" : "absent"}, serviceKey=${ctx.serviceKey ? "set" : "absent"}`,
      };
    }

    // Run SQL via Management query endpoint - single-statement each call (W05 lesson:
    // multi-statement strings run in one transaction and Postgres rejects
    // CREATE/ALTER/DROP SUBSCRIPTION inside a transaction block).
    const runSql = async (ref: string, query: string) => {
      const res = await mgmt(ctx, "POST", `/projects/${ref}/database/query`, { query });
      if (res.status >= 300) throw new Error(`HTTP ${res.status}: ${res.text.slice(0, 400)}`);
      return res;
    };

    // Fetch standby service key via ctx.pat (SPEC step 6 requirement).
    const getStandbyServiceKey = async (): Promise<string | undefined> => {
      const res = await mgmt(ctx, "GET", `/projects/${standby}/api-keys?reveal=true`);
      if (res.status !== 200 || !Array.isArray(res.json)) return undefined;
      const keys = res.json as Array<{ type?: string; name?: string; api_key?: string }>;
      const found = keys.find(
        (k) => k.type === "service_role" || k.type === "secret" || k.name === "service_role",
      );
      return found?.api_key;
    };

    const directConn = `host=db.${primary}.supabase.co port=5432 dbname=postgres user=postgres password=${dbPw} sslmode=require connect_timeout=15`;

    // Cleanup: recovery sequence from SPEC (disable -> slot_name=none -> drop),
    // each single-statement. ALTER SUBSCRIPTION does NOT support IF EXISTS; rely
    // on .catch(() => {}) for the case where the subscription does not exist.
    const cleanup = async () => {
      await runSql(standby, `ALTER SUBSCRIPTION w09_auth_sub DISABLE`).catch(() => {});
      await runSql(standby, `ALTER SUBSCRIPTION w09_auth_sub SET (slot_name = none)`).catch(() => {});
      await runSql(standby, `DROP SUBSCRIPTION IF EXISTS w09_auth_sub`).catch(() => {});
      await runSql(primary, `DROP PUBLICATION IF EXISTS w09_auth_pub`).catch(() => {});
      await runSql(
        primary,
        `SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name LIKE 'w09%'`,
      ).catch(() => {});
      // Delete test users via SQL (postgres superuser; ON DELETE CASCADE handles FK children).
      await runSql(primary, `DELETE FROM auth.users WHERE email LIKE 'w09-%'`).catch(() => {});
      await runSql(standby, `DELETE FROM auth.users WHERE email LIKE 'w09-%'`).catch(() => {});
    };

    try {
      // Step 1: CREATE PUBLICATION on primary (drop first for idempotency).
      await runSql(primary, `DROP PUBLICATION IF EXISTS w09_auth_pub`);
      await runSql(primary, `CREATE PUBLICATION w09_auth_pub FOR TABLE auth.users, auth.identities`);
      measurements["publication_created"] = "true";

      // Step 2: CREATE SUBSCRIPTION on standby - single-statement (W05 lesson).
      // copy_data=false: no sync workers needed; sidesteps the initial-sync
      // stall. Per W14, auth.* still never streams (platform-schema wall).
      let subCreated = false;
      try {
        await runSql(
          standby,
          `CREATE SUBSCRIPTION w09_auth_sub CONNECTION '${directConn}' PUBLICATION w09_auth_pub WITH (copy_data = false, streaming = on)`,
        );
        subCreated = true;
        measurements["subscription_created"] = "true";
      } catch (e: any) {
        measurements["subscription_created"] = "false";
        measurements["subscription_error"] = e.message;
      }

      // Step 3: Backfill - count users on both sides before the new user is created.
      // Primary query endpoint confirms the pre-backfill state.
      const countUsers = async (ref: string): Promise<number> => {
        try {
          const res = await runSql(
            ref,
            `SELECT count(*)::int AS n FROM auth.users WHERE email NOT LIKE 'w09-%'`,
          );
          const rows = res.json as Array<{ n: number | string }>;
          if (Array.isArray(rows) && rows.length > 0 && rows[0]) {
            const n = rows[0].n;
            return typeof n === "number" ? n : parseInt(String(n), 10) || 0;
          }
        } catch { /* fall through to -1 */ }
        return -1;
      };
      measurements["pre_primary_users"] = await countUsers(primary);
      measurements["pre_standby_users"] = await countUsers(standby);

      // Step 4: Admin-create a NEW user on primary (W03 pattern - admin endpoint,
      // no email send -> no over_email_send_rate_limit).
      const rand = Math.random().toString(36).slice(2, 8);
      const email = `w09-${rand}@example.com`;
      const password = `W09-${rand}-pass!`;
      let adminCreateOk = false;

      const createRes = await fetch(`https://${ctx.apiHost}/auth/v1/admin/users`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: ctx.serviceKey!,
          Authorization: `Bearer ${ctx.serviceKey!}`,
        },
        body: JSON.stringify({ email, password, email_confirm: true }),
        signal: AbortSignal.timeout(30_000),
      });
      const createBody = await createRes.text();
      measurements["admin_create_status"] = createRes.status;
      if (!createRes.ok) {
        measurements["admin_create_error"] = createBody.slice(0, 200);
      } else {
        adminCreateOk = true;
      }

      // Poll standby for the new user row via streaming replication.
      let userFound = false;
      if (adminCreateOk && subCreated) {
        const pollStart = Date.now();
        while (Date.now() - pollStart < 120_000) {
          try {
            const res = await runSql(
              standby,
              `SELECT email FROM auth.users WHERE email = '${email}'`,
            );
            const rows = res.json as Array<{ email: string }>;
            if (Array.isArray(rows) && rows.length > 0) {
              userFound = true;
              measurements["streaming_lag_ms"] = Date.now() - pollStart;
              break;
            }
          } catch { /* poll errors are non-fatal */ }
          await new Promise<void>((r) => setTimeout(r, 5_000));
        }
        if (!userFound) {
          measurements["streaming_lag_ms"] = -1;
          // Record verbatim evidence - the platform behavior IS the finding.
          for (const [key, query] of [
            [
              "pg_subscription",
              `SELECT subname, subenabled, subslotname FROM pg_subscription WHERE subname = 'w09_auth_sub'`,
            ],
            [
              "pg_subscription_rel",
              `SELECT srsubid, srrelid::regclass AS rel, srsubstate FROM pg_subscription_rel WHERE srsubid = (SELECT oid FROM pg_subscription WHERE subname = 'w09_auth_sub')`,
            ],
            [
              "pg_stat_subscription",
              `SELECT subname, pid, received_lsn, last_msg_send_time FROM pg_stat_subscription WHERE subname = 'w09_auth_sub'`,
            ],
          ] as [string, string][]) {
            try {
              const res = await runSql(standby, query);
              measurements[key] = res.text.slice(0, 400);
            } catch (e: any) {
              measurements[`${key}_err`] = e.message;
            }
          }
        }
      } else {
        measurements["streaming_lag_ms"] = -1;
        measurements["streaming_skip_reason"] = adminCreateOk
          ? "subscription not created"
          : "admin-create failed";
      }

      // Step 5: Fresh password grant on the STANDBY for the streamed user.
      // Record status + body verbatim. Success = no forced re-login for users
      // created after the replication start.
      if (userFound) {
        const grantRes = await fetch(
          `https://${standby}.supabase.co/auth/v1/token?grant_type=password`,
          {
            method: "POST",
            headers: { apikey: standbyAnon, "Content-Type": "application/json" },
            body: JSON.stringify({ email, password }),
            signal: AbortSignal.timeout(30_000),
          },
        );
        const grantBody = await grantRes.text();
        measurements["standby_password_grant_status"] = grantRes.status;
        measurements["standby_password_grant_body"] = grantBody.slice(0, 200);
      } else {
        measurements["standby_password_grant_status"] = "skipped - user not found on standby";
      }

      // Step 6: Manual backfill demonstration.
      // GET a pre-existing user from the primary admin API, POST to standby admin API.
      // The key finding: password_hash is NOT portable via the admin API.
      measurements["backfill_limitation"] = "password_hash not portable via admin API - users must re-authenticate post-cutover unless hash is copied via direct SQL";
      const standbyServiceKey = await getStandbyServiceKey().catch(() => undefined);
      measurements["standby_service_key_available"] = standbyServiceKey ? "true" : "false";

      if (standbyServiceKey && (measurements["pre_primary_users"] as number) > 0) {
        try {
          // Use query endpoint to find a pre-existing user (one not created by this run).
          const usersRes = await runSql(
            primary,
            `SELECT id::text, email FROM auth.users WHERE email NOT LIKE 'w09-%' LIMIT 1`,
          );
          const rows = usersRes.json as Array<{ id: string; email: string }>;
          if (Array.isArray(rows) && rows.length > 0 && rows[0]) {
            const target = rows[0];
            measurements["backfill_target_email"] = target.email ?? "(present)";
            // POST to standby without password_hash - the limitation is that
            // password_hash is not accepted via admin API, so a migrated user
            // cannot log in with their old password without a re-auth.
            const backfillRes = await fetch(`https://${standby}.supabase.co/auth/v1/admin/users`, {
              method: "POST",
              headers: {
                apikey: standbyServiceKey,
                Authorization: `Bearer ${standbyServiceKey}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ id: target.id, email: target.email, email_confirm: true }),
              signal: AbortSignal.timeout(30_000),
            });
            const backfillBody = await backfillRes.text();
            measurements["backfill_attempt_status"] = backfillRes.status;
            measurements["backfill_attempt_body"] = backfillBody.slice(0, 200);
          }
        } catch (e: any) {
          measurements["backfill_attempt_error"] = e.message;
        }
      } else {
        measurements["backfill_skip_reason"] = !standbyServiceKey
          ? "standby service key unavailable"
          : "no pre-existing users on primary";
      }

      // SPEC pass criteria: all outcomes recorded verbatim; passes with ANY measured
      // behavior as long as steps 2-6 each produced recorded evidence.
      const detail = subCreated
        ? userFound
          ? `subscription active; user streamed in ${measurements["streaming_lag_ms"]}ms; standby password grant HTTP ${measurements["standby_password_grant_status"]}`
          : `subscription created (copy_data=false); user did not stream within 120s (platform-managed schema wall - see W14); evidence recorded`
        : `subscription not created: ${measurements["subscription_error"] ?? "unknown"}; evidence recorded`;

      return {
        id: "W09",
        title: this.title,
        status: "pass",
        detail,
        measurements,
      };
    } catch (e: any) {
      return {
        id: "W09",
        title: this.title,
        status: "fail",
        detail: e.message,
        measurements,
      };
    } finally {
      await cleanup();
    }
  },
};

export default mod;
