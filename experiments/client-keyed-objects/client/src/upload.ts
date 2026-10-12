/**
 * Uploads. Two transports over the same ciphertext stream:
 *
 *   s3-multipart  one part = `partChunks` ciphertext chunks (8 x 8 MiB = 64 MiB
 *                 of plaintext by default). The upload id is stored in the
 *                 asset row; resume = ListParts, re-derive the missing parts
 *                 (encryption is deterministic given DEK and nonce prefix),
 *                 upload them, complete.
 *   tus           6 MiB transport chunks over the same ciphertext bytes; the
 *                 upload URL is stored in the asset row; resume = HEAD for the
 *                 offset, continue from there.
 *
 * Order of side effects: wrap the DEK first (the key service down means
 * nothing is written anywhere), then the catalogue row, then storage.
 * Per-chunk ciphertext hashes go to app.asset_chunks before the bytes they
 * describe are sent, so any byte on the server has a hash in the catalogue.
 */
import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  ListPartsCommand,
  UploadPartCommand,
  type CompletedPart,
} from "@aws-sdk/client-s3";
import * as tus from "tus-js-client";
import { type AssetRow, chunkRowCount, getAsset, insertAsset, patchAsset, upsertChunks } from "./catalogue";
import type { Ck, Session, TargetConfig } from "./ctx";
import { CHUNK, CIPHER, cipherOffset, cipherSize, chunkCount, encryptChunk, hex, importDek, plainLen, sha256Hex, unhex } from "./envelope";
import { CkError } from "./errors";
import { unwrapDek, wrapDek } from "./keys";
import { s3call, s3For } from "./s3";
import { FetchHttpStack } from "./tus-fetch";

export const TUS_CHUNK = 6 * 1024 * 1024;

export interface UploadOpts {
  tenantId: string;
  recordId: string;
  source: Blob;
  method: "s3-multipart" | "tus";
  partChunks?: number;
  assetId?: string;
  onProgress?: (doneBytes: number, totalBytes: number) => void;
}

export interface UploadResult {
  assetId: string;
  objectKey: string;
  plaintextSha256: string;
  ciphertextSize: number;
  parts?: number;
  partsSkipped?: number;
  resumedEtagMatches?: number;
  resumedEtagMismatches?: number;
  etagSource?: string;
  tusOffsetAtResume?: number;
  chunkRows: number;
  ms: number;
}

const objectKey = (tenant: string, asset: string) => `${tenant}/${asset}/data`;

async function plaintextSha(ck: Ck, src: Blob): Promise<string> {
  const h = ck.platform.sha256Stream();
  const step = 64 * 1024 * 1024;
  for (let o = 0; o < src.size; o += step) h.update(new Uint8Array(await src.slice(o, Math.min(src.size, o + step)).arrayBuffer()));
  return h.digestHex();
}

/** Create the asset: DEK, wrap, catalogue row. Nothing reaches storage yet. */
async function createAsset(ck: Ck, t: TargetConfig, s: Session, o: UploadOpts): Promise<{ row: AssetRow; dek: Uint8Array }> {
  const dek = crypto.getRandomValues(new Uint8Array(32));
  const prefix = crypto.getRandomValues(new Uint8Array(8));
  const assetId = o.assetId ?? crypto.randomUUID();
  const { wrapped, key_id } = await wrapDek(t, s, o.tenantId, dek);
  const row: AssetRow = {
    id: assetId,
    record_id: o.recordId,
    tenant_id: o.tenantId,
    object_key: objectKey(o.tenantId, assetId),
    plaintext_size: o.source.size,
    chunk_size: CHUNK,
    chunk_count: chunkCount(o.source.size),
    ciphertext_size: cipherSize(o.source.size),
    cipher: CIPHER,
    key_id,
    wrapped_dek: wrapped,
    nonce_prefix: hex(prefix),
    plaintext_sha256: null,
    upload_state: "uploading",
    upload_method: o.method,
    s3_upload_id: null,
    tus_url: null,
  };
  await insertAsset(t, s, row);
  ck.deks.set(assetId, dek);
  return { row, dek };
}

/** Ciphertext of chunks [first, last] plus their hashes. */
async function encryptRange(key: CryptoKey, a: AssetRow, src: Blob, first: number, last: number): Promise<{ bytes: Uint8Array; hashes: { idx: number; h: string }[] }> {
  const prefix = unhex(a.nonce_prefix);
  const parts: Uint8Array[] = [];
  const hashes: { idx: number; h: string }[] = [];
  const plain = new Uint8Array(await src.slice(first * a.chunk_size, Math.min(a.plaintext_size, (last + 1) * a.chunk_size)).arrayBuffer());
  for (let i = first; i <= last; i++) {
    const off = (i - first) * a.chunk_size;
    const ct = await encryptChunk(key, prefix, a.id, i, a.chunk_count, plain.subarray(off, off + plainLen(i, a.plaintext_size, a.chunk_size)));
    parts.push(ct);
    hashes.push({ idx: i, h: await sha256Hex(ct) });
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const bytes = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    bytes.set(p, o);
    o += p.length;
  }
  return { bytes, hashes };
}

const toRows = (assetId: string, hs: { idx: number; h: string }[]) => hs.map((x) => ({ asset_id: assetId, idx: x.idx, ciphertext_sha256: x.h }));

// ------------------------------------------------------------------ S3

async function runParts(
  ck: Ck,
  t: TargetConfig,
  s: Session,
  a: AssetRow,
  dek: Uint8Array,
  src: Blob,
  partChunks: number,
  uploaded: Map<number, string>,
  onProgress?: (d: number, total: number) => void,
): Promise<Partial<UploadResult>> {
  const s3 = s3For(t, s);
  const key = await importDek(dek);
  const partCount = Math.ceil(a.chunk_count / partChunks);
  const etags = new Map<number, string | undefined>();
  let skipped = 0;
  let match = 0;
  let mismatch = 0;
  for (let p = 0; p < partCount; p++) {
    const first = p * partChunks;
    const last = Math.min(a.chunk_count - 1, first + partChunks - 1);
    const pn = p + 1;
    const { bytes, hashes } = await encryptRange(key, a, src, first, last);
    await upsertChunks(t, s, toRows(a.id, hashes));
    const prior = uploaded.get(pn);
    if (prior !== undefined) {
      skipped++;
      // The server's part ETag is the MD5 of what it stored; compare with the re-derived part.
      if (ck.platform.md5Hex) {
        if (prior.replace(/"/g, "") === ck.platform.md5Hex(bytes)) match++;
        else mismatch++;
      }
      etags.set(pn, prior);
    } else {
      const r = await s3call(`UploadPart ${pn}`, () =>
        s3.send(new UploadPartCommand({ Bucket: t.bucket, Key: a.object_key, UploadId: a.s3_upload_id!, PartNumber: pn, Body: bytes, ContentLength: bytes.length })),
      );
      etags.set(pn, r.ETag);
    }
    onProgress?.(Math.min(a.plaintext_size, (last + 1) * a.chunk_size), a.plaintext_size);
  }
  // A browser cannot read ETag unless the server exposes it; fall back to ListParts.
  let etagSource = "upload-part-header";
  if ([...etags.values()].some((e) => !e)) {
    etagSource = "list-parts";
    const listed = await listParts(t, s, a);
    for (const [pn, e] of listed) if (!etags.get(pn)) etags.set(pn, e);
  }
  const parts: CompletedPart[] = [...etags.entries()].sort((x, y) => x[0] - y[0]).map(([PartNumber, ETag]) => ({ PartNumber, ETag }));
  if (parts.some((p) => !p.ETag)) throw new CkError("StorageError", "no ETag for some parts, even from ListParts");
  await s3call("CompleteMultipartUpload", () =>
    s3.send(new CompleteMultipartUploadCommand({ Bucket: t.bucket, Key: a.object_key, UploadId: a.s3_upload_id!, MultipartUpload: { Parts: parts } })),
  );
  return { parts: partCount, partsSkipped: skipped, resumedEtagMatches: match, resumedEtagMismatches: mismatch, etagSource };
}

async function listParts(t: TargetConfig, s: Session, a: AssetRow): Promise<Map<number, string>> {
  const s3 = s3For(t, s);
  const out = new Map<number, string>();
  let marker: string | undefined;
  for (;;) {
    const r = await s3call("ListParts", () => s3.send(new ListPartsCommand({ Bucket: t.bucket, Key: a.object_key, UploadId: a.s3_upload_id!, PartNumberMarker: marker })));
    for (const p of r.Parts ?? []) if (p.PartNumber && p.ETag) out.set(p.PartNumber, p.ETag);
    if (!r.IsTruncated || !r.NextPartNumberMarker) break;
    marker = String(r.NextPartNumberMarker);
  }
  return out;
}

async function finish(ck: Ck, t: TargetConfig, s: Session, a: AssetRow, src: Blob, t0: number, extra: Partial<UploadResult>): Promise<UploadResult> {
  const sha = await plaintextSha(ck, src);
  await patchAsset(t, s, a.id, { upload_state: "complete", plaintext_sha256: sha, completed_at: new Date().toISOString() });
  return {
    assetId: a.id,
    objectKey: a.object_key,
    plaintextSha256: sha,
    ciphertextSize: a.ciphertext_size,
    chunkRows: await chunkRowCount(t, s, a.id),
    ms: Math.round(performance.now() - t0),
    ...extra,
  };
}

export async function upload(ck: Ck, o: UploadOpts): Promise<UploadResult> {
  const t0 = performance.now();
  const t = ck.target(o.tenantId);
  const s = await ck.session(t);
  const { row, dek } = await createAsset(ck, t, s, o);
  if (o.method === "s3-multipart") {
    const s3 = s3For(t, s);
    const c = await s3call("CreateMultipartUpload", () =>
      s3.send(new CreateMultipartUploadCommand({ Bucket: t.bucket, Key: row.object_key, ContentType: "application/octet-stream" })),
    );
    row.s3_upload_id = c.UploadId ?? null;
    if (!row.s3_upload_id) throw new CkError("StorageError", "CreateMultipartUpload returned no UploadId");
    await patchAsset(t, s, row.id, { s3_upload_id: row.s3_upload_id });
    const r = await runParts(ck, t, s, row, dek, o.source, o.partChunks ?? 8, new Map(), o.onProgress);
    return finish(ck, t, s, row, o.source, t0, r);
  }
  const r = await runTus(ck, t, s, row, dek, o.source, o.onProgress);
  return finish(ck, t, s, row, o.source, t0, r);
}

/** Continue an interrupted upload from a new process, using only the catalogue row and the server's state. */
export async function resume(ck: Ck, tenantId: string, assetId: string, source: Blob, o: { partChunks?: number; onProgress?: (d: number, total: number) => void } = {}): Promise<UploadResult> {
  const t0 = performance.now();
  const t = ck.target(tenantId);
  const s = await ck.session(t);
  const a = await getAsset(t, s, assetId);
  if (a.plaintext_size !== source.size) throw new CkError("IntegrityError", "source size differs from the catalogue");
  const dek = await unwrapDek(ck, t, s, tenantId, assetId, a.wrapped_dek);
  if (a.upload_method === "s3-multipart") {
    const uploaded = await listParts(t, s, a);
    const r = await runParts(ck, t, s, a, dek, source, o.partChunks ?? 8, uploaded, o.onProgress);
    return finish(ck, t, s, a, source, t0, r);
  }
  const r = await runTus(ck, t, s, a, dek, source, o.onProgress);
  return finish(ck, t, s, a, source, t0, r);
}

// ------------------------------------------------------------------ TUS

/** tus FileSource producing ciphertext bytes [start, end) on demand from the plaintext. */
class CipherSource {
  readonly size: number;
  private cache = new Map<number, Uint8Array>();
  constructor(
    private ck: Ck,
    private t: TargetConfig,
    private s: Session,
    private a: AssetRow,
    private key: CryptoKey,
    private src: Blob,
  ) {
    this.size = a.ciphertext_size;
  }

  private async chunk(i: number): Promise<Uint8Array> {
    const hit = this.cache.get(i);
    if (hit) return hit;
    const { bytes, hashes } = await encryptRange(this.key, this.a, this.src, i, i);
    await upsertChunks(this.t, this.s, toRows(this.a.id, hashes));
    this.cache.set(i, bytes);
    for (const k of this.cache.keys()) if (k < i - 1) this.cache.delete(k);
    return bytes;
  }

  async slice(start: number, end: number): Promise<{ value: unknown; done: boolean }> {
    end = Math.min(end, this.size);
    const stride = this.a.chunk_size + 16;
    const out = new Uint8Array(Math.max(0, end - start));
    let pos = start;
    while (pos < end) {
      const i = Math.floor(pos / stride);
      const c = await this.chunk(i);
      const off = pos - cipherOffset(i, this.a.chunk_size);
      const n = Math.min(c.length - off, end - pos);
      out.set(c.subarray(off, off + n), pos - start);
      pos += n;
    }
    // A Blob: tus-js-client reads `.size`, and fetch sends it as is.
    return { value: new Blob([out as BlobPart]), done: end >= this.size };
  }

  close(): void {
    this.cache.clear();
  }
}

async function runTus(ck: Ck, t: TargetConfig, s: Session, a: AssetRow, dek: Uint8Array, src: Blob, onProgress?: (d: number, total: number) => void): Promise<Partial<UploadResult>> {
  const source = new CipherSource(ck, t, s, a, await importDek(dek), src);
  let offsetAtResume: number | undefined;
  await new Promise<void>((resolve, reject) => {
    const up = new tus.Upload(src as Blob & File, {
      endpoint: `${t.storageUrl}/upload/resumable`,
      uploadUrl: a.tus_url ?? undefined,
      chunkSize: TUS_CHUNK,
      retryDelays: [0, 1000, 3000, 5000],
      headers: { apikey: t.anonKey, "x-upsert": "false" },
      metadata: { bucketName: t.bucket, objectName: a.object_key, contentType: "application/octet-stream", cacheControl: "3600" },
      storeFingerprintForResuming: false,
      removeFingerprintOnSuccess: false,
      fileReader: { openFile: async () => source },
      httpStack: new FetchHttpStack(),
      onBeforeRequest: async (req) => {
        req.setHeader("authorization", `Bearer ${await s.token()}`);
      },
      onAfterResponse: (req, res) => {
        if (req.getMethod() === "HEAD" && offsetAtResume === undefined) offsetAtResume = Number(res.getHeader("Upload-Offset") ?? NaN);
      },
      onUploadUrlAvailable: async () => {
        if (up.url && up.url !== a.tus_url) {
          a.tus_url = up.url;
          await patchAsset(t, s, a.id, { tus_url: up.url });
        }
      },
      onProgress: (sent, total) => onProgress?.(Math.floor((sent / total) * a.plaintext_size), a.plaintext_size),
      onSuccess: () => resolve(),
      onError: (e) => {
        const res = (e as { originalResponse?: { getStatus(): number; getBody(): string } }).originalResponse;
        reject(new CkError("StorageError", `tus: ${String(e.message).slice(0, 200)}`, { status: res?.getStatus() ?? 0, body: res?.getBody()?.slice(0, 200) ?? "" }));
      },
    });
    up.start();
  });
  // Chunks wholly before the resume offset were hashed by the first process.
  return { tusOffsetAtResume: offsetAtResume };
}
