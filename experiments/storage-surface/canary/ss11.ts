/**
 * SS11 canary commands (Node, raw node:https where the request shape matters):
 *
 *   fixtures      huge (2304 MiB = 2.25 GiB, 144 x 16 MiB parts) and two
 *                 64 MiB files r1, r2, seeded like fixtures.ts; reused while
 *                 their manifest matches
 *   mpu-parallel  multipart upload of the first `parts` 16 MiB parts of a
 *                 fixture with `concurrency` UploadPart requests in flight;
 *                 wall time, per-part times, final ETag against the AWS value
 *   tus-create    a TUS creation POST; Location and Upload-Expires
 *   tus-race      two clients on one TUS upload URL: `overlap` (both PATCH
 *                 offset 0, one slowly) or `head-during` (HEAD and PATCH
 *                 while the slow PATCH is in flight); then the rest is
 *                 filled, and the stored object is read back and its bytes
 *                 counted by fill letter per 6 MiB segment
 *
 *   s3-delete     S3 DeleteObject (SS12)
 *   mpu-abandon   CreateMultipartUpload and `parts` parts, never completed (SS12)
 *   mpu-abort     AbortMultipartUpload of that upload (SS12)
 *   tus-delete    a TUS termination (DELETE) on an upload URL (SS12)
 *
 *   echo '{"cmd":"...", ...}' | node ss11.ts   -> one JSON line
 */
import { AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand, DeleteObjectCommand, UploadPartCommand } from "@aws-sdk/client-s3";
import { existsSync, readFileSync, writeFileSync, openSync, readSync, closeSync, mkdirSync } from "node:fs";
import https from "node:https";
import http from "node:http";
import { join } from "node:path";
import { PART, MiB, writeSeeded, type Fix } from "./fixtures.ts";
import { awsMultipartEtag } from "./upload.ts";
import { type Host, type Target, s3c, scrubber, sdk } from "./target.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const unq = (e?: string) => (e ?? "").replace(/"/g, "");

export const HUGE_MIB = 2304;
const VERSION = 1;

function fixtures(dir: string) {
  mkdirSync(dir, { recursive: true });
  const mf = join(dir, "ss11.json");
  if (existsSync(mf)) {
    const m = JSON.parse(readFileSync(mf, "utf8"));
    if (m.version === VERSION && [m.huge, m.r1, m.r2].every((f: Fix) => existsSync(f.path))) return m;
  }
  const m = {
    version: VERSION,
    huge: writeSeeded(join(dir, "huge.bin"), "huge", HUGE_MIB * MiB),
    r1: writeSeeded(join(dir, "r1.bin"), "r1", 64 * MiB),
    r2: writeSeeded(join(dir, "r2.bin"), "r2", 64 * MiB),
  };
  writeFileSync(mf, JSON.stringify(m));
  return m;
}

function readPart(path: string, n: number, size: number): Buffer {
  const start = (n - 1) * PART;
  const len = Math.min(PART, size - start);
  const buf = Buffer.alloc(len);
  const fd = openSync(path, "r");
  readSync(fd, buf, 0, len, start);
  closeSync(fd);
  return buf;
}

function pctl(xs: number[], p: number) {
  if (!xs.length) return -1;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!);
}

async function mpuParallel(t: Target, h: Host, bucket: string, key: string, fx: Fix, parts: number, concurrency: number) {
  const c = s3c(t, h);
  const t0 = performance.now();
  const cr = await sdk(() => c.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: "application/octet-stream" })));
  if (!cr.ok) return { ok: false, step: "create", status: cr.status, code: cr.code, msg: cr.msg };
  const uploadId = cr.r!.UploadId!;
  const etags: Array<{ ETag: string; PartNumber: number }> = [];
  const partMs: number[] = [];
  let next = 1;
  let failed = "";
  let md5match = 0;
  let inflightMax = 0;
  let inflight = 0;
  const tUp = performance.now();
  const worker = async () => {
    for (;;) {
      const n = next++;
      if (n > parts || failed) return;
      const body = readPart(fx.path, n, fx.size);
      const p0 = performance.now();
      inflight++;
      inflightMax = Math.max(inflightMax, inflight);
      const r = await sdk(() => c.send(new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumber: n, Body: body })));
      inflight--;
      partMs.push(performance.now() - p0);
      if (!r.ok) {
        failed = `part ${n}: ${r.status} ${r.code} ${r.msg}`;
        return;
      }
      if (unq(r.r?.ETag) === fx.partMd5[n - 1]) md5match++;
      etags.push({ ETag: r.r!.ETag!, PartNumber: n });
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const upMs = performance.now() - tUp;
  if (failed) return { ok: false, failed, uploadId, partsDone: etags.length, upMs };
  etags.sort((a, b) => a.PartNumber - b.PartNumber);
  const done = await sdk(() => c.send(new CompleteMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId, MultipartUpload: { Parts: etags } })));
  const ms = performance.now() - t0;
  const bytes = Math.min(parts * PART, fx.size);
  const etag = unq(done.r?.ETag);
  return {
    ok: done.ok,
    parts,
    concurrency,
    inflightMax,
    bytes,
    md5match,
    completeStatus: done.status,
    completeCode: done.code,
    completeMsg: done.msg,
    etagIsAws: etag === awsMultipartEtag(fx.partMd5.slice(0, parts)),
    etag,
    ms: Math.round(ms),
    partsPhaseMs: Math.round(upMs),
    // MB = 10^6 bytes; over the whole call (create to complete)
    mbps: Math.round((bytes / 1e6 / (ms / 1000)) * 10) / 10,
    partMsP50: pctl(partMs, 50),
    partMsP95: pctl(partMs, 95),
    partMsMax: pctl(partMs, 100),
  };
}

// ---- TUS ----

function tusHeaders(t: Target): Record<string, string> {
  return { authorization: `Bearer ${t.service}`, apikey: t.service, "tus-resumable": "1.0.0" };
}

const b64 = (s: string) => Buffer.from(s).toString("base64");

interface Resp {
  status: number;
  headers: Record<string, string>;
  body: string;
  atMs: number;
  error?: string;
  sentBytes?: number;
}

/** One request on its own agent (a separate client); body written in slices `delayMs` apart when given. */
function req(url: string, method: string, headers: Record<string, string>, body: Buffer | undefined, t0: number, slice = 0, delayMs = 0): Promise<Resp> {
  const u = new URL(url);
  const mod = u.protocol === "https:" ? https : http;
  const agent = u.protocol === "https:" ? new https.Agent({ keepAlive: false }) : new http.Agent({ keepAlive: false });
  return new Promise((resolve) => {
    let sent = 0;
    let settled = false;
    const done = (r: Resp) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    const h = { ...headers };
    if (body) h["content-length"] = String(body.length);
    const rq = mod.request(u, { method, headers: h, agent }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (d: Buffer) => chunks.push(d));
      res.on("end", () => {
        const hs: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) hs[k] = Array.isArray(v) ? v.join(", ") : String(v ?? "");
        done({ status: res.statusCode ?? 0, headers: hs, body: Buffer.concat(chunks).toString("utf8").replace(/\s+/g, " ").slice(0, 200), atMs: Math.round(performance.now() - t0), sentBytes: sent });
      });
      res.on("error", (e) => done({ status: res.statusCode ?? 0, headers: {}, body: "", atMs: Math.round(performance.now() - t0), error: e.message, sentBytes: sent }));
    });
    rq.setTimeout(300_000, () => rq.destroy(new Error("timeout")));
    rq.on("error", (e) => done({ status: 0, headers: {}, body: "", atMs: Math.round(performance.now() - t0), error: String(e.message).slice(0, 160), sentBytes: sent }));
    if (!body) return void rq.end();
    if (!slice) {
      sent = body.length;
      return void rq.end(body);
    }
    (async () => {
      for (let off = 0; off < body.length; off += slice) {
        if (settled || rq.destroyed) return;
        const part = body.subarray(off, Math.min(body.length, off + slice));
        rq.write(part);
        sent += part.length;
        if (off + slice < body.length) await sleep(delayMs);
      }
      rq.end();
    })();
  });
}

const short = (r: Resp) => `${r.status}${r.error ? ` err=${r.error}` : ""} at=${r.atMs}ms offset=${r.headers["upload-offset"] ?? "-"}${r.status >= 300 && r.body ? ` body=${r.body.slice(0, 120)}` : ""}${r.sentBytes !== undefined ? ` sent=${r.sentBytes}` : ""}`;

async function tusCreate(t: Target, h: Host, bucket: string, key: string, length: number) {
  const ep = `${h.rest}/upload/resumable`;
  const r = await req(ep, "POST", { ...tusHeaders(t), "upload-length": String(length), "x-upsert": "true", "upload-metadata": `bucketName ${b64(bucket)},objectName ${b64(key)},contentType ${b64("application/octet-stream")}` }, undefined, performance.now());
  const loc = r.headers.location ? new URL(r.headers.location, ep).toString() : "";
  return { status: r.status, url: loc, body: r.status >= 300 ? r.body : "" };
}

const patchHeaders = (t: Target, offset: number) => ({ ...tusHeaders(t), "upload-offset": String(offset), "content-type": "application/offset+octet-stream" });

/** GET the stored object and count bytes per segment by fill letter. */
function letters(url: string, headers: Record<string, string>, seg: number): Promise<{ status: number; bytes: number; segs: string[] }> {
  const u = new URL(url);
  const mod = u.protocol === "https:" ? https : http;
  return new Promise((resolve) => {
    const rq = mod.request(u, { headers }, (res) => {
      const counts: Array<Record<string, number>> = [];
      let pos = 0;
      res.on("data", (d: Buffer) => {
        for (let i = 0; i < d.length; i++) {
          const s = Math.floor((pos + i) / seg);
          const c = counts[s] ??= {};
          const ch = d[i] === 65 ? "A" : d[i] === 66 ? "B" : d[i] === 67 ? "C" : "other";
          c[ch] = (c[ch] ?? 0) + 1;
        }
        pos += d.length;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, bytes: pos, segs: counts.map((c) => Object.entries(c).map(([k, v]) => `${k}:${v}`).join(" ")) }));
    });
    rq.on("error", () => resolve({ status: 0, bytes: 0, segs: [] }));
    rq.end();
  });
}

async function tusRace(t: Target, h: Host, bucket: string, key: string, scenario: "overlap" | "head-during") {
  const SEG = 6 * MiB;
  const LEN = 2 * SEG;
  const cr = await tusCreate(t, h, bucket, key, LEN);
  if (cr.status !== 201 || !cr.url) return { ok: false, create: `${cr.status} ${cr.body}` };
  const A = Buffer.alloc(SEG, "A");
  const B = Buffer.alloc(SEG, "B");
  const out: Record<string, string | number> = { create: cr.status, upload_length: LEN };
  const t0 = performance.now();
  // client A: 6 MiB at offset 0, 12 slices of 512 KiB, 500 ms apart (about 5.5 s of sending)
  const aP = req(cr.url, "PATCH", patchHeaders(t, 0), A, t0, 512 * 1024, 500);
  await sleep(1500);
  let bP: Promise<Resp>;
  if (scenario === "overlap") {
    out.b_starts_at_ms = Math.round(performance.now() - t0);
    bP = req(cr.url, "PATCH", patchHeaders(t, 0), B, t0);
  } else {
    const hd = await req(cr.url, "HEAD", tusHeaders(t), undefined, t0);
    out.b_head_during_a = short(hd);
    const off = Number(hd.headers["upload-offset"] ?? "0") || 0;
    out.b_patch_offset = off;
    out.b_starts_at_ms = Math.round(performance.now() - t0);
    bP = req(cr.url, "PATCH", patchHeaders(t, off), B, t0);
  }
  const [a, b] = await Promise.all([aP, bP]);
  out.a_patch = short(a);
  out.b_patch = short(b);
  const hd = await req(cr.url, "HEAD", tusHeaders(t), undefined, t0);
  out.head_after = short(hd);
  let off = Number(hd.headers["upload-offset"] ?? "-1");
  // fill the rest with C, one PATCH per remaining 6 MiB step
  const fills: string[] = [];
  for (let i = 0; i < 4 && off >= 0 && off < LEN; i++) {
    const n = Math.min(SEG, LEN - off);
    const r = await req(cr.url, "PATCH", patchHeaders(t, off), Buffer.alloc(n, "C"), t0);
    fills.push(`@${off}:${short(r)}`);
    const nh = await req(cr.url, "HEAD", tusHeaders(t), undefined, t0);
    off = Number(nh.headers["upload-offset"] ?? "-1");
    if (r.status >= 300 && nh.status >= 300) break;
  }
  out.fill = fills.join(" | ") || "none needed";
  const lt = await letters(`${h.rest}/object/authenticated/${bucket}/${key}`, { authorization: `Bearer ${t.service}`, apikey: t.service }, SEG);
  out.object_get = `${lt.status} bytes=${lt.bytes}`;
  lt.segs.forEach((s, i) => (out[`object_seg${i}`] = s));
  return { ok: true, url_host: new URL(cr.url).host === new URL(h.rest).host ? "same host" : "other host", rows: out };
}

if (import.meta.main) {
  const input = JSON.parse(readFileSync(0, "utf8"));
  let out: unknown;
  if (input.cmd === "fixtures") {
    out = fixtures(input.dir);
    console.log(JSON.stringify(out));
    process.exit(0);
  }
  const t = input.target as Target;
  const scrub = scrubber(t);
  const host = (t.hosts.find((x) => x.name === input.host) ?? t.hosts[0]) as Host;
  switch (input.cmd) {
    case "mpu-parallel":
      out = await mpuParallel(t, host, input.bucket, input.key, input.fx, input.parts, input.concurrency);
      break;
    case "tus-create":
      out = await tusCreate(t, host, input.bucket, input.key, input.length);
      break;
    case "tus-race":
      out = await tusRace(t, host, input.bucket, input.key, input.scenario);
      break;
    case "s3-delete": {
      const r = await sdk(() => s3c(t, host).send(new DeleteObjectCommand({ Bucket: input.bucket, Key: input.key })));
      out = { ok: r.ok, status: r.status, code: r.code };
      break;
    }
    case "mpu-abandon": {
      const c = s3c(t, host);
      const cr = await sdk(() => c.send(new CreateMultipartUploadCommand({ Bucket: input.bucket, Key: input.key })));
      if (!cr.ok) {
        out = { ok: false, status: cr.status, code: cr.code };
        break;
      }
      let done = 0;
      for (let n = 1; n <= input.parts; n++) {
        const r = await sdk(() => c.send(new UploadPartCommand({ Bucket: input.bucket, Key: input.key, UploadId: cr.r!.UploadId!, PartNumber: n, Body: readPart(input.fx.path, n, input.fx.size) })));
        if (r.ok) done++;
      }
      out = { ok: true, uploadId: cr.r!.UploadId!, parts: done };
      break;
    }
    case "mpu-abort": {
      const r = await sdk(() => s3c(t, host).send(new AbortMultipartUploadCommand({ Bucket: input.bucket, Key: input.key, UploadId: input.uploadId })));
      out = { ok: r.ok, status: r.status, code: r.code };
      break;
    }
    case "tus-delete": {
      const r = await req(input.url, "DELETE", tusHeaders(t), undefined, performance.now());
      out = { status: r.status, body: r.body.slice(0, 120), error: r.error ?? "" };
      break;
    }
  }
  console.log(scrub(JSON.stringify(out)));
  process.exit(0);
}
