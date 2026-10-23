/**
 * TPA05 - does managed Storage VERIFY a third-party token, or only pass it
 * through? self-hosted-auth SH06e could not tell: `GET /storage/v1/bucket`
 * answered 200 to anon too. Here every probe hits a PRIVATE bucket whose
 * storage.objects policies key on a custom claim (`tenant`), so the token's
 * claims decide the answer, and two forged tokens carry the same claims as the
 * allowed one: if Storage only decoded the token without checking the
 * signature, the forgeries would be allowed too.
 *
 * Tokens (all ES256, role authenticated, iss = the registered jwks_url):
 *   A          tenant=acme, signed by the registered issuer key
 *   B          tenant=globex, registered key
 *   noclaim    no tenant claim, registered key
 *   forged     tenant=acme, the registered key's kid, signed by ANOTHER key
 *   unknownkid tenant=acme, another key with its own unregistered kid
 *   expired    tenant=acme, registered key, exp 10 minutes in the past
 *   anon       the legacy anon JWT as bearer (no third-party token)
 *
 *   TPA05-setup  issuer registered; first PostgREST 200 and first Storage 200
 *                for token A, each in seconds after registration.
 *   TPA05a-*     GET /storage/v1/object/authenticated/<bucket>/acme/a.txt per
 *                token. Expect A 200 with the body, every other token refused.
 *   TPA05b-*     POST /storage/v1/object/list/<bucket> with a prefix.
 *   TPA05c-*     POST /storage/v1/object/<bucket>/<tenant>/<new file> upload.
 *   TPA05d-*     POST /storage/v1/object/sign/... then GET the signed URL with
 *                no credentials; records the signed-URL token's header.
 *
 * Every row records the HTTP status and the response body verbatim (first
 * 240 chars) and the `server` / `sb-gateway-*` headers, because the body
 * shape tells which side answered: storage-api errors carry
 * `{statusCode, error, message}`.
 *
 * Not settled here: TUS resumable and S3-protocol uploads (S3 uses its own
 * keys or a session token), image transformation reads, and the public
 * bucket path (no token needed by design).
 *
 * DESTRUCTIVE: deploys a JWKS function, registers one issuer, creates a
 * bucket, two storage.objects policies and a table; all removed in finally.
 * Runs against PVLAB_REF; self-skips without it.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { fetchKeys, sql } from "../../../harness/src/platform";
import { cleanupPrefix } from "../../edge-function-limits/lib/ef";
import { deleteTpa, generateIdp, mint, setupIssuer, sleep } from "../lib/idp";

const P = "pvlab-tpa05-";
const BUCKET = "tpa05-priv";
const TABLE = "public.tpa05_ping";

interface SRes {
  status: number;
  text: string;
  json: any;
  via: string;
}

async function sreq(ctx: Ctx, method: string, path: string, apikey: string | null, bearer: string | null, body?: string, contentType = "application/json"): Promise<SRes> {
  const headers: Record<string, string> = {};
  if (apikey) headers.apikey = apikey;
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (body !== undefined) headers["Content-Type"] = contentType;
  const res = await fetch(`https://${ctx.apiHost}${path}`, { method, headers, body, signal: AbortSignal.timeout(20_000) }).catch((e) => e as Error);
  if (res instanceof Error) return { status: 0, text: res.message, json: undefined, via: "" };
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  const via = [...res.headers.entries()]
    .filter(([k]) => k === "server" || k.startsWith("sb-gateway") || k === "x-sb-error-code")
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  return { status: res.status, text: text.replace(/\s+/g, " ").slice(0, 240), json, via };
}

const decodeHeader = (jwt: string): string => {
  try {
    return Buffer.from(jwt.split(".")[0]!, "base64url").toString("utf8");
  } catch {
    return "undecodable";
  }
};

const mod: TestModule = {
  id: "TPA05",
  title: "Storage verifies a third-party token: private bucket, RLS on a custom claim",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!ctx.ref) return [{ id: "TPA05", title: this.title, status: "skip", detail: "no project ref (PVLAB_REF)" }];
    const keys = await fetchKeys(ctx);
    const out: TestResult[] = [];
    let tpaId = "";
    const svc = keys.service;
    const row = (id: string, title: string, expectAllow: boolean, r: SRes, extra: Record<string, number | string> = {}, okOverride?: boolean): TestResult => {
      const allowed = r.status >= 200 && r.status < 300;
      const ok = okOverride ?? allowed === expectAllow;
      return {
        id,
        title,
        status: ok ? "pass" : "fail",
        detail: `${r.status} ${r.text}${r.via ? ` [${r.via}]` : ""} (expected ${expectAllow ? "allowed" : "refused"})`,
        measurements: { status: r.status, allowed: allowed ? 1 : 0, ...extra },
      };
    };
    try {
      await cleanupPrefix(ctx, P);
      // A table the issuer setup polls through PostgREST (first-time kid propagation).
      await sql(ctx, `create table if not exists ${TABLE} (id int primary key)`);
      await sql(ctx, `insert into ${TABLE} values (1) on conflict do nothing`);
      await sql(ctx, `alter table ${TABLE} enable row level security`);
      await sql(ctx, `drop policy if exists tpa05_ping_read on ${TABLE}`);
      await sql(ctx, `create policy tpa05_ping_read on ${TABLE} for select to authenticated using (true)`);

      // Private bucket and two objects, written with the service_role key.
      await sreq(ctx, "DELETE", `/storage/v1/bucket/${BUCKET}`, svc, svc);
      const mk = await sreq(ctx, "POST", `/storage/v1/bucket`, svc, svc, JSON.stringify({ id: BUCKET, name: BUCKET, public: false }));
      const upA = await sreq(ctx, "POST", `/storage/v1/object/${BUCKET}/acme/a.txt`, svc, svc, "acme-secret", "text/plain");
      const upB = await sreq(ctx, "POST", `/storage/v1/object/${BUCKET}/globex/b.txt`, svc, svc, "globex-secret", "text/plain");
      const claimMatch = `bucket_id = '${BUCKET}' and (storage.foldername(name))[1] = (auth.jwt()->>'tenant')`;
      for (const p of ["tpa05_read", "tpa05_write"]) await sql(ctx, `drop policy if exists ${p} on storage.objects`);
      const polR = await sql(ctx, `create policy tpa05_read on storage.objects for select to authenticated using (${claimMatch})`);
      const polW = await sql(ctx, `create policy tpa05_write on storage.objects for insert to authenticated with check (${claimMatch})`);

      const iss = await setupIssuer(ctx, `${P}jwks`, keys.anon, `/rest/v1/tpa05_ping?select=id`);
      tpaId = iss.tpaId;
      const t0 = Date.now();
      const A = await mint(iss.idp, { sub: crypto.randomUUID(), iss: iss.iss, extra: { tenant: "acme" } });
      const B = await mint(iss.idp, { sub: crypto.randomUUID(), iss: iss.iss, extra: { tenant: "globex" } });
      const noclaim = await mint(iss.idp, { sub: crypto.randomUUID(), iss: iss.iss });
      const other = await generateIdp();
      const forged = await mint({ ...other, kid: iss.idp.kid }, { sub: crypto.randomUUID(), iss: iss.iss, extra: { tenant: "acme" } });
      const unknownkid = await mint(other, { sub: crypto.randomUUID(), iss: iss.iss, extra: { tenant: "acme" } });
      const expired = await mint(iss.idp, { sub: crypto.randomUUID(), iss: iss.iss, ttlSeconds: -600, extra: { tenant: "acme" } });

      // Storage may resolve the issuer on its own schedule: poll token A on the private object.
      const objA = `/storage/v1/object/authenticated/${BUCKET}/acme/a.txt`;
      let first = await sreq(ctx, "GET", objA, keys.anon, A);
      while (iss.tpaId && Date.now() - t0 < 180_000 && first.status !== 200) {
        await sleep(5_000);
        first = await sreq(ctx, "GET", objA, keys.anon, A);
      }
      const storageAfter = first.status === 200 ? Math.round((Date.now() - t0) / 1000) : -1;
      out.push({
        id: "TPA05-setup",
        title: "issuer registered; bucket, objects and claim policies in place",
        status: iss.tpaId && mk.status === 200 && upA.status === 200 && upB.status === 200 && polR.status < 300 && polW.status < 300 ? "pass" : "fail",
        detail:
          `jwks ${iss.jwksStatus}; register ${iss.regStatus}; PostgREST first 200 ${iss.restAcceptedAfterS}s after registration (last ${iss.restLast.slice(0, 80)}); ` +
          `Storage first 200 for token A ${storageAfter}s after the PostgREST 200 (last ${first.status} ${first.text.slice(0, 120)}); ` +
          `bucket ${mk.status}, uploads ${upA.status}/${upB.status}, policies ${polR.status}/${polW.status}${polR.error ? ` ${polR.error}` : ""}`,
        measurements: { register_status: iss.regStatus, rest_accepted_after_s: iss.restAcceptedAfterS, storage_accepted_after_rest_s: storageAfter },
      });
      if (!iss.tpaId) return out;

      // TPA05a - download the acme object with each token.
      const dl: [string, string | null, boolean][] = [
        ["A", A, true],
        ["B", B, false],
        ["noclaim", noclaim, false],
        ["forged", forged, false],
        ["unknownkid", unknownkid, false],
        ["expired", expired, false],
        ["anon", keys.anon, false],
      ];
      for (const [name, tok, allow] of dl) {
        const r = await sreq(ctx, "GET", objA, keys.anon, tok);
        const bodyOk = allow ? r.text === "acme-secret" : true;
        out.push(row(`TPA05a-${name}`, `download acme/a.txt with token ${name}`, allow, r, {}, (r.status === 200) === allow && bodyOk));
      }

      // TPA05b - list with a prefix.
      const list = async (tok: string, prefix: string) => {
        const r = await sreq(ctx, "POST", `/storage/v1/object/list/${BUCKET}`, keys.anon, tok, JSON.stringify({ prefix, limit: 100, offset: 0 }));
        const names = Array.isArray(r.json) ? (r.json as { name: string }[]).map((x) => x.name) : [];
        return { r, names };
      };
      for (const [name, tok, prefix, want] of [
        ["A-acme", A, "acme/", ["a.txt"]],
        ["A-globex", A, "globex/", []],
        ["B-acme", B, "acme/", []],
        ["B-globex", B, "globex/", ["b.txt"]],
        ["forged-acme", forged, "acme/", []],
      ] as [string, string, string, string[]][]) {
        const { r, names } = await list(tok, prefix);
        const namesOk = JSON.stringify(names.filter((n) => n !== ".emptyFolderPlaceholder").sort()) === JSON.stringify(want);
        out.push({
          id: `TPA05b-${name}`,
          title: `list prefix ${prefix} with token ${name.split("-")[0]}`,
          status: namesOk ? "pass" : "fail",
          detail: `${r.status} names=${JSON.stringify(names)}${r.status >= 300 ? ` ${r.text}` : ""}${r.via ? ` [${r.via}]` : ""} (expected ${JSON.stringify(want)})`,
          measurements: { status: r.status, names: names.length },
        });
      }

      // TPA05c - upload into a tenant folder.
      const ts = Date.now();
      for (const [name, tok, folder, allow] of [
        ["A-acme", A, "acme", true],
        ["B-acme", B, "acme", false],
        ["B-globex", B, "globex", true],
        ["forged-acme", forged, "acme", false],
        ["expired-acme", expired, "acme", false],
      ] as [string, string, string, boolean][]) {
        const r = await sreq(ctx, "POST", `/storage/v1/object/${BUCKET}/${folder}/up-${name}-${ts}.txt`, keys.anon, tok, `from ${name}`, "text/plain");
        out.push(row(`TPA05c-${name}`, `upload into ${folder}/ with token ${name.split("-")[0]}`, allow, r));
      }

      // TPA05d - signed URL creation and use.
      for (const [name, tok, allow] of [
        ["A", A, true],
        ["B", B, false],
        ["forged", forged, false],
      ] as [string, string, boolean][]) {
        const r = await sreq(ctx, "POST", `/storage/v1/object/sign/${BUCKET}/acme/a.txt`, keys.anon, tok, JSON.stringify({ expiresIn: 60 }));
        const signed = String(r.json?.signedURL ?? "");
        let fetched = "not fetched";
        let hdr = "";
        if (signed) {
          const u = await sreq(ctx, "GET", `/storage/v1${signed}`, null, null);
          fetched = `${u.status} ${u.text.slice(0, 40)}`;
          const t = new URL(`https://x${signed}`).searchParams.get("token") ?? "";
          hdr = decodeHeader(t);
        }
        const res = row(`TPA05d-${name}`, `create a signed URL for acme/a.txt with token ${name}`, allow, r);
        if (signed) res.detail = `sign ${r.status}; GET signed URL with no apikey or bearer -> ${fetched}; signed-URL token header ${hdr} (expected ${allow ? "allowed" : "refused"})`;
        if (allow && !fetched.startsWith("200 acme-secret")) res.status = "fail";
        out.push(res);
      }
    } catch (e) {
      out.push({ id: "TPA05", title: this.title, status: "fail", detail: `threw: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      const notes: string[] = [];
      if (tpaId) notes.push(`tpa delete ${await deleteTpa(ctx, tpaId)}`);
      const empty = await sreq(ctx, "POST", `/storage/v1/bucket/${BUCKET}/empty`, svc, svc, "{}");
      await sleep(2_000);
      const del = await sreq(ctx, "DELETE", `/storage/v1/bucket/${BUCKET}`, svc, svc);
      notes.push(`bucket empty ${empty.status} delete ${del.status}`);
      for (const p of ["tpa05_read", "tpa05_write"]) await sql(ctx, `drop policy if exists ${p} on storage.objects`);
      await sql(ctx, `drop table if exists ${TABLE}`);
      const c = await cleanupPrefix(ctx, P).catch(() => ({ deleted: 0, left: ["threw"] }));
      notes.push(`functions deleted ${c.deleted}${c.left.length ? ` LEFT ${c.left.join(",")}` : ""}`);
      out.push({ id: "TPA05z", title: "cleanup: issuer, bucket, policies, table, JWKS function", status: c.left.length || del.status >= 300 ? "fail" : "pass", detail: notes.join("; ") });
    }
    return out;
  },
};

export default mod;
