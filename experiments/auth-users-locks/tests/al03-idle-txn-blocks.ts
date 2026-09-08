/**
 * AL03 - an idle-in-transaction session blocks a migration-shaped ALTER. This
 * is the incident shape: a session holding a weak read lock (ACCESS SHARE),
 * left idle in a transaction, keeps a schema change from taking the
 * ACCESS EXCLUSIVE lock it needs, and every statement queued behind it waits.
 *
 * auth.users DDL is platform-restricted, so the ACCESS EXCLUSIVE change is
 * modelled on a PUBLIC table. The lock conflict measured is the general one
 * (ACCESS SHARE blocks ACCESS EXCLUSIVE) that a GoTrue migration on auth.users
 * hits behind an abandoned pg_dump COPY - the table differs, the lock
 * arithmetic does not.
 *
 *   AL03a  session A: BEGIN; SELECT from public.al_mig; then sits idle in
 *          transaction, holding ACCESS SHARE. Session B: ALTER TABLE ADD COLUMN
 *          (ACCESS EXCLUSIVE) under lock_timeout='2s'. PASS if B is blocked
 *          (55P03) while A holds the read lock.
 *   AL03b  A commits; B's ALTER now succeeds. PASS if it goes through. This is
 *          the control that proves AL03a measured the block, not a broken ALTER.
 *
 * Not settled by this module: the same test against auth.users itself (the
 * platform forbids the DDL); and the unbounded wait a real GoTrue migration
 * takes, which runs with no lock_timeout - here a lock_timeout is set on
 * purpose so the run cannot hang.
 *
 * DESTRUCTIVE: creates public.al_mig, drops it in finally. Self-skips without a
 * pooler host.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { sql } from "../../../harness/src/platform";
import { connect, tryUnderLockTimeout } from "../lib/locks";

const T = "public.al_mig";

const mod: TestModule = {
  id: "AL03",
  title: "An idle-in-transaction reader blocks a migration-shaped ALTER",
  where: "local",
  requires: ["pat", "pooler"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!ctx.ref) return [{ id: "AL03", title: this.title, status: "skip", detail: "no project ref (PVLAB_REF)" }];
    const out: TestResult[] = [];
    await sql(ctx, `create table if not exists ${T} (id int primary key)`);
    await sql(ctx, `insert into ${T} values (1) on conflict do nothing`);

    const a = await connect(ctx);
    try {
      if (!a.client) return [{ id: "AL03", title: this.title, status: "skip", detail: a.err ?? "no pooler connection" }];
      const A = a.client;

      // A holds ACCESS SHARE and goes idle in transaction (no commit).
      await A.query("begin");
      await A.query(`select id from ${T} limit 1`);

      // B: the migration-shaped change, blocked behind A.
      const blocked = await tryUnderLockTimeout(ctx, `alter table ${T} add column added_${Date.now() % 100000} int`, "2s");
      out.push({
        id: "AL03a",
        title: "ADD COLUMN is blocked while an idle-in-transaction reader holds ACCESS SHARE",
        status: blocked.blocked ? "pass" : "fail",
        detail: blocked.blocked
          ? `ALTER blocked as expected: ${blocked.code} ${blocked.error}`
          : blocked.ok
            ? "ALTER was NOT blocked - the idle reader did not hold a conflicting lock"
            : `ALTER errored (not the lock signature): ${blocked.code} ${blocked.error}`,
        measurements: { blocked: blocked.blocked ? 1 : 0, code: blocked.code || "none" },
      });

      // A commits; the same change now goes through (control).
      await A.query("commit");
      const after = await tryUnderLockTimeout(ctx, `alter table ${T} add column added_ok_${Date.now() % 100000} int`, "5s");
      out.push({
        id: "AL03b",
        title: "control: ADD COLUMN succeeds once the idle reader commits",
        status: after.ok ? "pass" : "fail",
        detail: after.ok ? "ALTER succeeded after the reader released ACCESS SHARE" : `ALTER still blocked/failed: ${after.code} ${after.error}`,
        measurements: { ok: after.ok ? 1 : 0, code: after.code || "none" },
      });
    } catch (e) {
      out.push({ id: "AL03", title: this.title, status: "fail", detail: `threw: ${e instanceof Error ? e.message : String(e)}` });
      await a.client?.query("rollback").catch(() => {});
    } finally {
      await a.client?.end().catch(() => {});
      await sql(ctx, `drop table if exists ${T}`);
      out.push({ id: "AL03z", title: "cleanup: drop al_mig", status: "pass", detail: "dropped table" });
    }
    return out;
  },
};

export default mod;
