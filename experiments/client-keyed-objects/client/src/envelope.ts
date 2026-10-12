/**
 * Chunked envelope encryption, WebCrypto only (same code in Bun and the
 * browser).
 *
 *   DEK          random 256-bit key per asset, wrapped by the key service
 *   chunk        8 MiB of plaintext; ciphertext chunk = plaintext + 16-byte tag
 *   nonce        nonce_prefix (8 random bytes per asset) || uint32be(chunk index)
 *   AAD          utf8(asset_id) || uint32be(chunk index) || uint32be(chunk count)
 *
 * The AAD binds every chunk to its asset, its position and the total count, so
 * reordering, swapping chunks between assets or dropping trailing chunks fails
 * the tag check even when the catalogue hashes are not consulted.
 */
import { CkError } from "./errors";

export const CHUNK = 8 * 1024 * 1024;
export const TAG = 16;
export const CIPHER = "aes-256-gcm";

export const chunkCount = (plainSize: number, chunk = CHUNK) => Math.max(1, Math.ceil(plainSize / chunk));
export const cipherSize = (plainSize: number, chunk = CHUNK) => plainSize + chunkCount(plainSize, chunk) * TAG;
/** Ciphertext offset of chunk i. */
export const cipherOffset = (i: number, chunk = CHUNK) => i * (chunk + TAG);
/** Plaintext length of chunk i. */
export const plainLen = (i: number, plainSize: number, chunk = CHUNK) => Math.max(0, Math.min(chunk, plainSize - i * chunk));

export interface ChunkSpan {
  first: number;
  last: number;
  /** Inclusive ciphertext byte range covering chunks first..last. */
  cStart: number;
  cEnd: number;
}

/** Plaintext [start, endExcl) -> covering chunks and the ciphertext byte range to fetch. */
export function span(start: number, endExcl: number, plainSize: number, chunk = CHUNK): ChunkSpan {
  if (start < 0 || endExcl > plainSize || endExcl <= start) throw new RangeError(`bad range ${start}-${endExcl} of ${plainSize}`);
  const first = Math.floor(start / chunk);
  const last = Math.floor((endExcl - 1) / chunk);
  const cStart = cipherOffset(first, chunk);
  const cEnd = cipherOffset(last, chunk) + plainLen(last, plainSize, chunk) + TAG - 1;
  return { first, last, cStart, cEnd };
}

export function nonce(prefix: Uint8Array, idx: number): Uint8Array<ArrayBuffer> {
  if (prefix.length !== 8) throw new Error("nonce prefix must be 8 bytes");
  const n = new Uint8Array(12);
  n.set(prefix);
  new DataView(n.buffer).setUint32(8, idx);
  return n;
}

export function aad(assetId: string, idx: number, count: number): Uint8Array<ArrayBuffer> {
  const id = new TextEncoder().encode(assetId);
  const a = new Uint8Array(id.length + 8);
  a.set(id);
  const dv = new DataView(a.buffer);
  dv.setUint32(id.length, idx);
  dv.setUint32(id.length + 4, count);
  return a;
}

export const importDek = (raw: Uint8Array) =>
  crypto.subtle.importKey("raw", raw as Uint8Array<ArrayBuffer>, "AES-GCM", false, ["encrypt", "decrypt"]);

export async function encryptChunk(key: CryptoKey, prefix: Uint8Array, assetId: string, idx: number, count: number, plain: Uint8Array): Promise<Uint8Array> {
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce(prefix, idx), additionalData: aad(assetId, idx, count) }, key, plain as Uint8Array<ArrayBuffer>);
  return new Uint8Array(ct);
}

export async function decryptChunk(key: CryptoKey, prefix: Uint8Array, assetId: string, idx: number, count: number, ct: Uint8Array): Promise<Uint8Array> {
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce(prefix, idx), additionalData: aad(assetId, idx, count) }, key, ct as Uint8Array<ArrayBuffer>);
    return new Uint8Array(pt);
  } catch {
    throw new CkError("ChunkAuthFailed", `chunk ${idx} of ${count} did not authenticate`, { idx });
  }
}

export const hex = (u: Uint8Array) => Array.from(u, (b) => b.toString(16).padStart(2, "0")).join("");
export const unhex = (s: string) => new Uint8Array((s.match(/../g) ?? []).map((h) => parseInt(h, 16)));
export const b64 = (u: Uint8Array) => {
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};
export const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function sha256Hex(u: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", u as Uint8Array<ArrayBuffer>)));
}
