/**
 * C03 - the same merge through the supported surface.
 *
 * C01 writes into the `auth` schema, which nothing in Supabase's docs
 * sanctions. Before recommending that, it is worth establishing what the
 * documented admin endpoint can and cannot do, because a consolidation that
 * can be done with `POST /auth/v1/admin/users` is a different proposition from
 * one that needs SQL against a schema the platform owns.
 *
 * Three fields decide it. `password_hash` decides whether the users keep their
 * passwords; `id` decides whether every user_id already stored in the
 * customer's data still resolves; `app_metadata` decides whether the tenant
 * claim can be set at creation rather than in a follow-up write. If all three
 * hold, the auth-schema copy is an optimisation, not a requirement.
 *
 * C03f is the control that prices the alternative: a create with no password
 * material at all, to confirm that the naive API merge really does force every
 * user through a reset rather than silently carrying something over.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { PASSWORD, adminCreate, claims, keys, login, sql, waitReady } from "../lib/consolidate";

const TENANT = "tenant-a";
const SUBJECT = "c03-api@lab.invalid";
const NOPASS = "c03-nopass@lab.invalid";

const mod: TestModule = {
  id: "C03",
  title: "Merging users through the admin API instead of the auth schema",
  where: "local",
  requires: ["pat", "peer"],
  destructive: true,
  async run(ctx) {
    const srcA = ctx.peers.src_a;
    const shared = ctx.ref;
    if (!srcA) {
      return { id: "C03", title: this.title, status: "skip", detail: "needs PVLAB_PEER_SRC_A" };
    }
    const results: TestResult[] = [];
    await waitReady(ctx, srcA);
    await waitReady(ctx, shared);

    for (const ref of [srcA, shared]) {
      await sql(ctx, ref, `delete from auth.users where lower(email) like 'c03-%'`);
    }
    const srcKeys = await keys(ctx, srcA);
    const shKeys = await keys(ctx, shared);
    if (!srcKeys.service || !shKeys.service || !shKeys.anon) {
      return [{ id: "C03z", title: "key fetch", status: "fail", detail: "could not read API keys" }];
    }

    await adminCreate(`${srcA}.supabase.co`, srcKeys.service, {
      email: SUBJECT,
      password: PASSWORD,
      email_confirm: true,
    });
    const src = await sql(
      ctx,
      srcA,
      `select id::text, email, encrypted_password from auth.users where email = '${SUBJECT}'`,
    );
    const row = src.rows?.[0];
    if (!row) {
      return [{ id: "C03z", title: "seed", status: "fail", detail: "no source user to migrate" }];
    }
    const srcId = String(row.id);
    const hash = String(row.encrypted_password);

    const created = await adminCreate(`${shared}.supabase.co`, shKeys.service, {
      id: srcId,
      email: SUBJECT,
      password_hash: hash,
      email_confirm: true,
      app_metadata: { tenant_id: TENANT },
    });
    results.push({
      id: "C03a",
      title: "Admin create accepts an existing bcrypt hash as password_hash",
      status: created.status < 300 ? "pass" : "fail",
      detail:
        created.status < 300
          ? `HTTP ${created.status} - the hash was taken without the plaintext`
          : `HTTP ${created.status} ${String(created.json.error_code ?? created.json.msg ?? "")}`,
      measurements: { status: created.status, hash_prefix: hash.slice(0, 4) },
      evidence: created.status < 300 ? undefined : created.text.slice(0, 300),
    });

    const gotId = typeof created.json.id === "string" ? created.json.id : "";
    results.push({
      id: "C03b",
      title: "The supplied uuid is honoured, so stored user_id references survive",
      status: gotId === srcId ? "pass" : "fail",
      detail:
        gotId === srcId
          ? "the target user carries the source uuid"
          : `target uuid ${gotId.slice(0, 8)} != source ${srcId.slice(0, 8)} - every FK would need remapping`,
      measurements: { id_preserved: String(gotId === srcId) },
    });

    const l = await login(`${shared}.supabase.co`, shKeys.anon, SUBJECT);
    const token = typeof l.json.access_token === "string" ? l.json.access_token : undefined;
    results.push({
      id: "C03c",
      title: "The migrated user logs in with the original password, no reset",
      status: token ? "pass" : "fail",
      detail: token ? "password login succeeds" : `HTTP ${l.status} ${String(l.json.error_code ?? "")}`,
      measurements: { status: l.status },
      evidence: token ? undefined : l.text.slice(0, 200),
    });

    if (token) {
      const meta = (claims(token).app_metadata ?? {}) as Record<string, unknown>;
      results.push({
        id: "C03d",
        title: "The tenant claim set at creation appears in the token",
        status: meta.tenant_id === TENANT ? "pass" : "fail",
        detail: `app_metadata.tenant_id=${String(meta.tenant_id ?? "absent")}`,
        measurements: { tenant_id: String(meta.tenant_id ?? "absent") },
      });
    }

    // The same conflict C02 provokes in SQL, on the documented surface: the
    // status code and error code a merge script would actually have to branch
    // on.
    const dup = await adminCreate(`${shared}.supabase.co`, shKeys.service, {
      email: SUBJECT,
      password: PASSWORD,
      email_confirm: true,
      app_metadata: { tenant_id: "tenant-b" },
    });
    results.push({
      id: "C03e",
      title: "A duplicate address is refused on the admin endpoint too",
      status: dup.status >= 400 ? "pass" : "fail",
      detail:
        dup.status >= 400
          ? `HTTP ${dup.status} ${String(dup.json.error_code ?? dup.json.msg ?? "")}`
          : "ACCEPTED - two users now share an address",
      measurements: {
        status: dup.status,
        error_code: String(dup.json.error_code ?? dup.json.code ?? "none"),
      },
      evidence: dup.text.slice(0, 300),
    });

    // C02 found the SQL path admits a case-variant of an address that already
    // exists, because the unique index is over the raw column. The admin
    // endpoint normalises input, or it does not; if it does, the documented
    // path is immune to a trap the auth-schema copy walks into silently.
    const cased = await adminCreate(`${shared}.supabase.co`, shKeys.service, {
      email: SUBJECT.toUpperCase(),
      password: PASSWORD,
      email_confirm: true,
      app_metadata: { tenant_id: "tenant-b" },
    });
    const variantRows = await sql(
      ctx,
      shared,
      `select count(*)::int as n from auth.users where lower(email) = lower('${SUBJECT}')`,
    );
    results.push({
      id: "C03g",
      title: "A case-variant of an existing address on the admin endpoint",
      status: cased.status >= 400 ? "pass" : "fail",
      detail:
        cased.status >= 400
          ? `HTTP ${cased.status} ${String(cased.json.error_code ?? "")} - the endpoint normalises, unlike the raw index`
          : `ACCEPTED - ${String(variantRows.rows?.[0]?.n ?? "?")} rows for that address, same trap as the SQL path`,
      measurements: {
        status: cased.status,
        error_code: String(cased.json.error_code ?? cased.json.code ?? "none"),
        rows_for_that_human: Number(variantRows.rows?.[0]?.n ?? -1),
      },
      evidence: cased.text.slice(0, 250),
    });

    // Control: what the merge costs if password_hash is not used.
    await adminCreate(`${shared}.supabase.co`, shKeys.service, {
      email: NOPASS,
      email_confirm: true,
      app_metadata: { tenant_id: TENANT },
    });
    const noPassLogin = await login(`${shared}.supabase.co`, shKeys.anon, NOPASS);
    results.push({
      id: "C03f",
      title: "Control: without password_hash the user cannot log in with the old password",
      status: typeof noPassLogin.json.access_token === "string" ? "fail" : "pass",
      detail: `HTTP ${noPassLogin.status} ${String(noPassLogin.json.error_code ?? "")} - C03c is attributable to password_hash`,
      measurements: { status: noPassLogin.status },
    });

    return results;
  },
};
export default mod;
