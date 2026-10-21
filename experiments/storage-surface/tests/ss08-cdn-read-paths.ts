/**
 * SS08 - CDN cache state per read path, public and private bucket, and JSON
 * compression on the wire.
 *
 * SS03d measured `/object/authenticated`, `/object/public`, signed URLs and
 * presigned S3 on a public bucket only. Not run there: a private bucket, the
 * path supabase-js `download()` calls (`GET /storage/v1/object/{bucket}/{path}`
 * with the session JWT; storage-js 2.112.3 `renderPath = "object"`), a second
 * user reading what the first user warmed, a long `cacheControl`, and whether
 * a plain JSON object is compressed on the wire.
 *
 * One throwaway Pro-org project `ss-ss08-<epoch>` in ap-southeast-1, deleted
 * in `finally`. Gateway host only (`<ref>.supabase.co`). Buckets `pub`
 * (public) and `priv` (private), each with a select policy for any
 * authenticated user (createSignedUrl needs one even on a public bucket).
 * Two signed-in users, A and B, through supabase-js with a recording fetch.
 * Every cell uploads its own fresh key, so its first read is the first
 * request for that key anywhere. Reads are 1.5 s apart.
 *
 *   SS08_setup  storage version, buckets, users, policies, payload sizes
 *   SS08a       public bucket: download() A, A, B, anon key; public URL;
 *               /object/authenticated A, A, B; one signed URL read 3 times;
 *               3 fresh signed URLs read once each; public read then
 *               download(); download() on an object uploaded with
 *               cacheControl 31536000
 *   SS08b       private bucket: download() A, A, B; /object/authenticated
 *               A, A, B; signed URL reused and fresh; cacheControl 31536000
 *   SS08c       the request download() sent: method, path, header names
 *   SS08d       a plain application/json object: wire bytes and
 *               Content-Encoding with and without Accept-Encoding, public URL
 *               and download path, first and repeat (curl, no decoding)
 *   SS08e       the same JSON gzipped client-side and uploaded with
 *               Content-Encoding: gzip: wire bytes with and without
 *               Accept-Encoding, and what download() hands the caller
 *
 * Every row is `info` (a recorded cache state); SS08e is pass/fail on
 * whether `download()` returned the original JSON. Not settled here: how egress is metered for any of these reads
 * (the lab has no view of the usage pipeline), the direct storage host,
 * regions other than ap-southeast-1, objects over 1 MB, repeat runs.
 *
 * DESTRUCTIVE: one project, deleted in finally. Cost: a few minutes of Micro
 * compute and a few MB of egress.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { gzipSync } from "node:zlib";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { mgmtSql, provision, sleep, teardown, type Proj } from "../lib";

const GAP_MS = 1500;

interface Read {
  status: number;
  cf: string;
  cc: string;
  age: string;
  ce: string;
  bytes: number;
  ms: number;
}

const line = (r: Read) =>
  `${r.status} cf=${r.cf || "-"} cc=${r.cc || "-"} age=${r.age || "-"} ce=${r.ce || "-"} bytes=${r.bytes} ms=${Math.round(r.ms)}`;

async function get(url: string, headers: Record<string, string> = {}): Promise<Read> {
  const t = performance.now();
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(60_000) });
    const b = new Uint8Array(await r.arrayBuffer());
    const h = (k: string) => r.headers.get(k) ?? "";
    return { status: r.status, cf: h("cf-cache-status"), cc: h("cache-control"), age: h("age"), ce: h("content-encoding"), bytes: b.length, ms: performance.now() - t };
  } catch (e) {
    return { status: 0, cf: `err ${(e as Error).name}`, cc: "", age: "", ce: "", bytes: 0, ms: performance.now() - t };
  }
}

/**
 * Wire bytes without decoding: curl without --compressed writes the body as
 * received. Headers go in on stdin (curl -K -) so keys never reach argv.
 */
async function wire(url: string, headers: Record<string, string>): Promise<string> {
  const cfg = [
    `url = "${url}"`,
    ...Object.entries(headers).map(([k, v]) => `header = "${k}: ${v}"`),
    `silent`,
    `output = "/dev/null"`,
    `dump-header = "-"`,
    `write-out = "\\n__WIRE__ %{http_code} %{size_download}\\n"`,
  ].join("\n");
  const p = Bun.spawn(["curl", "-K", "-"], { stdin: new Blob([cfg]), stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  const hdr = (k: string) => out.match(new RegExp(`^${k}:\\s*(.*?)\\r?$`, "im"))?.[1] ?? "-";
  const w = out.match(/__WIRE__ (\d+) (\d+)/);
  return `${w?.[1] ?? 0} ce=${hdr("content-encoding")} cf=${hdr("cf-cache-status")} wire=${w?.[2] ?? 0}`;
}

/** Deterministic JSON of nested records, about `target` bytes. */
function payload(target: number): string {
  const rows: unknown[] = [];
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  let len = 2;
  for (let i = 0; len < target; i++) {
    const row = {
      id: `rec-${i}`,
      kind: ["alpha", "beta", "gamma", "delta"][i % 4],
      score: Math.round(rnd() * 1000) / 10,
      active: rnd() > 0.5,
      createdAt: 1_790_000_000_000 + Math.floor(rnd() * 1e9),
      counts: { a: Math.floor(rnd() * 50), b: Math.floor(rnd() * 20), c: Math.floor(rnd() * 1e6) },
    };
    const s = JSON.stringify(row);
    len += s.length + 1;
    rows.push(row);
  }
  return JSON.stringify({ version: 3, records: rows });
}

const mod: TestModule = {
  id: "SS08",
  title: "CDN cache state per read path (public and private bucket, download(), two users) and JSON compression on the wire",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const org = ctx.orgs.pro ?? "";
    if (!org) return [{ id: "SS08", title: "SS08", status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    const out: TestResult[] = [];
    let p: Proj | undefined;
    let ref = "";
    try {
      try {
        p = await provision(ctx, org, "ss08");
        ref = p.ref;
      } catch (e) {
        ref = (e as { ref?: string }).ref ?? "";
        throw e;
      }
      const rest = `${p.apiBase}/storage/v1`;
      const svc = { apikey: p.service, Authorization: `Bearer ${p.service}` };
      const setup: Record<string, string | number> = {};

      const ver = await fetch(`${rest}/version`).then((r) => r.text()).catch(() => "");
      setup.storage_version = ver.slice(0, 40) || "unknown";
      for (const [id, pub] of [["pub", true], ["priv", false]] as const) {
        const r = await fetch(`${rest}/bucket`, {
          method: "POST",
          headers: { ...svc, "content-type": "application/json" },
          body: JSON.stringify({ id, name: id, public: pub }),
        });
        setup[`bucket_${id}`] = r.status;
      }
      const pol = await mgmtSql(ctx, ref, `create policy ss08_auth_read on storage.objects for select to authenticated using (bucket_id = 'priv')`);
      setup.policy_priv_authenticated_read = pol.status;
      // createSignedUrl needs a select policy even on a public bucket: the
      // 2026-10-21T04-04 run had none on pub and its signed-URL cells failed.
      const polPub = await mgmtSql(ctx, ref, `create policy ss08_auth_read_pub on storage.objects for select to authenticated using (bucket_id = 'pub')`);
      setup.policy_pub_authenticated_read = polPub.status;

      // Recording fetch: the request supabase-js sends, without credentials.
      // It also keeps the last storage response's headers, so a download()
      // is measured from its own single request.
      const sent: { method: string; path: string; headers: string }[] = [];
      let last: Headers | undefined;
      let lastStatus = 0;
      const recFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        const r = await fetch(input, init);
        if (u.pathname.startsWith("/storage/")) {
          const hs = new Headers(init?.headers);
          sent.push({ method: init?.method ?? "GET", path: u.pathname, headers: [...hs.keys()].sort().join(",") });
          last = r.headers;
          lastStatus = r.status;
        }
        return r;
      };
      const mk = () => createClient(p!.apiBase, p!.anon, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: recFetch as typeof fetch } });
      const users: Record<"A" | "B", { sb: SupabaseClient; jwt: string }> = {} as never;
      const rand = crypto.randomUUID().slice(0, 8);
      for (const who of ["A", "B"] as const) {
        const email = `ss08-${who.toLowerCase()}-${rand}${"@"}example.com`;
        const password = `${crypto.randomUUID()}Aa1!`;
        const cu = await fetch(`${p.apiBase}/auth/v1/admin/users`, {
          method: "POST",
          headers: { ...svc, "content-type": "application/json" },
          body: JSON.stringify({ email, password, email_confirm: true }),
        });
        const sb = mk();
        const si = await sb.auth.signInWithPassword({ email, password });
        users[who] = { sb, jwt: si.data.session?.access_token ?? "" };
        setup[`user_${who}`] = `${cu.status}/${si.error ? si.error.message : "signed in"}`;
      }
      const anonSb = mk();

      const body = payload(800_000);
      const gz = gzipSync(Buffer.from(body));
      setup.json_bytes = body.length;
      setup.json_gzip_bytes = gz.length;

      let n = 0;
      const fresh = async (bucket: string, opts: { cacheControl?: string; gzip?: boolean } = {}) => {
        const key = `ss08/${Date.now()}-${n++}.json`;
        const r = await fetch(`${rest}/object/${bucket}/${key}`, {
          method: "POST",
          headers: {
            ...svc,
            "content-type": "application/json",
            "cache-control": `max-age=${opts.cacheControl ?? "3600"}`,
            "x-upsert": "true",
            ...(opts.gzip ? { "content-encoding": "gzip" } : {}),
          },
          body: opts.gzip ? gz : body,
        });
        if (r.status !== 200) throw new Error(`upload ${bucket}/${key}: HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
        return key;
      };
      const auth = (jwt: string) => ({ apikey: p!.anon, Authorization: `Bearer ${jwt}` });
      const objUrl = (bucket: string, key: string) => `${rest}/object/${bucket}/${key}`;
      const pubUrl = (key: string) => anonSb.storage.from("pub").getPublicUrl(key).data.publicUrl;
      // download() through the SDK: one request, its status and headers from
      // the recording fetch, bytes from the Blob the SDK returns.
      const dl = async (sb: SupabaseClient, bucket: string, key: string): Promise<Read> => {
        last = undefined;
        lastStatus = 0;
        const t = performance.now();
        const { data, error } = await sb.storage.from(bucket).download(key);
        const ms = performance.now() - t;
        const bytes = data ? (await data.arrayBuffer()).byteLength : 0;
        const h = (k: string) => last?.get(k) ?? "";
        const cf = error ? `sdk error ${error.message.slice(0, 60)} ${h("cf-cache-status")}` : h("cf-cache-status");
        return { status: lastStatus, cf, cc: h("cache-control"), age: h("age"), ce: h("content-encoding"), bytes, ms };
      };
      const series = async (rows: Record<string, string>, prefix: string, steps: [string, () => Promise<Read>][]) => {
        for (const [label, f] of steps) {
          rows[`${prefix}_${label}`] = line(await f());
          await sleep(GAP_MS);
        }
      };

      out.push({ id: "SS08_setup", title: "project, buckets, users, policy, payload", status: "info", detail: `storage ${setup.storage_version}; json ${body.length} B, gzip ${gz.length} B`, measurements: setup });

      // ---- SS08a / SS08b: cache state per path ----
      for (const [rid, bucket] of [["SS08a", "pub"], ["SS08b", "priv"]] as const) {
        const m: Record<string, string> = {};
        const A = users.A;
        const B = users.B;
        let k = await fresh(bucket);
        await series(m, "download", [
          ["1_userA", () => dl(A.sb, bucket, k)],
          ["2_userA", () => dl(A.sb, bucket, k)],
          ["3_userB", () => dl(B.sb, bucket, k)],
          ...(bucket === "pub" ? ([["4_anonkey", () => dl(anonSb, bucket, k)]] as [string, () => Promise<Read>][]) : []),
        ]);
        if (bucket === "pub") {
          k = await fresh(bucket);
          await series(m, "public_url", [
            ["1", () => get(pubUrl(k))],
            ["2", () => get(pubUrl(k))],
          ]);
        }
        k = await fresh(bucket);
        await series(m, "authenticated", [
          ["1_userA", () => get(`${rest}/object/authenticated/${bucket}/${k}`, auth(A.jwt))],
          ["2_userA", () => get(`${rest}/object/authenticated/${bucket}/${k}`, auth(A.jwt))],
          ["3_userB", () => get(`${rest}/object/authenticated/${bucket}/${k}`, auth(B.jwt))],
        ]);
        k = await fresh(bucket);
        const one = (await A.sb.storage.from(bucket).createSignedUrl(k, 3600)).data?.signedUrl ?? "";
        await series(m, "signed_reused", [
          ["1", () => get(one)],
          ["2", () => get(one)],
          ["3", () => get(one)],
        ]);
        k = await fresh(bucket);
        const freshSigned = async () => get((await A.sb.storage.from(bucket).createSignedUrl(k, 3600)).data?.signedUrl ?? "");
        await series(m, "signed_fresh", [
          ["1", freshSigned],
          ["2", freshSigned],
          ["3", freshSigned],
        ]);
        if (bucket === "pub") {
          k = await fresh(bucket);
          await series(m, "warm_public_then_download", [
            ["1_public", () => get(pubUrl(k))],
            ["2_download_userA", () => dl(A.sb, bucket, k)],
          ]);
        }
        k = await fresh(bucket, { cacheControl: "31536000" });
        await series(m, "download_cc1y", [
          ["1_userA", () => dl(A.sb, bucket, k)],
          ["2_userA", () => dl(A.sb, bucket, k)],
          ["3_userB", () => dl(B.sb, bucket, k)],
        ]);
        const hits = Object.entries(m).filter(([, v]) => v.includes("cf=HIT")).map(([c]) => c);
        out.push({
          id: rid,
          title: `${bucket === "pub" ? "public" : "private"} bucket: cache state per read path, fresh key per cell`,
          status: "info",
          detail: `cells with cf=HIT: ${hits.length ? hits.join(", ") : "none"}`,
          measurements: m,
        });
      }

      // ---- SS08c: the request download() sent ----
      const dls = sent.filter((s) => s.method === "GET" && /^\/storage\/v1\/object\/(pub|priv)\//.test(s.path));
      out.push({
        id: "SS08c",
        title: "the request supabase-js download() sends",
        status: "info",
        detail: dls[0] ? `${dls[0].method} ${dls[0].path.replace(/\/ss08\/.*/, "/<key>")}` : "no download request recorded",
        measurements: {
          supabase_js_version: "2.112.3",
          download_requests_recorded: dls.length,
          download_method: dls[0]?.method ?? "none",
          download_path_shape: dls[0]?.path.replace(/\/ss08\/.*/, "/<key>") ?? "none",
          download_header_names: dls[0]?.headers ?? "none",
        },
      });

      // ---- SS08d: plain JSON on the wire ----
      {
        const m: Record<string, string | number> = { json_bytes: body.length, json_gzip_bytes_local: gz.length };
        const kp = await fresh("pub");
        const ae = { "Accept-Encoding": "gzip, br" };
        m.public_1_accept_gzip_br = await wire(pubUrl(kp), ae);
        await sleep(GAP_MS);
        m.public_2_accept_gzip_br = await wire(pubUrl(kp), ae);
        await sleep(GAP_MS);
        m.public_3_no_accept_encoding = await wire(pubUrl(kp), {});
        const kd = await fresh("pub");
        m.download_path_1_accept_gzip = await wire(objUrl("pub", kd), { ...auth(users.A.jwt), "Accept-Encoding": "gzip" });
        await sleep(GAP_MS);
        m.download_path_2_accept_gzip = await wire(objUrl("pub", kd), { ...auth(users.A.jwt), "Accept-Encoding": "gzip" });
        await sleep(GAP_MS);
        m.download_path_3_no_accept_encoding = await wire(objUrl("pub", kd), auth(users.A.jwt));
        const kq = await fresh("priv");
        m.private_download_path_1_accept_gzip = await wire(objUrl("priv", kq), { ...auth(users.A.jwt), "Accept-Encoding": "gzip" });
        await sleep(GAP_MS);
        m.private_download_path_2_accept_gzip = await wire(objUrl("priv", kq), { ...auth(users.A.jwt), "Accept-Encoding": "gzip" });
        out.push({ id: "SS08d", title: "plain application/json object: Content-Encoding and wire bytes per read", status: "info", measurements: m });
      }

      // ---- SS08e: client-side gzip, stored with Content-Encoding: gzip ----
      {
        const m: Record<string, string | number> = { json_bytes: body.length, uploaded_gzip_bytes: gz.length };
        const kg = await fresh("pub", { gzip: true });
        m.public_1_accept_gzip = await wire(pubUrl(kg), { "Accept-Encoding": "gzip" });
        await sleep(GAP_MS);
        m.public_2_accept_gzip = await wire(pubUrl(kg), { "Accept-Encoding": "gzip" });
        await sleep(GAP_MS);
        m.public_3_no_accept_encoding = await wire(pubUrl(kg), {});
        m.download_path_accept_gzip = await wire(objUrl("pub", kg), { ...auth(users.A.jwt), "Accept-Encoding": "gzip" });
        const { data, error } = await users.A.sb.storage.from("pub").download(kg);
        const text = data ? await data.text() : "";
        const same = text === body;
        m.sdk_download_result = error ? `error ${error.message.slice(0, 80)}` : `${text.length} chars, equals original JSON: ${same}`;
        const md = await mgmtSql(ctx, ref, `select metadata->>'mimetype' as mt, metadata->>'contentLength' as cl, metadata->>'size' as sz from storage.objects where bucket_id = 'pub' and name = '${kg}'`);
        m.stored_metadata = md.rows[0] ? `mimetype=${md.rows[0].mt} contentLength=${md.rows[0].cl} size=${md.rows[0].sz}` : md.text.slice(0, 100);
        out.push({
          id: "SS08e",
          title: "JSON gzipped client-side, stored with Content-Encoding: gzip: wire bytes, and what download() returns",
          status: same ? "pass" : "fail",
          detail: `download() returned the original JSON: ${same}`,
          measurements: m,
        });
      }
    } catch (e) {
      out.push({ id: "SS08", title: "SS08 aborted", status: "fail", detail: `threw: ${(e as Error).message}` });
    } finally {
      if (ref) {
        const del = await teardown(ctx, ref);
        out.push({ id: "SS08_teardown", title: "project deleted", status: del >= 200 && del < 300 ? "info" : "fail", detail: `DELETE HTTP ${del}` });
      }
    }
    return out;
  },
};

export default mod;
