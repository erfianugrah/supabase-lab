/**
 * AL02 - the workaround AL01 recommends: add the constraint NOT VALID, then
 * VALIDATE it. The claim is that this keeps a sign-in unblocked throughout,
 * where the plain ADD (AL01) blocks it.
 *
 *   AL02a  `ADD CONSTRAINT ... NOT VALID` - measure the lock on auth.users.
 *          NOT VALID skips the scan, so the conflicting window is tiny; docs
 *          still list SHARE ROW EXCLUSIVE for the constraint add itself, so
 *          this row RECORDS the mode (info) rather than asserting a negative.
 *   AL02b  `VALIDATE CONSTRAINT` - measure the lock on auth.users. Postgres
 *          docs: VALIDATE takes SHARE UPDATE EXCLUSIVE on the altered table and
 *          only ROW SHARE on the referenced table. PASS if auth.users is at
 *          RowShareLock (or weaker), i.e. NOT ShareRowExclusiveLock.
 *   AL02c  with the VALIDATE transaction held open, the same sign-in-shaped
 *          UPDATE auth.users under lock_timeout='2s' SUCCEEDS - ROW SHARE does
 *          not conflict with ROW EXCLUSIVE. PASS if it is not blocked. This is
 *          the mirror of AL01b and the point of the whole module.
 *
 * Not settled by this module: the duration of the tiny window NOT VALID still
 * needs; this measures the lock mode, not its hold time.
 *
 * DESTRUCTIVE: creates public.al_child2 and one confirmed user, drops both in
 * finally. Self-skips without a pooler host or the service key.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { fetchKeys, sql } from "../../../harness/src/platform";
import { adminCreateUser, connect, hasMode, locksOn, tryUnderLockTimeout } from "../lib/locks";

const CHILD = "public.al_child2";
const SRE = "ShareRowExclusiveLock";
// A fixed, obviously-synthetic test password: low entropy on purpose so secret
// scanners do not flag it. Test users only need it consistent, not unique.
const PW = "supabase-lab-test-password";

const mod: TestModule = {
  id: "AL02",
  title: "NOT VALID + VALIDATE keeps auth.users writable where a plain FK add does not",
  where: "local",
  requires: ["pat", "pooler"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!ctx.ref) return [{ id: "AL02", title: this.title, status: "skip", detail: "no project ref (PVLAB_REF)" }];
    const keys = await fetchKeys(ctx);
    const out: TestResult[] = [];
    const email = `al02.${Date.now()}@example.com`;

    await sql(ctx, `create table if not exists ${CHILD} (id int primary key, user_id uuid)`);
    await adminCreateUser(ctx, keys.service, email, PW);
    const uid = await sql(ctx, `select id from auth.users where email = ${quote(email)} limit 1`);
    const userId = (uid.rows[0]?.id as string | undefined) ?? null;
    if (userId) await sql(ctx, `insert into ${CHILD} values (1, ${quote(userId)}) on conflict (id) do update set user_id = excluded.user_id`);

    // AL02a - NOT VALID, measured in its own short transaction.
    const nvConn = await connect(ctx);
    try {
      if (!nvConn.client) return [{ id: "AL02", title: this.title, status: "skip", detail: nvConn.err ?? "no pooler connection" }];
      const N = nvConn.client;
      await N.query("begin");
      await N.query(`set local lock_timeout = '10s'`);
      await N.query(`alter table ${CHILD} add constraint al_child2_user_fk foreign key (user_id) references auth.users (id) not valid`);
      const nvLocks = (await locksOn(N, "auth", "users")).filter((l) => l.granted).map((l) => l.mode);
      await N.query("commit"); // keep the NOT VALID constraint so VALIDATE has something to do
      out.push({
        id: "AL02a",
        title: "ADD CONSTRAINT NOT VALID: lock on auth.users (recorded)",
        status: "info",
        detail: `auth.users locks held during NOT VALID: ${nvLocks.join(", ") || "none"}`,
        measurements: { modes_held: nvLocks.join(",") || "none" },
      });
    } catch (e) {
      out.push({ id: "AL02a", title: "ADD CONSTRAINT NOT VALID", status: "fail", detail: `threw: ${e instanceof Error ? e.message : String(e)}` });
      await nvConn.client?.query("rollback").catch(() => {});
    } finally {
      await nvConn.client?.end().catch(() => {});
    }

    // AL02b/AL02c - VALIDATE, held open, and a sign-in-shaped UPDATE against it.
    const vConn = await connect(ctx);
    try {
      if (!vConn.client) {
        out.push({ id: "AL02b", title: "VALIDATE CONSTRAINT lock", status: "skip", detail: vConn.err ?? "no pooler connection" });
      } else {
        const V = vConn.client;
        await V.query("begin");
        await V.query(`set local lock_timeout = '10s'`);
        await V.query(`alter table ${CHILD} validate constraint al_child2_user_fk`);
        const vLocks = await locksOn(V, "auth", "users");
        const modes = vLocks.filter((l) => l.granted).map((l) => l.mode);
        out.push({
          id: "AL02b",
          title: "VALIDATE CONSTRAINT: lock on auth.users is weaker than a plain FK add",
          status: !hasMode(vLocks, SRE) ? "pass" : "fail",
          detail: `auth.users locks held by VALIDATE: ${modes.join(", ") || "none"} (docs: RowShareLock; must not be ${SRE})`,
          measurements: { modes_held: modes.join(",") || "none", is_share_row_exclusive: hasMode(vLocks, SRE) ? 1 : 0 },
        });

        if (userId) {
          const upd = await tryUnderLockTimeout(ctx, `update auth.users set last_sign_in_at = now() where id = ${quote(userId)}`, "2s");
          out.push({
            id: "AL02c",
            title: "sign-in-shaped UPDATE auth.users succeeds while VALIDATE holds its lock",
            status: upd.ok ? "pass" : "fail",
            detail: upd.ok ? "UPDATE succeeded - VALIDATE did not block the write" : `UPDATE was blocked/failed: ${upd.code} ${upd.error}`,
            measurements: { blocked: upd.blocked ? 1 : 0, ok: upd.ok ? 1 : 0, code: upd.code || "none" },
          });
        }
        await V.query("rollback");
      }
    } catch (e) {
      out.push({ id: "AL02b", title: "VALIDATE CONSTRAINT", status: "fail", detail: `threw: ${e instanceof Error ? e.message : String(e)}` });
      await vConn.client?.query("rollback").catch(() => {});
    } finally {
      await vConn.client?.end().catch(() => {});
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
      out.push({ id: "AL02z", title: "cleanup: drop al_child2, delete probe user", status: "pass", detail: "dropped table, deleted user (best effort)" });
    }
    return out;
  },
};

function quote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

export default mod;
