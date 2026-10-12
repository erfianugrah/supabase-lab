/**
 * Seeded fixtures for SS03-SS05, written to a gitignored directory and
 * reused while their manifest matches (delete the directory to regenerate).
 *
 *   big  2048 MiB (2 GiB) of AES-256-CTR keystream seeded from its name;
 *        SHA-256 of the whole file and the MD5 of every 16 MiB part
 *        (128 parts) computed while writing
 *   mid  64 MiB, same treatment (4 parts)
 *   gz   a gzip stream (level 1) of 256 MiB of keystream; stored and served
 *        with `Content-Encoding: gzip` in SS03k. Hashes are of the gz bytes.
 *   png  a 64x64 PNG (solid colour), the sniffing control for SS05c
 *
 *   echo '{"dir":"..."}' | node fixtures.ts   -> manifest JSON
 */
import { createCipheriv, createHash } from "node:crypto";
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { constants, createGzip, deflateSync } from "node:zlib";

export const MiB = 1024 * 1024;
export const PART = 16 * MiB;

export interface Fix {
  path: string;
  size: number;
  sha256: string;
  /** MD5 of the whole file. */
  md5: string;
  partMd5: string[];
}
export interface Manifest {
  version: number;
  big: Fix;
  mid: Fix;
  gz: Fix & { plainSize: number; plainSha256: string };
  png: Fix;
}
const VERSION = 4;

function keystream(name: string) {
  const key = createHash("sha256").update(`ss-fixture-${name}`).digest();
  return createCipheriv("aes-256-ctr", key, Buffer.alloc(16));
}

function writeSeeded(path: string, name: string, size: number): Fix {
  const c = keystream(name);
  const fd = openSync(path, "w");
  const all = createHash("sha256");
  const whole = createHash("md5");
  const parts: string[] = [];
  const zero = Buffer.alloc(PART);
  for (let off = 0; off < size; off += PART) {
    const n = Math.min(PART, size - off);
    const block = c.update(n === PART ? zero : Buffer.alloc(n));
    writeSync(fd, block);
    all.update(block);
    whole.update(block);
    parts.push(createHash("md5").update(block).digest("hex"));
  }
  closeSync(fd);
  return { path, size, sha256: all.digest("hex"), md5: whole.digest("hex"), partMd5: parts };
}

async function writeGz(path: string, plainSize: number): Promise<Manifest["gz"]> {
  const c = keystream("gz");
  const plainHash = createHash("sha256");
  const out = createWriteStream(path);
  const gz = createGzip({ level: 1 });
  const all = createHash("sha256");
  const whole = createHash("md5");
  let size = 0;
  gz.on("data", (d: Buffer) => {
    all.update(d);
    whole.update(d);
    size += d.length;
  });
  gz.pipe(out);
  const zero = Buffer.alloc(MiB);
  for (let off = 0; off < plainSize; off += MiB) {
    const block = c.update(zero);
    plainHash.update(block);
    if (!gz.write(block)) await new Promise((r) => gz.once("drain", r));
  }
  await new Promise<void>((r) => {
    out.on("close", () => r());
    gz.end();
  });
  return { path, size, sha256: all.digest("hex"), md5: whole.digest("hex"), partMd5: [], plainSize, plainSha256: plainHash.digest("hex") };
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function png(path: string): Fix {
  const w = 64;
  const h = 64;
  const rows = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rows.set([200, 80, 40], y * (w * 3 + 1) + 1 + x * 3);
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const buf = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(rows, { level: constants.Z_BEST_COMPRESSION })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  writeFileSync(path, buf);
  const md5 = createHash("md5").update(buf).digest("hex");
  return { path, size: buf.length, sha256: createHash("sha256").update(buf).digest("hex"), md5, partMd5: [md5] };
}

export async function ensureFixtures(dir: string): Promise<Manifest> {
  mkdirSync(dir, { recursive: true });
  const mf = join(dir, "manifest.json");
  if (existsSync(mf)) {
    const m = JSON.parse(readFileSync(mf, "utf8")) as Manifest;
    if (m.version === VERSION && [m.big, m.mid, m.gz, m.png].every((f) => existsSync(f.path))) return m;
  }
  const m: Manifest = {
    version: VERSION,
    big: writeSeeded(join(dir, "big.bin"), "big", 2048 * MiB),
    mid: writeSeeded(join(dir, "mid.bin"), "mid", 64 * MiB),
    gz: await writeGz(join(dir, "gz.bin.gz"), 256 * MiB),
    png: png(join(dir, "solid.png")),
  };
  writeFileSync(mf, JSON.stringify(m));
  return m;
}

/** Bytes [start, end] of a fixture file (inclusive), for comparing a range read. */
export function sliceSha(path: string, start: number, end: number): string {
  const fd = openSync(path, "r");
  const h = createHash("sha256");
  const buf = Buffer.alloc(Math.min(PART, end - start + 1));
  let pos = start;
  while (pos <= end) {
    const n = readSync(fd, buf, 0, Math.min(buf.length, end - pos + 1), pos);
    if (n <= 0) break;
    h.update(buf.subarray(0, n));
    pos += n;
  }
  closeSync(fd);
  return h.digest("hex");
}

if (import.meta.main) {
  const { dir } = JSON.parse(readFileSync(0, "utf8")) as { dir: string };
  console.log(JSON.stringify(await ensureFixtures(dir)));
}
