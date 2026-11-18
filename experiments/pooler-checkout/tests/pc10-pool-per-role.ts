/**
 * PC10 - does the shared Supavisor pooler keep one pool per role?
 * (work-supabase-lab#331)
 *
 * PC07 set `default_pool_size` and measured one role. A pool per role would
 * let N login roles hold N x pool_size backends; nothing in the lab had
 * measured whether the shared pooler keeps one.
 *
 *   PC10a  PATCH default_pool_size 5, read back
 *   PC10b  three new login roles plus postgres; each sends 8 transaction-mode
 *          clients running pg_sleep(25) at once through Supavisor 6543.
 *          Backends running the sleep at +8 s, per usename, read through the
 *          Management API, and how many clients per role errored
 *
 * Shared pool: the total stays near 5. Pool per role: each role near 5,
 * about 20 in total. Runs on the module's shared project (PC09 deletes it).
 */
import { mgmt } from "../../../harness/src/mgmt";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { holdPool, sharedTxn } from "../lib/pg";
import { acquireProject, type PoolerEntry, sleep, stallGuard } from "../lib/project";

const POOL = 5;
const PER_ROLE = 8;
const HOLD_S = 25;
const ROLES = ["pc10_r1", "pc10_r2", "pc10_r3"];

const mod: TestModule = {
  id: "PC10",
  title: "Shared pooler: one pool per role or one per project",
  where: "local",
  requires: ["pat"],
  destructive: true,
  timeoutMs: 20 * 60_000,
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!ctx.orgs.pro) return [{ id: "PC10", title: this.title, status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    const out: TestResult[] = [];
    const guard = stallGuard("PC10");
    try {
      const p = await acquireProject(ctx);
      const q = (query: string) => mgmt(ctx, "POST", `/projects/${p.ref}/database/query`, { query }, 60_000);
      const path = `/projects/${p.ref}/config/database/pooler`;
      const patch = await mgmt(ctx, "PATCH", path, { default_pool_size: POOL });
      await sleep(20_000);
      const back = await mgmt(ctx, "GET", path);
      const entry = (Array.isArray(back.json) ? (back.json as PoolerEntry[]) : []).find((e) => e.database_type === "PRIMARY");
      out.push({
        id: "PC10a",
        title: `PATCH default_pool_size ${POOL}`,
        status: patch.status < 300 && entry?.default_pool_size === POOL ? "info" : "fail",
        detail: `PATCH HTTP ${patch.status}; read back default_pool_size ${entry?.default_pool_size ?? "null"}, max_client_conn ${entry?.max_client_conn ?? "null"}`,
        measurements: { patch_status: patch.status, default_pool_size: entry?.default_pool_size ?? "null", max_client_conn: entry?.max_client_conn ?? "null" },
      });

      // Roles share the project password so the client helpers can be reused;
      // they are dropped with the project.
      const pwq = p.password.replaceAll("'", "''");
      const mk = await q(ROLES.map((r) => `create role ${r} login password '${pwq}'; grant usage on schema public to ${r};`).join("\n"));
      if (mk.status >= 300) throw new Error(`create roles: ${mk.text.slice(0, 200)}`);
      await sleep(5_000);

      const base = sharedTxn(p);
      const users = [{ role: "postgres", user: base.user }, ...ROLES.map((r) => ({ role: r, user: `${r}.${p.ref}` }))];
      const crowds = users.map((u) => ({ role: u.role, h: holdPool({ ...base, user: u.user }, p.password, PER_ROLE, HOLD_S) }));
      await sleep(8_000);
      const act = await q(`select usename, count(*)::int as n from pg_stat_activity where query = 'select pg_sleep(${HOLD_S})' and state = 'active' group by 1 order by 1`);
      const rows = (Array.isArray(act.json) ? act.json : []) as { usename: string; n: number }[];
      const byRole = new Map(rows.map((r) => [r.usename, r.n]));
      const total = rows.reduce((a, r) => a + r.n, 0);
      const results = await Promise.all(crowds.map(async (c) => ({ role: c.role, res: await c.h.done })));
      const errs = results.map((r) => {
        const bad = r.res.filter((o) => !o.ok);
        return { role: r.role, errored: bad.length, kinds: [...new Set(bad.map((o) => `${o.code} ${o.error}`.slice(0, 70)))].join(" | ") };
      });
      out.push({
        id: "PC10b",
        title: `four roles x ${PER_ROLE} transaction-mode pg_sleep(${HOLD_S}) clients, pool size ${POOL}`,
        status: "info",
        detail: `Backends running the sleep at +8 s, by role: ${users.map((u) => `${u.role} ${byRole.get(u.role) ?? 0}`).join(", ")}; total ${total} against default_pool_size ${POOL}. Clients errored per role: ${errs.map((e) => `${e.role} ${e.errored} of ${PER_ROLE}${e.kinds ? ` (${e.kinds})` : ""}`).join("; ")}.`,
        measurements: {
          pool_size: POOL,
          clients_per_role: PER_ROLE,
          backends_total: total,
          ...Object.fromEntries(users.map((u) => [`backends_${u.role}`, byRole.get(u.role) ?? 0])),
          ...Object.fromEntries(errs.map((e) => [`errored_${e.role}`, e.errored])),
        },
      });
    } catch (e) {
      out.push({ id: "PC10x", title: "PC10 aborted", status: "fail", detail: (e as Error).message.slice(0, 300) });
    }
    out.push(guard.result());
    return out;
  },
};
export default mod;
