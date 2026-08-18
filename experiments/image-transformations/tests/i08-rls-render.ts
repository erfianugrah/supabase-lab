/**
 * I08 - does the authenticated render surface enforce storage RLS? Pair of
 * probes against the private bucket with a real user JWT:
 *
 *   negative: user with NO select policy on storage.objects -> render denied
 *   positive: same user WITH a select policy -> render allowed
 *
 * Without the negative, a 200 on the positive proves nothing (the render
 * path could be ignoring RLS entirely and serving anyone with any JWT).
 * Policy is applied via the Management query endpoint; the user is created
 * through GoTrue admin with the service key. Email is randomized per run
 * (adminCreate 422s on duplicates - the tenant-promotion note).
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { mgmt } from "../../../harness/src/mgmt";
import { storageBase, probe } from "../lib";

const mod: TestModule = {
  id: "I08",
  title: "RLS on the authenticated render surface",
  where: "local",
  requires: ["pat", "anon-key"],
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!ctx.serviceKey) {
      return [{
        id: "I08",
        title: "RLS on the authenticated render surface",
        status: "skip",
        detail: "no service key in ctx (SUPABASE_SERVICE_ROLE_KEY unset)",
      }];
    }
    const out: TestResult[] = [];
    const host = `https://${ctx.ref}.supabase.co`;
    const email = `pvlab-i08-${Date.now()}@example.invalid`;
    const password = `pvlab-${Math.random().toString(36).slice(2)}xX1!`;

    // create user
    const createRes = await fetch(`${host}/auth/v1/admin/users`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.serviceKey}`,
        apikey: ctx.serviceKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email, password, email_confirm: true }),
    });
    if (createRes.status !== 200 && createRes.status !== 201) {
      return [{
        id: "I08-user",
        title: "Create test user",
        status: "fail",
        detail: `admin create user: ${createRes.status} ${(await createRes.text()).slice(0, 200)}`,
      }];
    }

    // sign in -> user JWT
    const tokenRes = await fetch(`${host}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: ctx.anonKey!, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const tokenJson = (await tokenRes.json()) as { access_token?: string };
    const userJwt = tokenJson.access_token;
    if (!userJwt) {
      return [{
        id: "I08-user",
        title: "Create test user",
        status: "fail",
        detail: `password grant failed: ${tokenRes.status}`,
      }];
    }
    out.push({ id: "I08-user", title: "Create + sign in test user", status: "pass" });

    const renderUrl = `${storageBase(ctx)}/render/image/authenticated/priv/small.png?width=200`;
    const asUser = () =>
      probe(renderUrl, { headers: { Authorization: `Bearer ${userJwt}` } });

    // negative: no policy yet
    const denied = await asUser();
    out.push({
      id: "I08-denied-without-policy",
      title: "user without storage policy is denied",
      status: denied.status === 400 || denied.status === 403 ? "pass" : "fail",
      detail: denied.status === 200 ? "render served without any RLS grant - RLS not enforced on this path" : undefined,
      measurements: { status: denied.status },
    });

    // grant select on the priv bucket to authenticated users
    const sql = `
      create policy pvlab_i08_read on storage.objects
      for select to authenticated
      using (bucket_id = 'priv');
    `;
    const q = await mgmt(ctx, "POST", `/projects/${ctx.ref}/database/query`, { query: sql });
    out.push({
      id: "I08-policy",
      title: "Apply select policy on storage.objects",
      status: q.status === 200 || q.status === 201 ? "pass" : "fail",
      measurements: { status: q.status },
      evidence: q.text?.slice(0, 200),
    });

    const allowed = await asUser();
    out.push({
      id: "I08-allowed-with-policy",
      title: "user with select policy can render",
      status: allowed.status === 200 ? "pass" : "fail",
      measurements: { status: allowed.status, bytes: allowed.bytes },
    });

    // cleanup: drop policy (best effort)
    await mgmt(ctx, "POST", `/projects/${ctx.ref}/database/query`, {
      query: "drop policy if exists pvlab_i08_read on storage.objects;",
    });

    return out;
  },
};
export default mod;
