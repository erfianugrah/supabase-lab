/**
 * Shared helpers for the image-transformations experiment: fixture generation
 * (pure-TS encoders, no native deps) and Storage API plumbing.
 *
 * Fixtures are generated, not committed: the repo stays text-only, and the
 * exact byte shape (flat vs noise) is what the limit probes depend on - a
 * >25MB fixture must be noise (incompressible), a >50MP fixture must be flat
 * (tiny on disk), or each would trip the other's limit first.
 */
import { deflateSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import type { Ctx } from "../../harness/src/types";

// ---------------------------------------------------------------------------
// PNG encoder (8-bit truecolor, filter 0)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++)
    c = (CRC_TABLE[(c ^ (buf[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function pngFromRows(width: number, height: number, rows: Buffer[], level: number): Buffer {
  const raw = Buffer.concat(rows.map((r) => Buffer.concat([Buffer.from([0]), r])));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export function pngFlat(width: number, height: number, [r, g, b]: [number, number, number]): Buffer {
  const row = Buffer.alloc(width * 3);
  for (let x = 0; x < width; x++) {
    row[x * 3] = r;
    row[x * 3 + 1] = g;
    row[x * 3 + 2] = b;
  }
  return pngFromRows(width, height, Array.from({ length: height }, () => row), 6);
}

/** Noise deflates to ~raw size; level 1 keeps generation fast and the output >25MB. */
export function pngNoise(width: number, height: number): Buffer {
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) rows.push(randomBytes(width * 3));
  return pngFromRows(width, height, rows, 1);
}

// ---------------------------------------------------------------------------
// Other formats
// ---------------------------------------------------------------------------

/** 1x1 GIF89a. */
export function gifTiny(): Buffer {
  return Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
}

export function svgTiny(): Buffer {
  return Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="steelblue"/></svg>',
  );
}

/** Minimal 24-bit BMP. */
export function bmp24(width: number, height: number, [r, g, b]: [number, number, number]): Buffer {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const imgSize = rowSize * height;
  const buf = Buffer.alloc(54 + imgSize);
  buf.write("BM");
  buf.writeUInt32LE(54 + imgSize, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(imgSize, 34);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const o = 54 + y * rowSize + x * 3;
      buf[o] = b;
      buf[o + 1] = g;
      buf[o + 2] = r;
    }
  return buf;
}

// ---------------------------------------------------------------------------
// Storage API
// ---------------------------------------------------------------------------

export function storageBase(ctx: Ctx): string {
  return `https://${ctx.ref}.supabase.co/storage/v1`;
}

function svc(ctx: Ctx): string {
  if (!ctx.serviceKey) throw new Error("service key required");
  return ctx.serviceKey;
}

/**
 * Fresh-project storage lags ACTIVE_HEALTHY (TenantNotFound, then 429
 * SlowDown for the first minutes - the W21 note). Retry, don't fail.
 */
async function withRetry<T>(fn: () => Promise<T>, ok: (r: T) => boolean, tries = 10): Promise<T> {
  let last: T | undefined;
  for (let i = 0; i < tries; i++) {
    last = await fn();
    if (ok(last)) return last;
    await new Promise((r) => setTimeout(r, 5000));
  }
  return last!;
}

export async function ensureBucket(ctx: Ctx, id: string, isPublic: boolean): Promise<number> {
  // Re-runs hit "already exists" as a 400, not a 409 - check first instead.
  const existing = await fetch(`${storageBase(ctx)}/bucket/${id}`, {
    headers: { Authorization: `Bearer ${svc(ctx)}` },
  });
  if (existing.status === 200) return 200;
  return withRetry(
    async () => {
      const res = await fetch(`${storageBase(ctx)}/bucket`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${svc(ctx)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ id, name: id, public: isPublic }),
      });
      return res.status;
    },
    (s) => s === 200 || s === 201,
  );
}

export async function upload(
  ctx: Ctx,
  bucket: string,
  path: string,
  body: Buffer,
  contentType: string,
): Promise<number> {
  return withRetry(
    async () => {
      const res = await fetch(`${storageBase(ctx)}/object/${bucket}/${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${svc(ctx)}`,
          "Content-Type": contentType,
          // POST without x-upsert 400s on an existing path; uploads must be
          // idempotent across re-runs and I06's overwrite probe depends on it.
          "x-upsert": "true",
        },
        body: new Uint8Array(body),
      });
      return res.status;
    },
    (s) => s === 200 || s === 201,
  );
}

export interface SignedUrl {
  /** Path+query relative to /storage/v1, e.g. /object/sign/priv/x.png?token=... */
  signedURL: string;
}

export async function sign(
  ctx: Ctx,
  path: string,
  expiresIn: number,
  transform?: Record<string, number | string>,
): Promise<string> {
  const res = await fetch(`${storageBase(ctx)}/object/sign/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${svc(ctx)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ expiresIn, ...(transform ? { transform } : {}) }),
  });
  const json = (await res.json()) as SignedUrl;
  return json.signedURL;
}

export interface Probe {
  status: number;
  bytes: number;
  timeMs: number;
  contentType: string;
  cfCacheStatus: string;
  vary: string;
  body?: Buffer;
}

export async function probe(url: string, init?: RequestInit, keepBody = false): Promise<Probe> {
  const t0 = performance.now();
  const res = await fetch(url, init);
  const body = await res.arrayBuffer();
  return {
    status: res.status,
    bytes: body.byteLength,
    timeMs: Math.round(performance.now() - t0),
    contentType: res.headers.get("content-type") ?? "",
    cfCacheStatus: res.headers.get("cf-cache-status") ?? "",
    vary: res.headers.get("vary") ?? "",
    body: keepBody ? Buffer.from(body) : undefined,
  };
}

/** The fixture set I01 uploads; later modules reference paths from here. */
export const FIXTURES = {
  small: { path: "small.png", contentType: "image/png", make: () => pngFlat(1200, 800, [70, 130, 180]) },
  big12mp: { path: "big-12mp.png", contentType: "image/png", make: () => pngFlat(4000, 3000, [128, 64, 200]) },
  hugeBytes: { path: "huge-bytes.png", contentType: "image/png", make: () => pngNoise(3000, 3000) },
  hugeMp: { path: "huge-mp.png", contentType: "image/png", make: () => pngFlat(8000, 7000, [60, 60, 60]) },
  gif: { path: "tiny.gif", contentType: "image/gif", make: gifTiny },
  svg: { path: "vector.svg", contentType: "image/svg+xml", make: svgTiny },
  bmp: { path: "small.bmp", contentType: "image/bmp", make: () => bmp24(64, 64, [200, 100, 50]) },
} as const;
