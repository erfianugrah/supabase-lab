/**
 * P03 - retiring the source identity.
 *
 * After promotion, the tenant's identity lives on both projects. Deleting the
 * source user should stop the shared project from issuing tokens for this
 * tenant WITHOUT affecting the dedicated project. Two paths must fail at the
 * source - password grant AND the previously-issued refresh token - and the
 * target must be confirmed unaffected.
 *
 * The tenant's application ROWS at the source must still exist: identity
 * retires, data does not. That is the operational distinction between
 * "delete the user" and "delete the tenant".
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import {
  PASSWORD,
  adminCreate,
  copyTable,
  resyncSequence,
  keys,
  login,
  restRead,
  sql,
  waitReady,
} from "../lib/promote";

const EMAIL = "p03-retire@lab.invalid";
const TENANT = "p03-tenant";

const SCHEMA = `
create table if not exists public.items (
  id bigserial primary key, tenant_id text not null, body text not null);
alter table public.items enable row level security;
drop policy if exists tenant_isolation on public.items;
create policy tenant_isolation on public.items
  using (tenant_id = (auth.jwt() -> 'app_metadata' ->> 'tenant_id'))
  with check (tenant_id = (auth.jwt() -> 'app_metadata' ->> 'tenant_id'));
grant usage on schema public to authenticated;
grant select, insert, update, delete on public.items to authenticated;
grant usage, select on sequence public.items_id_seq to authenticated;
truncate public.items;
`;

const mod: TestModule = {
  id: "P03",
  title: "Retiring the source identity after promotion",
  where: "local",
  requires: ["pat", "peer"],
  destructive: true, // creates user, copies auth rows, deletes source user
  async run(ctx) {
    const dedicated = ctx.peers.dedicated;
    const shared = ctx.ref;
    if (!dedicated) {
      return {
        id: "P03",
        title: this.title,
        status: "skip",
        detail: "PVLAB_PEER_DEDICATED not set - this experiment needs two projects",
      };
    }
    const results: TestResult[] = [];

    await waitReady(ctx, shared);
    await waitReady(ctx, dedicated);

    // Clean slate.
    await sql(ctx, shared, `delete from auth.users where lower(email) = '${EMAIL}'`);
    await sql(ctx, dedicated, `delete from auth.users where lower(email) = '${EMAIL}'`);
    await sql(ctx, shared, SCHEMA);
    await sql(ctx, dedicated, SCHEMA);
    await sql(
      ctx,
      shared,
      `insert into public.items(tenant_id,body) values ('${TENANT}','p03-row');`,
    );

    const sharedKeys = await keys(ctx, shared);
    const dedKeys = await keys(ctx, dedicated);
    if (!sharedKeys.anon || !sharedKeys.service || !dedKeys.anon || !dedKeys.service) {
      return [
        ...results,
        { id: "P03z", title: "key fetch", status: "fail", detail: "could not read project API keys" },
      ];
    }

    // Create user on shared.
    const create = await adminCreate(`${shared}.supabase.co`, sharedKeys.service, {
      email: EMAIL,
      password: PASSWORD,
      email_confirm: true,
      app_metadata: { tenant_id: TENANT },
    });
    const userObj = create.json.user as Record<string, unknown> | undefined;
    const uid =
      typeof create.json.id === "string"
        ? create.json.id
        : typeof userObj?.id === "string"
          ? String(userObj!.id)
          : undefined;
    results.push({
      id: "P03a",
      title: "User created on shared project",
      status: create.status < 300 && uid ? "pass" : "fail",
      detail: `HTTP ${create.status} id=${String(uid ?? "?").slice(0, 12)}`,
      measurements: { status: create.status },
    });
    if (!uid) return results;

    // Login, keep refresh token.
    const l = await login(`${shared}.supabase.co`, sharedKeys.anon, EMAIL);
    const tok = typeof l.json.access_token === "string" ? l.json.access_token : undefined;
    const refTok =
      typeof l.json.refresh_token === "string" ? l.json.refresh_token : undefined;
    if (!tok || !refTok) {
      return [
        ...results,
        {
          id: "P03z",
          title: "user login",
          status: "fail",
          detail: `login HTTP ${l.status}: ${l.text.slice(0, 100)}`,
        },
      ];
    }

    // Read data rows on shared.
    const preRows = await restRead(
      `${shared}.supabase.co`,
      sharedKeys.anon,
      tok,
      "items?select=tenant_id,body&order=id",
    );
    results.push({
      id: "P03b",
      title: "Tenant reads its data on shared before promotion",
      status: preRows.rows?.length === 1 ? "pass" : "fail",
      detail: `${preRows.rows?.length ?? 0} rows`,
      measurements: { rows: preRows.rows?.length ?? 0 },
    });

    // ---- Promote to dedicated. ----
    const userWhere = `email = '${EMAIL}'`;
    await copyTable(ctx, shared, dedicated, "auth", "users", userWhere);
    await copyTable(
      ctx,
      shared,
      dedicated,
      "auth",
      "identities",
      `user_id = '${uid}'`,
    );
    await copyTable(
      ctx,
      shared,
      dedicated,
      "auth",
      "sessions",
      `user_id = '${uid}'`,
    );
    await copyTable(
      ctx,
      shared,
      dedicated,
      "auth",
      "refresh_tokens",
      `user_id = '${uid}'`,
    );

    // Sequence resync: without it the tenant's NEXT refresh collides on an
    // id the copy already landed. See lib/promote.ts resyncSequence.
    await resyncSequence(ctx, dedicated, "auth.refresh_tokens_id_seq", "auth", "refresh_tokens");
    await sql(
      ctx,
      dedicated,
      `insert into public.items(tenant_id,body) values ('${TENANT}','p03-row');`,
    );

    // Confirm the user exists on dedicated.
    const dedUser = await sql(
      ctx,
      dedicated,
      `select id::text, email from auth.users where ${userWhere}`,
    );
    const dedUid = String(dedUser.rows?.[0]?.id ?? "");
    results.push({
      id: "P03c",
      title: "User row exists on the dedicated project after promotion",
      status: dedUser.rows?.length === 1 ? "pass" : "fail",
      detail: `${dedUser.rows?.length ?? 0} rows, id=${dedUid.slice(0, 12)}`,
      measurements: { rows: dedUser.rows?.length ?? 0 },
    });
    if (!dedUid) return results;

    // ---- Delete the user from the SOURCE. ----
    const del = await (async () => {
      const res = await fetch(
        `https://${shared}.supabase.co/auth/v1/admin/users/${uid}`,
        {
          method: "DELETE",
          headers: {
            apikey: sharedKeys.service!,
            Authorization: `Bearer ${sharedKeys.service}`,
          },
          signal: AbortSignal.timeout(20000),
        },
      );
      const text = await res.text();
      let json: Record<string, unknown> = {};
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        /* non-json */
      }
      return { status: res.status, json, text };
    })();
    results.push({
      id: "P03d",
      title: "Source user deleted from the shared project",
      status: del.status < 300 ? "pass" : "fail",
      detail: `DELETE HTTP ${del.status}`,
      measurements: { status: del.status },
      evidence: del.text.slice(0, 200),
    });

    // ---- Probe 1: password grant on shared MUST fail. ----
    const pwAfter = await login(`${shared}.supabase.co`, sharedKeys.anon, EMAIL);
    results.push({
      id: "P03e",
      title: "Password grant on the source is refused after identity retirement",
      status: pwAfter.status >= 400 ? "pass" : "fail",
      detail:
        pwAfter.status >= 400
          ? `refused: HTTP ${pwAfter.status} ${String(pwAfter.json.error_code ?? pwAfter.json.error ?? "").slice(0, 80)}`
          : `STILL ISSUING: HTTP ${pwAfter.status} - the source identity was not retired`,
      measurements: {
        status: pwAfter.status,
        error_code: String(pwAfter.json.error_code ?? "none"),
      },
      evidence: pwAfter.text.slice(0, 200),
    });

    // ---- Probe 2: the old refresh token on shared MUST fail. ----
    const refAfter = await (async () => {
      const res = await fetch(
        `https://${shared}.supabase.co/auth/v1/token?grant_type=refresh_token`,
        {
          method: "POST",
          headers: {
            apikey: sharedKeys.anon!,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ refresh_token: refTok }),
          signal: AbortSignal.timeout(20000),
        },
      );
      const text = await res.text();
      let json: Record<string, unknown> = {};
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        /* non-json */
      }
      return { status: res.status, json, text };
    })();
    results.push({
      id: "P03f",
      title: "Previously-issued refresh token is refused at the source",
      status: refAfter.status >= 400 ? "pass" : "fail",
      detail:
        refAfter.status >= 400
          ? `refused: HTTP ${refAfter.status} ${String(refAfter.json.error_code ?? refAfter.json.error ?? "").slice(0, 80)}`
          : `STILL ISSUING: HTTP ${refAfter.status} - the refresh token outlived the user`,
      measurements: {
        status: refAfter.status,
        error_code: String(refAfter.json.error_code ?? "none"),
      },
      evidence: refAfter.text.slice(0, 200),
    });

    // ---- Probe 3: the dedicated project is UNAFFECTED. ----
    const dedLogin = await login(`${dedicated}.supabase.co`, dedKeys.anon, EMAIL);
    const dedTok =
      typeof dedLogin.json.access_token === "string"
        ? dedLogin.json.access_token
        : undefined;
    results.push({
      id: "P03g",
      title: "Password login on the dedicated project is unaffected",
      status: dedLogin.status < 300 ? "pass" : "fail",
      detail:
        dedLogin.status < 300
          ? `login HTTP ${dedLogin.status} - dedicated project works independently`
          : `login refused: HTTP ${dedLogin.status} ${String(dedLogin.json.error_code ?? "")}`,
      measurements: { status: dedLogin.status },
      evidence: dedLogin.text.slice(0, 200),
    });

    if (dedTok) {
      const dedRows = await restRead(
        `${dedicated}.supabase.co`,
        dedKeys.anon,
        dedTok,
        "items?select=tenant_id,body&order=id",
      );
      results.push({
        id: "P03h",
        title: "Tenant reads its data row on the dedicated project after source retirement",
        status: dedRows.rows?.length === 1 ? "pass" : "fail",
        detail: `${dedRows.rows?.length ?? 0} rows`,
        measurements: { rows: dedRows.rows?.length ?? 0, status: dedRows.status },
      });
    }

    // ---- Probe 4: the tenant's data rows REMAIN on the source.
    //      Identity retires, data does not. ----
    const rowsLeft = await sql(
      ctx,
      shared,
      `select count(*)::int as n from public.items where tenant_id = '${TENANT}'`,
    );
    const n = Number(rowsLeft.rows?.[0]?.n ?? -1);
    results.push({
      id: "P03i",
      title: "Tenant's application rows remain on the source after identity retirement",
      status: n >= 1 ? "pass" : "fail",
      detail: `${n} row(s) - identity retires, data does not`,
      measurements: { rows: n },
    });

    return results;
  },
};
export default mod;