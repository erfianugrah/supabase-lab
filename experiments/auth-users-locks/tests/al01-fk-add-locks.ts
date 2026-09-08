/**
 * AL01 - a foreign key to auth.users, the lock it takes, and the sign-in it
 * blocks. This is the customer-side scenario: the FK lives on a PUBLIC table
 * that references auth.users, so nothing in the auth schema is modified (that
 * is platform-restricted); the lock lands on auth.users all the same.
 *
 *   AL01a  measure the lock `ALTER TABLE public.al_child ADD CONSTRAINT ...
 *          REFERENCES auth.users` takes ON auth.users, read from pg_locks in
 *          the same transaction. Postgres docs: ADD FOREIGN KEY takes
 *          SHARE ROW EXCLUSIVE on the referenced table. PASS if that mode is
 *          the one held.
 *   AL01b  with that ADD-CONSTRAINT transaction held open on session A, a
 *          SECOND connection's UPDATE auth.users (what a sign-in's
 *          last_sign_in_at write is) under lock_timeout='2s'. SHARE ROW
 *          EXCLUSIVE conflicts with the ROW EXCLUSIVE an UPDATE needs, so the
 *          UPDATE is blocked -> 55P03. PASS if blocked.
 *   AL01c  the real observable: a password sign-in via managed GoTrue while
 *          session A still holds the lock. INFO - GoTrue's own statement
 *          timeout decides the exact status, so the value is the evidence, not
 *          a pass/fail. Recorded verbatim.
 *
 * Not settled by this module: the lock auth.users takes when the FK is DROPPED
 * (AGENTS.md: unverified whether that is ACCESS EXCLUSIVE on the referenced
 * table); AL02 covers the NOT VALID avoidance path.
 *
 * DESTRUCTIVE: creates public.al_child and one confirmed user, drops both in
 * finally. Self-skips without a pooler host or the service key.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { fetchKeys, sql } from "../../../harness/src/platform";
import { adminCreateUser, connect, hasMode, locksOn, signInPassword, tryUnderLockTimeout } from "../lib/locks";

const CHILD = "public.al_child";
const SRE = "ShareRowExclusiveLock";
// Fixed synthetic test password, low entropy on purpose (secret scanners).
const PW = "supabase-lab-test-password";

const mod: TestModule = {
  id: "AL01",
  title: "Foreign key to auth.users: the lock it takes and the sign-in it blocks",
  where: "local",
  requires: ["pat", "pooler"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!ctx.ref) return [{ id: "AL01", title: this.title, status: "skip", detail: "no project ref (PVLAB_REF)" }];
    const keys = await fetchKeys(ctx);
    const out: TestResult[] = [];
    const email = `al01.${Date.now()}@example.com`;

    // Setup: a child table with a seeded user id, and a confirmed user to sign in as.
    await sql(ctx, `create table if not exists ${CHILD} (id int primary key, user_id uuid)`);
    const mk = await adminCreateUser(ctx, keys.service, email, PW);
    const uid = await sql(ctx, `select id from auth.users where email = ${quote(email)} limit 1`);
    const userId = (uid.rows[0]?.id as string | undefined) ?? null;
    if (userId) await sql(ctx, `insert into ${CHILD} values (1, ${quote(userId)}) on conflict (id) do update set user_id = excluded.user_id`);

    const held = await connect(ctx);
    try {
      if (!held.client) {
        return [{ id: "AL01", title: this.title, status: "skip", detail: held.err ?? "no pooler connection" }];
      }
      const A = held.client;

      // AL01a - take the lock and read it, in one transaction.
      await A.query("begin");
      await A.query(`set local lock_timeout = '10s'`);
      await A.query(
        `alter table ${CHILD} add constraint al_child_user_fk foreign key (user_id) references auth.users (id)`,
      );
      const locks = await locksOn(A, "auth", "users");
      const modes = locks.filter((l) => l.granted).map((l) => l.mode);
      out.push({
        id: "AL01a",
        title: `FK add: lock on auth.users (docs: ${SRE})`,
        status: hasMode(locks, SRE) ? "pass" : "fail",
        detail: `auth.users locks held by the ADD CONSTRAINT txn: ${modes.join(", ") || "none"}`,
        measurements: { docs_mode: SRE, modes_held: modes.join(",") || "none", matched: hasMode(locks, SRE) ? 1 : 0 },
      });

      // AL01b - a sign-in-shaped UPDATE on auth.users, from another connection, blocks.
      if (userId) {
        const upd = await tryUnderLockTimeout(
          ctx,
          `update auth.users set last_sign_in_at = now() where id = ${quote(userId)}`,
          "2s",
        );
        out.push({
          id: "AL01b",
          title: "sign-in-shaped UPDATE auth.users is blocked while the FK add holds the lock",
          status: upd.blocked ? "pass" : "fail",
          detail: upd.blocked
            ? `UPDATE blocked as expected: ${upd.code} ${upd.error}`
            : upd.ok
              ? "UPDATE was NOT blocked - the FK add did not hold a conflicting lock"
              : `UPDATE errored (not the lock signature): ${upd.code} ${upd.error}`,
          measurements: { blocked: upd.blocked ? 1 : 0, code: upd.code || "none" },
        });
      } else {
        out.push({ id: "AL01b", title: "sign-in-shaped UPDATE blocked", status: "skip", detail: `no seeded user id (admin create HTTP ${mk})` });
      }

      // AL01c - the real sign-in, as evidence.
      const login = await signInPassword(ctx, email, PW, 15_000);
      out.push({
        id: "AL01c",
        title: "real password sign-in while the lock is held (observable)",
        status: "info",
        detail: `POST /auth/v1/token grant_type=password -> ${login.status} in ${login.ms}ms${login.error ? ` (${login.error})` : ""}; body ${login.body}`,
        measurements: { status: login.status, ms: login.ms },
      });

      await A.query("rollback");
    } catch (e) {
      out.push({ id: "AL01", title: this.title, status: "fail", detail: `threw: ${e instanceof Error ? e.message : String(e)}` });
      await held.client?.query("rollback").catch(() => {});
    } finally {
      await held.client?.end().catch(() => {});
      // Cleanup: drop the child table and the seeded user.
      await sql(ctx, `drop table if exists ${CHILD}`);
      if (keys.service) {
        const u = await sql(ctx, `select id from auth.users where email = ${quote(email)} limit 1`);
        const id = u.rows[0]?.id as string | undefined;
        if (id) {
          await fetch(`https://${ctx.apiHost}/auth/v1/admin/users/${id}`, {
            method: "DELETE",
            headers: { apikey: keys.service, Authorization: `Bearer ${keys.service}` },
          }).catch(() => undefined);
        }
      }
      out.push({ id: "AL01z", title: "cleanup: drop al_child, delete probe user", status: "pass", detail: "dropped table, deleted user (best effort)" });
    }
    return out;
  },
};

/** Single-quote a SQL literal for the query endpoint (no bound params there). */
function quote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

export default mod;
