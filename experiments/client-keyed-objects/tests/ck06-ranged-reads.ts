/**
 * CK06 - Do ranged decrypting reads return exactly the plaintext slice, and
 * fetch no more than the covering chunks, on all four read paths?
 *
 * SIDE: each target, as the primary tenant's viewer, on the 2 GiB asset CK04
 * uploaded. 100 plaintext ranges from a fixed seed (lengths log-uniform from
 * 1 KiB to 64 MiB, uniform start), each read through all four paths:
 *   s3            S3 GetObject + Range (session token = viewer JWT)
 *   s3-presigned  presigned GET (query SigV4 carrying the session token) + Range
 *   signed-url    Storage /object/sign URL + Range
 *   authenticated Storage /object/authenticated + Range
 * Every read is one ciphertext Range GET, per-chunk SHA-256 checked against
 * the catalogue, AES-GCM decrypted, sliced, and compared with the fixture.
 *
 *   CK06-<target>  per path: reads ok, bytes equal, reads where the body was
 *                  exactly the covering-chunk length, total plaintext asked,
 *                  total body bytes, median and p95 ms (info: one vantage),
 *                  cf-cache-status counts where the CDN answers. On the three
 *                  HTTP paths (since 2026-10-26): time to response headers vs
 *                  body, the sign call (signed-url), the edge colo from cf-ray,
 *                  Age, the first read's header names and cache headers, the
 *                  Spearman correlation of time-to-headers with the range's
 *                  start offset and with its length, of body time with the
 *                  start offset, and one token per read
 *                  (`<start MiB>+<len KiB>=<ttfb>/<total ms>,<cache>[,age<n>]`,
 *                  total from the ranged GET to its last body byte).
 *                  `error_messages` keeps the first message per error key.
 *
 * Pass = 100 of 100 reads equal the fixture slice and every body is exactly
 * the covering chunks (the server honoured the Range). (The first onprem runs
 * read every range through every path, 400 reads; cut to 100 so a far region
 * does not move 5.6 GB per run.)
 * Not settled: reads by other users concurrently; CDN behaviour for objects
 * larger than its cache ceiling (not probed).
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { credsFor, directory, errMsg, loadRun, loadState, row, runClient, scrub } from "../lib/ckrun";

const PATHS = ["s3", "s3-presigned", "signed-url", "authenticated"];
const N = 100;
const KiB = 1024;

/** mulberry32: a fixed seed gives the same ranges on every target. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function ranges(size: number, n = N, seed = 20261012): [number, number][] {
  const r = rng(seed);
  const lo = Math.log(KiB);
  const hi = Math.log(64 * 1024 * KiB);
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const len = Math.round(Math.exp(lo + r() * (hi - lo)));
    const start = Math.floor(r() * (size - len));
    out.push([start, start + len]);
  }
  return out;
}

/**
 * Spearman rank correlation without tie correction (ties are rare in ms and byte offsets; `scripts/ck06-reads.ts`
 * feeds it rounded MiB/KiB, where a few lengths tie - tie-corrected values differ by up to 0.02 on the 2026-10-26
 * runs). -2 when n < 3.
 */
export function spearman(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 3 || ys.length !== n) return -2;
  const rank = (v: number[]) => {
    const idx = v.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
    const r = new Array<number>(n);
    idx.forEach(([, i], k) => (r[i] = k + 1));
    return r;
  };
  const rx = rank(xs);
  const ry = rank(ys);
  const d2 = rx.reduce((acc, r, i) => acc + (r - ry[i]!) ** 2, 0);
  return Math.round((1 - (6 * d2) / (n * (n * n - 1))) * 100) / 100;
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]! : -1;
};

const mod: TestModule = {
  id: "CK06",
  title: "100 ranged decrypting reads across 4 read paths",
  where: "local",
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const l = loadRun(ctx);
    if ("skip" in l) return [{ id: "CK06", title: this.title, status: "skip", detail: l.skip }];
    const out: TestResult[] = [];
    const rs = ranges(l.run.fixtures.big.size);
    for (const t of l.targets) {
      const st = loadState(l.run, t.name);
      const a = st.assets.big_s3;
      if (!a) {
        out.push(row("CK06", t, this.title, "skip", "no 2 GiB asset from CK04 on this target"));
        continue;
      }
      try {
        const res = await runClient({ cmd: "read-ranges", directory: directory(l), creds: credsFor(l, "viewer"), tenant: a.tenant, asset: a.id, file: l.run.fixtures.big.path, ranges: rs, paths: PATHS, spread: true });
        if (!res.result.ok) throw new Error(`${res.result.code} ${res.result.message}`);
        const rows = res.result.rows as {
          path: string;
          s: number;
          e: number;
          ok: boolean;
          equal?: boolean;
          transferred?: number;
          need?: number;
          ms?: number;
          ttfb?: number;
          fetch?: number;
          sign?: number;
          cache?: string;
          hdr?: Record<string, string>;
          code?: string;
        }[];
        const m: Record<string, string | number> = { ranges: rs.length, reads: rows.length, plaintext_bytes_asked: rs.reduce((n, [s, e]) => n + (e - s), 0) };
        let bad = 0;
        const errs = new Map<string, number>();
        // First message per error key: a bare "Thrown" (2026-10-23 region-b) says nothing about the cause.
        const errMsgs = new Map<string, string>();
        for (const p of PATHS) {
          const pr = rows.filter((r) => r.path === p);
          const ok = pr.filter((r) => r.ok);
          const eq = ok.filter((r) => r.equal);
          const exact = ok.filter((r) => r.transferred === r.need);
          m[`${p}.ok`] = ok.length;
          m[`${p}.equal`] = eq.length;
          m[`${p}.body_equals_covering_chunks`] = exact.length;
          m[`${p}.body_bytes_total`] = ok.reduce((n, r) => n + (r.transferred ?? 0), 0);
          m[`${p}.covering_chunk_bytes_total`] = ok.reduce((n, r) => n + (r.need ?? 0), 0);
          m[`${p}.info_ms_p50`] = pct(ok.map((r) => r.ms ?? 0), 50);
          m[`${p}.info_ms_p95`] = pct(ok.map((r) => r.ms ?? 0), 95);
          const cache = new Map<string, number>();
          for (const r of ok) if (r.cache) cache.set(r.cache, (cache.get(r.cache) ?? 0) + 1);
          if (cache.size) m[`${p}.cf_cache_status`] = [...cache].map(([k, v]) => `${k}:${v}`).join(" ");
          // Where the time went on the HTTP paths (2026-10-26): headers vs body, the edge colo, Age, and
          // whether time-to-headers follows the range's start offset or its length.
          const http = ok.filter((r) => r.ttfb !== undefined);
          if (http.length) {
            m[`${p}.info_ttfb_ms_p50`] = pct(http.map((r) => r.ttfb!), 50);
            m[`${p}.info_ttfb_ms_p95`] = pct(http.map((r) => r.ttfb!), 95);
            m[`${p}.info_body_ms_p50`] = pct(http.map((r) => r.fetch! - r.ttfb!), 50);
            if (http.some((r) => r.sign !== undefined)) m[`${p}.info_sign_ms_p50`] = pct(http.map((r) => r.sign ?? 0), 50);
            m[`${p}.ttfb_vs_start_spearman`] = spearman(http.map((r) => r.s), http.map((r) => r.ttfb!));
            m[`${p}.ttfb_vs_len_spearman`] = spearman(http.map((r) => r.e - r.s), http.map((r) => r.ttfb!));
            // Added after the 2026-10-26 runs: on signed-url MISS reads the wait was in the body and followed the start offset.
            m[`${p}.body_vs_start_spearman`] = spearman(http.map((r) => r.s), http.map((r) => r.fetch! - r.ttfb!));
            const count = (f: (h: Record<string, string>) => string | undefined) => {
              const c = new Map<string, number>();
              for (const r of http) {
                const v = f(r.hdr ?? {}) ?? "-";
                c.set(v, (c.get(v) ?? 0) + 1);
              }
              return [...c].map(([k, v]) => `${k}:${v}`).join(" ");
            };
            m[`${p}.colo`] = count((h) => h.colo);
            m[`${p}.age_present`] = http.filter((r) => r.hdr?.age !== undefined).length;
            const first = http[0]!.hdr ?? {};
            m[`${p}.header_names`] = first.names ?? "";
            for (const k of ["cache-control", "server-timing", "via", "x-cache", "x-served-by"]) if (first[k]) m[`${p}.first_${k.replace(/-/g, "_")}`] = first[k]!;
            // One token per read, in read order: start MiB + length KiB = ttfb/total ms, cache, age.
            m[`${p}.reads`] = http
              .map((r) => `${(r.s / 1048576).toFixed(0)}+${Math.round((r.e - r.s) / 1024)}=${r.ttfb}/${r.fetch}${r.cache ? `,${r.cache}` : ""}${r.hdr?.age ? `,age${r.hdr.age}` : ""}`)
              .join(" ");
          }
          for (const r of pr.filter((x) => !x.ok)) {
            const d = (r as { detail?: { status?: number; code?: string } }).detail;
            const k = `${p}:${r.code}${d?.status ? ` ${d.status}` : ""}${d?.code ? ` ${d.code}` : ""}`;
            errs.set(k, (errs.get(k) ?? 0) + 1);
            const msg = (r as { message?: string }).message;
            if (msg && !errMsgs.has(k)) errMsgs.set(k, `range ${r.s}-${r.e}: ${msg.slice(0, 160)}`);
          }
          bad += pr.length - eq.length + (ok.length - exact.length);
        }
        m.iat_future_retries = Number(res.result.iatFutureRetries ?? 0);
        if (errs.size) m.errors = [...errs].map(([k, v]) => `${k} x${v}`).join("; ");
        if (errMsgs.size) m.error_messages = scrub(l, [...errMsgs].map(([k, v]) => `${k}: ${v}`).join("; "));
        out.push(row("CK06", t, this.title, bad || rows.length !== rs.length ? "fail" : "pass", bad ? `problems: ${scrub(l, String(m.errors ?? "body length or content mismatch"))}` : `${rows.length} reads equal the fixture slice; every body was exactly the covering chunks`, m));
      } catch (e) {
        out.push(row("CK06", t, this.title, "fail", `threw: ${scrub(l, errMsg(e))}`));
      }
    }
    return out;
  },
};
export default mod;
