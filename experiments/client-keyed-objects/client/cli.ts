/**
 * Bun entry for the CK suite: one JSON command on stdin, one JSON result on
 * the last stdout line, progress as `PROGRESS <fraction>` lines on stderr (so
 * a parent can kill the process mid-upload). The library code is the same
 * the browser build uses; only the Platform adapter differs.
 *
 *   {cmd: "upload",     directory, creds, tenant, record, file, method, assetId?}
 *   {cmd: "resume",     directory, creds, tenant, asset, file}
 *   {cmd: "read-all",   directory, creds, tenant, asset, path?}
 *   {cmd: "read-ranges",directory, creds, tenant, asset, file, ranges: [[s,e)], paths}
 *   {cmd: "read-one",   directory, creds, tenant, asset, start, end, path?, verifyHashes?}
 *   {cmd: "s3ops",      s3: {endpoint, region, accessKeyId, secretAccessKey, sessionToken?}, bucket, ops}
 *   {cmd: "fixtures",   dir}
 */
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createHash } from "node:crypto";
import { ensureFixtures } from "./fixtures";
import { Ck, type Credentials, type Directory, type Platform } from "./src/ctx";
import { isCk } from "./src/errors";
import { restStats } from "./src/catalogue";
import { readAll, readRange, type ReadPath } from "./src/read";
import { resume, upload } from "./src/upload";

export const bunPlatform: Platform = {
  sha256Stream() {
    const h = createHash("sha256");
    return { update: (u) => void h.update(u), digestHex: async () => h.digest("hex") };
  },
  md5Hex: (u) => createHash("md5").update(u).digest("hex"),
};

const progress = (d: number, total: number) => process.stderr.write(`PROGRESS ${(d / total).toFixed(4)}\n`);
const errOut = (e: unknown) =>
  isCk(e) ? { ok: false, code: e.code, message: e.message.slice(0, 300), detail: e.detail } : { ok: false, code: "Thrown", message: String((e as Error)?.message ?? e).slice(0, 300) };

interface Base {
  cmd: string;
  directory: Directory;
  creds: Record<string, Credentials>;
  tenant: string;
}

async function s3ops(c: {
  s3: { endpoint: string; region: string; accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  bucket: string;
  ops: Record<string, any>[];
}) {
  const s3 = new S3Client({
    forcePathStyle: true,
    region: c.s3.region,
    endpoint: c.s3.endpoint,
    maxAttempts: 1,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    credentials: { accessKeyId: c.s3.accessKeyId, secretAccessKey: c.s3.secretAccessKey, sessionToken: c.s3.sessionToken },
  });
  const out: Record<string, unknown>[] = [];
  for (const o of c.ops) {
    const t0 = performance.now();
    const base = { op: o.op, key: o.key ?? "" };
    try {
      let r: Record<string, unknown> = {};
      if (o.op === "put") {
        const body = o.file ? new Uint8Array(await Bun.file(o.file).arrayBuffer()) : Buffer.from(o.text ?? "");
        const x = await s3.send(new PutObjectCommand({ Bucket: c.bucket, Key: o.key, Body: body, ContentType: o.contentType ?? "application/octet-stream" }));
        r = { status: x.$metadata.httpStatusCode, etag: x.ETag };
      } else if (o.op === "get") {
        const x = await s3.send(new GetObjectCommand({ Bucket: c.bucket, Key: o.key, Range: o.range }));
        const h = createHash("sha256");
        let bytes = 0;
        let hits = 0;
        const needle = o.needle ? Buffer.from(o.needle) : null;
        let tail = Buffer.alloc(0);
        for await (const chunk of x.Body as AsyncIterable<Uint8Array>) {
          h.update(chunk);
          bytes += chunk.length;
          if (needle) {
            const buf = Buffer.concat([tail, Buffer.from(chunk)]);
            for (let i = buf.indexOf(needle); i !== -1; i = buf.indexOf(needle, i + 1)) hits++;
            tail = buf.subarray(Math.max(0, buf.length - needle.length + 1));
          }
        }
        r = { status: x.$metadata.httpStatusCode, bytes, sha256: h.digest("hex"), etag: x.ETag, contentRange: x.ContentRange, needleHits: hits };
      } else if (o.op === "head") {
        const x = await s3.send(new HeadObjectCommand({ Bucket: c.bucket, Key: o.key }));
        r = { status: x.$metadata.httpStatusCode, etag: x.ETag, size: x.ContentLength };
      } else if (o.op === "delete") {
        const x = await s3.send(new DeleteObjectCommand({ Bucket: c.bucket, Key: o.key }));
        r = { status: x.$metadata.httpStatusCode };
      } else if (o.op === "copy") {
        const x = await s3.send(new CopyObjectCommand({ Bucket: c.bucket, Key: o.key, CopySource: `${c.bucket}/${o.from}` }));
        r = { status: x.$metadata.httpStatusCode };
      } else if (o.op === "list") {
        const x = await s3.send(new ListObjectsV2Command({ Bucket: c.bucket, Prefix: o.prefix }));
        r = { status: x.$metadata.httpStatusCode, keys: (x.Contents ?? []).map((k) => k.Key) };
      } else if (o.op === "multipart") {
        // Two-part upload of `text` repeated to 5 MiB + a short tail (minimum part size).
        const cm = await s3.send(new CreateMultipartUploadCommand({ Bucket: c.bucket, Key: o.key }));
        try {
          const p1 = await s3.send(new UploadPartCommand({ Bucket: c.bucket, Key: o.key, UploadId: cm.UploadId, PartNumber: 1, Body: Buffer.alloc(5 * 1024 * 1024, 7) }));
          const p2 = await s3.send(new UploadPartCommand({ Bucket: c.bucket, Key: o.key, UploadId: cm.UploadId, PartNumber: 2, Body: Buffer.from("tail") }));
          const x = await s3.send(
            new CompleteMultipartUploadCommand({
              Bucket: c.bucket,
              Key: o.key,
              UploadId: cm.UploadId,
              MultipartUpload: { Parts: [{ PartNumber: 1, ETag: p1.ETag }, { PartNumber: 2, ETag: p2.ETag }] },
            }),
          );
          r = { status: x.$metadata.httpStatusCode, etag: x.ETag };
        } catch (e) {
          await s3.send(new AbortMultipartUploadCommand({ Bucket: c.bucket, Key: o.key, UploadId: cm.UploadId })).catch(() => {});
          throw e;
        }
      } else if (o.op === "presign-get") {
        const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: c.bucket, Key: o.key }), { expiresIn: 300 });
        const res = await fetch(url, { headers: o.range ? { range: o.range } : {} });
        const body = new Uint8Array(await res.arrayBuffer());
        r = { status: res.status, bytes: body.length, code: /<Code>([^<]*)<\/Code>/.exec(new TextDecoder().decode(body.subarray(0, 2048)))?.[1] ?? "" };
      } else if (o.op === "tamper") {
        // Read the whole object, change it, write it back to the same key (S3 overwrite).
        const x = await s3.send(new GetObjectCommand({ Bucket: c.bucket, Key: o.key }));
        let buf = Buffer.from(await (x.Body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray());
        const stride = Number(o.stride);
        if (o.mode === "flip") buf[Number(o.at)] = buf[Number(o.at)]! ^ 0x01;
        else if (o.mode === "swap") {
          const a = Buffer.from(buf.subarray(0, stride));
          const b = Buffer.from(buf.subarray(stride, 2 * stride));
          b.copy(buf, 0);
          a.copy(buf, stride);
        } else if (o.mode === "truncate") buf = buf.subarray(0, Number(o.length));
        const y = await s3.send(new PutObjectCommand({ Bucket: c.bucket, Key: o.key, Body: buf, ContentType: "application/octet-stream" }));
        r = { status: y.$metadata.httpStatusCode, bytes: buf.length };
      } else throw new Error(`unknown op ${o.op}`);
      out.push({ ...base, ok: true, ms: Math.round(performance.now() - t0), ...r });
    } catch (e) {
      const x = e as { name?: string; Code?: string; message?: string; $metadata?: { httpStatusCode?: number }; $response?: { headers?: Record<string, string> } };
      out.push({
        ...base,
        ok: false,
        ms: Math.round(performance.now() - t0),
        status: x.$metadata?.httpStatusCode ?? 0,
        code: x.Code ?? x.name ?? "Error",
        message: String(x.message ?? "").replace(/\s+/g, " ").slice(0, 200),
        contentType: x.$response?.headers?.["content-type"] ?? "",
      });
    }
  }
  return { ok: true, results: out };
}

async function main() {
  const input = JSON.parse(await Bun.stdin.text()) as Base & Record<string, any>;
  if (input.cmd === "fixtures") return ensureFixtures(input.dir, input.bigMiB);
  if (input.cmd === "s3ops") return s3ops(input as any);
  const ck = new Ck(input.directory, input.creds, bunPlatform);
  switch (input.cmd) {
    case "upload":
      return { ok: true, ...(await upload(ck, { tenantId: input.tenant, recordId: input.record, source: Bun.file(input.file), method: input.method, onProgress: progress })) };
    case "resume":
      return { ok: true, ...(await resume(ck, input.tenant, input.asset, Bun.file(input.file), { onProgress: progress })) };
    case "read-all":
      return { ok: true, ...(await readAll(ck, input.tenant, input.asset, { path: input.path, needle: input.needle })) };
    case "read-one": {
      const r = await readRange(ck, input.tenant, input.asset, input.start, input.end, { path: input.path, verifyHashes: input.verifyHashes, log: false });
      const want = input.file ? new Uint8Array(await Bun.file(input.file).slice(input.start, input.end).arrayBuffer()) : null;
      return { ok: true, equal: want ? Buffer.compare(Buffer.from(r.plain), Buffer.from(want)) === 0 : null, transferred: r.transferred, status: r.status };
    }
    case "read-ranges": {
      const file = Bun.file(input.file);
      const rows: Record<string, unknown>[] = [];
      const paths = input.paths as ReadPath[];
      for (const [i, [s, e]] of (input.ranges as [number, number][]).entries()) {
        const want = Buffer.from(await file.slice(s, e).arrayBuffer());
        // spread: range i through path i mod n; otherwise every range through every path.
        for (const path of input.spread ? [paths[i % paths.length]!] : paths) {
          try {
            const r = await readRange(ck, input.tenant, input.asset, s, e, { path });
            rows.push({ path, s, e, ok: true, equal: Buffer.compare(Buffer.from(r.plain), want) === 0, transferred: r.transferred, need: r.cipherNeeded, status: r.status, cache: r.cacheStatus, ms: Math.round(r.ms) });
          } catch (err) {
            rows.push({ path, s, e, ...errOut(err) });
          }
        }
      }
      return { ok: true, rows };
    }
  }
  throw new Error(`unknown cmd ${input.cmd}`);
}

main()
  .then((r) => console.log(JSON.stringify(r && typeof r === "object" && "ok" in r ? { ...r, iatFutureRetries: restStats.iatFutureRetries } : r)))
  .catch((e) => {
    console.log(JSON.stringify(errOut(e)));
  });
