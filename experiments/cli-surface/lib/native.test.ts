import { describe, expect, test } from "bun:test";
import { abiTag, assetOf, cmpVer, glibcBanner, idleCallSite, maxGlibcRequired, parseIdle, parsePins, parseTargets, readElf } from "./native";

// Shapes copied from the 2.120.0 linux-arm64 CLI bundle (digests shortened to a repeated hex digit).
const H = (c: string) => c.repeat(64);
const PIN = `rest:nT("postgrest",{upstreamVersion:"v16.4",revision:0,image:"ghcr.io/supabase/cli/postgrest:v16.4-r0@sha256:${H("0")}",upstreamImage:"postgrest/postgrest:v16.4",natives:{"darwin-arm64":{archive:"${H("1")}",manifest:"${H("2")}"},"linux-amd64":{archive:"${H("3")}",manifest:"${H("4")}"},"linux-arm64":{archive:"${H("5")}",manifest:"${H("6")}"}}})`;
const PIN15 = `{"15.19.0.004":{upstreamVersion:"15.19.0.004",revision:1,image:"x",upstreamImage:"supabase/postgres:15.19.0.004",natives:{"darwin-arm64":{archive:"${H("7")}",manifest:"${H("8")}"},"linux-amd64":{archive:"${H("9")}",manifest:"${H("a")}"},"linux-arm64":{archive:"${H("b")}"}}}`;

describe("bundle parsers", () => {
  test("parsePins reads the default pin and skips the extra-version map", () => {
    const p = parsePins(`x,${PIN},${PIN15},y`);
    expect(p).toEqual([{ key: "rest", source: "postgrest", version: "v16.4", revision: 0, amd64: H("3"), arm64: H("5") }]);
    expect(assetOf(p[0]!, "arm64")).toEqual({
      tag: "postgrest-v16.4-r0",
      name: "postgrest-v16.4-r0-linux-arm64.tar.zst",
      url: "https://github.com/supabase/slim-services/releases/download/postgrest-v16.4-r0/postgrest-v16.4-r0-linux-arm64.tar.zst",
      sha256: H("5"),
    });
  });

  test("parseIdle resolves which constant is studio's", () => {
    expect(parseIdle(`});var X2n=60000,z2n=300000,Y2n=(e)=>e==="studio"?z2n:X2n,Cae`)).toEqual({ lazyMs: 60000, studioMs: 300000 });
    expect(parseIdle("nothing here")).toBeUndefined();
  });

  test("idleCallSite finds lazy services exempt from idle stops", () => {
    // 2.120.0
    expect(idleCallSite(`L=J.map(({id:x,creation:W})=>r.eager!==!0&&W.service!=="database"&&Vf(W).length>0?W.service==="functions"?{id:x,activation:"lazy"}:{id:x,activation:"lazy",idleMillis:Y2n(W.service)}:{id:x,activation:"eager"})`)).toEqual({ found: true, lazyWithoutIdle: ["functions"] });
    // 2.121.0
    expect(idleCallSite(`H=F.map(({id:I,creation:z})=>r.eager!==!0&&z.service!=="database"&&hf(z).length>0?{id:I,activation:"lazy",idleMillis:eYn(z.service)}:{id:I,activation:"eager"})`)).toEqual({ found: true, lazyWithoutIdle: [] });
    expect(idleCallSite('activation:"lazy"').found).toBe(false);
  });

  test("parseTargets lists the native targets and notices a libc check", () => {
    const fn = `F_t=(e)=>{if(e.os==="darwin"&&e.arch==="arm64")return"darwin-arm64";if(e.os==="linux"&&e.arch==="x64")return"linux-amd64";if(e.os==="linux"&&e.arch==="arm64")return"linux-arm64";return},f$=`;
    expect(parseTargets(fn)).toEqual({ targets: ["darwin-arm64", "linux-amd64", "linux-arm64"], checksOnlyOsArch: true });
    expect(parseTargets("no map").targets).toEqual([]);
  });
});

describe("ELF helpers", () => {
  test("readElf finds PT_INTERP in a hand-built ELF64 header", () => {
    const b = new Uint8Array(200);
    b.set([0x7f, 0x45, 0x4c, 0x46, 2, 1], 0);
    const dv = new DataView(b.buffer);
    dv.setUint16(0x10, 2, true); // ET_EXEC
    dv.setBigUint64(0x20, 64n, true); // phoff
    dv.setUint16(0x36, 56, true);
    dv.setUint16(0x38, 2, true);
    const interp = "/lib/ld-musl-aarch64.so.1\0";
    dv.setUint32(64, 3, true); // PT_INTERP
    dv.setBigUint64(64 + 8, 180n - BigInt(interp.length), true);
    dv.setBigUint64(64 + 32, BigInt(interp.length), true);
    dv.setUint32(120, 2, true); // PT_DYNAMIC
    b.set(new TextEncoder().encode(interp), 180 - interp.length);
    expect(readElf(b)).toEqual({ elf: true, bits: 64, type: "exec", interp: "/lib/ld-musl-aarch64.so.1", dynamic: true });
    expect(readElf(new TextEncoder().encode("#!/bin/sh\n".padEnd(80)))).toEqual({ elf: false });
  });

  test("readElf reads a PT_INTERP that lies past the head through readAt", () => {
    // A patchelf'd binary: PT_INTERP at offset 0x7bfc128 (edge-runtime's), far past a 64 KB head.
    const head = new Uint8Array(65536);
    head.set([0x7f, 0x45, 0x4c, 0x46, 2, 1], 0);
    const dv = new DataView(head.buffer);
    dv.setUint16(0x10, 3, true); // ET_DYN (PIE)
    dv.setBigUint64(0x20, 64n, true);
    dv.setUint16(0x36, 56, true);
    dv.setUint16(0x38, 1, true);
    const interp = "/lib64/ld-linux-x86-64.so.2\0";
    dv.setUint32(64, 3, true);
    dv.setBigUint64(64 + 8, 0x7bfc128n, true);
    dv.setBigUint64(64 + 32, BigInt(interp.length), true);
    const asked: number[] = [];
    const readAt = (off: number, len: number) => {
      asked.push(off);
      return new TextEncoder().encode(interp).subarray(0, len);
    };
    expect(readElf(head, readAt)).toEqual({ elf: true, bits: 64, type: "dyn", interp: "/lib64/ld-linux-x86-64.so.2", dynamic: false });
    expect(asked).toEqual([0x7bfc128]);
    // Without a reader the interpreter is unread, not absent (the bug: it came back "").
    const r = readElf(head);
    expect(r.interp).toBeUndefined();
    expect(r.interpUnread).toBe(true);
  });

  test("maxGlibcRequired ignores version definitions and sorts numerically", () => {
    const out = `Version definitions:\n1 0x01 0x0 libgcc_s.so.1\n2 0x00 0x0 GLIBC_2.99\n\nVersion References:\n  required from libc.so.6:\n    0x0 0x00 03 GLIBC_2.9\n    0x0 0x00 04 GLIBC_2.35\n    0x0 0x00 05 GLIBC_2.17\n`;
    expect(maxGlibcRequired(out)).toBe("2.35");
    expect(maxGlibcRequired("Dynamic Section:\n")).toBeUndefined();
    expect(cmpVer("2.9", "2.17")).toBeLessThan(0);
    expect(cmpVer("2.3.4", "2.3")).toBeGreaterThan(0);
  });

  test("banner and ABI tag", () => {
    expect(glibcBanner("GNU C Library (GNU libc) stable release version 2.40.\nCopyright")).toBe("2.40");
    expect(abiTag("ELF 64-bit LSB pie executable, x86-64, dynamically linked, for GNU/Linux 3.10.0, stripped")).toBe("3.10.0");
  });
});
