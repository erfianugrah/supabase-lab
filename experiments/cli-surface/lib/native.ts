/**
 * Static reads of what the experimental stack's native runtime ships: the
 * artifact pins and idle-stop constants inside the CLI's bundled JavaScript,
 * and the ELF facts (interpreter, glibc symbol versions, a bundled loader)
 * that decide which Linux hosts can run each service. Pure functions; CL23
 * does the downloading.
 */

/** One native service artifact the CLI pins, with the Linux archive digests. */
export interface Pin {
  key: string; // capability key in the CLI (database, rest, auth, ...)
  source: string; // release-tag prefix on supabase/slim-services (postgres, postgrest, ...)
  version: string;
  revision: number;
  amd64: string; // sha256 of the linux-amd64 .tar.zst
  arm64: string;
}

const ID = "[A-Za-z0-9_$]+";

/**
 * Default pins from the CLI bundle. The record shape (2.120.0, 2.121.0):
 * `rest:nT("postgrest",{upstreamVersion:"v16.4",revision:0,image:"...",upstreamImage:"...",
 * natives:{"darwin-arm64":{archive:"..",manifest:".."},"linux-amd64":{archive:"..",...},"linux-arm64":{archive:"..",...}}`.
 * The factory's minified name changes between releases, so it is matched loosely.
 * Extra pins of the same service (postgres 15, orioledb) sit in a separate map
 * keyed by version and do not match this shape.
 */
export function parsePins(bundle: string): Pin[] {
  const re = new RegExp(
    `([a-z]+):${ID}\\("([a-z-]+)",\\{upstreamVersion:"([^"]+)",revision:(\\d+),image:"[^"]+",upstreamImage:"[^"]+",natives:\\{"darwin-arm64":\\{[^}]*\\},"linux-amd64":\\{archive:"([0-9a-f]{64})"[^}]*\\},"linux-arm64":\\{archive:"([0-9a-f]{64})"`,
    "g",
  );
  const seen = new Set<string>();
  const out: Pin[] = [];
  for (const m of bundle.matchAll(re)) {
    if (seen.has(m[1]!)) continue;
    seen.add(m[1]!);
    out.push({ key: m[1]!, source: m[2]!, version: m[3]!, revision: Number(m[4]), amd64: m[5]!, arm64: m[6]! });
  }
  return out;
}

/** Release tag and asset name on github.com/supabase/slim-services. */
export function assetOf(p: Pin, arch: "amd64" | "arm64"): { tag: string; name: string; url: string; sha256: string } {
  const tag = `${p.source}-${p.version}-r${p.revision}`;
  const name = `${tag}-linux-${arch}.tar.zst`;
  return { tag, name, url: `https://github.com/supabase/slim-services/releases/download/${tag}/${name}`, sha256: arch === "amd64" ? p.amd64 : p.arm64 };
}

/**
 * Idle-stop constants: `var X=60000,Z=300000,F=(e)=>e==="studio"?Z:X` in the
 * bundle, used as `idleMillis` for every lazy member of a stack.
 */
export function parseIdle(bundle: string): { lazyMs: number; studioMs: number } | undefined {
  const m = bundle.match(new RegExp(`(${ID})=(\\d+),(${ID})=(\\d+),${ID}=\\(e\\)=>e==="studio"\\?(${ID}):(${ID})`));
  if (!m) return undefined;
  const v: Record<string, number> = { [m[1]!]: Number(m[2]), [m[3]!]: Number(m[4]) };
  const studio = v[m[5]!];
  const lazy = v[m[6]!];
  return studio !== undefined && lazy !== undefined ? { lazyMs: lazy, studioMs: studio } : undefined;
}

/**
 * The composition call site that hands out `idleMillis`: lazy members (not
 * the database, not under `--eager`) get one, except services the bundle
 * names as lazy without an idle timeout. 2.120.0 exempts `functions`
 * (`W.service==="functions"?{id:x,activation:"lazy"}:{...idleMillis}`);
 * 2.121.0 has no exemption.
 */
export function idleCallSite(bundle: string): { found: boolean; lazyWithoutIdle: string[] } {
  const m = bundle.match(/eager!==!0&&\w+\.service!=="database"&&[^?]{0,40}\?((?:\w+\.service==="[a-z]+"\?\{id:\w+,activation:"lazy"\}:)*)\{id:\w+,activation:"lazy",idleMillis:/);
  if (!m) return { found: false, lazyWithoutIdle: [] };
  return { found: true, lazyWithoutIdle: [...m[1]!.matchAll(/service==="([a-z]+)"/g)].map((x) => x[1]!) };
}

/**
 * The host-to-target map: which (os, arch) pairs get the native runtime, and
 * whether anything but os and arch is consulted (a libc check, for instance).
 */
export function parseTargets(bundle: string): { targets: string[]; checksOnlyOsArch: boolean } {
  const fn = bundle.match(/\(e\)=>\{(if\(e\.os==="[a-z]+"&&e\.arch==="[a-z0-9]+"\)return"[a-z0-9-]+";)+return\}/);
  if (!fn) return { targets: [], checksOnlyOsArch: false };
  const targets = [...fn[0].matchAll(/return"([a-z0-9-]+)"/g)].map((x) => x[1]!);
  return { targets, checksOnlyOsArch: !/libc|musl|glibc/.test(fn[0]) };
}

// ---- ELF ------------------------------------------------------------------

export interface ElfInfo {
  elf: boolean;
  bits?: 32 | 64;
  type?: "exec" | "dyn" | "other";
  interp?: string; // PT_INTERP, absent for static executables and shared objects
  interpUnread?: boolean; // PT_INTERP exists but lies past `buf` and no `readAt` was given
  dynamic?: boolean; // has PT_DYNAMIC
}

/**
 * Minimal little-endian ELF header and program-header read: enough to tell
 * static from dynamic. `buf` is the head of the file; patchelf'd binaries keep
 * PT_INTERP far past it (edge-runtime's sits about 130 MB in), so `readAt`
 * fetches the interpreter string by offset when it is outside `buf`.
 */
export function readElf(buf: Uint8Array, readAt?: (offset: number, length: number) => Uint8Array): ElfInfo {
  if (buf.length < 64 || buf[0] !== 0x7f || buf[1] !== 0x45 || buf[2] !== 0x4c || buf[3] !== 0x46) return { elf: false };
  if (buf[4] !== 2 || buf[5] !== 1) return { elf: true, bits: buf[4] === 1 ? 32 : 64, type: "other" };
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const etype = dv.getUint16(0x10, true);
  const phoff = Number(dv.getBigUint64(0x20, true));
  const phentsize = dv.getUint16(0x36, true);
  const phnum = dv.getUint16(0x38, true);
  let interp: string | undefined;
  let interpUnread = false;
  let dynamic = false;
  for (let i = 0; i < phnum; i++) {
    const o = phoff + i * phentsize;
    if (o + 56 > buf.length) break;
    const pt = dv.getUint32(o, true);
    if (pt === 2) dynamic = true;
    if (pt === 3) {
      const off = Number(dv.getBigUint64(o + 8, true));
      const sz = Number(dv.getBigUint64(o + 32, true));
      const raw = off + sz <= buf.length ? buf.subarray(off, off + sz) : readAt?.(off, sz);
      if (raw && raw.length === sz) interp = new TextDecoder().decode(raw).replace(/\0+$/, "");
      else interpUnread = true;
    }
  }
  const info: ElfInfo = { elf: true, bits: 64, type: etype === 2 ? "exec" : etype === 3 ? "dyn" : "other", interp, dynamic };
  if (interpUnread) info.interpUnread = true;
  return info;
}

/** Compare dotted versions numerically ("2.9" < "2.17" < "2.35"). */
export function cmpVer(a: string, b: string): number {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/**
 * Highest GLIBC_x.y symbol version an `objdump -p` listing requires. Reads only
 * the "Version References" block, so versions a library defines (its own
 * "Version definitions") do not count. GNU objdump and llvm-objdump both print
 * the block under that heading.
 */
export function maxGlibcRequired(objdumpP: string): string | undefined {
  const i = objdumpP.indexOf("Version References");
  if (i < 0) return undefined;
  const vs = [...objdumpP.slice(i).matchAll(/GLIBC_(\d+\.\d+(?:\.\d+)?)/g)].map((m) => m[1]!);
  return vs.sort(cmpVer).at(-1);
}

/** Release version from a glibc libc.so.6 banner ("GNU C Library ... release version 2.40."). */
export function glibcBanner(libc: string): string | undefined {
  return libc.match(/GNU C Library[^\n]*?release version (\d+\.\d+(?:\.\d+)?)/)?.[1];
}

/** Minimum kernel from an ELF note as `file` prints it ("for GNU/Linux 3.10.0"). */
export function abiTag(fileOut: string): string | undefined {
  return fileOut.match(/for GNU\/Linux (\d+\.\d+(?:\.\d+)?)/)?.[1];
}
