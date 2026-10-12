/**
 * SS03c-l and SS05a/c/d request batteries, target-agnostic (see target.ts).
 * Reads one JSON document on stdin, writes one on stdout:
 *
 *   in:  { cmd: "ss03" | "too-large" | "ss05" | "ss05-rls", target, fx, bucket, ... }
 *   out: { rows: { <row id>: { <measurement>: string|number } }, notes: { <row id>: string[] } }
 *
 * Every response field is recorded as received; nothing is retried. Raw
 * requests go through http.ts (node:http, no decompression); S3 calls use the
 * AWS SDK v3 where the SDK can express the request, and the SigV4 raw signer
 * where it cannot or where the verbatim error body is the point.
 */
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetBucketCorsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListBucketsCommand,
  PutBucketCorsCommand,
  PutObjectCommand,
  UploadPartCommand,
  UploadPartCopyCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { sliceSha, type Manifest, type Fix, MiB } from "./fixtures.ts";
import { type RawResp, pick, raw, s3raw, sigv4, xmlCode } from "./http.ts";
import { type Host, type Target, gw, restAuth, s3c, scrubber, sdk } from "./target.ts";

type Row = Record<string, string | number>;
const rows: Record<string, Row> = {};
const notes: Record<string, string[]> = {};
const set = (row: string, k: string, v: string | number) => ((rows[row] ??= {})[k] = v);
const note = (row: string, s: string) => (notes[row] ??= []).push(s);

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const md5b64 = (b: Buffer | string) => createHash("md5").update(b).digest("base64");
const unq = (e?: string) => (e ?? "").replace(/"/g, "");
const ORIGIN = "https://cors-probe.example";

function readRange(path: string, start: number, len: number): Buffer {
  const buf = Buffer.alloc(len);
  const fd = openSync(path, "r");
  readSync(fd, buf, 0, len, start);
  closeSync(fd);
  return buf;
}

/** Stream an SDK body: byte count and SHA-256, without holding a whole object (a 2 GiB body does not fit one hash update). */
async function drain(body: unknown): Promise<{ bytes: number; sha: string }> {
  const h = createHash("sha256");
  let bytes = 0;
  for await (const c of body as AsyncIterable<Buffer>) {
    h.update(c);
    bytes += c.length;
  }
  return { bytes, sha: h.digest("hex") };
}

/** One cell: status plus the named headers plus the hash verdict. */
function cell(r: RawResp, names: string[], expectSha?: string): string {
  if (r.error) return `ERR ${r.error}`;
  const h = pick(r.headers, names);
  const parts = [`${r.status}`];
  for (const n of names) parts.push(`${short(n)}=${h[n]}`);
  parts.push(`bytes=${r.bytes}`);
  if (expectSha) parts.push(r.sha256 === expectSha ? "hash=ok" : "hash=DIFF");
  return parts.join(" ");
}
const SHORT: Record<string, string> = {
  "content-range": "cr",
  "content-length": "cl",
  "accept-ranges": "ar",
  "cf-cache-status": "cf",
  "content-type": "ct",
  "content-encoding": "ce",
  "transfer-encoding": "te",
  etag: "etag",
};
const short = (n: string) => SHORT[n] ?? n;

/** URL paths per read path for one object. */
interface Paths {
  presign: (h: Host) => Promise<string>;
  sign: (h: Host) => Promise<string>;
  pub: (h: Host) => string;
  auth: (h: Host) => string;
}

function paths(t: Target, bucket: string, key: string): Paths {
  const signed = new Map<string, string>();
  return {
    async presign(h) {
      return getSignedUrl(s3c(t, h), new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 3600 });
    },
    async sign(h) {
      // One token per object, reused on every host, so first/repeat reads are comparable.
      if (!signed.has(key)) {
        const r = await raw(`${gw(t).rest}/object/sign/${bucket}/${key}`, {
          method: "POST",
          headers: { ...restAuth(t), "content-type": "application/json" },
          body: JSON.stringify({ expiresIn: 3600 }),
        });
        const j = JSON.parse(r.text || "{}") as { signedURL?: string };
        signed.set(key, j.signedURL ?? "");
      }
      // signedURL is "/object/sign/<bucket>/<key>?token=..." relative to /storage/v1
      return `${h.rest}${signed.get(key)}`;
    },
    pub: (h) => `${h.rest}/object/public/${bucket}/${key}`,
    auth: (h) => `${h.rest}/object/authenticated/${bucket}/${key}`,
  };
}

const PATHS = ["presign", "sign", "pub", "auth"] as const;
async function pathUrl(t: Target, p: Paths, which: (typeof PATHS)[number], h: Host): Promise<{ url: string; headers: Record<string, string> }> {
  switch (which) {
    case "presign":
      return { url: await p.presign(h), headers: {} };
    case "sign":
      return { url: await p.sign(h), headers: {} };
    case "pub":
      return { url: p.pub(h), headers: {} };
    case "auth":
      return { url: p.auth(h), headers: restAuth(t) };
  }
}

// ---------------- SS03c - single-range GET ----------------
async function ss03c(t: Target, fx: Manifest, bucket: string) {
  const h = gw(t);
  const c = s3c(t, h);
  for (const [name, f, key] of [
    ["mid", fx.mid, "mid.bin"],
    ["big", fx.big, "big.bin"],
  ] as const) {
    const S = f.size;
    const half = Math.floor(S / 2);
    const ranges: Array<[string, string, [number, number] | null]> = [
      ["first", "bytes=0-1023", [0, 1023]],
      ["middle", `bytes=${half}-${half + 4095}`, [half, half + 4095]],
      ["suffix", "bytes=-1024", [S - 1024, S - 1]],
      ["open", `bytes=${S - 1000}-`, [S - 1000, S - 1]],
      ["past_eof", `bytes=${S + 10}-${S + 20}`, null],
      ["multi", "bytes=0-9,20-29", null],
      ["mixed_case_unit", "Bytes=0-9", [0, 9]],
    ];
    const hd = await sdk(() => c.send(new HeadObjectCommand({ Bucket: bucket, Key: key })));
    set("SS03c", `${name}_s3_head_accept_ranges`, hd.ok ? hd.r!.AcceptRanges ?? "absent" : `${hd.status} ${hd.code}`);
    const full = await sdk(() => c.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: "bytes=0-0" })));
    set("SS03c", `${name}_s3_get_accept_ranges`, full.ok ? full.r!.AcceptRanges ?? "absent" : `${full.status} ${full.code}`);
    if (full.ok) await drain(full.r!.Body);
    for (const [rn, hdr, span] of ranges) {
      const want = span ? sliceSha(f.path, span[0], span[1]) : undefined;
      // S3 GetObject through the SDK
      const r = await sdk(() => c.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: hdr })));
      if (r.ok) {
        const body = await drain(r.r!.Body);
        const verdict = want && r.status < 300 ? (body.sha === want ? "hash=ok" : body.sha === f.sha256 ? "hash=WHOLE-OBJECT" : "hash=DIFF") : "";
        set("SS03c", `${name}_s3_${rn}`, `${r.status} cr=${r.r!.ContentRange ?? "-"} cl=${r.r!.ContentLength ?? "-"} ar=${r.r!.AcceptRanges ?? "-"} ct=${r.r!.ContentType ?? "-"} bytes=${body.bytes} ${verdict}`.trim());
      } else set("SS03c", `${name}_s3_${rn}`, `${r.status} ${r.code}`);
      // REST /object/authenticated
      const rr = await raw(`${h.rest}/object/authenticated/${bucket}/${key}`, { headers: { ...restAuth(t), range: hdr }, keep: 200 });
      const v = want && rr.status < 300 ? (rr.sha256 === want ? "hash=ok" : rr.sha256 === f.sha256 ? "hash=WHOLE-OBJECT" : "hash=DIFF") : "";
      set("SS03c", `${name}_rest_${rn}`, `${rr.status} cr=${rr.headers["content-range"] ?? "-"} cl=${rr.headers["content-length"] ?? "-"} ar=${rr.headers["accept-ranges"] ?? "-"} ct=${(rr.headers["content-type"] ?? "-").slice(0, 40)} bytes=${rr.bytes} ${v}`.trim());
    }
  }
}

// ---------------- SS03d - range through every read path ----------------
const RUN = Date.now().toString(36);

/** A server-side copy of `src` under a fresh key, so its first read through a cached path is cold. */
async function freshCopy(t: Target, bucket: string, src: string, key: string): Promise<string> {
  const r = await sdk(() => s3c(t, gw(t)).send(new CopyObjectCommand({ Bucket: bucket, Key: key, CopySource: `${bucket}/${src}` })));
  return r.ok ? "" : `copy ${r.status} ${r.code}`;
}
async function dropKey(t: Target, bucket: string, key: string) {
  await sdk(() => s3c(t, gw(t)).send(new DeleteObjectCommand({ Bucket: bucket, Key: key })));
}
const timing = (r: RawResp) => `ttfb=${Math.round(r.ttfbMs ?? -1)} total=${Math.round(r.ms)}`;

async function ss03d(t: Target, fx: Manifest, bucket: string) {
  const RANGE: [number, number] = [MiB, MiB + 1023];
  const rg = { range: `bytes=${RANGE[0]}-${RANGE[1]}` };
  for (const [name, f, key] of [
    ["mid", fx.mid, "mid.bin"],
    ["big", fx.big, "big.bin"],
  ] as const) {
    const want = sliceSha(f.path, RANGE[0], RANGE[1]);
    for (const h of t.hosts) {
      // S3 GetObject (SDK): not cached, so the original key is fine.
      for (const read of ["first", "repeat"]) {
        const g = await sdk(() => s3c(t, h).send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: rg.range })));
        if (g.ok) {
          const body = await drain(g.r!.Body);
          set("SS03d", `${name}_${h.name}_s3sdk_${read}`, `${g.status} cr=${g.r!.ContentRange ?? "-"} bytes=${body.bytes} ${body.sha === want ? "hash=ok" : body.sha === f.sha256 ? "hash=WHOLE-OBJECT" : "hash=DIFF"}`);
        } else set("SS03d", `${name}_${h.name}_s3sdk_${read}`, `${g.status} ${g.code}`);
      }
      // Every cached path gets its own fresh key: the first read is the first request for that object anywhere.
      for (const which of PATHS) {
        const k = `d-${name}-${which}-${h.name}-${RUN}.bin`;
        const err = await freshCopy(t, bucket, key, k);
        if (err) {
          set("SS03d", `${name}_${h.name}_${which}_first`, err);
          continue;
        }
        const p = paths(t, bucket, k);
        for (const read of ["first", "repeat"]) {
          const u = await pathUrl(t, p, which, h);
          const r = await raw(u.url, { headers: { ...u.headers, ...rg }, keep: 200 });
          set("SS03d", `${name}_${h.name}_${which}_${read}`, cell(r, ["content-range", "cf-cache-status"], want));
          if (name === "big") set("SS03d", `big_${h.name}_${which}_${read}_timing_ms`, timing(r));
        }
        await dropKey(t, bucket, k);
      }
    }
  }
  // Does a read through one path or host warm another? One fresh key per probe, mid-sized.
  const probes: Array<[string, Array<[(typeof PATHS)[number], Host]>]> = [];
  const g0 = gw(t);
  const d0 = t.hosts.find((x) => x.name === "direct");
  probes.push(["auth_then_public_same_host", [["auth", g0], ["pub", g0]]]);
  probes.push(["public_then_auth_same_host", [["pub", g0], ["auth", g0]]]);
  probes.push(["auth_then_sign_same_host", [["auth", g0], ["sign", g0]]]);
  if (d0) {
    probes.push(["auth_gateway_then_auth_direct", [["auth", g0], ["auth", d0]]]);
    probes.push(["public_gateway_then_public_direct", [["pub", g0], ["pub", d0]]]);
  }
  for (const [label, steps] of probes) {
    const k = `w-${label}-${RUN}.bin`;
    const err = await freshCopy(t, bucket, "mid.bin", k);
    if (err) {
      set("SS03d", `warms_${label}`, err);
      continue;
    }
    const p = paths(t, bucket, k);
    const out: string[] = [];
    for (const [which, h] of steps) {
      const u = await pathUrl(t, p, which, h);
      const r = await raw(u.url, { headers: { ...u.headers, ...rg }, keep: 0 });
      out.push(`${which}@${h.name} ${r.status} cf=${r.headers["cf-cache-status"] ?? "-"}`);
    }
    set("SS03d", `warms_${label}`, out.join(" -> "));
    await dropKey(t, bucket, k);
  }
}

// ---------------- SS03e - conditional reads ----------------
async function ss03e(t: Target, fx: Manifest, bucket: string) {
  const h = gw(t);
  const key = "cond.bin";
  const body = readRange(fx.mid.path, 0, MiB);
  const c = s3c(t, h);
  const put = await sdk(() => c.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: "application/octet-stream" })));
  set("SS03e", "setup_put", `${put.status} ${put.code}`);
  const p = paths(t, bucket, key);
  const past = new Date(Date.now() - 86_400_000).toUTCString();
  for (const which of ["s3", ...PATHS] as const) {
    // A presigned URL is signed for GET; a HEAD on it is a signature mismatch by construction, so it is not sent.
    for (const method of which === "presign" ? (["GET"] as const) : (["GET", "HEAD"] as const)) {
      const send = async (hdrs: Record<string, string>) => {
        if (which === "s3") return s3raw(h.s3, `/${bucket}/${key}`, { method, headers: hdrs, creds: t.creds, region: t.region, keep: 300 });
        const u = await pathUrl(t, p, which, h);
        return raw(u.url, { method, headers: { ...u.headers, ...hdrs }, keep: 300 });
      };
      const ctl = await send({});
      const etag = ctl.headers.etag ?? "";
      const lm = ctl.headers["last-modified"] ?? "";
      const k = `${which}_${method.toLowerCase()}`;
      set("SS03e", `${k}_control`, `${ctl.status} etag=${etag ? (unq(etag) === createHash("md5").update(body).digest("hex") ? "md5" : etag.slice(0, 40)) : "-"} lm=${lm ? "present" : "absent"} cf=${ctl.headers["cf-cache-status"] ?? "-"}`);
      const cases: Array<[string, Record<string, string>]> = [
        ["if_none_match_same_etag", { "if-none-match": etag || '"x"' }],
        ["if_match_wrong", { "if-match": '"00000000000000000000000000000000"' }],
        ["if_modified_since_last_modified", { "if-modified-since": lm || new Date().toUTCString() }],
        ["if_unmodified_since_yesterday", { "if-unmodified-since": past }],
        ["inm_other_plus_ims_last_modified", { "if-none-match": '"00000000000000000000000000000000"', "if-modified-since": lm || new Date().toUTCString() }],
        ["inm_same_plus_ims_yesterday", { "if-none-match": etag || '"x"', "if-modified-since": past }],
      ];
      for (const [cn, hdrs] of cases) {
        const r = await send(hdrs);
        const code = r.status >= 400 ? xmlCode(r.text) || (r.text.match(/"error":"([^"]*)"/)?.[1] ?? "") : "";
        set("SS03e", `${k}_${cn}`, `${r.status}${code ? ` ${code}` : ""} bytes=${r.bytes} cf=${r.headers["cf-cache-status"] ?? "-"}`);
      }
    }
  }
  // Cache-hit precondition: warm a ranged read twice, then a wrong If-Match on the same range.
  for (const which of PATHS) {
    const u = await pathUrl(t, p, which, h);
    const rg = { range: "bytes=0-1023" };
    const a = await raw(u.url, { headers: { ...u.headers, ...rg }, keep: 0 });
    const b = await raw(u.url, { headers: { ...u.headers, ...rg }, keep: 0 });
    const w = await raw(u.url, { headers: { ...u.headers, ...rg, "if-match": '"00000000000000000000000000000000"' }, keep: 200 });
    set("SS03e", `${which}_warm_range_then_if_match_wrong`, `warm ${a.status}/${a.headers["cf-cache-status"] ?? "-"},${b.status}/${b.headers["cf-cache-status"] ?? "-"}; if-match wrong -> ${w.status} cf=${w.headers["cf-cache-status"] ?? "-"} bytes=${w.bytes}`);
  }
  // Overwrite race: read v1 twice (warm), overwrite with v2, then a ranged If-Match on v1's ETag.
  const k2 = "cond-overwrite.bin";
  const v1 = readRange(fx.mid.path, MiB, MiB);
  const v2 = readRange(fx.mid.path, 2 * MiB, MiB);
  const p1 = await sdk(() => c.send(new PutObjectCommand({ Bucket: bucket, Key: k2, Body: v1 })));
  const e1 = p1.r?.ETag ?? "";
  const p2 = paths(t, bucket, k2);
  const authUrl = p2.auth(h);
  for (let i = 0; i < 2; i++) await raw(authUrl, { headers: { ...restAuth(t), range: "bytes=0-99" }, keep: 0 });
  await sdk(() => c.send(new PutObjectCommand({ Bucket: bucket, Key: k2, Body: v2 })));
  const s1 = sha(v1.subarray(0, 100));
  const s2 = sha(v2.subarray(0, 100));
  const which = (x: string) => (x === s1 ? "v1-bytes" : x === s2 ? "v2-bytes" : "neither");
  const ra = await raw(authUrl, { headers: { ...restAuth(t), range: "bytes=0-99", "if-match": e1 }, keep: 200 });
  set("SS03e", "after_overwrite_rest_auth_range_if_match_v1", `${ra.status} cf=${ra.headers["cf-cache-status"] ?? "-"} bytes=${ra.bytes} ${ra.bytes ? which(ra.sha256) : ""}`.trim());
  const g = await sdk(() => c.send(new GetObjectCommand({ Bucket: bucket, Key: k2, Range: "bytes=0-99", IfMatch: e1 })));
  if (g.ok) {
    const b = Buffer.from(await g.r!.Body!.transformToByteArray());
    set("SS03e", "after_overwrite_s3_range_if_match_v1", `${g.status} bytes=${b.length} ${which(sha(b))}`);
  } else set("SS03e", "after_overwrite_s3_range_if_match_v1", `${g.status} ${g.code}`);
  const pr = await raw(p2.pub(h), { headers: { range: "bytes=0-99", "if-match": e1 }, keep: 200 });
  set("SS03e", "after_overwrite_public_range_if_match_v1", `${pr.status} cf=${pr.headers["cf-cache-status"] ?? "-"} bytes=${pr.bytes} ${pr.bytes ? which(pr.sha256) : ""}`.trim());
}

// ---------------- SS03f - conditional writes ----------------
async function ss03f(t: Target, fx: Manifest, bucket: string) {
  const h = gw(t);
  const c = s3c(t, h);
  const key = "cw.bin";
  const orig = Buffer.from(`original-${Date.now()}`);
  const p0 = await sdk(() => c.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: orig })));
  const e0 = p0.r?.ETag ?? "";
  const current = async () => {
    const g = await sdk(() => c.send(new GetObjectCommand({ Bucket: bucket, Key: key })));
    return g.ok ? Buffer.from(await g.r!.Body!.transformToByteArray()).toString() : `(${g.status} ${g.code})`;
  };
  const verdict = async (sent: string) => {
    const now = await current();
    return now === sent ? "overwritten" : now.startsWith("original-") || now.startsWith("kept-") ? "kept" : `other:${now.slice(0, 30)}`;
  };
  const b1 = `inm-star-${Date.now()}`;
  const r1 = await sdk(() => c.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: b1, IfNoneMatch: "*" })));
  set("SS03f", "put_if_none_match_star_existing", `${r1.status} ${r1.code || "ok"} -> ${await verdict(b1)}`);
  // reset
  await sdk(() => c.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: `kept-${Date.now()}` })));
  const b2 = `im-stale-${Date.now()}`;
  const r2 = await sdk(() => c.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: b2, IfMatch: e0 })));
  set("SS03f", "put_if_match_stale_etag", `${r2.status} ${r2.code || "ok"} -> ${await verdict(b2)}`);
  // multipart with If-None-Match: * on Complete
  await sdk(() => c.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: `kept-${Date.now()}` })));
  const b3 = `mpu-inm-${Date.now()}`;
  const cr = await sdk(() => c.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key })));
  if (cr.ok) {
    const up = await sdk(() => c.send(new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: cr.r!.UploadId, PartNumber: 1, Body: b3 })));
    const done = await sdk(() =>
      c.send(new CompleteMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: cr.r!.UploadId, IfNoneMatch: "*", MultipartUpload: { Parts: [{ PartNumber: 1, ETag: up.r?.ETag }] } })),
    );
    set("SS03f", "complete_multipart_if_none_match_star_existing", `${done.status} ${done.code || "ok"} -> ${await verdict(b3)}`);
    if (!done.ok) await sdk(() => c.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: cr.r!.UploadId })));
  } else set("SS03f", "complete_multipart_if_none_match_star_existing", `create ${cr.status} ${cr.code}`);
  // CreateMultipartUpload itself with If-None-Match: * (raw; the SDK has no field for it)
  const cm = await s3raw(h.s3, `/${bucket}/${key}?uploads`, { method: "POST", headers: { "if-none-match": "*" }, creds: t.creds, region: t.region });
  const cmId = /<UploadId>([^<]*)<\/UploadId>/.exec(cm.text)?.[1];
  set("SS03f", "create_multipart_if_none_match_star_existing", `${cm.status} ${xmlCode(cm.text) || (cmId ? "upload id returned" : "")}`.trim());
  if (cmId) await sdk(() => c.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: cmId })));
  // UploadPartCopy with a wrong x-amz-copy-source-if-match, and a correct one as control
  const src = "cw-src.bin";
  const sp = await sdk(() => c.send(new PutObjectCommand({ Bucket: bucket, Key: src, Body: readRange(fx.mid.path, 0, 5 * MiB) })));
  const srcEtag = sp.r?.ETag ?? "";
  for (const [name, cond] of [
    ["upload_part_copy_if_match_wrong", '"00000000000000000000000000000000"'],
    ["upload_part_copy_if_match_correct", srcEtag],
  ] as const) {
    const m = await sdk(() => c.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: `upc-${name}.bin` })));
    if (!m.ok) {
      set("SS03f", name, `create ${m.status} ${m.code}`);
      continue;
    }
    const pc = await sdk(() => c.send(new UploadPartCopyCommand({ Bucket: bucket, Key: `upc-${name}.bin`, UploadId: m.r!.UploadId, PartNumber: 1, CopySource: `${bucket}/${src}`, CopySourceIfMatch: cond })));
    set("SS03f", name, `${pc.status} ${pc.code || "ok"}${pc.ok ? ` etag=${pc.r?.CopyPartResult?.ETag ? "returned" : "-"}` : ""}`);
    await sdk(() => c.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: `upc-${name}.bin`, UploadId: m.r!.UploadId })));
  }
}

// ---------------- SS03g - checksums ----------------
function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
const crc32b64 = (b: Buffer) => {
  const x = Buffer.alloc(4);
  x.writeUInt32BE(crc32(b));
  return x.toString("base64");
};

/** PUT with an aws-chunked body and a trailing checksum, unsigned payload (what the SDK sends for streams). */
function chunkedTrailerPut(t: Target, h: Host, path: string, data: Buffer, trailerValue: string): Promise<RawResp> {
  const body = Buffer.concat([
    Buffer.from(`${data.length.toString(16)}\r\n`),
    data,
    Buffer.from(`\r\n0\r\nx-amz-checksum-crc32:${trailerValue}\r\n\r\n`),
  ]);
  const url = `${h.s3}${path}`;
  const headers = sigv4(
    "PUT",
    url,
    {
      "content-encoding": "aws-chunked",
      "x-amz-decoded-content-length": String(data.length),
      "x-amz-trailer": "x-amz-checksum-crc32",
      "content-length": String(body.length),
    },
    { hash: "STREAMING-UNSIGNED-PAYLOAD-TRAILER" },
    t.creds,
    t.region,
  );
  return raw(url, { method: "PUT", headers, body, keep: 400 });
}

async function ss03g(t: Target, fx: Manifest, bucket: string) {
  const h = gw(t);
  const c = s3c(t, h);
  const data = readRange(fx.mid.path, 0, 256 * 1024);
  const good = createHash("sha256").update(data).digest("base64");
  const wrong = createHash("sha256").update("not the body").digest("base64");
  const stored = async (key: string) => {
    const g = await sdk(() => c.send(new GetObjectCommand({ Bucket: bucket, Key: key })));
    if (!g.ok) return `absent (${g.status} ${g.code})`;
    return sha(Buffer.from(await g.r!.Body!.transformToByteArray())) === sha(data) ? "stored" : "stored-different-bytes";
  };
  const sent: Record<string, string> = {};
  const cap = (k: string) => (next: any) => async (args: any) => {
    const hh = args.request?.headers ?? {};
    sent[k] = Object.keys(hh)
      .filter((n) => /checksum|content-md5|x-amz-trailer|content-encoding|x-amz-content-sha256/i.test(n))
      .map((n) => `${n}=${/sha256$/i.test(n) && /^[0-9a-f]{64}$/.test(hh[n]) ? "<hex>" : String(hh[n]).slice(0, 40)}`)
      .join(" ");
    return next(args);
  };
  const put = async (k: string, key: string, extra: Record<string, unknown>, client = c) => {
    client.middlewareStack.add(cap(k), { step: "deserialize", name: `cap-${k}` });
    const r = await sdk(() => client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: data, ...extra })));
    client.middlewareStack.remove(`cap-${k}`);
    set("SS03g", k, `${r.status} ${r.code || "ok"}${r.ok ? ` echo_sha256=${r.r?.ChecksumSHA256 ? "yes" : "no"} echo_crc32=${r.r?.ChecksumCRC32 ? "yes" : "no"}` : ""} -> ${await stored(key)}`);
    set("SS03g", `${k}_sent_headers`, sent[k] || "-");
  };
  await put("put_sha256_correct", "ck-sha-good.bin", { ChecksumAlgorithm: "SHA256", ChecksumSHA256: good });
  await put("put_sha256_wrong", "ck-sha-bad.bin", { ChecksumAlgorithm: "SHA256", ChecksumSHA256: wrong });
  await put("put_content_md5_correct", "ck-md5-good.bin", { ContentMD5: md5b64(data) });
  await put("put_content_md5_wrong", "ck-md5-bad.bin", { ContentMD5: md5b64("not the body") });
  await put("put_crc32_header_wrong", "ck-crc-bad.bin", { ChecksumAlgorithm: "CRC32", ChecksumCRC32: "AAAAAA==" });
  await put("put_sdk_default_checksum", "ck-default.bin", {});
  await put("put_sdk_when_required", "ck-when-required.bin", {}, s3c(t, h, t.creds, { requestChecksumCalculation: "WHEN_REQUIRED" }));
  // trailer mode, raw
  const tg = await chunkedTrailerPut(t, h, `/${bucket}/ck-trailer-good.bin`, data, crc32b64(data));
  set("SS03g", "put_aws_chunked_trailer_crc32_correct", `${tg.status} ${xmlCode(tg.text) || "ok"} -> ${await stored("ck-trailer-good.bin")}`);
  const tb = await chunkedTrailerPut(t, h, `/${bucket}/ck-trailer-bad.bin`, data, "AAAAAA==");
  set("SS03g", "put_aws_chunked_trailer_crc32_wrong", `${tb.status} ${xmlCode(tb.text) || "ok"} -> ${await stored("ck-trailer-bad.bin")}`);
  // read back with ChecksumMode
  const hd = await sdk(() => c.send(new HeadObjectCommand({ Bucket: bucket, Key: "ck-sha-good.bin", ChecksumMode: "ENABLED" })));
  set("SS03g", "head_checksum_mode_enabled", hd.ok ? `${hd.status} sha256=${hd.r?.ChecksumSHA256 ? "returned" : "absent"} crc32=${hd.r?.ChecksumCRC32 ? "returned" : "absent"}` : `${hd.status} ${hd.code}`);
  const gm = await sdk(() => c.send(new GetObjectCommand({ Bucket: bucket, Key: "ck-sha-good.bin", ChecksumMode: "ENABLED" })));
  if (gm.ok) await gm.r!.Body!.transformToByteArray();
  set("SS03g", "get_checksum_mode_enabled", gm.ok ? `${gm.status} sha256=${gm.r?.ChecksumSHA256 ? "returned" : "absent"} crc32=${gm.r?.ChecksumCRC32 ? "returned" : "absent"}` : `${gm.status} ${gm.code}`);
  // GetObjectAttributes, raw so a fall-through to GetObject is visible
  const ga = await s3raw(h.s3, `/${bucket}/ck-sha-good.bin?attributes`, { headers: { "x-amz-object-attributes": "ETag,Checksum,ObjectParts,ObjectSize" }, creds: t.creds, region: t.region, keep: 300 });
  const gaKind = /GetObjectAttributesResponse|<ObjectSize>/.test(ga.text) ? "attributes XML" : ga.sha256 === sha(data) ? "the object bytes (fell through to GetObject)" : xmlCode(ga.text) || ga.text.slice(0, 60);
  set("SS03g", "get_object_attributes", `${ga.status} ct=${ga.headers["content-type"] ?? "-"} bytes=${ga.bytes} body=${gaKind}`);
  // per-part SHA-256 on multipart, one correct part and one wrong part
  const key = "ck-mpu.bin";
  const m = await sdk(() => c.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ChecksumAlgorithm: "SHA256" })));
  if (m.ok) {
    const p1 = readRange(fx.mid.path, 0, 5 * MiB);
    const r1 = await sdk(() => c.send(new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: m.r!.UploadId, PartNumber: 1, Body: p1, ChecksumAlgorithm: "SHA256", ChecksumSHA256: createHash("sha256").update(p1).digest("base64") })));
    set("SS03g", "upload_part_sha256_correct", `${r1.status} ${r1.code || "ok"} echo_sha256=${r1.r?.ChecksumSHA256 ? "yes" : "no"}`);
    const r2 = await sdk(() => c.send(new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: m.r!.UploadId, PartNumber: 2, Body: p1, ChecksumAlgorithm: "SHA256", ChecksumSHA256: wrong })));
    set("SS03g", "upload_part_sha256_wrong", `${r2.status} ${r2.code || "ok"}`);
    await sdk(() => c.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: m.r!.UploadId })));
  } else set("SS03g", "upload_part_sha256_correct", `create ${m.status} ${m.code}`);
  // GetObject / HeadObject with partNumber=1 on the 128-part object
  const hp = await s3raw(h.s3, `/${bucket}/big.bin?partNumber=1`, { method: "HEAD", creds: t.creds, region: t.region });
  set("SS03g", "head_part_number_1_on_multipart_object", `${hp.status} cl=${hp.headers["content-length"] ?? "-"} cr=${hp.headers["content-range"] ?? "-"} parts_count=${hp.headers["x-amz-mp-parts-count"] ?? "-"} (part 1 is ${16 * MiB} bytes, object ${fx.big.size})`);
  // ETag of a PutObject with no Content-Length (chunked transfer encoding)
  const url = `${h.s3}/${bucket}/unknown-length.bin`;
  const hdr = sigv4("PUT", url, {}, { hash: "UNSIGNED-PAYLOAD" }, t.creds, t.region);
  const ul = await new Promise<RawResp>((resolve) => {
    const u = new URL(url);
    const mod = u.protocol === "https:" ? https : http;
    const t0 = performance.now();
    const req = mod.request(u, { method: "PUT", headers: { ...hdr, "transfer-encoding": "chunked" } }, (res) => {
      let txt = "";
      res.on("data", (d) => (txt += d));
      res.on("end", () => {
        const hs: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) hs[k] = String(v);
        resolve({ status: res.statusCode ?? 0, headers: hs, bytes: txt.length, sha256: "", text: txt.slice(0, 300), ms: performance.now() - t0 });
      });
    });
    req.on("error", (e) => resolve({ status: 0, headers: {}, bytes: 0, sha256: "", text: "", ms: 0, error: e.message }));
    const fd = openSync(fx.mid.path, "r");
    const buf = Buffer.alloc(MiB);
    let off = 0;
    const pump = () => {
      while (off < fx.mid.size) {
        readSync(fd, buf, 0, MiB, off);
        off += MiB;
        if (!req.write(Buffer.from(buf))) return void req.once("drain", pump);
      }
      closeSync(fd);
      req.end();
    };
    pump();
  });
  const uh = await sdk(() => c.send(new HeadObjectCommand({ Bucket: bucket, Key: "unknown-length.bin" })));
  const e = unq(uh.r?.ETag);
  set("SS03g", "put_unknown_length_etag", `${ul.status} ${xmlCode(ul.text) || ""} head etag=${e === fx.mid.md5 ? "md5-of-object" : /-\d+$/.test(e) ? `md5-dash-${e.split("-")[1]}` : e ? "other" : "-"} size=${uh.r?.ContentLength ?? "-"}`.replace(/\s+/g, " "));
}

// ---------------- SS03h - CORS ----------------
async function ss03h(t: Target, fx: Manifest, bucket: string) {
  const h = gw(t);
  const p = paths(t, bucket, "cond.bin");
  const ac = ["access-control-allow-origin", "access-control-allow-methods", "access-control-allow-headers", "access-control-max-age", "access-control-expose-headers"];
  const fmt = (r: RawResp) => [`${r.status}`, ...ac.map((n) => `${n.replace("access-control-", "")}=${(r.headers[n] ?? "-").slice(0, 120)}`)].join(" ");
  const pre = async (url: string, method: string, reqHeaders: string) =>
    raw(url, { method: "OPTIONS", headers: { origin: ORIGIN, "access-control-request-method": method, "access-control-request-headers": reqHeaders }, keep: 200 });
  set("SS03h", "preflight_s3_put", fmt(await pre(`${h.s3}/${bucket}/cond.bin`, "PUT", "authorization,content-type,x-amz-date,x-amz-content-sha256,x-amz-security-token")));
  set("SS03h", "preflight_sign_get", fmt(await pre(await p.sign(h), "GET", "range")));
  set("SS03h", "preflight_public_get", fmt(await pre(p.pub(h), "GET", "range")));
  set("SS03h", "preflight_authenticated_get", fmt(await pre(p.auth(h), "GET", "authorization,apikey,range")));
  // actual responses carry Expose-Headers
  const s3get = await s3raw(h.s3, `/${bucket}/cond.bin`, { headers: { origin: ORIGIN, range: "bytes=0-9" }, creds: t.creds, region: t.region, keep: 0 });
  set("SS03h", "actual_s3_get", fmt(s3get));
  for (const which of ["sign", "pub", "auth"] as const) {
    const u = await pathUrl(t, p, which, h);
    set("SS03h", `actual_${which}_get`, fmt(await raw(u.url, { headers: { ...u.headers, origin: ORIGIN, range: "bytes=0-9" }, keep: 0 })));
  }
  // UploadPart response
  const c = s3c(t, h);
  const m = await sdk(() => c.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: "cors-part.bin" })));
  if (m.ok) {
    const up = await s3raw(h.s3, `/${bucket}/cors-part.bin?partNumber=1&uploadId=${encodeURIComponent(m.r!.UploadId!)}`, { method: "PUT", headers: { origin: ORIGIN }, body: Buffer.from("part"), creds: t.creds, region: t.region });
    set("SS03h", "actual_s3_upload_part", fmt(up));
    await sdk(() => c.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: "cors-part.bin", UploadId: m.r!.UploadId })));
  }
  const exposes = (r: string) => {
    const v = (rows.SS03h?.[r] as string) ?? "";
    const ex = /expose-headers=([^ ]*)/.exec(v)?.[1] ?? "-";
    return ["etag", "content-range", "x-amz-checksum"].map((n) => `${n}:${ex === "*" ? "wildcard" : ex.toLowerCase().includes(n) ? "yes" : "no"}`).join(",");
  };
  for (const r of ["actual_s3_get", "actual_sign_get", "actual_pub_get", "actual_auth_get", "actual_s3_upload_part"]) if (rows.SS03h?.[r]) set("SS03h", `${r}_exposes`, exposes(r));
  // Bucket CORS API on a throwaway bucket name that does not exist yet
  const tb = `ss-cors-${randomBytes(4).toString("hex")}`;
  const pc = await sdk(() => c.send(new PutBucketCorsCommand({ Bucket: tb, CORSConfiguration: { CORSRules: [{ AllowedMethods: ["GET"], AllowedOrigins: [ORIGIN] }] } })));
  const exists = await sdk(() => c.send(new HeadBucketCommand({ Bucket: tb })));
  set("SS03h", "put_bucket_cors_on_new_name", `${pc.status} ${pc.code || "ok"}; bucket exists afterwards: ${exists.ok ? "yes" : `no (${exists.status})`}`);
  if (exists.ok) {
    const del = await s3raw(h.s3, `/${tb}`, { method: "DELETE", creds: t.creds, region: t.region });
    set("SS03h", "put_bucket_cors_new_bucket_deleted", del.status);
  }
  const gcs = await s3raw(h.s3, `/${bucket}?cors`, { creds: t.creds, region: t.region, keep: 300 });
  const body = gcs.text;
  set("SS03h", "get_bucket_cors_raw", `${gcs.status} ${xmlCode(body) || (/<ListBucketResult/.test(body) ? "ListBucketResult body (routed to ListObjects)" : /<CORSConfiguration/.test(body) ? "CORSConfiguration body" : body.slice(0, 60))}`);
  const gc = await sdk(() => c.send(new GetBucketCorsCommand({ Bucket: bucket })));
  set("SS03h", "get_bucket_cors_sdk", `${gc.status} ${gc.code || `rules=${gc.r?.CORSRules?.length ?? 0}`}`);
}

// ---------------- SS03i - error bodies ----------------
function errCell(r: RawResp): string {
  if (r.error) return `ERR ${r.error}`;
  const ct = (r.headers["content-type"] ?? "-").split(";")[0];
  let code = "";
  let msg = "";
  let bodyStatus = "";
  if (/<Error/.test(r.text)) {
    code = xmlCode(r.text);
    msg = /<Message>([^<]*)<\/Message>/.exec(r.text)?.[1] ?? "";
  } else {
    try {
      const j = JSON.parse(r.text) as { code?: string; error?: string; message?: string; statusCode?: string | number };
      code = String(j.code ?? j.error ?? "");
      msg = String(j.message ?? "");
      bodyStatus = j.statusCode !== undefined ? String(j.statusCode) : "";
    } catch {
      msg = r.text.replace(/\s+/g, " ").slice(0, 80);
    }
  }
  return `${r.status} ct=${ct} code=${code || "-"}${bodyStatus ? ` body.statusCode=${bodyStatus}` : ""} message=${msg.slice(0, 100) || "-"}`;
}

async function ss03i(t: Target, fx: Manifest, bucket: string) {
  const h = gw(t);
  const s3 = (path: string, o: { method?: string; headers?: Record<string, string>; secret?: string } = {}) =>
    s3raw(h.s3, path, { method: o.method, headers: o.headers, creds: o.secret ? { ...t.creds, secretAccessKey: o.secret } : t.creds, region: t.region, keep: 400 });
  const rest = (path: string, o: { headers?: Record<string, string> } = {}) => raw(`${h.rest}${path}`, { headers: { ...restAuth(t), ...(o.headers ?? {}) }, keep: 400 });
  const S = MiB;
  set("SS03i", "s3_no_such_key", errCell(await s3(`/${bucket}/missing-ss03i.bin`)));
  set("SS03i", "rest_no_such_key", errCell(await rest(`/object/authenticated/${bucket}/missing-ss03i.bin`)));
  set("SS03i", "s3_no_such_bucket", errCell(await s3(`/no-such-bucket-ss03/x.bin`)));
  set("SS03i", "rest_no_such_bucket", errCell(await rest(`/object/authenticated/no-such-bucket-ss03/x.bin`)));
  set("SS03i", "s3_wrong_secret", errCell(await s3(`/${bucket}/cond.bin`, { secret: "wrong-secret-for-ss03i-000000000000" })));
  // A token with a valid shape and a made-up signature, built at run time so no token-shaped literal sits in source.
  const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const forged = [b64u({ alg: "HS256", typ: "JWT" }), b64u({ role: "service_role" }), Buffer.from("not-a-signature").toString("base64url")].join(".");
  set("SS03i", "rest_bogus_jwt", errCell(await raw(`${h.rest}/object/authenticated/${bucket}/cond.bin`, { headers: { apikey: t.anon, authorization: `Bearer ${forged}` }, keep: 400 })));
  set("SS03i", "s3_invalid_key_put", errCell(await s3(`/${bucket}/100%25.txt`, { method: "PUT" })));
  set("SS03i", "rest_invalid_key_get", errCell(await rest(`/object/authenticated/${bucket}/100%25.txt`)));
  set("SS03i", "s3_invalid_range", errCell(await s3(`/${bucket}/cond.bin`, { headers: { range: `bytes=${S + 10}-${S + 20}` } })));
  set("SS03i", "rest_invalid_range", errCell(await rest(`/object/authenticated/${bucket}/cond.bin`, { headers: { range: `bytes=${S + 10}-${S + 20}` } })));
  void fx;
}

/** SS03i EntityTooLarge rows at the target's default limit (run before the limit is raised). */
async function tooLarge(t: Target, fx: Manifest, bucket: string) {
  const h = gw(t);
  const body = readFileSync(fx.mid.path);
  const sp = await s3raw(h.s3, `/${bucket}/too-large-s3.bin`, { method: "PUT", body, creds: t.creds, region: t.region, keep: 400 });
  set("SS03i", "default_limit_s3_put_64MiB", errCell(sp));
  const rp = await raw(`${h.rest}/object/${bucket}/too-large-rest.bin`, { method: "POST", headers: { ...restAuth(t), "content-type": "application/octet-stream" }, body, keep: 400 });
  set("SS03i", "default_limit_rest_post_64MiB", errCell(rp));
  // multipart: four 16 MiB parts, each under the limit, total over it
  const c = s3c(t, h);
  const m = await sdk(() => c.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: "too-large-mpu.bin" })));
  if (m.ok) {
    const parts: Array<{ PartNumber: number; ETag?: string }> = [];
    let partErr = "";
    for (let n = 1; n <= 4; n++) {
      const r = await sdk(() => c.send(new UploadPartCommand({ Bucket: bucket, Key: "too-large-mpu.bin", UploadId: m.r!.UploadId, PartNumber: n, Body: body.subarray((n - 1) * 16 * MiB, n * 16 * MiB) })));
      if (!r.ok) {
        partErr = `part ${n}: ${r.status} ${r.code} ${r.msg}`;
        break;
      }
      parts.push({ PartNumber: n, ETag: r.r?.ETag });
    }
    if (partErr) set("SS03i", "default_limit_s3_multipart_4x16MiB", partErr);
    else {
      const d = await sdk(() => c.send(new CompleteMultipartUploadCommand({ Bucket: bucket, Key: "too-large-mpu.bin", UploadId: m.r!.UploadId, MultipartUpload: { Parts: parts } })));
      set("SS03i", "default_limit_s3_multipart_4x16MiB", `complete ${d.status} ${d.code || "ok"} ${d.msg}`.trim());
    }
    await sdk(() => c.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: "too-large-mpu.bin", UploadId: m.r!.UploadId })));
  } else set("SS03i", "default_limit_s3_multipart_4x16MiB", `create ${m.status} ${m.code}`);
}

// ---------------- SS03k - large and gzip-encoded objects through the read paths ----------------
async function ss03k(t: Target, fx: Manifest, bucket: string) {
  const objs: Array<[string, Fix, string, string]> = [
    ["gz", fx.gz, "gz.bin", "gzip, deflate, br"],
    ["big", fx.big, "big.bin", "gzip, deflate, br"],
  ];
  for (const [name, f, key, ae] of objs) {
    for (const h of t.hosts) {
      for (const which of PATHS) {
        // A fresh copy per path and host, so "first" is a cold read; deleted after its two reads.
        const k = `k-${name}-${which}-${h.name}-${RUN}.bin`;
        const err = await freshCopy(t, bucket, key, k);
        if (err) {
          set("SS03k", `${name}_${h.name}_${which}_first`, err);
          continue;
        }
        const p = paths(t, bucket, k);
        for (const read of ["first", "repeat"]) {
          const u = await pathUrl(t, p, which, h);
          const r = await raw(u.url, { headers: { ...u.headers, "accept-encoding": ae }, keep: 0, timeoutMs: 900_000 });
          const verdict = r.sha256 === f.sha256 ? "hash=stored-bytes" : name === "gz" && r.sha256 === fx.gz.plainSha256 ? "hash=DECOMPRESSED" : "hash=DIFF";
          set("SS03k", `${name}_${h.name}_${which}_${read}`, `${r.status} cl=${r.headers["content-length"] ?? "-"} ce=${r.headers["content-encoding"] ?? "-"} te=${r.headers["transfer-encoding"] ?? "-"} cf=${r.headers["cf-cache-status"] ?? "-"} bytes=${r.bytes} ${verdict} ttfb=${Math.round(r.ttfbMs ?? -1)} ms=${Math.round(r.ms)}`);
        }
        await dropKey(t, bucket, k);
      }
    }
  }
}

// ---------------- SS03l - server-side encryption headers ----------------
async function ss03l(t: Target, fx: Manifest, bucket: string) {
  const h = gw(t);
  const key32 = randomBytes(32);
  const variants: Array<[string, Record<string, string>]> = [
    [
      "sse_c",
      {
        "x-amz-server-side-encryption-customer-algorithm": "AES256",
        "x-amz-server-side-encryption-customer-key": key32.toString("base64"),
        "x-amz-server-side-encryption-customer-key-md5": md5b64(key32),
      },
    ],
    ["sse_s3_aes256", { "x-amz-server-side-encryption": "AES256" }],
    ["sse_kms", { "x-amz-server-side-encryption": "aws:kms", "x-amz-server-side-encryption-aws-kms-key-id": "alias/ss03l-probe" }],
  ];
  const data = readRange(fx.mid.path, 0, 4096);
  for (const [name, hdrs] of variants) {
    const key = `sse-${name}.bin`;
    const put = await s3raw(h.s3, `/${bucket}/${key}`, { method: "PUT", headers: hdrs, body: data, creds: t.creds, region: t.region, keep: 400 });
    const echoed = Object.keys(put.headers).filter((k) => k.startsWith("x-amz-server-side-encryption")).join(",") || "none";
    set("SS03l", `put_${name}`, `${put.status} ${xmlCode(put.text) || "accepted"} sse_response_headers=${echoed}`);
    if (put.status === 200) {
      const g = await s3raw(h.s3, `/${bucket}/${key}`, { creds: t.creds, region: t.region, keep: 0 });
      set("SS03l", `get_${name}_without_sse_headers`, `${g.status} ${g.sha256 === sha(data) ? "plaintext bytes returned" : g.status === 200 ? "different bytes" : xmlCode(g.text)}`);
      const hd = await s3raw(h.s3, `/${bucket}/${key}`, { method: "HEAD", creds: t.creds, region: t.region });
      set("SS03l", `head_${name}_sse_headers`, Object.keys(hd.headers).filter((k) => k.startsWith("x-amz-server-side-encryption")).join(",") || "none");
    }
    const cm = await s3raw(h.s3, `/${bucket}/sse-mpu-${name}.bin?uploads`, { method: "POST", headers: hdrs, creds: t.creds, region: t.region, keep: 400 });
    const id = /<UploadId>([^<]*)<\/UploadId>/.exec(cm.text)?.[1];
    set("SS03l", `create_multipart_${name}`, `${cm.status} ${xmlCode(cm.text) || (id ? "accepted (upload id)" : "")}`.trim());
    if (id) await s3raw(h.s3, `/${bucket}/sse-mpu-${name}.bin?uploadId=${encodeURIComponent(id)}`, { method: "DELETE", creds: t.creds, region: t.region });
  }
  const ge = await s3raw(h.s3, `/${bucket}?encryption`, { creds: t.creds, region: t.region, keep: 400 });
  set("SS03l", "get_bucket_encryption", `${ge.status} ${xmlCode(ge.text) || (/<ListBucketResult/.test(ge.text) ? "ListBucketResult body (routed to ListObjects)" : ge.text.slice(0, 80))}`);
}

// ---------------- SS05 - client-side encrypted object ----------------
const ENC_CHUNK = 4 * MiB;
const TAG = 16;
const nonce = (i: number) => {
  const n = Buffer.alloc(12);
  n.writeUInt32BE(i, 8);
  return n;
};

async function ss05(t: Target, fx: Manifest, bucket: string) {
  const h = gw(t);
  const c = s3c(t, h);
  const key = randomBytes(32); // per run, in memory only
  const plain = readFileSync(fx.mid.path);
  const chunks: Buffer[] = [];
  for (let i = 0; i * ENC_CHUNK < plain.length; i++) {
    const ci = createCipheriv("aes-256-gcm", key, nonce(i));
    const ct = Buffer.concat([ci.update(plain.subarray(i * ENC_CHUNK, (i + 1) * ENC_CHUNK)), ci.final(), ci.getAuthTag()]);
    chunks.push(ct);
  }
  const enc = Buffer.concat(chunks);
  const put = await sdk(() => c.send(new PutObjectCommand({ Bucket: bucket, Key: "enc.bin", Body: enc, ContentType: "application/octet-stream" })));
  set("SS05a", "put_enc", `${put.status} ${put.code || "ok"} size=${enc.length}`);
  const whole = await raw(`${h.rest}/object/authenticated/${bucket}/enc.bin`, { headers: restAuth(t), keep: 0 });
  set("SS05a", "whole_object_ciphertext_hash", whole.sha256 === sha(enc) ? "equal" : `DIFF (${whole.status})`);
  const span = ENC_CHUNK + TAG;
  for (const i of [0, 7, chunks.length - 1]) {
    const start = i * span;
    const end = start + span - 1;
    const tryDecrypt = (b: Buffer) => {
      try {
        const d = createDecipheriv("aes-256-gcm", key, nonce(i));
        d.setAuthTag(b.subarray(b.length - TAG));
        const p = Buffer.concat([d.update(b.subarray(0, b.length - TAG)), d.final()]);
        return sha(p) === sha(plain.subarray(i * ENC_CHUNK, (i + 1) * ENC_CHUNK)) ? "decrypts to the plaintext slice" : "decrypts, wrong plaintext";
      } catch {
        return "auth tag check FAILED";
      }
    };
    const g = await sdk(() => c.send(new GetObjectCommand({ Bucket: bucket, Key: "enc.bin", Range: `bytes=${start}-${end}` })));
    if (g.ok) {
      const b = Buffer.from(await g.r!.Body!.transformToByteArray());
      set("SS05a", `s3_range_chunk_${i}`, `${g.status} bytes=${b.length} ${tryDecrypt(b)}`);
    } else set("SS05a", `s3_range_chunk_${i}`, `${g.status} ${g.code}`);
    const rr = await new Promise<Buffer | string>((resolve) => {
      const u = new URL(`${h.rest}/object/authenticated/${bucket}/enc.bin`);
      const mod = u.protocol === "https:" ? https : http;
      mod
        .get(u, { headers: { ...restAuth(t), range: `bytes=${start}-${end}` } }, (res) => {
          const bufs: Buffer[] = [];
          res.on("data", (d: Buffer) => bufs.push(d));
          res.on("end", () => resolve(res.statusCode === 206 || res.statusCode === 200 ? Buffer.concat(bufs) : `${res.statusCode}`));
        })
        .on("error", (e) => resolve(e.message));
    });
    set("SS05a", `rest_range_chunk_${i}`, typeof rr === "string" ? rr : `bytes=${rr.length} ${tryDecrypt(rr)}`);
  }
  // SS05c: image render on the ciphertext, with a real PNG as the control
  const png = readFileSync(fx.png.path);
  await sdk(() => c.send(new PutObjectCommand({ Bucket: bucket, Key: "solid.png", Body: png, ContentType: "image/png" })));
  for (const [n, k] of [
    ["enc", "enc.bin"],
    ["png_control", "solid.png"],
  ] as const) {
    const r = await raw(`${h.rest}/render/image/authenticated/${bucket}/${k}?width=32&height=32`, { headers: restAuth(t), keep: 200 });
    const body = /json|text|xml/.test(r.headers["content-type"] ?? "") ? r.text.replace(/\s+/g, " ").slice(0, 150) : `<${r.bytes} bytes>`;
    set("SS05c", `render_image_${n}`, `${r.status} ct=${r.headers["content-type"] ?? "-"} ${body}`);
  }
  // uploads with no content type: REST (raw, no Content-Type header) and S3 (raw, none sent)
  for (const [n, b] of [
    ["enc", enc.subarray(0, 64 * 1024)],
    ["png", png],
  ] as const) {
    const rp = await raw(`${h.rest}/object/${bucket}/notype-rest-${n}`, { method: "POST", headers: { ...restAuth(t) }, body: b, keep: 200 });
    set("SS05c", `rest_post_no_content_type_${n}`, `${rp.status} ${rp.status >= 300 ? rp.text.slice(0, 100) : ""}`.trim());
    const sp = await s3raw(h.s3, `/${bucket}/notype-s3-${n}`, { method: "PUT", body: b, creds: t.creds, region: t.region, keep: 200 });
    set("SS05c", `s3_put_no_content_type_${n}`, `${sp.status} ${xmlCode(sp.text)}`.trim());
    const hd = await s3raw(h.s3, `/${bucket}/notype-s3-${n}`, { method: "HEAD", creds: t.creds, region: t.region });
    set("SS05c", `s3_head_content_type_${n}`, hd.headers["content-type"] ?? "-");
  }
}

/** SS05d reads with user JWTs (session-token S3 auth and REST). */
async function ss05rls(t: Target, bucket: string, objKey: string, jwts: Record<string, string>, tag: string) {
  const h = gw(t);
  for (const [who, jwt] of Object.entries(jwts)) {
    const r = await raw(`${h.rest}/object/authenticated/${bucket}/${objKey}`, { headers: { apikey: t.anon, authorization: `Bearer ${jwt}`, range: "bytes=0-15" }, keep: 300 });
    set("SS05d", `${tag}_rest_authenticated_${who}`, `${r.status} cf=${r.headers["cf-cache-status"] ?? "-"}${r.status >= 300 ? ` ${r.text.replace(/\s+/g, " ").slice(0, 120)}` : ` bytes=${r.bytes}`}`);
    if (who === "anon") continue;
    const creds = { accessKeyId: t.sessionKeyId, secretAccessKey: t.anon, sessionToken: jwt };
    const c = s3c(t, h, creds);
    const g = await sdk(() => c.send(new GetObjectCommand({ Bucket: bucket, Key: objKey, Range: "bytes=0-15" })));
    if (g.ok) await g.r!.Body!.transformToByteArray();
    set("SS05d", `${tag}_s3_session_token_${who}`, g.ok ? `${g.status} ok` : `${g.status} ${g.code} ${g.msg.slice(0, 80)}`);
    const lb = await sdk(() => c.send(new ListBucketsCommand({})));
    set("SS05d", `${tag}_s3_session_token_${who}_list_buckets`, lb.ok ? `${lb.status} buckets=${lb.r?.Buckets?.length ?? 0}` : `${lb.status} ${lb.code}`);
  }
}

if (import.meta.main) {
  const input = JSON.parse(readFileSync(0, "utf8"));
  const t = input.target as Target;
  const fx = input.fx as Manifest;
  const bucket = input.bucket as string;
  const want = new Set<string>(input.rows ?? []);
  const run = async (id: string, f: () => Promise<void>) => {
    if (want.size && !want.has(id)) return;
    try {
      await f();
    } catch (e) {
      set(id, "battery_error", String((e as Error).stack ?? e).replace(/\s+/g, " ").slice(0, 300));
    }
  };
  switch (input.cmd) {
    case "ss03":
      await run("SS03c", () => ss03c(t, fx, bucket));
      await run("SS03d", () => ss03d(t, fx, bucket));
      await run("SS03e", () => ss03e(t, fx, bucket));
      await run("SS03f", () => ss03f(t, fx, bucket));
      await run("SS03g", () => ss03g(t, fx, bucket));
      await run("SS03h", () => ss03h(t, fx, bucket));
      await run("SS03i", () => ss03i(t, fx, bucket));
      await run("SS03k", () => ss03k(t, fx, bucket));
      await run("SS03l", () => ss03l(t, fx, bucket));
      break;
    case "too-large":
      await run("SS03i", () => tooLarge(t, fx, bucket));
      break;
    case "ss05":
      await run("SS05a", () => ss05(t, fx, bucket));
      break;
    case "ss05-rls":
      await run("SS05d", () => ss05rls(t, bucket, input.key, input.jwts, input.tag ?? "x"));
      break;
  }
  const scrub = scrubber(t);
  console.log(scrub(JSON.stringify({ rows, notes })));
  process.exit(0);
}
