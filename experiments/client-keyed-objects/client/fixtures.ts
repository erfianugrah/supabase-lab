/**
 * Plaintext fixtures, written to a gitignored directory and reused while the
 * manifest matches. Seeded AES-256-CTR keystream with an ASCII marker at the
 * start of every MiB, so CK08 can scan stored bytes for plaintext:
 *
 *   big  2 GiB    CK04 (S3 multipart), CK05 (TUS), CK06 (ranged reads); CK_BIG_MIB resizes it
 *   mid  64 MiB   CK07 (tamper), CK09 (key service down), CK11 (browser)
 */
import { createCipheriv, createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

export const MiB = 1024 * 1024;
export const MARKER = "CK-PLAINTEXT-MARKER-";

export interface Fix {
  path: string;
  size: number;
  sha256: string;
}
export interface Manifest {
  version: number;
  big: Fix;
  mid: Fix;
}
const VERSION = 1;

function write(path: string, name: string, size: number): Fix {
  const c = createCipheriv("aes-256-ctr", createHash("sha256").update(`ck-fixture-${name}`).digest(), Buffer.alloc(16));
  const fd = openSync(path, "w");
  const h = createHash("sha256");
  const zero = Buffer.alloc(MiB);
  for (let off = 0, n = 0; off < size; off += MiB, n++) {
    const block = c.update(zero);
    block.write(`${MARKER}${String(n).padStart(8, "0")}-`, 0, "latin1");
    writeSync(fd, block);
    h.update(block);
  }
  closeSync(fd);
  return { path, size, sha256: h.digest("hex") };
}

export function ensureFixtures(dir: string, bigMiB = 2048): Manifest {
  mkdirSync(dir, { recursive: true });
  const mf = join(dir, "manifest.json");
  if (existsSync(mf)) {
    const m = JSON.parse(readFileSync(mf, "utf8")) as Manifest;
    if (m.version === VERSION && m.big.size === bigMiB * MiB && existsSync(m.big.path) && existsSync(m.mid.path)) return m;
  }
  const m: Manifest = { version: VERSION, big: write(join(dir, "big.bin"), "big", bigMiB * MiB), mid: write(join(dir, "mid.bin"), "mid", 64 * MiB) };
  writeFileSync(mf, JSON.stringify(m));
  return m;
}
