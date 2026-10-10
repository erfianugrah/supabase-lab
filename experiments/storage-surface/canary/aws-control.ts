/**
 * Control for SS02: the same SDK, the same three keys that got
 * SignatureDoesNotMatch from the Storage S3 endpoint, against Amazon S3
 * itself. Creates one temporary bucket, PUT/GET/DELETEs, deletes the bucket.
 * Optional and manual (needs AWS credentials in the environment):
 *
 *   sx AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY -- bun canary/aws-control.ts <region>
 *
 * Prints one JSON document: per key, the PUT/GET/DELETE status or error code.
 */
import {
  S3Client,
  CreateBucketCommand,
  DeleteBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";

const region = process.argv[2] ?? "ap-southeast-1";
const bucket = `ss-ctl-${crypto.randomUUID().slice(0, 12)}`;
const c = new S3Client({ region, maxAttempts: 1 });
const keys = ["plain.txt", "a b.txt", "a+b.txt", "a//b.txt", "dot/./seg.txt", "dot/../seg2.txt"];
const res: Array<Record<string, string | number>> = [];
const code = (e: unknown) => {
  const x = e as { name?: string; $metadata?: { httpStatusCode?: number } };
  return `${x.$metadata?.httpStatusCode ?? 0} ${x.name ?? "Error"}`;
};
try {
  await c.send(new CreateBucketCommand({ Bucket: bucket, CreateBucketConfiguration: { LocationConstraint: region as never } }));
  for (const key of keys) {
    const row: Record<string, string | number> = { key };
    try {
      row.put = (await c.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: "x" }))).$metadata.httpStatusCode ?? 0;
    } catch (e) {
      row.put = code(e);
    }
    try {
      const g = await c.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      row.get = `${g.$metadata.httpStatusCode} ${await g.Body!.transformToString()}`;
    } catch (e) {
      row.get = code(e);
    }
    res.push(row);
  }
  const l = await c.send(new ListObjectsV2Command({ Bucket: bucket }));
  console.log(JSON.stringify({ region, results: res, keys_stored: (l.Contents ?? []).map((x) => x.Key) }, null, 1));
} finally {
  for (const key of keys) await c.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })).catch(() => null);
  const l = await c.send(new ListObjectsV2Command({ Bucket: bucket })).catch(() => null);
  for (const o of l?.Contents ?? []) await c.send(new DeleteObjectCommand({ Bucket: bucket, Key: o.Key })).catch(() => null);
  await c.send(new DeleteBucketCommand({ Bucket: bucket })).catch((e) => console.error("bucket delete failed", code(e)));
}
