/**
 * C02 - GoTrue-issued JWT claims drive RLS over the wire, with no PostgREST
 * in the path.
 *
 * The doc's middle option: keep Supabase Auth (user management, minting) but
 * drop the Data API. The client verifies the GoTrue JWT itself and sets
 * request.jwt.claims from its claims; RLS resolves per-user exactly as it
 * would have through PostgREST.
 *
 * Measured:
 *  a. create a user via the Auth admin API, sign in via password grant
 *  b. set claims from the token's sub over the session pooler -> that
 *     user's row only
 *  c. tamper the sub (a different valid uuid) -> RLS enforces the TAMPERED
 *     identity. This is the doc's "GUC is unprivileged" hazard made concrete:
 *     the database cannot tell a verified JWT from a forged claims string.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";

const run = promisify(execFile);

let ORG = ""; // from PVLAB_ORG_PRO via ctx.orgs.pro; set in run()
const REGION = "ap-southeast-1";
const OTHER_UUID = "33333333-3333-3333-3333-333333333333";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sql(ctx: Ctx, ref: string, query: string): Promise<void> {
  const r = await mgmt(ctx, "POST", `/projects/${ref}/database/query`, { query });
  if (r.status >= 300) throw new Error(`sql http ${r.status}: ${r.text.slice(0, 300)}`);
}

async function psql(host: string, user: string, password: string, sqlText: string): Promise<string> {
  const { stdout } = await run(
    "psql",
    ["-h", host, "-p", "5432", "-U", user, "-d", "postgres", "-At", "-v", "ON_ERROR_STOP=1", "-c", sqlText],
    { env: { ...process.env, PGPASSWORD: password }, timeout: 30_000 },
  );
  return stdout.trim();
}

// Multi-statement psql output is one line per statement result; the scalar
// asserted on is the LAST line (set_config echoes the value it set first).
const lastNum = (out: string) => Number(out.split("\n").filter(Boolean).pop() ?? "");

const mod: TestModule = {
  id: "C02",
  title: "GoTrue JWT claims drive RLS over the wire (no PostgREST)",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    ORG = ctx.orgs.pro ?? "";
    if (!ORG) return [{ id: "C02", title: this.title, status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    let ref = "";
    try {
      const dbPass = `${crypto.randomUUID()}Aa1!`;
      const create = await mgmt(ctx, "POST", "/projects", {
        organization_slug: ORG,
        name: `c02-gotrue-${Date.now()}`,
        db_pass: dbPass,
        region: REGION,
      });
      ref = ((create.json as { ref?: string } | undefined)?.ref ?? "") as string;
      if (create.status !== 201 || !ref) {
        return [{ id: "C02", title: this.title, status: "fail", detail: `create: HTTP ${create.status}: ${create.text.slice(0, 200)}` }];
      }

      let status = "";
      const deadline = Date.now() + 20 * 60_000;
      while (Date.now() < deadline && status !== "ACTIVE_HEALTHY") {
        await sleep(10_000);
        const p = await mgmt(ctx, "GET", `/projects/${ref}`);
        status = ((p.json as { status?: string } | undefined)?.status ?? "") as string;
      }
      if (status !== "ACTIVE_HEALTHY") throw new Error(`not healthy: ${status}`);

      // Service key for the Auth admin API (legacy service_role JWT).
      let serviceKey = "";
      for (let i = 0; i < 12 && !serviceKey; i += 1) {
        const keys = await mgmt(ctx, "GET", `/projects/${ref}/api-keys?reveal=true`);
        const arr = (keys.json as { name?: string; api_key?: string }[] | undefined) ?? [];
        serviceKey = arr.find((k) => k.name === "service_role")?.api_key ?? "";
        if (!serviceKey) await sleep(5_000);
      }
      if (!serviceKey) throw new Error("no service_role key");

      const apiBase = `https://${ref}.supabase.co`;

      // Fixture: a docs table with RLS; admin-created user; that user's row.
      const email = `c02-${Date.now()}@example.com`;
      const password = `${crypto.randomUUID()}Aa1!`;
      // First admin write can 500 for ~10s past ACTIVE_HEALTHY (AGENTS.md).
      let userId = "";
      let lastCreate = "";
      for (let i = 0; i < 12 && !userId; i += 1) {
        const res = await fetch(`${apiBase}/auth/v1/admin/users`, {
          method: "POST",
          headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ email, password, email_confirm: true }),
        });
        const text = await res.text();
        lastCreate = `HTTP ${res.status}: ${text.slice(0, 200)}`;
        if (res.status < 300) {
          try {
            userId = (JSON.parse(text) as { id?: string }).id ?? "";
          } catch {
            userId = "";
          }
        }
        if (!userId) await sleep(5_000);
      }
      if (!userId) throw new Error(`admin create never succeeded: ${lastCreate}`);

      // Second user (for the isolation control) + rows for both.
      const email2 = `c02b-${Date.now()}@example.com`;
      let userId2 = "";
      {
        const res = await fetch(`${apiBase}/auth/v1/admin/users`, {
          method: "POST",
          headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ email: email2, password, email_confirm: true }),
        });
        if (res.status < 300) {
          const body = (await res.json()) as { id?: string };
          userId2 = body.id ?? "";
        }
      }
      if (!userId2) throw new Error("second user create failed");

      const rolePass = `${crypto.randomUUID()}Aa1!`;
      await sql(ctx, ref, `
create schema wire_claims;
        create table wire_claims.docs (
          id bigint generated always as identity primary key,
          owner uuid not null,
          body text not null default ''
        );
        insert into wire_claims.docs (owner, body)
          values ('${userId}', 'user1-private'), ('${userId2}', 'user2-private');
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

      // Sign in user 1 via password grant - this is the real GoTrue token.
      const tokenRes = await fetch(`${apiBase}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: { apikey: serviceKey, "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const tokenBody = (await tokenRes.json()) as { access_token?: string };
      if (!tokenBody.access_token) throw new Error(`token grant failed: HTTP ${tokenRes.status}`);
      const payload = JSON.parse(
        Buffer.from(tokenBody.access_token.split(".")[1] ?? "", "base64url").toString(),
      ) as { sub?: string; role?: string };
      if (payload.sub !== userId) throw new Error(`token sub ${payload.sub} != created user ${userId}`);

      const host = `aws-0-${REGION}.pooler.supabase.com`;
      const user = `claims_user.${ref}`;
      const meas: Record<string, number | string> = {};
      const failures: string[] = [];

      let ready = false;
      for (let i = 0; i < 12 && !ready; i += 1) {
        try {
          await psql(host, user, rolePass, "select 1");
          ready = true;
        } catch {
          await sleep(5_000);
        }
      }
      if (!ready) throw new Error("claims_user never connected");

      const claimsFrom = (sub: string, role: string) =>
        `select set_config('request.jwt.claims', '${JSON.stringify({ sub, role })}', true)`;
      const COUNT = "select count(*) from wire_claims.docs";

      // a: real GoTrue sub over the wire.
      const realCount = lastNum(await psql(host, user, rolePass, `${claimsFrom(userId, payload.role ?? "authenticated")}; ${COUNT}`));
      meas.real_gotrue_claims_rows = realCount;
      if (realCount !== 1) failures.push(`real claims saw ${realCount} rows, want 1`);

      // b: other user's sub -> their row only (isolation, not leak).
      const otherCount = lastNum(await psql(host, user, rolePass, `${claimsFrom(userId2, "authenticated")}; ${COUNT}`));
      meas.other_user_claims_rows = otherCount;
      if (otherCount !== 1) failures.push(`other user claims saw ${otherCount} rows, want 1`);

      // c: tampered sub (a uuid with NO rows and NO user) -> zero rows.
      // Proves the DB enforces whatever the GUC says; nothing validates it.
      const tamperedCount = lastNum(await psql(host, user, rolePass, `${claimsFrom(OTHER_UUID, "authenticated")}; ${COUNT}`));
      meas.tampered_sub_rows = tamperedCount;
      if (tamperedCount !== 0) failures.push(`tampered sub saw ${tamperedCount} rows, want 0`);

      const pass = failures.length === 0;
      return [{
        id: "C02",
        title: this.title,
        status: pass ? "pass" : "fail",
        detail: pass
          ? "GoTrue sub over the wire resolves per-user RLS; tampered sub enforced as-is (GUC unprivileged confirmed)"
          : failures.join("; "),
        measurements: meas,
      }];
    } catch (e) {
      return [{ id: "C02", title: this.title, status: "fail", detail: `threw: ${e instanceof Error ? e.message : String(e)}` }];
    } finally {
      if (ref) await mgmt(ctx, "DELETE", `/projects/${ref}`).catch(() => null);
    }
  },
};
export default mod;
