/**
 * Generic S3 operation runner on the real AWS SDK for JavaScript v3.
 *
 * It lives outside tests/ and lib.ts on purpose: the SDK is a dependency of
 * this experiment only (canary/package.json), and the harness registry and
 * root typecheck must keep building on a checkout where it is not installed.
 * The TestModules spawn this script and read one JSON document from stdout.
 *
 *   echo '{"endpoint":...,"ops":[...]}' | bun canary/s3op.ts
 *
 * Credentials are the session-token form of Supabase Storage S3 auth
 * (https://supabase.com/docs/guides/storage/s3/authentication): access key id
 * is the project ref, secret access key is the anon key, session token is a
 * JWT. Dashboard-generated S3 access keys have no API and are not used.
 */
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
} from "@aws-sdk/client-s3";
import { readFileSync } from "node:fs";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export interface Cfg {
  endpoint: string;
  ref: string;
  anon: string;
  token: string;
  region: string;
}

export interface Op {
  op: "put" | "get" | "head" | "list" | "delete" | "copy" | "multipart" | "presign-get";
  bucket: string;
  key?: string;
  body?: string;
  prefix?: string;
  /** copy: destination key is `key`; source key here (unencoded). */
  from?: string;
}

export interface OpResult {
  op: string;
  key: string;
  ok: boolean;
  status: number;
  /** AWS error code from the XML body, e.g. SignatureDoesNotMatch. */
  code: string;
  message: string;
  ms: number;
  body?: string;
  keys?: string[];
  requestId?: string;
  url?: string;
}

export function client(cfg: Cfg): S3Client {
  return new S3Client({
    forcePathStyle: true,
    region: cfg.region,
    endpoint: cfg.endpoint,
    credentials: { accessKeyId: cfg.ref, secretAccessKey: cfg.anon, sessionToken: cfg.token },
    maxAttempts: 1,
  });
}

export async function run(c: S3Client, cfg: Cfg, o: Op): Promise<OpResult> {
  const key = o.key ?? "";
  const t0 = performance.now();
  const base = { op: o.op, key };
  try {
    switch (o.op) {
      case "put": {
        const r = await c.send(new PutObjectCommand({ Bucket: o.bucket, Key: key, Body: o.body ?? "", ContentType: "text/plain" }));
        return { ...base, ok: true, status: r.$metadata.httpStatusCode ?? 0, code: "", message: "", ms: performance.now() - t0, requestId: r.$metadata.requestId };
      }
      case "get": {
        const r = await c.send(new GetObjectCommand({ Bucket: o.bucket, Key: key }));
        const body = await r.Body!.transformToString();
        return { ...base, ok: true, status: r.$metadata.httpStatusCode ?? 0, code: "", message: "", ms: performance.now() - t0, body };
      }
      case "head": {
        const r = await c.send(new HeadObjectCommand({ Bucket: o.bucket, Key: key }));
        return { ...base, ok: true, status: r.$metadata.httpStatusCode ?? 0, code: "", message: "", ms: performance.now() - t0, body: String(r.ContentLength ?? "") };
      }
      case "delete": {
        const r = await c.send(new DeleteObjectCommand({ Bucket: o.bucket, Key: key }));
        return { ...base, ok: true, status: r.$metadata.httpStatusCode ?? 0, code: "", message: "", ms: performance.now() - t0 };
      }
      case "list": {
        const keys: string[] = [];
        let token: string | undefined;
        let status = 0;
        do {
          const r = await c.send(new ListObjectsV2Command({ Bucket: o.bucket, Prefix: o.prefix ?? "", ContinuationToken: token }));
          status = r.$metadata.httpStatusCode ?? 0;
          for (const x of r.Contents ?? []) if (x.Key) keys.push(x.Key);
          token = r.IsTruncated ? r.NextContinuationToken : undefined;
        } while (token);
        return { ...base, ok: true, status, code: "", message: "", ms: performance.now() - t0, keys };
      }
      case "copy": {
        // The SDK does not encode CopySource for the caller. Percent-encoding
        // each segment is what the S3 API specifies.
        const src = `${o.bucket}/${(o.from ?? "").split("/").map(encodeURIComponent).join("/")}`;
        const r = await c.send(new CopyObjectCommand({ Bucket: o.bucket, Key: key, CopySource: src }));
        return { ...base, ok: true, status: r.$metadata.httpStatusCode ?? 0, code: "", message: "", ms: performance.now() - t0 };
      }
      case "multipart": {
        const m = await c.send(new CreateMultipartUploadCommand({ Bucket: o.bucket, Key: key, ContentType: "text/plain" }));
        const part = await c.send(new UploadPartCommand({ Bucket: o.bucket, Key: key, UploadId: m.UploadId, PartNumber: 1, Body: o.body ?? "" }));
        const done = await c.send(
          new CompleteMultipartUploadCommand({
            Bucket: o.bucket,
            Key: key,
            UploadId: m.UploadId,
            MultipartUpload: { Parts: [{ ETag: part.ETag, PartNumber: 1 }] },
          }),
        );
        return { ...base, ok: true, status: done.$metadata.httpStatusCode ?? 0, code: "", message: "", ms: performance.now() - t0 };
      }
      case "presign-get": {
        const url = await getSignedUrl(c, new GetObjectCommand({ Bucket: o.bucket, Key: key }), { expiresIn: 300 });
        const res = await fetch(url);
        const text = await res.text();
        const code = /<Code>([^<]*)<\/Code>/.exec(text)?.[1] ?? "";
        return {
          ...base,
          ok: res.status === 200,
          status: res.status,
          code,
          message: res.status === 200 ? "" : text.slice(0, 200),
          ms: performance.now() - t0,
          body: res.status === 200 ? text : undefined,
        };
      }
    }
  } catch (e) {
    const err = e as { name?: string; Code?: string; message?: string; $metadata?: { httpStatusCode?: number; requestId?: string } };
    return {
      ...base,
      ok: false,
      status: err.$metadata?.httpStatusCode ?? 0,
      code: err.Code ?? err.name ?? "Error",
      message: String(err.message ?? "").slice(0, 300),
      ms: performance.now() - t0,
      requestId: err.$metadata?.requestId,
    };
  }
}

if (import.meta.main) {
  const input = JSON.parse(readFileSync(0, "utf8")) as { cfg: Cfg; ops: Op[] };
  const c = client(input.cfg);
  const out: OpResult[] = [];
  for (const o of input.ops) out.push(await run(c, input.cfg, o));
  console.log(JSON.stringify(out));
}
