/**
 * DD05 - are the lab fixtures' explicit Data API GRANTs load-bearing?
 *
 * work-supabase-lab#128 added explicit GRANTs to the setup SQL of older
 * experiments ahead of the 2026-10-30 default. Every re-run on 2026-10-13 hit a
 * project that still carried the legacy `pg_default_acl`, so each would have
 * passed with the GRANTs removed (#179). This module removes that confound: it
 * applies DD01c's opt-in `ALTER DEFAULT PRIVILEGES ... REVOKE` first, then runs
 * each fixture with its GRANT left out and again with it.
 *
 *   DD05a  pg_default_acl for `public` before and after the revoke.
 *   DD05b  edge-resilience `make seed` SQL for `w_probe`: publishable-key read
 *          without the seed's GRANT, then with it.
 *   DD05c  usage-metering M05's store table `metering_hourly`: insert with the
 *          service_role and sb_secret_ keys without M05's GRANT, then with it.
 *   DD05d-f  edge-resilience W12 itself (realtime join + anon REST insert into
 *          a `serial` table), run three times on the same table, grants only
 *          ever added: no GRANT, table GRANT only, table + sequence GRANT
 *          (the committed fixture).
 *
 * Expected if the GRANTs are needed: 42501 with the "Grant the required
 * privileges" hint wherever a table GRANT is left out, success once it is
 * issued. DD05e is recorded, not judged: the revoke takes USAGE and SELECT on
 * sequences but leaves UPDATE, and nextval() needs USAGE or UPDATE, so the
 * first run (2026-10-23) inserted without the sequence GRANT.
 * The fixture SQL is copied from the two sources named above as of
 * 2026-10-23; W12 is imported, so its own setup SQL is the one measured.
 *
 * Run it as `ONLY=DD05,DD99`: in a battery after DD01 the shared project is
 * already revoked and DD05a's "before" reading shows that, not the default.
 * Deletes nothing itself; DD99 deletes the project.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import w12 from "../../edge-resilience/tests/w12-realtime-probe.js";
import type { W12Grants } from "../../edge-resilience/tests/w12-realtime-probe.js";
import { ACL_SQL, REVOKE_SQL } from "./dd01-default-grants.js";
import { skipWithoutPro, brief, currentProject, dataApi, ensureProject, pollApi, sql, type RestResult } from "../lib/project.js";

// experiments/edge-resilience/Makefile `seed`, split at its GRANT.
const SEED_SQL = "create table if not exists public.w_probe(id int primary key); insert into public.w_probe values (1) on conflict do nothing;";
const SEED_GRANT = "grant select, insert, update, delete on table public.w_probe to anon, authenticated, service_role;";
// experiments/usage-metering/tests/m05-control-plane-store.ts, the statement and its GRANT.
const M05_SQL =
  "create table if not exists public.metering_hourly (ts timestamptz default now(), project_ref text, name text, status text, sku text, monthly_usd numeric)";
const M05_GRANT = "grant select, insert, update, delete on table public.metering_hourly to anon, authenticated, service_role";
const M05_ROW = { project_ref: "dd05", name: "dd05", status: "ACTIVE_HEALTHY", sku: "none(micro)", monthly_usd: 1 };

type Row = { role: string; objtype: string; acl: string };
const aclFor = (rows: Row[], objtype: string) => rows.find((r) => r.role === "postgres" && r.objtype === objtype)?.acl ?? "absent";
const privsOf = (acl: string, who: string) => acl.match(new RegExp(`[{,]${who}=([a-zA-Z*]*)/`))?.[1] ?? "none";
/** True when `who` holds none of the privilege letters the revoke targets. */
const lacks = (acl: string, who: string, letters: string) => ![...letters].some((l) => privsOf(acl, who).includes(l));
const HINT = /Grant the required privileges/i;

function errShape(r: RestResult): { code: string; hint: string } {
  const o = (r.json ?? {}) as { code?: string; hint?: string };
  return { code: o.code ?? "-", hint: o.hint ?? "-" };
}

const mod: TestModule = {
  id: "DD05",
  title: "Lab fixture GRANTs under the revoked default privileges",
  where: "local",
  requires: ["pat", "org"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const results: TestResult[] = [];
    const skip = skipWithoutPro(ctx, "DD05");
    if (skip) return skip;
    let p;
    try {
      p = await ensureProject(ctx);
    } catch (e) {
      return [{ id: "DD05", title: "DD05", status: "fail", detail: `provision: ${e instanceof Error ? e.message : String(e)}` }];
    }
    const red = (s: string) => brief(currentProject(), s, 300);
    const relacl = async (obj: string) =>
      String((await sql(ctx, p.ref, `select relacl::text as acl from pg_class where oid = '${obj}'::regclass`)).rows?.[0]?.acl ?? "absent");
    try {
      // ---- DD05a ----
      const before = ((await sql(ctx, p.ref, ACL_SQL)).rows ?? []) as unknown as Row[];
      const rev = await sql(ctx, p.ref, REVOKE_SQL);
      const after = ((await sql(ctx, p.ref, ACL_SQL)).rows ?? []) as unknown as Row[];
      // Tables: SELECT/INSERT/UPDATE/DELETE = r a w d. Sequences: USAGE/SELECT = U r.
      const revoked = lacks(aclFor(after, "r"), "anon", "rawd") && lacks(aclFor(after, "S"), "anon", "Ur");
      results.push({
        id: "DD05a",
        title: "DD05a: default privileges for public, before and after the opt-in revoke",
        status: rev.status < 300 && revoked ? "pass" : "fail",
        detail: `revoke HTTP ${rev.status}; tables acl after=${aclFor(after, "r")}`,
        measurements: {
          tables_acl_before: aclFor(before, "r"),
          sequences_acl_before: aclFor(before, "S"),
          revoke_status: rev.status,
          tables_acl_after: aclFor(after, "r"),
          sequences_acl_after: aclFor(after, "S"),
          anon_tables_privs_after: privsOf(aclFor(after, "r"), "anon"),
          anon_sequences_privs_after: privsOf(aclFor(after, "S"), "anon"),
        },
      });

      // ---- DD05b: edge-resilience seed, w_probe ----
      const s1 = await sql(ctx, p.ref, SEED_SQL);
      const read = () => dataApi(p.host, "/rest/v1/w_probe?select=id", p.keys.publishable);
      const b0 = await pollApi(read, (r) => r.status !== 404);
      const aclNo = await relacl("public.w_probe");
      const g1 = await sql(ctx, p.ref, SEED_GRANT);
      const b1 = await pollApi(read, (r) => r.status === 200, 30_000);
      const e0 = errShape(b0.last);
      results.push({
        id: "DD05b",
        title: "DD05b: edge-resilience seed (w_probe), publishable read without and with the seed's GRANT",
        status: e0.code === "42501" && HINT.test(e0.hint) && b1.ok ? "pass" : "fail",
        detail: `no grant -> ${b0.last.status} ${red(b0.last.body)}; with grant -> ${b1.last.status} ${red(b1.last.body)}`,
        measurements: {
          seed_status: s1.status,
          relacl_without_grant: aclNo,
          without_status: b0.last.status,
          without_code: e0.code,
          without_hint: e0.hint,
          grant_status: g1.status,
          relacl_with_grant: await relacl("public.w_probe"),
          with_status: b1.last.status,
          with_seconds_to_serve: b1.s,
        },
      });

      // ---- DD05c: usage-metering M05 store table, service_role writes ----
      const s2 = await sql(ctx, p.ref, M05_SQL);
      const ins = (key: string) => dataApi(p.host, "/rest/v1/metering_hourly", key, { method: "POST", body: M05_ROW });
      // Wait out the schema cache on a read first, so a 404 is not mistaken for the answer.
      await pollApi(() => dataApi(p.host, "/rest/v1/metering_hourly?select=sku", p.keys.secret), (r) => r.status !== 404);
      const cSvc0 = await ins(p.keys.service);
      const cSec0 = await ins(p.keys.secret);
      const g2 = await sql(ctx, p.ref, M05_GRANT);
      const cSec1 = await pollApi(() => ins(p.keys.secret), (r) => r.status === 201, 30_000);
      const cSvc1 = await ins(p.keys.service);
      const sv = errShape(cSvc0);
      const se = errShape(cSec0);
      results.push({
        id: "DD05c",
        title: "DD05c: usage-metering M05 store table, service_role insert without and with M05's GRANT",
        status: sv.code === "42501" && se.code === "42501" && HINT.test(se.hint) && cSec1.ok && cSvc1.status === 201 ? "pass" : "fail",
        detail: `no grant -> service_role ${cSvc0.status}, sb_secret ${cSec0.status} ${red(cSec0.body)}; with grant -> ${cSec1.last.status}, ${cSvc1.status}`,
        measurements: {
          create_status: s2.status,
          service_role_without_status: cSvc0.status,
          service_role_without_code: sv.code,
          sb_secret_without_status: cSec0.status,
          sb_secret_without_code: se.code,
          sb_secret_without_hint: se.hint,
          grant_status: g2.status,
          sb_secret_with_status: cSec1.last.status,
          service_role_with_status: cSvc1.status,
        },
      });

      // ---- DD05d-f: W12 itself, grants only ever added ----
      const wctx: Ctx = { ...ctx, ref: p.ref, apiHost: p.host, anonKey: p.keys.publishable };
      // expect: "pass" (W12 passes), "42501" (W12 fails on the GRANT), null (recorded only).
      const variants: [string, W12Grants, "pass" | "42501" | null][] = [
        ["DD05d", "none", "42501"],
        ["DD05e", "table", null],
        ["DD05f", "all", "pass"],
      ];
      for (const [id, grants, expect] of variants) {
        const r = await w12.run(wctx, grants);
        const detail = red(r.detail ?? "");
        const denied = /42501/.test(detail) && HINT.test(detail);
        const asExpected = expect === "pass" ? r.status === "pass" : r.status === "fail" && denied;
        results.push({
          id,
          title: `${id}: edge-resilience W12 with grants=${grants} (${expect ? `expect ${expect}` : "recorded"})`,
          status: expect === null ? "info" : asExpected ? "pass" : "fail",
          detail: `W12 ${r.status}: ${detail}`,
          measurements: {
            grants,
            w12_status: r.status,
            insert_denied_42501: denied ? 1 : 0,
            table_relacl: await relacl("public.probe_canary"),
            sequence_relacl: await relacl("public.probe_canary_id_seq"),
            ...Object.fromEntries(Object.entries(r.measurements ?? {}).map(([k, v]) => [k, typeof v === "string" ? red(v) : v])),
          },
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({ id: "DD05", title: "DD05", status: "fail", detail: `test threw: ${red(msg)}` });
    }
    return results;
  },
};
export default mod;
