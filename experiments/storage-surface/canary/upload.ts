/**
 * Large uploads for SS03a/b and SS04, each command one child process so a
 * "client stops" step is a real process exit (multipart) or a SIGKILL from
 * the parent (TUS), and the resume runs in a fresh process with only what a
 * client would have persisted (the upload id, or the TUS upload URL).
 *
 *   echo '{"cmd":"mpu-start",...}'  | node upload.ts
 *   echo '{"cmd":"mpu-resume",...}' | node upload.ts
 *   echo '{"cmd":"get-sha",...}'    | node upload.ts
 *   echo '{"cmd":"tus",...}'        | node upload.ts   (one JSON line per chunk, then a final line)
 */
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListBucketsCommand,
  ListMultipartUploadsCommand,
  ListPartsCommand,
  PutObjectCommand,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { closeSync, createReadStream, openSync, readFileSync, readSync } from "node:fs";
import type { Readable } from "node:stream";
import * as tus from "tus-js-client";
import { PART, type Fix } from "./fixtures.ts";
import { type Host, type Target, s3c, scrubber, sdk } from "./target.ts";

function readPart(path: string, n: number, size: number): Buffer {
  const start = (n - 1) * PART;
  const len = Math.min(PART, size - start);
  const buf = Buffer.alloc(len);
  const fd = openSync(path, "r");
  readSync(fd, buf, 0, len, start);
  closeSync(fd);
  return buf;
}

const unq = (e?: string) => (e ?? "").replace(/"/g, "");

/** The AWS convention for a multipart ETag: MD5 of the concatenated binary part MD5s, then `-N`. */
export function awsMultipartEtag(partMd5: string[]): string {
  const h = createHash("md5");
  for (const m of partMd5) h.update(Buffer.from(m, "hex"));
  return `${h.digest("hex")}-${partMd5.length}`;
}

/** Name an ETag's form against the fixture: whole-object MD5, the AWS multipart value, or other. */
export function etagForm(etag: string, fx: Fix): string {
  const e = unq(etag).replace(/^W\//, "");
  if (!e) return "absent";
  if (e === fx.md5) return "md5-of-object";
  if (fx.partMd5.length > 1 && e === awsMultipartEtag(fx.partMd5)) return `aws-multipart-16MiB(-${fx.partMd5.length})`;
  const m = /^[0-9a-f]{32}-(\d+)$/.exec(e);
  if (m) return `md5-dash-${m[1]} (not the AWS value for 16 MiB parts)`;
  if (/^[0-9a-f]{32}$/.test(e)) return "32-hex, not the object MD5";
  return `other: ${e.slice(0, 40)}`;
}

async function mpuStart(t: Target, h: Host, bucket: string, key: string, fx: Fix, stopAfter: number) {
  const c = s3c(t, h);
  const t0 = performance.now();
  const cr = await sdk(() => c.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: "application/octet-stream" })));
  if (!cr.ok) return { ok: false, step: "create", status: cr.status, code: cr.code, msg: cr.msg };
  const uploadId = cr.r!.UploadId!;
  const parts: Array<{ n: number; etag: string; md5match: boolean; status: number; code: string }> = [];
  for (let n = 1; n <= stopAfter; n++) {
    const body = readPart(fx.path, n, fx.size);
    const r = await sdk(() => c.send(new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumber: n, Body: body })));
    parts.push({ n, etag: r.r?.ETag ?? "", md5match: unq(r.r?.ETag) === fx.partMd5[n - 1], status: r.status, code: r.code });
    if (!r.ok) break;
  }
  const lp = await sdk(() => c.send(new ListPartsCommand({ Bucket: bucket, Key: key, UploadId: uploadId })));
  const listed = lp.r?.Parts ?? [];
  return {
    ok: true,
    uploadId,
    parts,
    ms: performance.now() - t0,
    listParts: {
      status: lp.status,
      code: lp.code,
      count: listed.length,
      etagsMatch: listed.filter((p) => unq(p.ETag) === fx.partMd5[(p.PartNumber ?? 0) - 1]).length,
      sizes: [...new Set(listed.map((p) => p.Size))].join(","),
    },
  };
}

async function mpuResume(t: Target, h: Host, bucket: string, key: string, fx: Fix, uploadId: string) {
  const c = s3c(t, h);
  const t0 = performance.now();
  const lu = await sdk(() => c.send(new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: key })));
  const listedUpload = (lu.r?.Uploads ?? []).some((u) => u.UploadId === uploadId && u.Key === key);
  const lp = await sdk(() => c.send(new ListPartsCommand({ Bucket: bucket, Key: key, UploadId: uploadId })));
  const have = new Map((lp.r?.Parts ?? []).map((p) => [p.PartNumber!, p.ETag!]));
  const total = fx.partMd5.length;
  const partTimes: number[] = [];
  let failed = "";
  const etags: Array<{ ETag: string; PartNumber: number }> = [];
  let md5match = 0;
  for (let n = 1; n <= total; n++) {
    if (have.has(n)) {
      etags.push({ ETag: have.get(n)!, PartNumber: n });
      continue;
    }
    const body = readPart(fx.path, n, fx.size);
    const p0 = performance.now();
    const r = await sdk(() => c.send(new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumber: n, Body: body })));
    partTimes.push(performance.now() - p0);
    if (!r.ok) {
      failed = `part ${n}: ${r.status} ${r.code} ${r.msg}`;
      break;
    }
    if (unq(r.r?.ETag) === fx.partMd5[n - 1]) md5match++;
    etags.push({ ETag: r.r!.ETag!, PartNumber: n });
  }
  if (failed) return { ok: false, listedUpload, listPartsCount: have.size, failed, ms: performance.now() - t0 };
  const done = await sdk(() => c.send(new CompleteMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId, MultipartUpload: { Parts: etags } })));
  return {
    ok: done.ok,
    listUploadsStatus: lu.status,
    listedUpload,
    listPartsCount: have.size,
    uploadedHere: partTimes.length,
    md5matchHere: md5match,
    completeStatus: done.status,
    completeCode: done.code,
    completeMsg: done.msg,
    etag: done.r?.ETag ?? "",
    expectedAws: awsMultipartEtag(fx.partMd5),
    ms: performance.now() - t0,
  };
}

/** Stream an object through S3 GetObject and hash it. */
async function getSha(t: Target, h: Host, bucket: string, key: string, range?: string) {
  const c = s3c(t, h);
  const t0 = performance.now();
  const r = await sdk(() => c.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: range })));
  if (!r.ok) return { ok: false, status: r.status, code: r.code, msg: r.msg, ms: performance.now() - t0 };
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of r.r!.Body as Readable) {
    hash.update(chunk as Buffer);
    bytes += (chunk as Buffer).length;
  }
  return {
    ok: true,
    status: r.status,
    bytes,
    sha256: hash.digest("hex"),
    etag: r.r!.ETag ?? "",
    contentRange: r.r!.ContentRange ?? "",
    contentLength: r.r!.ContentLength ?? -1,
    ms: performance.now() - t0,
  };
}

async function abortCheck(t: Target, h: Host, bucket: string, key: string, fx: Fix) {
  const c = s3c(t, h);
  const cr = await sdk(() => c.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key })));
  if (!cr.ok) return { ok: false, step: "create", status: cr.status, code: cr.code };
  const id = cr.r!.UploadId!;
  for (const n of [1, 2]) await sdk(() => c.send(new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: id, PartNumber: n, Body: readPart(fx.path, n, fx.size) })));
  const before = await sdk(() => c.send(new ListPartsCommand({ Bucket: bucket, Key: key, UploadId: id })));
  const ab = await sdk(() => c.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: id })));
  const after = await sdk(() => c.send(new ListPartsCommand({ Bucket: bucket, Key: key, UploadId: id })));
  const lu = await sdk(() => c.send(new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: key })));
  const head = await sdk(() => c.send(new HeadObjectCommand({ Bucket: bucket, Key: key })));
  return {
    ok: true,
    partsBefore: before.r?.Parts?.length ?? -1,
    abortStatus: ab.status,
    abortCode: ab.code,
    listPartsAfter: after.ok ? `${after.status} parts=${after.r?.Parts?.length ?? 0}` : `${after.status} ${after.code}`,
    stillListed: (lu.r?.Uploads ?? []).some((u) => u.UploadId === id),
    headAfter: head.ok ? `${head.status}` : `${head.status} ${head.code}`,
  };
}

/** A plain single PutObject from a file (setup and SS03i). */
async function putFile(t: Target, h: Host, bucket: string, key: string, path: string, extra: Record<string, string> = {}) {
  const c = s3c(t, h);
  const body = readFileSync(path);
  const t0 = performance.now();
  const r = await sdk(() => c.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: extra.contentType ?? "application/octet-stream", ContentEncoding: extra.contentEncoding })));
  return { ok: r.ok, status: r.status, code: r.code, msg: r.msg, etag: r.r?.ETag ?? "", ms: performance.now() - t0 };
}

/**
 * TUS upload with tus-js-client. Prints one JSON line per completed chunk so
 * the parent can SIGKILL after n chunks; a resume passes `uploadUrl`.
 */
async function tusRun(o: {
  endpoint: string;
  uploadUrl?: string;
  file: string;
  size: number;
  chunkSize: number;
  headers: Record<string, string>;
  bucket: string;
  key: string;
}) {
  const line = (x: unknown) => process.stdout.write(`${JSON.stringify(x)}\n`);
  const responses: Array<{ method: string; status: number; headers: Record<string, string> }> = [];
  let chunks = 0;
  await new Promise<void>((resolve) => {
    const u = new tus.Upload(createReadStream(o.file), {
      endpoint: o.endpoint,
      uploadUrl: o.uploadUrl,
      chunkSize: o.chunkSize,
      uploadSize: o.size,
      retryDelays: [],
      headers: o.headers,
      storeFingerprintForResuming: false,
      metadata: { bucketName: o.bucket, objectName: o.key, contentType: "application/octet-stream", cacheControl: "3600" },
      onAfterResponse(req, res) {
        const h: Record<string, string> = {};
        for (const n of ["location", "upload-offset", "upload-expires", "upload-length", "tus-resumable", "tus-max-size", "content-type"]) {
          const v = res.getHeader(n);
          if (v) h[n] = v;
        }
        const x = { method: req.getMethod(), status: res.getStatus(), headers: h };
        responses.push(x);
        line({ resp: x });
      },
      onChunkComplete(_size, accepted) {
        chunks++;
        line({ chunk: chunks, offset: accepted, url: u.url });
      },
      onSuccess() {
        line({ done: true, ok: true, url: u.url, chunks });
        resolve();
      },
      onError(err) {
        const e = err as tus.DetailedError;
        line({ done: true, ok: false, url: u.url, chunks, error: String(e.message).replace(/\s+/g, " ").slice(0, 300), status: e.originalResponse?.getStatus?.() ?? 0, body: String(e.originalResponse?.getBody?.() ?? "").slice(0, 300) });
        resolve();
      },
    });
    u.start();
  });
}

if (import.meta.main) {
  const input = JSON.parse(readFileSync(0, "utf8"));
  const t = input.target as Target;
  if (input.cmd === "tus") {
    await tusRun(input.tus);
    process.exit(0);
  }
  const scrub = scrubber(t);
  const host = (t.hosts.find((x) => x.name === input.host) ?? t.hosts[0]) as Host;
  let out: unknown;
  switch (input.cmd) {
    case "mpu-start":
      out = await mpuStart(t, host, input.bucket, input.key, input.fx, input.stopAfter);
      break;
    case "mpu-resume":
      out = await mpuResume(t, host, input.bucket, input.key, input.fx, input.uploadId);
      break;
    case "abort":
      out = await abortCheck(t, host, input.bucket, input.key, input.fx);
      break;
    case "get-sha":
      out = await getSha(t, host, input.bucket, input.key, input.range);
      break;
    case "put-file":
      out = await putFile(t, host, input.bucket, input.key, input.path, input.extra ?? {});
      break;
    case "list-buckets": {
      const r = await sdk(() => s3c(t, host).send(new ListBucketsCommand({})));
      out = { ok: r.ok, status: r.status, code: r.code };
      break;
    }
    case "preflight": {
      const body = Buffer.alloc(1024, 7);
      const s3 = await sdk(() => s3c(t, host).send(new PutObjectCommand({ Bucket: input.bucket, Key: "preflight-s3.bin", Body: body })));
      const rest = await fetch(`${host.rest}/object/${input.bucket}/preflight-rest.bin`, {
        method: "POST",
        headers: { apikey: t.service, authorization: `Bearer ${t.service}`, "content-type": "application/octet-stream", "x-upsert": "true" },
        body,
      });
      const txt = await rest.text();
      out = { s3: `${s3.status} ${s3.code || "ok"}`, rest: `${rest.status}${rest.status >= 300 ? ` ${txt.replace(/\s+/g, " ").slice(0, 160)}` : ""}`, ok: s3.ok || rest.status < 300 };
      break;
    }
  }
  console.log(scrub(JSON.stringify(out)));
}
