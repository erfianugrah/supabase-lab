/**
 * CL23 - which Linux hosts the experimental stack's native runtime can run on,
 * read from what it downloads rather than by running it (static; CL24 is the
 * runtime matrix). No container, no project, no stack started.
 *
 *   CL23a  the CLI's own Linux binaries for one release (tarball, both
 *          architectures, and the Alpine .apk): ELF interpreter, the highest
 *          GLIBC_ symbol version they require, the .apk's declared depends.
 *   CL23b  what the CLI bundle says: the native targets and whether the
 *          host-to-target choice looks at anything but os and arch (a libc
 *          check), the pinned service artifacts, and the idle-stop constants
 *          and which lazy services get none.
 *   CL23c  every pinned linux-amd64 and linux-arm64 artifact, downloaded from
 *          the slim-services releases and checked against the CLI's sha256
 *          pin: bundled loader and glibc (version, ABI-tag kernel floor), or
 *          static, or dynamic against the host's glibc (highest GLIBC_ version
 *          any ELF in it requires). The host glibc floor per architecture is
 *          the highest of those.
 *
 * Needs network, `zstd`, `tar`, `objdump` and `file` on the orchestrator
 * (macOS: Homebrew zstd; objdump is llvm-objdump). About 1.1 GB downloaded
 * (0.9 GB of service artifacts, 0.25 GB of CLI packages);
 * PVLAB_CL23_CACHE keeps the downloads between runs (otherwise a temp dir,
 * removed at the end). PVLAB_CL23_CLI_VERSION picks the release (2.120.0).
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, closeSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { baseEnv, run, saveRaw } from "../lib/cli";
import { abiTag, assetOf, cmpVer, glibcBanner, idleCallSite, maxGlibcRequired, parseIdle, parsePins, parseTargets, readElf, type ElfInfo, type Pin } from "../lib/native";

const V = process.env.PVLAB_CL23_CLI_VERSION ?? "2.120.0";
const ARCHES = ["amd64", "arm64"] as const;
type Arch = (typeof ARCHES)[number];
const CLI_BASE = `https://github.com/supabase/cli/releases/download/v${V}`;

async function sha256(path: string): Promise<string> {
  const h = new Bun.CryptoHasher("sha256");
  h.update(new Uint8Array(await Bun.file(path).arrayBuffer()));
  return h.digest("hex");
}

/** Download once into the cache; returns the path, or throws on HTTP failure. */
async function fetchTo(url: string, path: string): Promise<string> {
  if (existsSync(path)) return path;
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  // Bun.write(path, response) hung on a 61 MB GitHub release asset (bun 1.3.14); buffer instead.
  await Bun.write(path + ".part", new Uint8Array(await r.arrayBuffer()));
  renameSync(path + ".part", path);
  return path;
}

/**
 * ELF facts for a file: the first 64 KB for the header and program headers,
 * plus a positioned read for PT_INTERP, which patchelf'd binaries keep far
 * past the head (edge-runtime's at about 130 MB).
 */
function elfOf(path: string): ElfInfo {
  const fd = openSync(path, "r");
  try {
    const b = new Uint8Array(65536);
    const n = readSync(fd, b, 0, b.length, 0);
    return readElf(b.subarray(0, n), (off, len) => {
      const r = new Uint8Array(len);
      const got = readSync(fd, r, 0, len, off);
      return r.subarray(0, got);
    });
  } finally {
    closeSync(fd);
  }
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { recursive: true }) as string[]) {
    const p = join(dir, e);
    const st = lstatSync(p);
    if (st.isFile()) out.push(p);
  }
  return out;
}

async function objdumpGlibc(path: string): Promise<string | undefined> {
  const r = await run(["objdump", "-p", path], { timeoutMs: 120_000 });
  return maxGlibcRequired(r.stdout);
}

interface ArtifactRow {
  service: string;
  arch: Arch;
  asset: string;
  bytes: number;
  shaOk: boolean;
  elfs: number;
  kind: "bundled" | "static" | "host" | "none";
  bundledGlibc?: string;
  bundledKernelFloor?: string;
  hostGlibc?: string;
  hostGlibcSetBy?: string;
  interps: string[];
  interpUnread: number;
}

async function classify(dir: string, pin: Pin, arch: Arch, asset: string, bytes: number, shaOk: boolean): Promise<ArtifactRow> {
  const files = walk(dir);
  const loader = files.find((f) => /\/lib\/ld-linux-[a-z0-9_-]+\.so\.\d$/.test(f));
  const libc = files.find((f) => /\/lib\/libc\.so\.6$/.test(f));
  const interps = new Set<string>();
  let elfs = 0;
  let unread = 0;
  const dynamic: string[] = [];
  for (const f of files) {
    const e = elfOf((f));
    if (!e.elf) continue;
    elfs++;
    if (e.interp) interps.add(e.interp);
    if (e.interpUnread) unread++;
    if (e.dynamic) dynamic.push(f);
  }
  const row: ArtifactRow = { service: pin.key, arch, asset, bytes, shaOk, elfs, kind: "none", interps: [...interps].sort(), interpUnread: unread };
  if (loader && libc) {
    row.kind = "bundled";
    row.bundledGlibc = glibcBanner(readFileSync(libc).toString("latin1"));
    row.bundledKernelFloor = abiTag((await run(["file", "-b", libc])).stdout);
    return row;
  }
  if (elfs === 0) return row;
  let best: string | undefined;
  let by: string | undefined;
  for (const f of dynamic) {
    const g = await objdumpGlibc(f);
    if (g && (!best || cmpVer(g, best) > 0)) {
      best = g;
      by = f.slice(dir.length + 1);
    }
  }
  if (best) {
    row.kind = "host";
    row.hostGlibc = best;
    row.hostGlibcSetBy = by;
  } else row.kind = "static";
  return row;
}

const mod: TestModule = {
  id: "CL23",
  title: "Native stack artifacts: libc dependencies, host glibc floor, idle-stop constants (static read)",
  where: "local",
  async run(ctx: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];
    for (const tool of [["zstd", "--version"], ["objdump", "--version"], ["file", "--version"]]) {
      const r = await run(tool, { timeoutMs: 20_000 }).catch(() => ({ code: 127 }));
      if (r.code !== 0) return [{ id: "CL23", title: this.title, status: "skip", detail: `\`${tool[0]}\` is not available on this host` }];
    }
    const keep = process.env.PVLAB_CL23_CACHE;
    const root = keep ?? mkdtempSync(join(tmpdir(), "cl23-"));
    mkdirSync(join(root, "dl"), { recursive: true });
    try {
      // ---------------- CL23a: the CLI binaries ----------------
      const sums = await (await fetch(`${CLI_BASE}/checksums.txt`)).text();
      const want = (n: string) => sums.split("\n").find((l) => l.trim().endsWith(` ${n}`))?.split(/\s+/)[0] ?? "";
      const cli: Record<string, string | number> = {};
      let bundle = "";
      let cliOk = true;
      let cliBytes = 0;
      for (const a of ARCHES) {
        const tgzName = `supabase_${V}_linux_${a}.tar.gz`;
        const tgz = await fetchTo(`${CLI_BASE}/supabase_linux_${a}.tar.gz`, join(root, "dl", tgzName));
        const tOk = (await sha256(tgz)) === want(tgzName);
        const td = join(root, `cli-${a}`);
        mkdirSync(td, { recursive: true });
        await run(["tar", "xzf", tgz, "-C", td]);
        const bin = join(td, "supabase");
        const e = elfOf((bin));
        const g = await objdumpGlibc(bin);
        const go = elfOf((join(td, "supabase-go")));
        if (a === "arm64") bundle = readFileSync(bin).toString("latin1");
        const apkName = `supabase_${V}_linux_${a}.apk`;
        const apk = await fetchTo(`${CLI_BASE}/${apkName}`, join(root, "dl", apkName));
        cliBytes += lstatSync(tgz).size + lstatSync(apk).size;
        const aOk = (await sha256(apk)) === want(apkName);
        const ad = join(root, `apk-${a}`);
        mkdirSync(ad, { recursive: true });
        let x = await run(["tar", "xzf", apk, "-C", ad]);
        if (!existsSync(join(ad, ".PKGINFO"))) x = await run(["tar", "--ignore-zeros", "-xzf", apk, "-C", ad]);
        const info = existsSync(join(ad, ".PKGINFO")) ? readFileSync(join(ad, ".PKGINFO"), "utf8") : "";
        const ae = existsSync(join(ad, "usr/bin/supabase")) ? elfOf((join(ad, "usr/bin/supabase"))) : { elf: false as const };
        cliOk &&= tOk && aOk && x.code === 0;
        Object.assign(cli, {
          [`${a}_tarball_sha256_ok`]: tOk ? 1 : 0,
          [`${a}_tarball_interp`]: e.interp ?? "static",
          [`${a}_tarball_max_glibc`]: g ?? "none",
          [`${a}_tarball_supabase_go`]: go.elf && !go.interp ? "static" : (go.interp ?? "not ELF"),
          [`${a}_apk_sha256_ok`]: aOk ? 1 : 0,
          [`${a}_apk_interp`]: "interp" in ae && ae.interp ? ae.interp : "static or absent",
          [`${a}_apk_depends`]: [...info.matchAll(/^depend = (.+)$/gm)].map((m) => m[1]).join(",") || "none",
        });
      }
      out.push({
        id: "CL23a",
        title: `CLI ${V} Linux binaries: interpreter and glibc symbol versions`,
        status: cliOk ? "info" : "fail",
        detail: ARCHES.map((a) => `${a}: tarball ${cli[`${a}_tarball_interp`]} needs GLIBC_${cli[`${a}_tarball_max_glibc`]}, apk ${cli[`${a}_apk_interp`]} (depends ${cli[`${a}_apk_depends`]})`).join("; "),
        measurements: { cli_version: V, cli_package_bytes: cliBytes, ...cli },
      });

      // ---------------- CL23b: what the bundle says ----------------
      const pins = parsePins(bundle);
      const idle = parseIdle(bundle);
      const site = idleCallSite(bundle);
      const tg = parseTargets(bundle);
      out.push({
        id: "CL23b",
        title: "The CLI bundle: native targets, artifact pins, idle-stop constants",
        status: pins.length > 0 && idle && site.found && tg.targets.length > 0 ? "info" : "fail",
        detail: `targets ${tg.targets.join(",")} (selector reads only os and arch: ${tg.checksOnlyOsArch}); ${pins.length} pinned services; idle stop ${idle?.lazyMs} ms for lazy services, ${idle?.studioMs} ms for studio; lazy with no idle stop: ${site.lazyWithoutIdle.join(",") || "none"}`,
        measurements: {
          native_targets: tg.targets.join(","),
          target_selector_reads_only_os_arch: tg.checksOnlyOsArch ? 1 : 0,
          pinned_services: pins.length,
          pins: pins.map((p) => `${p.key}=${p.source}@${p.version}-r${p.revision}`).join(" "),
          idle_ms_lazy: idle?.lazyMs ?? -1,
          idle_ms_studio: idle?.studioMs ?? -1,
          idle_call_site_found: site.found ? 1 : 0,
          lazy_without_idle_stop: site.lazyWithoutIdle.join(",") || "none",
        },
      });
      if (!pins.length) return out;

      // ---------------- CL23c: every artifact ----------------
      const rows: ArtifactRow[] = [];
      for (const p of pins) {
        for (const a of ARCHES) {
          const as = assetOf(p, a);
          const f = await fetchTo(as.url, join(root, "dl", as.name));
          const ok = (await sha256(f)) === as.sha256;
          const d = join(root, "x", as.name.replace(/\.tar\.zst$/, ""));
          rmSync(d, { recursive: true, force: true });
          mkdirSync(d, { recursive: true });
          const x = await run(["sh", "-c", 'zstd -dcq "$1" | tar xf - -C "$2"', "sh", f, d], { timeoutMs: 600_000, env: baseEnv() });
          if (x.code !== 0) ctx.log(`cl23: extract ${as.name} exit ${x.code}`);
          rows.push(await classify(d, p, a, as.name, lstatSync(f).size, ok));
          rmSync(d, { recursive: true, force: true });
        }
      }
      saveRaw("cl23c-artifacts.json", JSON.stringify(rows, null, 2));
      const floor = (a: Arch) => rows.filter((r) => r.arch === a && r.kind === "host").sort((x, y) => cmpVer(y.hostGlibc!, x.hostGlibc!))[0];
      const label = (r: ArtifactRow) =>
        r.kind === "bundled" ? `bundled glibc ${r.bundledGlibc} (kernel >= ${r.bundledKernelFloor})` : r.kind === "host" ? `host glibc >= ${r.hostGlibc} (${r.hostGlibcSetBy})` : r.kind;
      const m: Record<string, string | number> = {
        artifacts: rows.length,
        artifacts_sha256_ok: rows.filter((r) => r.shaOk).length,
        artifact_bytes_total: rows.reduce((s, r) => s + r.bytes, 0),
        elf_interp_unread: rows.reduce((s, r) => s + r.interpUnread, 0),
      };
      for (const a of ARCHES) {
        const f = floor(a);
        m[`${a}_host_glibc_floor`] = f?.hostGlibc ?? "none";
        m[`${a}_floor_set_by`] = f ? `${f.service} ${f.hostGlibcSetBy}` : "none";
        m[`${a}_bundled`] = rows.filter((r) => r.arch === a && r.kind === "bundled").map((r) => r.service).join(",");
        m[`${a}_static`] = rows.filter((r) => r.arch === a && r.kind === "static").map((r) => r.service).join(",");
        m[`${a}_elf_interps`] = rows.filter((r) => r.arch === a && r.interps.length).map((r) => `${r.service}:${r.interps.join("+")}`).join(",");
        m[`${a}_host_dynamic`] = rows.filter((r) => r.arch === a && r.kind === "host").map((r) => `${r.service}:${r.hostGlibc}`).join(",");
      }
      for (const r of rows) m[`${r.arch}_${r.service}`] = label(r);
      out.push({
        id: "CL23c",
        title: "Pinned linux artifacts: bundled glibc, static, or the host's glibc",
        status: rows.every((r) => r.shaOk) ? "info" : "fail",
        detail: ARCHES.map((a) => `${a}: host glibc floor ${m[`${a}_host_glibc_floor`]} set by ${m[`${a}_floor_set_by`]}; bundled ${m[`${a}_bundled`]}; static ${m[`${a}_static`]}`).join(" | "),
        measurements: m,
      });
    } catch (e) {
      out.push({ id: "CL23", title: this.title, status: "fail", detail: `threw: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      if (!keep) rmSync(root, { recursive: true, force: true });
    }
    return out;
  },
};

export default mod;
