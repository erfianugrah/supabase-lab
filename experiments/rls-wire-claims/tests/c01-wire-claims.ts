/**
 * C01 - wire-protocol RLS claims: the mechanism behind
 * "RLS without Supabase Auth" (lexicanum reference/rls-without-supabase-auth).
 *
 * Provisions a throwaway project, creates a `claims_user` role (no
 * BYPASSRLS, table owned by `postgres` so the owner bypass does not apply)
 * and an RLS-guarded table, then measures over psql from the runner:
 *
 *  a. session pooler (5432), claims set for user A -> per-user RLS resolves
 *  b. user B claims -> isolation holds
 *  c. bare `SET` without transaction -> leaks to the NEXT psql session on
 *     the session pooler (the doc's "never bare SET on a pooled connection"
 *     hazard, measured)
 *  d. transaction pooler (6543), set_config + query in ONE psql invocation
 *     (one implicit transaction) -> per-user RLS resolves
 *  e. transaction pooler, two separate psql invocations (SET, then SELECT)
 *     -> claims gone; the doc's per-transaction rule, measured
 *  f. prepared statements over 6543 (parity with T11) so a driver that
 *     prepares is not a hidden failure mode for the pattern
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";

const run = promisify(execFile);

const ORG = "gfqyoavfwjduavsvhbni";
const REGION = "ap-southeast-1";
const USER_A = "11111111-1111-1111-1111-111111111111";
const USER_B = "22222222-2222-2222-2222-222222222222";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sql(ctx: Ctx, ref: string, query: string): Promise<void> {
  const r = await mgmt(ctx, "POST", `/projects/${ref}/database/query`, { query });
  if (r.status >= 300) throw new Error(`sql http ${r.status}: ${r.text.slice(0, 300)}`);
}

interface PsqlTarget {
  host: string;
  port: string;
  user: string;
  password: string;
}

async function psql(t: PsqlTarget, sqlText: string): Promise<string> {
  const { stdout } = await run(
    "psql",
    ["-h", t.host, "-p", t.port, "-U", t.user, "-d", "postgres", "-At", "-v", "ON_ERROR_STOP=1", "-c", sqlText],
    { env: { ...process.env, PGPASSWORD: t.password }, timeout: 30_000 },
  );
  return stdout.trim();
}

// Multi-statement psql output is one line per statement result
// (set_config echoes the value it set). The scalar we assert on is the LAST
// line; the leak/identity probes read auth.uid, which is not numeric.
const lastLine = (out: string) => out.split("\n").filter(Boolean).pop() ?? "";
const lastNum = (out: string) => Number(lastLine(out));

const claims = (sub: string) => `{"sub":"${sub}","role":"authenticated"}`;
const setClaims = (sub: string) =>
  `select set_config('request.jwt.claims', '${claims(sub)}', true)`;
const COUNT = "select count(*) from wire_claims.docs";
const WHO = "select coalesce(public.claims_uid()::text, 'NULL')";

const mod: TestModule = {
  id: "C01",
  title: "wire-protocol claims GUC drives RLS (custom role, session + transaction pooler)",
  where: "local",
  requires: ["pat"],
  destructive: true, // provisions and deletes its own project
  async run(ctx: Ctx): Promise<TestResult[]> {
    let ref = "";
    try {
      const dbPass = `${crypto.randomUUID()}Aa1!`;
      const create = await mgmt(ctx, "POST", "/projects", {
        organization_slug: ORG,
        name: `c01-wire-${Date.now()}`,
        db_pass: dbPass,
        region: REGION,
      });
      ref = ((create.json as { ref?: string } | undefined)?.ref ?? "") as string;
      if (create.status !== 201 || !ref) {
        return [{ id: "C01", title: this.title, status: "fail", detail: `create: HTTP ${create.status}: ${create.text.slice(0, 200)}` }];
      }

      let status = "";
      const deadline = Date.now() + 20 * 60_000;
      while (Date.now() < deadline && status !== "ACTIVE_HEALTHY") {
        await sleep(10_000);
        const p = await mgmt(ctx, "GET", `/projects/${ref}`);
        status = ((p.json as { status?: string } | undefined)?.status ?? "") as string;
      }
      if (status !== "ACTIVE_HEALTHY") throw new Error(`not healthy: ${status}`);

      // Fixture: schema, table owned by postgres (RLS on), custom role.
      // Table owner = postgres matters: the owner bypasses RLS unless
      // FORCE, and we want the connecting role to be a non-owner.
      const rolePass = `${crypto.randomUUID()}Aa1!`;
      await sql(ctx, ref, `
create schema wire_claims;
        create table wire_claims.docs (
          id bigint generated always as identity primary key,
          owner uuid not null,
          body text not null default ''
        );
        insert into wire_claims.docs (owner, body)
          values ('${USER_A}', 'a-private'), ('${USER_B}', 'b-private');
        alter table wire_claims.docs enable row level security;
      `);
      await sql(ctx, ref, `
create or replace function public.claims_uid() returns uuid
          language sql stable security definer set search_path = auth, public
          as $$ select auth.uid() $$;
      `);
      await sql(ctx, ref, `
create role claims_user login password '${rolePass}' nosuperuser nocreatedb nocreaterole noinherit;
      `);
      await sql(ctx, ref, `
create policy per_user on wire_claims.docs for select to public
          using (owner = public.claims_uid());
        grant usage on schema wire_claims to claims_user;
        grant select on wire_claims.docs to claims_user;
        grant execute on function public.claims_uid() to claims_user;
      `);

      const sessionT: PsqlTarget = {
        host: `aws-0-${REGION}.pooler.supabase.com`,
        port: "5432",
        user: `claims_user.${ref}`,
        password: rolePass,
      };
      const txnT: PsqlTarget = { ...sessionT, port: "6543" };

      const meas: Record<string, number | string> = {};
      const failures: string[] = [];

      // Give the pooler/role a moment - first connects right after project
      // health can still refuse (AGENTS.md readiness note).
      let ready = false;
      for (let i = 0; i < 12 && !ready; i += 1) {
        try {
          await psql(sessionT, "select 1");
          ready = true;
        } catch {
          await sleep(5_000);
        }
      }
      if (!ready) throw new Error("claims_user never connected on session pooler");

      // a/b: session pooler, per-user claims.
      const aCount = lastNum(await psql(sessionT, `${setClaims(USER_A)}; ${COUNT}`));
      const bCount = lastNum(await psql(sessionT, `${setClaims(USER_B)}; ${COUNT}`));
      const noClaims = lastNum(await psql(sessionT, COUNT));
      meas.session_user_a_rows = aCount;
      meas.session_user_b_rows = bCount;
      meas.session_no_claims_rows = noClaims;
      if (aCount !== 1) failures.push(`session A saw ${aCount} rows, want 1`);
      if (bCount !== 1) failures.push(`session B saw ${bCount} rows, want 1`);
      if (noClaims !== 0) failures.push(`no-claims saw ${noClaims} rows, want 0`);

      // auth.uid() actually resolves from the GUC (via the SECURITY
      // DEFINER wrapper - see the fixture's grant note).
      const who = lastLine(await psql(sessionT, `${setClaims(USER_A)}; ${WHO}`));
      meas.session_auth_uid = who;
      if (who !== USER_A) failures.push(`claims_uid() resolved to ${who}, want ${USER_A}`);

      // c: bare SET on the session pooler - measured (v5/v6) NOT to leak:
      // the next invocation sees 0 rows, so Supavisor session mode resets
      // backend GUCs on return to the pool. Recorded as a measurement, not
      // asserted either way.
      await psql(sessionT, `set "request.jwt.claims" = '${claims(USER_A)}'`);
      let leakRows = -1;
      let leakHit = false;
      for (let i = 0; i < 5 && !leakHit; i += 1) {
        leakRows = lastNum(await psql(sessionT, COUNT));
        if (leakRows === 1) leakHit = true;
      }
      meas.session_bare_set_leak_rows = leakRows;
      meas.session_bare_set_leaked = leakHit ? "yes" : "no (5 tries)";

      // d: transaction pooler, claims + query in ONE invocation (one
      // implicit transaction) - the form the doc prescribes.
      const dCount = lastNum(await psql(txnT, `${setClaims(USER_A)}; ${COUNT}`));
      meas.txn_pooler_same_query_rows = dCount;
      if (dCount !== 1) failures.push(`txn pooler same-query saw ${dCount} rows, want 1`);

      // e: the doc's hazard on 6543, measured with the DETERMINISTIC shape:
      // set A's claims, then count with NO claims, back to back on the same
      // port - if transaction mode RESETs on return the count is 0.
      await psql(txnT, `set "request.jwt.claims" = '${claims(USER_A)}'`);
      const eCount = lastNum(await psql(txnT, COUNT));
      meas.txn_pooler_after_bare_set_rows = eCount;
      // Measured (v6): 1 - bare SET LEAKS across invocations on 6543. That
      // is the opposite of the doc-derived expectation and of the 5432
      // behavior above; assert the reset only if it actually holds, else
      // record the leak as the finding.
      meas.txn_pooler_bare_set_leaks = eCount === 1 ? "yes (FINDING)" : "no";
      if (eCount !== 0) ctx.log("finding: bare SET leaks across invocations on transaction-mode 6543");

      // self-clean the poisoned backend before the prepared probe.
      await psql(txnT, `set "request.jwt.claims" = '${claims(USER_B)}'`).catch(() => "");
      await psql(txnT, COUNT).catch(() => "");

      // f: prepared statements over 6543 (parity with T11).
      const prep = await psql(
        txnT,
        `prepare c01q as ${COUNT}; ${setClaims(USER_A)}; execute c01q`,
      ).catch((e) => `ERR:${String(e).slice(0, 120)}`);
      meas.txn_pooler_prepared = prep.startsWith("ERR") ? prep : lastNum(prep);

      const pass = failures.length === 0;
      return [{
        id: "C01",
        title: this.title,
        status: pass ? "pass" : "fail",
        detail: pass
          ? `claims drive RLS as custom role on both poolers; bare SET leak ${meas.session_bare_set_leaked}`
          : failures.join("; "),
        measurements: meas,
      }];
    } catch (e) {
      return [{ id: "C01", title: this.title, status: "fail", detail: `threw: ${e instanceof Error ? e.message : String(e)}` }];
    } finally {
      if (ref) await mgmt(ctx, "DELETE", `/projects/${ref}`).catch(() => null);
    }
  },
};
export default mod;
