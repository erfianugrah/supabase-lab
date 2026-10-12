/**
 * CK12 - What does each service answer to the same failing request on each
 * target: status, media type, body keys, code?
 *
 * SIDE: each target through its gateway (Auth, Data API with schema `app`,
 * Storage REST) and its S3 endpoint (raw SigV4, so the XML body is kept).
 * Actors: the primary tenant's owner and viewer, signed in fresh; the anon key
 * as `apikey` unless the case says otherwise.
 *
 * Each measurement is `<status> <media type> <sorted body keys | xml:elements> <code>`.
 * Status is `info`: the module records, scripts/parity.ts compares across
 * targets and puts the CK13 version gap next to every difference.
 *
 * Not settled: Realtime and Edge Functions errors; localisation of messages
 * (message text is deliberately not compared).
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { errMsg, http, loadRun, loadState, row, scrub, shape, signIn, type HarnessTarget, type Resp } from "../lib/ckrun";
import { s3raw } from "../lib/sigv4";

export const CASES = [
  "auth.wrong_password",
  "auth.bad_refresh_token",
  "auth.user_garbage_bearer",
  "auth.user_no_bearer",
  "auth.signup_invalid_email",
  "auth.admin_with_anon_key",
  "rest.unknown_table",
  "rest.bad_uuid_filter",
  "rest.insert_rls_denied",
  "rest.garbage_bearer",
  "rest.no_apikey",
  "rest.unknown_schema",
  "storage.object_not_found",
  "storage.bucket_not_found",
  "storage.upload_rls_denied",
  "storage.no_auth",
  "storage.sign_missing_object",
  "s3.no_such_key",
  "s3.no_such_bucket",
  "s3.bad_signature",
  "s3.range_past_eof",
  "s3.put_rls_denied",
] as const;

export async function errorShapes(t: HarnessTarget, st: ReturnType<typeof loadState>): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const owner = (await signIn(t, st.users.owner.email, st.users.owner.password)).j.access_token as string;
  const viewer = (await signIn(t, st.users.viewer.email, st.users.viewer.password)).j.access_token as string;
  const u = t.client.url;
  const ak = t.client.anonKey;
  const P = st.tenants.primary;
  const json = { "content-type": "application/json" };
  const rest = (tok: string) => ({ apikey: ak, authorization: `Bearer ${tok}`, "accept-profile": "app", "content-profile": "app", ...json });
  const sto = (tok: string) => ({ apikey: ak, authorization: `Bearer ${tok}` });
  const mid = st.assets.mid;
  const userS3 = (tok: string) => ({ accessKeyId: t.client.s3.accessKeyId, secretAccessKey: ak, sessionToken: tok });
  const calls: Record<(typeof CASES)[number], () => Promise<Resp>> = {
    "auth.wrong_password": () => http(`${u}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: ak, ...json }, body: JSON.stringify({ email: st.users.owner.email, password: "nope-nope-1" }) }),
    "auth.bad_refresh_token": () => http(`${u}/auth/v1/token?grant_type=refresh_token`, { method: "POST", headers: { apikey: ak, ...json }, body: JSON.stringify({ refresh_token: "notarealtoken" }) }),
    "auth.user_garbage_bearer": () => http(`${u}/auth/v1/user`, { headers: { apikey: ak, authorization: "Bearer not-a-jwt" } }),
    "auth.user_no_bearer": () => http(`${u}/auth/v1/user`, { headers: { apikey: ak } }),
    "auth.signup_invalid_email": () => http(`${u}/auth/v1/signup`, { method: "POST", headers: { apikey: ak, ...json }, body: JSON.stringify({ email: "not-an-email", password: "Abcdefgh1234" }) }),
    "auth.admin_with_anon_key": () => http(`${u}/auth/v1/admin/users`, { headers: { apikey: ak, authorization: `Bearer ${ak}` } }),
    "rest.unknown_table": () => http(`${u}/rest/v1/no_such_table`, { headers: rest(owner) }),
    "rest.bad_uuid_filter": () => http(`${u}/rest/v1/records?id=eq.not-a-uuid`, { headers: rest(owner) }),
    "rest.insert_rls_denied": () => http(`${u}/rest/v1/records`, { method: "POST", headers: rest(viewer), body: JSON.stringify({ tenant_id: P, title: "viewer insert" }) }),
    "rest.garbage_bearer": () => http(`${u}/rest/v1/records`, { headers: { ...rest(owner), authorization: "Bearer not-a-jwt" } }),
    "rest.no_apikey": () => http(`${u}/rest/v1/records`, { headers: { "accept-profile": "app" } }),
    "rest.unknown_schema": () => http(`${u}/rest/v1/records`, { headers: { ...rest(owner), "accept-profile": "nosuchschema" } }),
    "storage.object_not_found": () => http(`${u}/storage/v1/object/authenticated/${t.client.bucket}/${P}/missing/data`, { headers: sto(owner) }),
    "storage.bucket_not_found": () => http(`${u}/storage/v1/object/authenticated/nosuchbucket/x`, { headers: sto(owner) }),
    "storage.upload_rls_denied": () =>
      http(`${u}/storage/v1/object/${t.client.bucket}/${P}/${crypto.randomUUID()}/data`, { method: "POST", headers: { ...sto(viewer), "content-type": "application/octet-stream" }, body: "x" }),
    "storage.no_auth": () => http(`${u}/storage/v1/object/authenticated/${t.client.bucket}/${P}/missing/data`, { headers: { apikey: ak } }),
    "storage.sign_missing_object": () => http(`${u}/storage/v1/object/sign/${t.client.bucket}/${P}/missing/data`, { method: "POST", headers: { ...sto(owner), ...json }, body: JSON.stringify({ expiresIn: 60 }) }),
    "s3.no_such_key": () => s3raw(t.client.s3.endpoint, `/${t.client.bucket}/${P}/missing/data`, userS3(owner), t.client.s3.region),
    "s3.no_such_bucket": () => s3raw(t.client.s3.endpoint, `/nosuchbucket/x`, userS3(owner), t.client.s3.region),
    "s3.bad_signature": () => s3raw(t.client.s3.endpoint, `/${t.client.bucket}/${P}/missing/data`, { ...userS3(owner), secretAccessKey: "wrong-secret-value" }, t.client.s3.region),
    "s3.range_past_eof": () =>
      mid
        ? s3raw(t.client.s3.endpoint, `/${t.client.bucket}/${P}/${mid.id}/data`, userS3(owner), t.client.s3.region, { headers: { range: "bytes=999999999999-" } })
        : Promise.resolve({ status: 0, headers: {}, body: "no mid asset", ms: 0 }),
    "s3.put_rls_denied": () => s3raw(t.client.s3.endpoint, `/${t.client.bucket}/${P}/${crypto.randomUUID()}/data`, userS3(viewer), t.client.s3.region, { method: "PUT", body: "x" }),
  };
  for (const c of CASES) {
    const s = shape(await calls[c]());
    out[c] = `${s.status} ${s.type} ${s.keys} ${s.code}`.trim();
  }
  return out;
}

const mod: TestModule = {
  id: "CK12",
  title: "Error-shape matrix (Auth, Data API, Storage REST, S3)",
  where: "local",
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const l = loadRun(ctx);
    if ("skip" in l) return [{ id: "CK12", title: this.title, status: "skip", detail: l.skip }];
    const out: TestResult[] = [];
    const all: Record<string, Record<string, string>> = {};
    for (const t of l.targets) {
      try {
        const m = await errorShapes(t, loadState(l.run, t.name));
        for (const k of Object.keys(m)) m[k] = scrub(l, m[k]!);
        all[t.name] = m;
        out.push(row("CK12", t, this.title, "info", `${CASES.length} failing requests recorded`, m));
      } catch (e) {
        out.push(row("CK12", t, this.title, "fail", `threw: ${scrub(l, errMsg(e))}`));
      }
    }
    const names = Object.keys(all);
    if (names.length > 1) {
      const diff = CASES.filter((c) => new Set(names.map((n) => all[n]![c])).size > 1);
      out.push({ id: "CK12-diff", title: "error shapes that differ between the targets of this run", status: "info", detail: diff.length ? diff.join(", ") : "none", measurements: { differing_cases: diff.length, of: CASES.length } });
    }
    return out;
  },
};
export default mod;
