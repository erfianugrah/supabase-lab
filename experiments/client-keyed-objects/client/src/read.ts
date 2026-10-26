/**
 * Ranged decrypting reads.
 *
 *   plaintext [start, end) -> covering chunk indices -> ONE ciphertext Range
 *   GET -> verify every chunk's SHA-256 against app.asset_chunks -> decrypt
 *   (AAD binds asset, index, count) -> slice
 *
 * Four read paths, each with a `Range` header:
 *   s3             S3 GetObject, session token = user JWT
 *   s3-presigned   S3 presigned GET (query SigV4, session token in the query)
 *   signed-url     Storage /object/sign signed URL
 *   authenticated  Storage /object/authenticated with the user JWT
 */
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { type AssetRow, chunkHashes, getAsset, logAccess } from "./catalogue";
import type { Ck, Session, TargetConfig } from "./ctx";
import { TAG, cipherOffset, decryptChunk, importDek, plainLen, sha256Hex, span, unhex } from "./envelope";
import { CkError } from "./errors";
import { unwrapDek } from "./keys";
import { s3call, s3For } from "./s3";

export const READ_TIMEOUT_MS = 300_000;

export type ReadPath = "s3" | "s3-presigned" | "signed-url" | "authenticated";
export const READ_PATHS: ReadPath[] = ["s3", "s3-presigned", "signed-url", "authenticated"];

export interface Fetched {
  bytes: Uint8Array;
  status: number;
  contentRange: string;
  cacheStatus: string;
  /** HTTP paths only: ms from request start to response headers, and to the last body byte. */
  ttfbMs?: number;
  fetchMs?: number;
  /** signed-url only: ms for the POST /object/sign that minted the URL. */
  signMs?: number;
  /** HTTP paths only: allowlisted response headers (cf-ray reduced to its colo) plus `names`, every header name. */
  hdr?: Record<string, string>;
}

export interface ReadResult {
  plain: Uint8Array;
  /** Body bytes received for the ciphertext GET. */
  transferred: number;
  /** Ciphertext bytes the covering chunks occupy (the floor for this design). */
  cipherNeeded: number;
  chunks: number;
  status: number;
  cacheStatus: string;
  ms: number;
  ttfbMs?: number;
  fetchMs?: number;
  signMs?: number;
  hdr?: Record<string, string>;
}

export interface ReadOpts {
  path?: ReadPath;
  verifyHashes?: boolean;
  log?: boolean;
  /** Called with each ciphertext body as fetched (CK08 scans full reads for plaintext markers this way). */
  onCipher?: (body: Uint8Array) => void;
}

const assets = new Map<string, AssetRow>();

async function assetOf(t: TargetConfig, s: Session, id: string): Promise<AssetRow> {
  const hit = assets.get(id);
  if (hit) return hit;
  const a = await getAsset(t, s, id);
  if (a.upload_state === "complete") assets.set(id, a);
  return a;
}

/** Response headers worth keeping to explain a slow read; values only for these, names for all. */
const KEEP = ["age", "cache-control", "cf-cache-status", "content-length", "server-timing", "via", "x-cache", "x-served-by", "last-modified", "etag"];

function keepHeaders(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of KEEP) {
    const v = h.get(k);
    if (v !== null) out[k] = v;
  }
  // cf-ray is <id>-<colo>: keep the colo (where the edge answered), not the id.
  const ray = h.get("cf-ray");
  if (ray) out.colo = ray.split("-").pop() ?? "";
  out.names = [...h.keys()].filter((k) => k !== "set-cookie").sort().join(",");
  return out;
}

async function httpRange(url: string, headers: Record<string, string>, range: string): Promise<Fetched> {
  let r: Response;
  const t0 = performance.now();
  try {
    // A stalled transfer must fail (and be recorded), not hang the caller.
    r = await fetch(url, { headers: { ...headers, range }, signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
  } catch (e) {
    throw new CkError("StorageError", `GET failed: ${(e as Error).message}`);
  }
  const ttfbMs = performance.now() - t0;
  const hdr = keepHeaders(r.headers);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await r.arrayBuffer());
  } catch (e) {
    // Until 2026-10-26 a failing body read (reset, the timeout above) surfaced as an unlabelled `Thrown`; it is one
    // candidate for the CK06 region-b `Thrown` read of 2026-10-23, which that run could not separate from the
    // other unwrapped steps.
    const ms = Math.round(performance.now() - t0);
    throw new CkError("StorageError", `body read failed after ${ms} ms (status ${r.status}, headers at ${Math.round(ttfbMs)} ms, cf-cache-status ${hdr["cf-cache-status"] ?? "-"}, age ${hdr.age ?? "-"}): ${(e as Error)?.name ?? ""} ${(e as Error)?.message ?? e}`, { status: r.status, code: "BodyRead" });
  }
  const fetchMs = performance.now() - t0;
  if (r.status !== 206 && r.status !== 200) {
    let code = "";
    try {
      const j = JSON.parse(new TextDecoder().decode(bytes));
      code = String(j.error ?? j.code ?? "");
    } catch {
      code = /<Code>([^<]*)<\/Code>/.exec(new TextDecoder().decode(bytes.subarray(0, 2048)))?.[1] ?? "";
    }
    throw new CkError("StorageError", `ranged GET answered ${r.status} ${code}`, { status: r.status, code });
  }
  return { bytes, status: r.status, contentRange: r.headers.get("content-range") ?? "", cacheStatus: r.headers.get("cf-cache-status") ?? "", ttfbMs, fetchMs, hdr };
}

const enc = (key: string) => key.split("/").map(encodeURIComponent).join("/");

export async function fetchCipher(t: TargetConfig, s: Session, a: AssetRow, cStart: number, cEnd: number, path: ReadPath): Promise<Fetched> {
  const range = `bytes=${cStart}-${cEnd}`;
  if (path === "s3") {
    const s3 = s3For(t, s);
    const r = await s3call("GetObject", () => s3.send(new GetObjectCommand({ Bucket: t.bucket, Key: a.object_key, Range: range })));
    const bytes = r.Body ? await r.Body.transformToByteArray() : new Uint8Array();
    return { bytes, status: r.$metadata.httpStatusCode ?? 0, contentRange: r.ContentRange ?? "", cacheStatus: "" };
  }
  if (path === "s3-presigned") {
    const s3 = s3For(t, s);
    const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: t.bucket, Key: a.object_key }), { expiresIn: 300 });
    return httpRange(url, {}, range);
  }
  const auth = { apikey: t.anonKey, authorization: `Bearer ${await s.token()}` };
  if (path === "signed-url") {
    const t0 = performance.now();
    const r = await fetch(`${t.url}/storage/v1/object/sign/${t.bucket}/${enc(a.object_key)}`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ expiresIn: 300 }),
    });
    const j = (await r.json().catch(() => ({}))) as { signedURL?: string; error?: string };
    if (r.status !== 200 || !j.signedURL) throw new CkError("StorageError", `sign answered ${r.status} ${j.error ?? ""}`, { status: r.status, code: j.error ?? "" });
    const signMs = performance.now() - t0;
    return { ...(await httpRange(`${t.url}/storage/v1${j.signedURL}`, {}, range)), signMs };
  }
  return httpRange(`${t.url}/storage/v1/object/authenticated/${t.bucket}/${enc(a.object_key)}`, auth, range);
}

/** Decrypt plaintext [start, endExcl) of an asset. Fails closed on any integrity doubt. */
export async function readRange(ck: Ck, tenantId: string, assetId: string, start: number, endExcl: number, o: ReadOpts = {}): Promise<ReadResult> {
  const t0 = performance.now();
  const path = o.path ?? "s3";
  const t = ck.target(tenantId);
  const s = await ck.session(t);
  const a = await assetOf(t, s, assetId);
  if (a.upload_state !== "complete") throw new CkError("IntegrityError", `asset is ${a.upload_state}`);
  const dek = await unwrapDek(ck, t, s, tenantId, assetId, a.wrapped_dek);
  const sp = span(start, endExcl, a.plaintext_size, a.chunk_size);
  const need = sp.cEnd - sp.cStart + 1;
  const [got, hashes] = await Promise.all([
    fetchCipher(t, s, a, sp.cStart, sp.cEnd, path).catch((e) => {
      // A range past the stored end means the object is shorter than the catalogue says.
      if (e instanceof CkError && (e.detail.status === 416 || e.detail.code === "InvalidRange"))
        throw new CkError("TruncatedObject", `range ${sp.cStart}-${sp.cEnd} not satisfiable`, e.detail);
      throw e;
    }),
    o.verifyHashes === false ? Promise.resolve(new Map<number, string>()) : chunkHashes(t, s, assetId, sp.first, sp.last),
  ]);
  o.onCipher?.(got.bytes);
  // Whole object back (Range ignored): take our window out of it, but say so.
  let body = got.bytes;
  if (got.status === 200 && body.length !== need) {
    if (body.length < a.ciphertext_size) throw new CkError("TruncatedObject", `200 with ${body.length} of ${a.ciphertext_size} bytes`, { got: body.length });
    body = body.subarray(sp.cStart, sp.cEnd + 1);
  }
  const total = Number(/\/(\d+)$/.exec(got.contentRange)?.[1] ?? NaN);
  if (Number.isFinite(total) && total !== a.ciphertext_size)
    throw new CkError("TruncatedObject", `stored object is ${total} bytes, catalogue says ${a.ciphertext_size}`, { stored: total, expected: a.ciphertext_size });
  if (body.length < need) throw new CkError("TruncatedObject", `got ${body.length} of ${need} ciphertext bytes`, { got: body.length, need });
  const key = await importDek(dek);
  const prefix = unhex(a.nonce_prefix);
  const plain = new Uint8Array(endExcl - start);
  for (let i = sp.first; i <= sp.last; i++) {
    const off = cipherOffset(i, a.chunk_size) - sp.cStart;
    const ct = body.subarray(off, off + plainLen(i, a.plaintext_size, a.chunk_size) + TAG);
    if (o.verifyHashes !== false) {
      const want = hashes.get(i);
      if (!want) throw new CkError("ChunkHashMismatch", `no catalogue hash for chunk ${i}`, { idx: i });
      if ((await sha256Hex(ct)) !== want) throw new CkError("ChunkHashMismatch", `chunk ${i} hash differs from the catalogue`, { idx: i });
    }
    const pt = await decryptChunk(key, prefix, a.id, i, a.chunk_count, ct);
    const pStart = i * a.chunk_size;
    const from = Math.max(start, pStart);
    const to = Math.min(endExcl, pStart + pt.length);
    plain.set(pt.subarray(from - pStart, to - pStart), from - start);
  }
  if (o.log !== false) await logAccess(t, s, { action: `read:${path}`, tenant_id: tenantId, asset_id: assetId, byte_range: `${start}-${endExcl - 1}` });
  return { plain, transferred: got.bytes.length, cipherNeeded: need, chunks: sp.last - sp.first + 1, status: got.status, cacheStatus: got.cacheStatus, ms: performance.now() - t0, ttfbMs: got.ttfbMs, fetchMs: got.fetchMs, signMs: got.signMs, hdr: got.hdr };
}

/** Full read in windows of `windowChunks` chunks; checks the plaintext SHA-256 against the catalogue. */
/** Occurrences of `needle` across a stream of byte windows (matches may straddle windows). */
export function needleCounter(needle: string) {
  const n = new TextEncoder().encode(needle);
  let tail = new Uint8Array(0);
  let hits = 0;
  return {
    feed(u: Uint8Array) {
      const buf = new Uint8Array(tail.length + u.length);
      buf.set(tail);
      buf.set(u, tail.length);
      // Native first-byte search, then compare the rest.
      outer: for (let i = buf.indexOf(n[0]!); i !== -1 && i + n.length <= buf.length; i = buf.indexOf(n[0]!, i + 1)) {
        for (let j = 1; j < n.length; j++) if (buf[i + j] !== n[j]) continue outer;
        hits++;
      }
      tail = buf.slice(Math.max(0, buf.length - n.length + 1));
    },
    get hits() {
      return hits;
    },
  };
}

export async function readAll(
  ck: Ck,
  tenantId: string,
  assetId: string,
  o: ReadOpts & { windowChunks?: number; needle?: string } = {},
): Promise<{ sha256: string; transferred: number; ms: number; match: boolean; cipherNeedleHits?: number }> {
  const t0 = performance.now();
  const t = ck.target(tenantId);
  const s = await ck.session(t);
  const a = await assetOf(t, s, assetId);
  const h = ck.platform.sha256Stream();
  const step = (o.windowChunks ?? 8) * a.chunk_size;
  let transferred = 0;
  const counter = o.needle ? needleCounter(o.needle) : null;
  for (let p = 0; p < a.plaintext_size; p += step) {
    const r = await readRange(ck, tenantId, assetId, p, Math.min(a.plaintext_size, p + step), { ...o, log: false, onCipher: counter ? (b) => counter.feed(b) : undefined });
    h.update(r.plain);
    transferred += r.transferred;
  }
  const sha = await h.digestHex();
  await logAccess(t, s, { action: "read-all", tenant_id: tenantId, asset_id: assetId, byte_range: `0-${a.plaintext_size - 1}` });
  if (sha !== a.plaintext_sha256) throw new CkError("IntegrityError", "plaintext SHA-256 differs from the catalogue", { sha, expected: a.plaintext_sha256 });
  return { sha256: sha, transferred, ms: performance.now() - t0, match: true, cipherNeedleHits: counter?.hits };
}
