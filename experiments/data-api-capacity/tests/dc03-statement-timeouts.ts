/**
 * DC03 - Which statement_timeout a Data API request runs under, per role,
 * whether a function-level `set statement_timeout` lifts it for that call,
 * when an `alter role ... set statement_timeout` reaches PostgREST, and
 * whether a request that fails with a 5xx is retried (executed twice) by the
 * layer that retries PGRST003 (DC02b).
 *
 * Source claims: Supabase timeouts guide - anon 3 s, authenticated 8 s, set
 * per role with ALTER ROLE; PostgREST docs - role settings are applied per
 * request and re-read on a config reload. Competing hypothesis for (b):
 * Postgres starts the statement timer before the function's SET applies, so
 * a function-level timeout cannot extend the calling statement.
 *
 * Shared project (on Large after DC01). Keys and roles per row: anon = legacy
 * anon key; user = anon key + a signed-in confirmed user's access token
 * (role authenticated); service = legacy service_role key. Times are client
 * wall-clock from Singapore, so they include the round trip.
 *
 *   DC03a  rolconfig of anon, authenticated, service_role, authenticator; then
 *          dc_sleep(s) (no function setting) as anon (5 s), user (10 s) and
 *          service (10 s), twice each: status, code, ms.
 *   DC03b  dc_sleep_long(12) (function `set statement_timeout = '30s'`) as
 *          anon, user and service, twice each.
 *   DC03c  alter role authenticated set statement_timeout = '15s', then user
 *          dc_sleep(10) twice at each step: right after the ALTER, after
 *          `notify pgrst, 'reload config'`, after `notify pgrst, 'reload
 *          schema'`; then back to 8 s plus a config reload, one call.
 *   DC03d  user dc_tick_sleep(10) twice (nextval, then a sleep past 8 s):
 *          status, executions counted by the sequence, PostgREST access-log
 *          lines per request (User-Agent tagged).
 *
 * Not settled by this module: Storage, Auth or GraphQL paths; per-request
 * `Prefer` handling; timeouts set with `alter database`; a function called
 * by another function.
 *
 * DESTRUCTIVE: alters the `authenticated` role's statement_timeout and
 * restores 8 s; DC99 deletes the project.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { ensureProject, errText, linesForUa, redact, rpc, seqValue, skipWithoutPro, sleep, sql, untilHealthy, type DcProject, type RpcResult } from "../lib/dc.js";

type Who = "anon" | "user" | "service";

function call(p: DcProject, who: Who, fn: string, s: number, ua?: string): Promise<RpcResult> {
  const key = who === "service" ? p.keys.service : p.keys.anon;
  const bearer = who === "user" ? p.userJwt : key;
  return rpc(p.host, fn, { s }, key, bearer, 90_000, ua);
}

const fmt = (r: RpcResult) =>
  `${r.status}${r.code ? ` ${r.code}` : ""} @${(r.ms / 1000).toFixed(1)}s${r.status === 0 ? ` (${redact(r.message).slice(0, 80)})` : ""}`;

const mod: TestModule = {
  id: "DC03",
  title: "Statement timeouts through the Data API: role defaults, function settings, ALTER ROLE, retries on 5xx",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const skip = skipWithoutPro(ctx, "DC03");
    if (skip) return skip;
    const out: TestResult[] = [];
    try {
      const p = await ensureProject(ctx);
      const readyS = await untilHealthy(p, 10, 600);
      if (readyS < 0) throw new Error("Data API not answering 10 consecutive pings within 600 s");

      // DC03a
      const rc = await sql(ctx, p.ref, "select rolname, coalesce(rolconfig::text, 'null') as cfg from pg_roles where rolname in ('anon','authenticated','service_role','authenticator') order by 1");
      const cfg = Object.fromEntries((rc.rows ?? []).map((r) => [`rolconfig_${r.rolname}`, String(r.cfg)]));
      const a: Record<string, number | string> = { ...cfg };
      const adet: string[] = [];
      for (const [who, s] of [["anon", 5], ["user", 10], ["service", 10]] as const) {
        const rs = [await call(p, who, "dc_sleep", s), await call(p, who, "dc_sleep", s)];
        rs.forEach((r, i) => {
          a[`${who}_${i + 1}_status`] = r.status;
          a[`${who}_${i + 1}_code`] = r.code || "none";
          a[`${who}_${i + 1}_ms`] = r.ms;
        });
        adet.push(`${who} sleep ${s}: ${rs.map(fmt).join(", ")}`);
      }
      out.push({
        id: "DC03a",
        title: "Per-role statement_timeout through the Data API (no function setting)",
        status: "info",
        detail: adet.join("; "),
        measurements: a,
        evidence: redact(JSON.stringify(cfg)),
      });

      // DC03b
      const b: Record<string, number | string> = {};
      const bdet: string[] = [];
      for (const who of ["anon", "user", "service"] as const) {
        const rs = [await call(p, who, "dc_sleep_long", 12), await call(p, who, "dc_sleep_long", 12)];
        rs.forEach((r, i) => {
          b[`${who}_${i + 1}_status`] = r.status;
          b[`${who}_${i + 1}_code`] = r.code || "none";
          b[`${who}_${i + 1}_ms`] = r.ms;
        });
        bdet.push(`${who}: ${rs.map(fmt).join(", ")}`);
      }
      out.push({
        id: "DC03b",
        title: "Function-level set statement_timeout = '30s', 12 s sleep",
        status: "info",
        detail: bdet.join("; "),
        measurements: b,
      });

      // DC03c
      const c: Record<string, number | string> = {};
      const cdet: string[] = [];
      const step = async (label: string, n: number) => {
        const rs: RpcResult[] = [];
        for (let i = 0; i < n; i++) rs.push(await call(p, "user", "dc_sleep", 10));
        rs.forEach((r, i) => {
          c[`${label}_${i + 1}_status`] = r.status;
          c[`${label}_${i + 1}_code`] = r.code || "none";
          c[`${label}_${i + 1}_ms`] = r.ms;
        });
        cdet.push(`${label}: ${rs.map(fmt).join(", ")}`);
      };
      const alter = await sql(ctx, p.ref, "alter role authenticated set statement_timeout = '15s'");
      c.alter_status = alter.status;
      await step("after_alter", 2);
      await sql(ctx, p.ref, "notify pgrst, 'reload config'");
      await sleep(5_000);
      await step("after_reload_config", 2);
      await sql(ctx, p.ref, "notify pgrst, 'reload schema'");
      await sleep(5_000);
      await step("after_reload_schema", 2);
      await sql(ctx, p.ref, "alter role authenticated set statement_timeout = '8s'");
      await sql(ctx, p.ref, "notify pgrst, 'reload config'");
      await sleep(5_000);
      await step("restored_8s", 1);
      out.push({
        id: "DC03c",
        title: "alter role authenticated set statement_timeout = '15s': when the Data API applies it (user, 10 s sleep)",
        status: "info",
        detail: cdet.join("; "),
        measurements: c,
      });

      // DC03d
      const d: Record<string, number | string> = {};
      const ddet: string[] = [];
      for (let i = 1; i <= 2; i++) {
        const before = await seqValue(ctx, p.ref);
        const ua = `pvlab-dc-dc03d-${Date.now().toString(36)}-${i}`;
        const r = await call(p, "user", "dc_tick_sleep", 10, ua);
        await sleep(3_000);
        const after = await seqValue(ctx, p.ref);
        const l = await linesForUa(ctx, p.ref, ua);
        d[`req${i}_status`] = r.status;
        d[`req${i}_code`] = r.code || "none";
        d[`req${i}_ms`] = r.ms;
        d[`req${i}_executions`] = after - before;
        d[`req${i}_postgrest_lines`] = l.total;
        d[`req${i}_postgrest_lines_by_status`] = l.byStatus;
        ddet.push(`request ${i}: ${fmt(r)}, executed ${after - before}x, ${l.total} PostgREST lines (${l.byStatus})`);
      }
      out.push({
        id: "DC03d",
        title: "A request that fails 500 (statement timeout after a side effect): executions and attempts",
        status: d.req1_executions === 1 && d.req2_executions === 1 ? "pass" : "fail",
        detail: ddet.join("; "),
        measurements: d,
      });
    } catch (e) {
      out.push({ id: "DC03", title: this.title, status: "fail", detail: `threw: ${redact(errText(e))}` });
    }
    return out;
  },
};
export default mod;
