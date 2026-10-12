/**
 * SS03 - S3 contract on large objects, TUS and client-side encrypted objects
 * (the SS03, SS04 and SS05 rows of PLAN.md), on ONE target per run.
 *
 * Target (named in the SS03_target row of every run):
 *   managed   a throwaway Pro-org project `ss-ss03-<epoch>` in ap-southeast-1,
 *             created here and deleted in `finally`. Two hosts: the gateway
 *             `<ref>.supabase.co` and the direct storage host
 *             `<ref>.storage.supabase.co`. S3 auth is the session-token form
 *             (key id = ref, secret = anon key, token = service_role JWT).
 *   sh-*      the local self-hosted stack of experiments/self-hosted-defaults,
 *             when PVLAB_ENDPOINT_STACK_DIR and PVLAB_ENDPOINT_GW are set
 *             (`make probe-sh`). One host (the Envoy gateway). S3 auth is the
 *             stack's S3_PROTOCOL_ACCESS_KEY_ID / _SECRET. The kind is
 *             `sh-<STORAGE_BACKEND>@<storage image tag>`, read from the
 *             running container.
 * The same row ids and measurement keys on every target, so SS06 (and
 * `pvlab --diff`) can line runs up row by row.
 *
 *   SS03_target  kind, storage server version, default upload limit, S3
 *                protocol default (managed), raise of the limit
 *   SS03a  multipart upload of `big` (2 GiB, 128 x 16 MiB parts): per-part
 *          ETag vs local MD5, ListParts mid-upload, final ETag vs the AWS
 *          convention; AbortMultipartUpload on a 2-part upload
 *   SS03b  the client stops after 40 parts (process exit); a new process
 *          finds the upload (ListMultipartUploads, ListParts), uploads the
 *          rest and completes; SHA-256 of a full GET equals the fixture
 *   SS03c  single-range GET on `mid` and `big` (S3 GetObject and REST
 *          /object/authenticated): first, middle, suffix, open, past EOF,
 *          multi-range, mixed-case unit; Accept-Ranges on HEAD and GET
 *   SS03d  one range through every read path and host, each path and host on
 *          its own fresh server-side copy so the first read is cold, then a
 *          repeat read; cf-cache-status, and time to first byte vs total for
 *          `big`; whether a read on one path or host warms another
 *          (PVLAB_ENDPOINT_SS03_ROWS=SS03d,SS03k re-runs just these rows)
 *   SS03e  conditional reads (If-None-Match, If-Match, If-Modified-Since,
 *          If-Unmodified-Since, precedence), GET and HEAD, every path; a
 *          wrong If-Match on a warmed ranged read; a ranged If-Match on the
 *          pre-overwrite ETag
 *   SS03f  conditional writes: PutObject If-None-Match:* and stale If-Match,
 *          CompleteMultipartUpload and CreateMultipartUpload with
 *          If-None-Match:*, UploadPartCopy with a wrong copy-source If-Match
 *   SS03g  checksums: SHA-256 / CRC32 / Content-MD5 right and wrong, the
 *          SDK default and WHEN_REQUIRED, aws-chunked trailer right and
 *          wrong, ChecksumMode reads, GetObjectAttributes, per-part SHA-256,
 *          partNumber reads, ETag of an unknown-length PutObject
 *   SS03h  CORS preflight and actual responses per path; PutBucketCors and
 *          GetBucketCors
 *   SS03i  error bodies (NoSuchKey, NoSuchBucket, wrong secret, InvalidKey,
 *          InvalidRange, EntityTooLarge at the default limit) on S3 and REST
 *   SS03j  wall time of the `big` upload and download (one vantage, info)
 *   SS03k  a 256 MiB-input gzip object stored with Content-Encoding: gzip,
 *          and `big`, read whole through every path and host, first and
 *          repeat: Content-Length, Content-Encoding, cf-cache-status, bytes,
 *          hash
 *   SS03l  SSE-C, SSE-S3 (AES256) and SSE-KMS headers on PutObject and
 *          CreateMultipartUpload; GetBucketEncryption
 *   SS04a  `big` through TUS (tus-js-client, 6 MiB chunks), SHA-256 of a GET;
 *          `mid` with 5, 6 and 8 MiB chunks
 *   SS04b  SIGKILL after 20 chunks, resume from the stored upload URL in a
 *          new process; managed: kill on the gateway, resume on the direct host
 *   SS04c  the TUS object read through S3 (ETag form, a range)
 *   SS04d  Upload-Expires on the creation response; TUS to an existing key
 *          without x-upsert
 *   SS05a  `mid` encrypted client-side (AES-256-GCM, 4 MiB chunks), chunk-
 *          aligned range reads decrypt to the plaintext slices
 *   SS05b  the storage.objects metadata recorded for it
 *   SS05c  image render on the ciphertext (PNG control); content type stored
 *          for uploads sent without one
 *   SS05d  an RLS select policy on /object/authenticated and on S3 with a
 *          user JWT session token: before the policy, owner, other user, anon
 *
 * Pass/fail only where the row has a stated expectation (completion, hash
 * equality, decrypt, RLS allow/deny); everything else is `info`, a recorded
 * value. Not settled by this module: throughput (one laptop vantage),
 * dashboard-generated S3 keys (no API), any region other than ap-southeast-1,
 * repeat runs.
 *
 * DESTRUCTIVE: managed - one project, deleted in finally. Self-hosted - two
 * buckets, the storage service re-created with a raised FILE_SIZE_LIMIT, two
 * auth users and one storage.objects policy; `make clean` in the rig removes
 * all of it. Fixtures (2 GiB + 64 MiB + 256 MiB) live in the gitignored
 * evidence/fixtures/; `make clean-fixtures` deletes them.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import {
  type Proj,
  type Target,
  canary,
  managedTarget,
  mgmtRetry,
  mgmtSql,
  provision,
  raiseStackLimit,
  sleep,
  stackOf,
  stackSql,
  stackTarget,
  storageConfig,
  storageContainer,
  teardown,
  tusChild,
} from "../lib";

const ID = "SS03";
const FIX_DIR = new URL("../evidence/fixtures/", import.meta.url).pathname;
const RAISED_LIMIT = 10 * 1024 * 1024 * 1024; // 10 GiB
const PUB = "ss-pub";
const PRIV = "ss-priv";
const MiB = 1024 * 1024;

const TITLES: Record<string, string> = {
  SS03_target: "target: kind, storage version, upload limit",
  SS03a: "multipart upload of big (2 GiB, 16 MiB parts): ETags, ListParts, abort",
  SS03b: "multipart resume in a new process; SHA-256 of the GET",
  SS03c: "single-range GET on mid and big (S3 and REST)",
  SS03d: "one range through every read path and host on a fresh key (cold first read), repeat read, timing; cross-path warming",
  SS03e: "conditional reads, GET and HEAD, every path",
  SS03f: "conditional writes",
  SS03g: "checksums and ETag forms",
  SS03h: "CORS preflight and response headers; bucket CORS API",
  SS03i: "error bodies on S3 and REST",
  SS03j: "wall time of the big upload and download, one vantage",
  SS03k: "large and gzip-encoded objects read whole through every path, fresh key per path and host",
  SS03l: "server-side encryption headers",
  SS04a: "big through TUS (6 MiB chunks); other chunk sizes on mid",
  SS04b: "TUS resume after SIGKILL from the stored upload URL",
  SS04c: "TUS object read through S3",
  SS04d: "TUS upload URL lifetime; existing key without x-upsert",
  SS05a: "client-side encrypted object: chunk-aligned range reads decrypt",
  SS05b: "storage.objects metadata recorded for the encrypted object",
  SS05c: "image render and content-type sniffing on the encrypted object",
  SS05d: "RLS select policy on REST and on S3 with a user JWT session token",
};

/** REST bulk delete (service role). */
async function removeObjects(t: Target, bucket: string, names: string[]): Promise<number> {
  const r = await fetch(`${t.hosts[0]!.rest}/object/${bucket}`, {
    method: "DELETE",
    headers: { apikey: t.service, authorization: `Bearer ${t.service}`, "content-type": "application/json" },
    body: JSON.stringify({ prefixes: names }),
  });
  await r.text();
  return r.status;
}

const mod: TestModule = {
  id: ID,
  title: "S3 contract, TUS and client-side encrypted objects (SS03-SS05 rows) on one target",
  where: "local",
  requires: [],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const stack = stackOf(ctx);
    const org = ctx.orgs.pro ?? "";
    if (!stack && (!org || !ctx.pat)) return [{ id: ID, title: this.title, status: "skip", detail: "neither a self-hosted stack (PVLAB_ENDPOINT_STACK_DIR/GW) nor PVLAB_ORG_PRO + a PAT" }];
    if (!Bun.which("node")) return [{ id: ID, title: this.title, status: "skip", detail: "node not on PATH (the canary runs under Node)" }];
    // PVLAB_ENDPOINT_SS03_ROWS=SS03d,SS03k re-runs selected rows: setup and the
    // uploads they read still happen, other rows are not emitted.
    const only = (ctx.endpoints["ss03_rows"] ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    const want = (id: string) => !only.length || id === "SS03_target" || only.some((o) => id === o || id.startsWith(o));
    const meas: Record<string, Record<string, string | number>> = {};
    const status: Record<string, TestResult["status"]> = {};
    const detail: Record<string, string> = {};
    const m = (row: string, k: string, v: string | number) => ((meas[row] ??= {})[k] = v);
    const merge = (rows: Record<string, Record<string, string | number>>) => {
      for (const [row, kv] of Object.entries(rows ?? {})) for (const [k, v] of Object.entries(kv)) m(row, k, v);
    };
    let ref = "";
    let t: Target;
    let sql: (q: string) => Promise<{ ok: boolean; rows: any[][]; err: string }>;
    try {
      // ---- target ----
      let proj: Proj | null = null;
      if (stack) {
        const sc = await storageContainer();
        if (!sc) throw new Error("supabase-storage container not found");
        t = stackTarget(stack, sc.backend, sc.image);
        sql = stackSql;
        m("SS03_target", "storage_image", sc.image);
        m("SS03_target", "default_file_size_limit", sc.limit);
      } else {
        try {
          proj = await provision(ctx, org, "ss03");
        } catch (e) {
          ref = (e as { ref?: string }).ref ?? "";
          throw e;
        }
        ref = proj.ref;
        t = managedTarget(proj);
        sql = async (q) => {
          const r = await mgmtSql(ctx, ref, q);
          return { ok: r.status < 300, rows: r.rows.map((x) => Object.values(x).map((v) => (typeof v === "string" ? v : JSON.stringify(v)))), err: r.status < 300 ? "" : r.text.slice(0, 300) };
        };
        const cfg = await storageConfig(ctx, ref);
        const j = (cfg.json ?? {}) as { fileSizeLimit?: number; features?: Record<string, { enabled?: boolean }> };
        m("SS03_target", "default_file_size_limit", String(j.fileSizeLimit ?? cfg.status));
        m("SS03_target", "default_s3_protocol_enabled", String(j.features?.s3Protocol?.enabled ?? "absent"));
        m("SS03_target", "default_image_transformation_enabled", String(j.features?.imageTransformation?.enabled ?? "absent"));
        if (j.features?.s3Protocol?.enabled === false) {
          const p = await mgmtRetry(ctx, "PATCH", `/projects/${ref}/config/storage`, { features: { ...j.features, s3Protocol: { enabled: true } } });
          m("SS03_target", "s3_protocol_enable_patch", p.status);
        }
      }
      const gwHost = t.hosts[0]!;
      m("SS03_target", "kind", t.kind);
      const ver = await fetch(`${gwHost.rest}/version`, { headers: { apikey: t.anon } }).then((r) => r.text()).catch((e) => `ERR ${e}`);
      m("SS03_target", "storage_version", ver.trim().slice(0, 30));
      m("SS03_target", "hosts", t.hosts.map((h) => h.name).join(","));

      // ---- buckets ----
      for (const [id, pub] of [
        [PUB, true],
        [PRIV, false],
      ] as const) {
        const r = await fetch(`${gwHost.rest}/bucket`, {
          method: "POST",
          headers: { apikey: t.service, authorization: `Bearer ${t.service}`, "content-type": "application/json" },
          body: JSON.stringify({ id, name: id, public: pub }),
        });
        m("SS03_target", `create_bucket_${id}`, r.status);
      }

      // ---- preflight: does the target take a 1 KiB upload at all ----
      const pf = await canary("upload.ts", { target: t, cmd: "preflight", host: gwHost.name, bucket: PUB });
      m("SS03_target", "preflight_s3_put_1KiB", pf.s3);
      m("SS03_target", "preflight_rest_post_1KiB", pf.rest);
      if (stack && /localhost/.test(gwHost.s3)) {
        // The self-hosted server verifies SigV4 against STORAGE_PUBLIC_URL's host; record what a client on the loopback address gets.
        const alt = { ...t, hosts: [{ ...gwHost, s3: gwHost.s3.replace("localhost", "127.0.0.1") }] };
        const a = await canary("upload.ts", { target: alt, cmd: "list-buckets", host: gwHost.name });
        const b = await canary("upload.ts", { target: t, cmd: "list-buckets", host: gwHost.name });
        m("SS03_target", "s3_list_buckets_via_127_0_0_1", `${a.status} ${a.code || "ok"}`);
        m("SS03_target", "s3_list_buckets_via_public_url_host", `${b.status} ${b.code || "ok"}`);
      }
      if (!pf.ok) throw new Error("preflight: a 1 KiB upload was refused on both S3 and REST; battery not run");

      // ---- fixtures ----
      const fx = await canary("fixtures.ts", { dir: FIX_DIR });
      m("SS03_target", "fixture_sizes", `big=${fx.big.size} mid=${fx.mid.size} gz=${fx.gz.size} (gz of ${fx.gz.plainSize})`);
      const base = { target: t, fx };

      // ---- EntityTooLarge at the default limit, then raise it ----
      if (want("SS03i")) merge((await canary("battery.ts", { ...base, cmd: "too-large", bucket: PUB })).rows);
      if (stack) {
        const r = await raiseStackLimit(RAISED_LIMIT);
        m("SS03_target", "raise_limit", r.detail);
      } else {
        const p = await mgmtRetry(ctx, "PATCH", `/projects/${ref}/config/storage`, { fileSizeLimit: RAISED_LIMIT });
        const after = await storageConfig(ctx, ref);
        m("SS03_target", "raise_limit", `PATCH ${p.status}; fileSizeLimit now ${(after.json as { fileSizeLimit?: number })?.fileSizeLimit ?? after.status}`);
      }
      // the new limit has to reach the storage server: poll with a 64 MiB PutObject
      let accepted = "";
      const t0 = Date.now();
      while (Date.now() - t0 < 5 * 60_000) {
        const r = await canary("upload.ts", { ...base, cmd: "put-file", bucket: PUB, key: "mid.bin", path: fx.mid.path });
        if (r.ok) {
          accepted = `${Math.round((Date.now() - t0) / 1000)}s`;
          m("SS03_target", "mid_put_etag", String(r.etag));
          break;
        }
        await sleep(10_000);
      }
      m("SS03_target", "raised_limit_effective_after", accepted || "not within 300 s");
      if (!accepted) throw new Error("raised upload limit never took effect");

      // ---- SS03a/b: multipart with a process boundary ----
      const upHost = t.hosts.find((h) => h.name === "direct")?.name ?? gwHost.name;
      const s = await canary("upload.ts", { ...base, cmd: "mpu-start", host: upHost, bucket: PUB, key: "big.bin", fx: fx.big, stopAfter: 40 });
      if (!s.ok) throw new Error(`mpu-start: ${JSON.stringify(s).slice(0, 300)}`);
      const r = await canary("upload.ts", { ...base, cmd: "mpu-resume", host: upHost, bucket: PUB, key: "big.bin", fx: fx.big, uploadId: s.uploadId });
      const partOk = (s.parts as any[]).filter((p) => p.md5match).length + (r.md5matchHere ?? 0);
      const etag = String(r.etag ?? "").replace(/"/g, "");
      m("SS03a", "upload_host", upHost);
      m("SS03a", "parts_total", fx.big.partMd5.length);
      m("SS03a", "part_etag_equals_local_md5", `${partOk}/${fx.big.partMd5.length}`);
      m("SS03a", "list_parts_mid_upload", `${s.listParts.status} count=${s.listParts.count} etags_match=${s.listParts.etagsMatch} sizes=${s.listParts.sizes}`);
      m("SS03a", "complete", `${r.completeStatus ?? "-"} ${r.completeCode || (r.ok ? "ok" : r.failed ?? "")}`.trim());
      m("SS03a", "final_etag_form", etag === r.expectedAws ? "aws-multipart (md5 of part md5s, -128)" : etag === fx.big.md5 ? "md5-of-object" : /-\d+$/.test(etag) ? `md5-dash-${etag.split("-")[1]}, not the AWS value` : etag ? "other" : "absent");
      const ab = await canary("upload.ts", { ...base, cmd: "abort", host: gwHost.name, bucket: PUB, key: "abort.bin", fx: fx.mid });
      m("SS03a", "abort", `parts before=${ab.partsBefore}; abort ${ab.abortStatus} ${ab.abortCode || ""}; ListParts after: ${ab.listPartsAfter}; still in ListMultipartUploads: ${ab.stillListed}; HEAD key: ${ab.headAfter}`.replace(/\s+/g, " "));
      status.SS03a = r.ok && partOk === fx.big.partMd5.length ? "pass" : "fail";
      m("SS03b", "stopped_after_parts", (s.parts as any[]).length);
      m("SS03b", "new_process_list_multipart_uploads_finds_it", String(r.listedUpload));
      m("SS03b", "new_process_list_parts_count", r.listPartsCount ?? -1);
      m("SS03b", "uploaded_in_new_process", r.uploadedHere ?? -1);
      const g = await canary("upload.ts", { ...base, cmd: "get-sha", host: gwHost.name, bucket: PUB, key: "big.bin" });
      m("SS03b", "get_sha256_equals_fixture", g.ok ? String(g.sha256 === fx.big.sha256) : `${g.status} ${g.code}`);
      m("SS03b", "get_bytes", g.bytes ?? -1);
      status.SS03b = g.ok && g.sha256 === fx.big.sha256 ? "pass" : "fail";
      m("SS03j", "big_upload_s", Math.round(((s.ms ?? 0) + (r.ms ?? 0)) / 100) / 10);
      m("SS03j", "big_upload_host", upHost);
      m("SS03j", "big_download_s", Math.round((g.ms ?? 0) / 100) / 10);
      m("SS03j", "big_download_host", gwHost.name);
      m("SS03j", "big_bytes", fx.big.size);

      // gz object for SS03k, stored with Content-Encoding: gzip
      const gz = await canary("upload.ts", { ...base, cmd: "put-file", host: gwHost.name, bucket: PUB, key: "gz.bin", path: fx.gz.path, extra: { contentEncoding: "gzip", contentType: "application/octet-stream" } });
      m("SS03k", "gz_put", `${gz.status} ${gz.code || "ok"}`);

      // ---- SS03c-l ----
      merge((await canary("battery.ts", { ...base, cmd: "ss03", bucket: PUB, rows: only.length ? only : undefined })).rows);
      // Free the 2 GiB and 256 MiB objects before the TUS copy of big (a local MinIO volume is the tight one).
      await removeObjects(t, PUB, ["big.bin", "gz.bin"]);

      if (want("SS04")) {
        // ---- SS04 TUS ----
        const tusHeaders = { authorization: `Bearer ${t.service}`, apikey: t.service, "x-upsert": "true" };
        const ep = (hn: string) => `${(t.hosts.find((h) => h.name === hn) ?? gwHost).rest}/upload/resumable`;
        const tus = (o: Record<string, unknown>) => ({ headers: tusHeaders, bucket: PUB, chunkSize: 6 * MiB, ...o });
        const k1 = await tusChild(tus({ endpoint: ep(upHost), file: fx.big.path, size: fx.big.size, key: "tus-big.bin" }), 20);
        const created = k1.lines.find((l) => l.resp?.method === "POST")?.resp;
        const url = k1.lines.filter((l) => l.url).at(-1)?.url ?? "";
        m("SS04d", "creation_status", created?.status ?? -1);
        const exp = created?.headers?.["upload-expires"] ?? "";
        m("SS04d", "upload_expires_header", exp ? "present" : "absent");
        m("SS04d", "upload_expires_hours_from_now", exp ? Math.round(((Date.parse(exp) - Date.now()) / 3_600_000) * 10) / 10 : "-");
        m("SS04d", "location_host_is", created?.headers?.location ? new URL(created.headers.location, ep(upHost)).host === new URL(ep(upHost)).host ? "the host posted to" : "another host" : "-");
        m("SS04b", "big_killed_after_chunks", k1.lines.filter((l) => l.chunk).length);
        m("SS04b", "big_killed", String(k1.killed));
        const k2 = await tusChild(tus({ endpoint: ep(upHost), uploadUrl: url, file: fx.big.path, size: fx.big.size, key: "tus-big.bin" }), 0);
        const head = k2.lines.find((l) => l.resp?.method === "HEAD")?.resp;
        const done2 = k2.lines.find((l) => l.done);
        m("SS04b", "big_resume_head", `${head?.status ?? "-"} upload-offset=${head?.headers?.["upload-offset"] ?? "-"}`);
        m("SS04b", "big_resume_outcome", done2?.ok ? `completed, ${done2.chunks} more chunks` : `failed: ${done2?.status ?? ""} ${done2?.error ?? "no final line"}`.slice(0, 200));
        const tg = await canary("upload.ts", { ...base, cmd: "get-sha", host: gwHost.name, bucket: PUB, key: "tus-big.bin" });
        m("SS04a", "big_tus_upload_host", upHost);
        m("SS04a", "big_get_sha256_equals_fixture", tg.ok ? String(tg.sha256 === fx.big.sha256) : `${tg.status} ${tg.code}`);
        status.SS04a = tg.ok && tg.sha256 === fx.big.sha256 ? "pass" : "fail";
        // SS04c: TUS object through S3
        const hd = await canary("upload.ts", { ...base, cmd: "get-sha", host: gwHost.name, bucket: PUB, key: "tus-big.bin", range: `bytes=${MiB}-${MiB + 1023}` });
        m("SS04c", "s3_range_on_tus_object", hd.ok ? `${hd.status} cr=${hd.contentRange} bytes=${hd.bytes}` : `${hd.status} ${hd.code}`);
        const tusEtag = String(hd.etag ?? "").replace(/"/g, "");
        m("SS04c", "tus_object_etag_form", tusEtag === fx.big.md5 ? "md5-of-object" : /-\d+$/.test(tusEtag) ? `md5-dash-${tusEtag.split("-")[1]}` : tusEtag ? "32-hex, not the object MD5" : "absent");
        // free 2 GiB before the next uploads
        await removeObjects(t, PUB, ["tus-big.bin"]);
        for (const cs of [5, 6, 8]) {
          const c = await tusChild(tus({ endpoint: ep(gwHost.name), file: fx.mid.path, size: fx.mid.size, key: `tus-mid-${cs}.bin`, chunkSize: cs * MiB }), 0);
          const d = c.lines.find((l) => l.done);
          let v = d?.ok ? "completed" : `failed: ${d?.status ?? ""} ${(d?.body || d?.error || "").slice(0, 120)}`;
          if (d?.ok) {
            const gg = await canary("upload.ts", { ...base, cmd: "get-sha", host: gwHost.name, bucket: PUB, key: `tus-mid-${cs}.bin` });
            v += gg.sha256 === fx.mid.sha256 ? ", sha256 ok" : `, sha256 DIFF (${gg.status})`;
          }
          m("SS04a", `mid_chunk_${cs}MiB`, v);
          if (cs !== 6) await removeObjects(t, PUB, [`tus-mid-${cs}.bin`]);
        }
        if (t.hosts.length > 1) {
          const c1 = await tusChild(tus({ endpoint: ep("gateway"), file: fx.mid.path, size: fx.mid.size, key: "tus-cross.bin" }), 2);
          const u1 = c1.lines.filter((l) => l.url).at(-1)?.url ?? "";
          const direct = t.hosts.find((h) => h.name === "direct")!;
          const u2 = u1 ? `${new URL(direct.rest).origin}${new URL(u1).pathname}` : "";
          const c2 = await tusChild(tus({ endpoint: ep("direct"), uploadUrl: u2, file: fx.mid.path, size: fx.mid.size, key: "tus-cross.bin" }), 0);
          const hh = c2.lines.find((l) => l.resp?.method === "HEAD")?.resp;
          const d2 = c2.lines.find((l) => l.done);
          m("SS04b", "cross_host_gateway_to_direct", `HEAD ${hh?.status ?? "-"} offset=${hh?.headers?.["upload-offset"] ?? "-"}; ${d2?.ok ? "completed" : `failed: ${d2?.status ?? ""} ${(d2?.body || d2?.error || "").slice(0, 120)}`}`);
          if (d2?.ok) {
            const gg = await canary("upload.ts", { ...base, cmd: "get-sha", host: "gateway", bucket: PUB, key: "tus-cross.bin" });
            m("SS04b", "cross_host_sha256_equals_fixture", String(gg.sha256 === fx.mid.sha256));
          }
        } else m("SS04b", "cross_host_gateway_to_direct", "n/a (one host)");
        // SS04d: existing key without x-upsert
        const noUp = await tusChild({ ...tus({ endpoint: ep(gwHost.name), file: fx.png.path, size: fx.png.size, key: "tus-mid-6.bin" }), headers: { authorization: `Bearer ${t.service}`, apikey: t.service } }, 0);
        const dn = noUp.lines.find((l) => l.done);
        m("SS04d", "existing_key_without_x_upsert", dn?.ok ? "completed (overwrote)" : `refused: ${dn?.status ?? ""} ${(dn?.body || dn?.error || "").replace(/\s+/g, " ").slice(0, 140)}`);
      }
      if (want("SS05")) {
        // ---- SS05 ----
        merge((await canary("battery.ts", { ...base, cmd: "ss05", bucket: PRIV })).rows);
        const a = meas.SS05a ?? {};
        const chunkRows = Object.entries(a).filter(([k]) => /range_chunk/.test(k));
        status.SS05a = chunkRows.length > 0 && chunkRows.every(([, v]) => String(v).includes("decrypts to the plaintext slice")) ? "pass" : "fail";
        const md = await sql(`select metadata::text, coalesce(user_metadata::text,'null') from storage.objects where bucket_id = '${PRIV}' and name = 'enc.bin'`);
        if (md.ok && md.rows[0]) {
          const j = JSON.parse(md.rows[0][0] ?? "{}") as Record<string, unknown>;
          m("SS05b", "metadata_keys", Object.keys(j).sort().join(","));
          for (const k of ["size", "mimetype", "cacheControl", "contentLength", "httpStatusCode"]) m("SS05b", k, String(j[k] ?? "absent"));
          m("SS05b", "eTag_form", typeof j.eTag === "string" ? (/-\d+"?$/.test(j.eTag) ? "md5-dash-N" : "32-hex") : "absent");
          m("SS05b", "user_metadata", md.rows[0][1] ?? "");
        } else m("SS05b", "metadata_read", md.err || "no row");
        const nt = await sql(`select name, metadata->>'mimetype' from storage.objects where bucket_id = '${PRIV}' and name like 'notype-%' order by name`);
        for (const row of nt.rows) m("SS05c", `stored_mimetype_${String(row[0]).replace(/-/g, "_")}`, String(row[1] ?? "null"));

        // SS05d: users, then reads before and after an owner-only select policy
        const rand = crypto.randomUUID().slice(0, 8);
        const jwt: Record<string, string> = {};
        const uid: Record<string, string> = {};
        const authBase = gwHost.rest.replace(/\/storage\/v1$/, "/auth/v1");
        for (const who of ["user_a", "user_b"]) {
          const email = `ss05-${who.replace("_", "")}-${rand}${"@"}example.com`;
          const password = `${crypto.randomUUID()}Aa1!`;
          const cu = await fetch(`${authBase}/admin/users`, {
            method: "POST",
            headers: { apikey: t.service, authorization: `Bearer ${t.service}`, "content-type": "application/json" },
            body: JSON.stringify({ email, password, email_confirm: true }),
          });
          const cj = (await cu.json().catch(() => ({}))) as { id?: string };
          uid[who] = cj.id ?? "";
          const tk = await fetch(`${authBase}/token?grant_type=password`, {
            method: "POST",
            headers: { apikey: t.anon, "content-type": "application/json" },
            body: JSON.stringify({ email, password }),
          });
          jwt[who] = (((await tk.json().catch(() => ({}))) as { access_token?: string }).access_token ?? "") as string;
          m("SS05d", `${who}_created_and_signed_in`, `${cu.status}/${tk.status}`);
        }
        const objKey = `rls/${uid.user_a}/enc.bin`;
        const cp = await fetch(`${gwHost.rest}/object/copy`, {
          method: "POST",
          headers: { apikey: t.service, authorization: `Bearer ${t.service}`, "content-type": "application/json" },
          body: JSON.stringify({ bucketId: PRIV, sourceKey: "enc.bin", destinationKey: objKey }),
        });
        m("SS05d", "copy_object_for_user_a", cp.status);
        const jwts = { user_a: jwt.user_a!, user_b: jwt.user_b!, anon: t.anon };
        merge((await canary("battery.ts", { ...base, cmd: "ss05-rls", bucket: PRIV, key: objKey, jwts, tag: "before_policy" })).rows);
        const pol = await sql(
          `create policy ss05_owner_read on storage.objects for select to authenticated using (bucket_id = '${PRIV}' and name = 'rls/' || auth.uid()::text || '/enc.bin')`,
        );
        m("SS05d", "create_policy", pol.ok ? "ok" : pol.err);
        merge((await canary("battery.ts", { ...base, cmd: "ss05-rls", bucket: PRIV, key: objKey, jwts, tag: "after_policy" })).rows);
        const d = meas.SS05d ?? {};
        const okA = String(d.after_policy_rest_authenticated_user_a ?? "").startsWith("20") && String(d.after_policy_s3_session_token_user_a ?? "").startsWith("20");
        const denyB = !String(d.after_policy_rest_authenticated_user_b ?? "").startsWith("20") && !String(d.after_policy_s3_session_token_user_b ?? "").startsWith("20");
        const denyAnon = !String(d.after_policy_rest_authenticated_anon ?? "").startsWith("20");
        const beforeDenied = !String(d.before_policy_rest_authenticated_user_a ?? "").startsWith("20");
        status.SS05d = okA && denyB && denyAnon && beforeDenied ? "pass" : "fail";
        detail.SS05d = `owner allowed after policy: ${okA}; other user denied: ${denyB}; anon denied: ${denyAnon}; owner denied before policy: ${beforeDenied}`;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      m("SS03_target", "module_error", msg.slice(0, 400));
      status.SS03_target = "fail";
    } finally {
      if (ref) {
        const s = await teardown(ctx, ref).catch(() => -1);
        ctx.log(`SS03 teardown DELETE -> ${s}`);
        m("SS03_target", "teardown_delete_status", s);
      }
    }
    const out: TestResult[] = [];
    for (const id of Object.keys(TITLES).filter(want)) {
      const mm = meas[id];
      out.push({
        id,
        title: `${id}: ${TITLES[id]}`,
        status: status[id] ?? (mm ? (mm.battery_error ? "fail" : "info") : "skip"),
        detail: detail[id] ?? (mm ? `target ${String(meas.SS03_target?.kind ?? "?")}` : "row never produced"),
        measurements: mm,
      });
    }
    return out;
  },
};
export default mod;
