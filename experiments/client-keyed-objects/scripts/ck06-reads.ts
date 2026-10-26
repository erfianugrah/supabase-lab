#!/usr/bin/env bun
/**
 * Per-read view of a CK06 artifact's `<path>.reads` tokens
 * (`<start MiB>+<len KiB>=<ttfb>/<total ms>,<cache>`), for runs that predate
 * `body_vs_start_spearman` in the module (the 2026-10-26 runs).
 *
 *   bun scripts/ck06-reads.ts out/<date>/run-<stamp>.json [path]
 *
 * Prints, per HTTP read path: n, the Spearman correlation of body time
 * (total - ttfb) with the start offset and with the length, the maximum ttfb,
 * the median body ms per cache status, and the median (midpoint for even n),
 * min and max of start MiB / body s over reads that start past 64 MiB.
 */
import { spearman } from "../tests/ck06-ranged-reads";

/** Midpoint median (mean of the two middle values for even n). */
export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (!n) return Number.NaN;
  return n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
}

const [file, only] = process.argv.slice(2);
if (!file) throw new Error("usage: bun scripts/ck06-reads.ts <run.json> [path]");
const run = JSON.parse(await Bun.file(file).text()) as { results: { id: string; measurements?: Record<string, string | number> }[] };
const ck06 = run.results.find((r) => r.id.startsWith("CK06"));
if (!ck06?.measurements) throw new Error("no CK06 result with measurements");
for (const p of only ? [only] : ["s3-presigned", "signed-url", "authenticated"]) {
  const rows = String(ck06.measurements[`${p}.reads`] ?? "")
    .split(" ")
    .filter(Boolean)
    .map((t) => {
      const m = /^(\d+)\+(\d+)=(\d+)\/(\d+)/.exec(t);
      if (!m) throw new Error(`bad token ${t}`);
      return { startMiB: +m[1]!, lenKiB: +m[2]!, ttfb: +m[3]!, body: +m[4]! - +m[3]!, cache: /,(HIT|MISS|DYNAMIC|REVALIDATED|EXPIRED|BYPASS)/.exec(t)?.[1] ?? "-" };
    });
  const rate = rows.filter((r) => r.startMiB > 64).map((r) => r.startMiB / (r.body / 1000));
  const byCache = [...new Set(rows.map((r) => r.cache))].map((c) => `${c}:${median(rows.filter((r) => r.cache === c).map((r) => r.body)).toFixed(0)}`).join(" ");
  console.log(
    `${p}: n=${rows.length} body_vs_start_spearman=${spearman(rows.map((r) => r.startMiB), rows.map((r) => r.body))} body_vs_len_spearman=${spearman(rows.map((r) => r.lenKiB), rows.map((r) => r.body))} max_ttfb_ms=${Math.max(...rows.map((r) => r.ttfb))} median_body_ms_by_cache=${byCache}` +
      ` start_MiB_per_body_s(n=${rate.length}) median=${rate.length ? median(rate).toFixed(1) : "-"} min=${rate.length ? Math.min(...rate).toFixed(1) : "-"} max=${rate.length ? Math.max(...rate).toFixed(1) : "-"}`,
  );
}
