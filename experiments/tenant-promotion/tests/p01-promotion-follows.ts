/**
 * P01 - promotion carries the tenant, and the client finds it.
 *
 * The question: can a tenant be promoted from a shared project to a dedicated
 * one without re-authenticating? The design puts a client that learns its
 * placement at runtime through the flow: read on the shared, auth rows are
 * copied to the dedicated in FK order, the refresh token the client ALREADY
 * HELD mints a session at the new project with zero password grants, and it
 * reads its row there.
 *
 * Two controls are mandatory, because without them the result proves nothing:
 * a second tenant must be unaffected, and the old placement is probed after
 * the move - it still serves, and that is the finding rather than a bug.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import {
  PASSWORD,
  adminCreate,
  claims,
  copyTable,
  resyncSequence,
  keys,
  login,
  refreshSession,
  restRead,
  sql,
  sqlstate,
  waitReady,
} from "../lib/promote";

// Unique per run: adminCreate 422s on a duplicate address, so constant
// emails make the module pass exactly once against a given project pair.
const RUN = Math.random().toString(36).slice(2, 8);
const EMAIL_A = `p01-tenant-a-${RUN}@lab.invalid`;
const EMAIL_B = `p01-tenant-b-${RUN}@lab.invalid`;
const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";

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
  id: "P01",
  title: "Promotion: tenant follows its data to the dedicated project",
  where: "local",
  requires: ["pat", "peer"],
  destructive: true, // creates users and copies auth rows on both projects
  async run(ctx) {
    const dedicated = ctx.peers.dedicated;
    const shared = ctx.ref;
    if (!dedicated) {
      return {
        id: "P01",
        title: this.title,
        status: "skip",
        detail: "PVLAB_PEER_DEDICATED not set - this experiment needs two projects",
      };
    }
    const results: TestResult[] = [];

    await waitReady(ctx, shared);
    await waitReady(ctx, dedicated);

    // Start from a known state.
    await sql(ctx, shared, `delete from auth.users where lower(email) like 'p01-%'`);
    await sql(ctx, dedicated, `delete from auth.users where lower(email) like 'p01-%'`);
    await sql(ctx, shared, SCHEMA);
    await sql(ctx, dedicated, SCHEMA);
    await sql(
      ctx,
      shared,
      `insert into public.items(tenant_id,body) values ('${TENANT_A}','a1'),('${TENANT_A}','a2'),('${TENANT_B}','b1');`,
    );

    const sharedKeys = await keys(ctx, shared);
    const dedKeys = await keys(ctx, dedicated);
    if (!sharedKeys.anon || !sharedKeys.service || !dedKeys.anon || !dedKeys.service) {
      return [
        ...results,
        { id: "P01z", title: "key fetch", status: "fail", detail: "could not read project API keys" },
      ];
    }

    // Create both tenants on the shared project.
    await adminCreate(`${shared}.supabase.co`, sharedKeys.service, {
      email: EMAIL_A,
      password: PASSWORD,
      email_confirm: true,
      app_metadata: { tenant_id: TENANT_A },
    });
    await adminCreate(`${shared}.supabase.co`, sharedKeys.service, {
      email: EMAIL_B,
      password: PASSWORD,
      email_confirm: true,
      app_metadata: { tenant_id: TENANT_B },
    });

    // Login as tenant A, keeping the refresh token.
    const loginA = await login(`${shared}.supabase.co`, sharedKeys.anon, EMAIL_A);
    const tokA = typeof loginA.json.access_token === "string" ? loginA.json.access_token : undefined;
    const refA =
      typeof loginA.json.refresh_token === "string" ? loginA.json.refresh_token : undefined;
    if (!tokA || !refA) {
      return [
        ...results,
        {
          id: "P01z",
          title: "tenant A login",
          status: "fail",
          detail: `login HTTP ${loginA.status}: ${loginA.text.slice(0, 100)}`,
        },
      ];
    }

    // Login as tenant B (control tenant).
    const loginB = await login(`${shared}.supabase.co`, sharedKeys.anon, EMAIL_B);
    const tokB = typeof loginB.json.access_token === "string" ? loginB.json.access_token : undefined;

    // ---- Tenant A reads its rows on the shared project. ----
    const onShared = await restRead(
      `${shared}.supabase.co`,
      sharedKeys.anon,
      tokA,
      "items?select=tenant_id,body&order=id",
    );
    results.push({
      id: "P01a",
      title: "Tenant A reads its rows on the shared project (pre-promotion)",
      status: onShared.rows?.length === 2 ? "pass" : "fail",
      detail: `${onShared.rows?.length ?? 0} rows, code=${onShared.code ?? "none"}`,
      measurements: { rows: onShared.rows?.length ?? 0, status: onShared.status },
    });

    // ---- Tenant B is isolated on shared. ----
    if (tokB) {
      const onSharedB = await restRead(
        `${shared}.supabase.co`,
        sharedKeys.anon,
        tokB,
        "items?select=tenant_id,body&order=id",
      );
      results.push({
        id: "P01b",
        title: "Tenant B is isolated on the shared project (RLS)",
        status: onSharedB.rows?.length === 1 ? "pass" : "fail",
        detail: `${onSharedB.rows?.length ?? 0} rows returned`,
        measurements: { rows: onSharedB.rows?.length ?? 0 },
      });
    }

    // ---- Copy auth rows in FK order. ----
    const userCopy = await copyTable(
      ctx,
      shared,
      dedicated,
      "auth",
      "users",
      `email = '${EMAIL_A}'`,
    );
    results.push({
      id: "P01c",
      title: "auth.users row copied to the dedicated project",
      status: userCopy.result.status < 300 && userCopy.read === 1 ? "pass" : "fail",
      detail:
        userCopy.result.status < 300
          ? `${userCopy.read} row(s) over ${userCopy.cols} non-generated columns`
          : `insert failed: ${userCopy.result.error?.slice(0, 160)}`,
      measurements: { read: userCopy.read, landed: userCopy.read, columns: userCopy.cols },
      evidence: userCopy.result.error?.slice(0, 300),
    });

    const identCopy = await copyTable(
      ctx,
      shared,
      dedicated,
      "auth",
      "identities",
      `user_id in (select id from auth.users where email = '${EMAIL_A}')`,
    );
    results.push({
      id: "P01d",
      title: "auth.identities rows copied",
      status: identCopy.result.status < 300 && identCopy.read > 0 ? "pass" : "fail",
      detail: `${identCopy.read} row(s) over ${identCopy.cols} columns`,
      measurements: { read: identCopy.read, sqlstate: sqlstate(identCopy.result) },
      evidence: identCopy.result.error?.slice(0, 200),
    });

    const sessionCopy = await copyTable(
      ctx,
      shared,
      dedicated,
      "auth",
      "sessions",
      `user_id in (select id from auth.users where email = '${EMAIL_A}')`,
    );
    results.push({
      id: "P01e",
      title: "auth.sessions rows copied",
      status: sessionCopy.result.status < 300 && sessionCopy.read > 0 ? "pass" : "fail",
      detail: `${sessionCopy.read} row(s) over ${sessionCopy.cols} columns`,
      measurements: { read: sessionCopy.read, sqlstate: sqlstate(sessionCopy.result) },
      evidence: sessionCopy.result.error?.slice(0, 200),
    });

    const rtCopy = await copyTable(
      ctx,
      shared,
      dedicated,
      "auth",
      "refresh_tokens",
      `user_id::text in (select id::text from auth.users where email = '${EMAIL_A}')`,
      // Do NOT carry the source's surrogate id. auth.refresh_tokens.id is a
      // bigserial, and a target that has seen ANY prior auth activity already
      // occupies the low ids - the insert then dies on refresh_tokens_pkey.
      // The token string is what the client presents; the id is the target's
      // to assign. (Copying ids instead is legal, but then the sequence resync
      // below is mandatory rather than belt-and-braces.)
      { id: "nextval('auth.refresh_tokens_id_seq')" },
    );
    results.push({
      id: "P01f",
      title: "auth.refresh_tokens rows copied",
      // read > 0 matters: inserting an empty set succeeds, so status alone
      // reports a pass for a copy that moved nothing.
      status: rtCopy.result.status < 300 && rtCopy.read > 0 ? "pass" : "fail",
      detail: `${rtCopy.read} row(s) over ${rtCopy.cols} columns`,
      measurements: { read: rtCopy.read, sqlstate: sqlstate(rtCopy.result) },
      evidence: rtCopy.result.error?.slice(0, 200),
    });

    // The copy is not finished until the sequence is resynced. GoTrue rotates
    // the refresh token on every use, so a stale sequence does not break the
    // promotion - it breaks the tenant's NEXT refresh, which is a much worse
    // place to find out.
    const seq = await resyncSequence(
      ctx,
      dedicated,
      "auth.refresh_tokens_id_seq",
      "auth",
      "refresh_tokens",
    );
    results.push({
      id: "P01f2",
      title: "auth.refresh_tokens sequence resynced after the copy",
      status: seq.result.status < 300 ? "pass" : "fail",
      detail: `last_value=${seq.lastValue}`,
      measurements: { last_value: seq.lastValue, sqlstate: sqlstate(seq.result) },
      evidence: seq.result.error?.slice(0, 200),
    });

    // ---- Copy the tenant's data slice to the dedicated project. ----
    await sql(
      ctx,
      dedicated,
      `insert into public.items(tenant_id,body) values ('${TENANT_A}','a1'),('${TENANT_A}','a2');`,
    );

    // ---- The refresh token the client ALREADY HELD mints a session at the
    //      dedicated project - zero password logins. ----
    const refreshed = await refreshSession(`${dedicated}.supabase.co`, dedKeys.anon, refA);
    const newTok =
      typeof refreshed.json.access_token === "string" ? refreshed.json.access_token : undefined;
    results.push({
      id: "P01g",
      title: "Refresh token from the shared project mints a session at the dedicated project",
      status: newTok ? "pass" : "fail",
      detail: newTok
        ? `session minted - no password grant required`
        : `refresh refused: HTTP ${refreshed.status} ${String(refreshed.json.error_code ?? refreshed.json.error ?? "")}`,
      measurements: { status: refreshed.status },
      evidence: newTok ? claims(newTok).sub?.toString().slice(0, 12) : refreshed.text.slice(0, 200),
    });

    // ---- Tenant A reads its row on the dedicated project. ----
    if (newTok) {
      const onDed = await restRead(
        `${dedicated}.supabase.co`,
        dedKeys.anon,
        newTok,
        "items?select=tenant_id,body&order=id",
      );
      results.push({
        id: "P01h",
        title: "Tenant A reads its rows on the dedicated project after promotion",
        status: onDed.rows?.length === 2 ? "pass" : "fail",
        detail: `${onDed.rows?.length ?? 0} rows with a session minted from the original refresh token`,
        measurements: { rows: onDed.rows?.length ?? 0, status: onDed.status },
      });

      const subShared = claims(tokA).sub;
      const subDed = claims(newTok).sub;
      results.push({
        id: "P01i",
        title: "The user's uuid is preserved across projects",
        status: subShared && subDed && subShared === subDed ? "pass" : "fail",
        detail: `shared.sub=${String(subShared ?? "?").slice(0, 12)} dedicated.sub=${String(subDed ?? "?").slice(0, 12)}`,
        measurements: { match: String(subShared === subDed) },
      });
    }

    // ---- Control 1: tenant B is unaffected on the shared project. ----
    if (tokB) {
      const afterB = await restRead(
        `${shared}.supabase.co`,
        sharedKeys.anon,
        tokB,
        "items?select=tenant_id,body&order=id",
      );
      results.push({
        id: "P01j",
        title: "Control: tenant B is unaffected by tenant A's promotion",
        status: afterB.rows?.length === 1 ? "pass" : "fail",
        detail: `${afterB.rows?.length ?? 0} rows - the other tenant's move did not disrupt this one`,
        measurements: { rows: afterB.rows?.length ?? 0 },
      });
    }

    // ---- Control 2: the old placement still serves. This is the finding,
    //      not a bug - a promotion that copies is a different risk profile
    //      from one that cuts. ----
    const oldPlace = await restRead(
      `${shared}.supabase.co`,
      sharedKeys.anon,
      tokA,
      "items?select=tenant_id,body&order=id",
    );
    results.push({
      id: "P01k",
      title: "Control: the old placement still serves the tenant after the copy",
      status: oldPlace.rows?.length === 2 ? "pass" : "info",
      detail: `${oldPlace.rows?.length ?? 0} rows at the source - promotion is a copy, not a cutover`,
      measurements: { rows: oldPlace.rows?.length ?? 0, status: oldPlace.status },
    });

    return results;
  },
};
export default mod;