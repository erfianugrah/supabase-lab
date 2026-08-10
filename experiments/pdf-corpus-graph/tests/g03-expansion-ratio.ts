/**
 * G03 - expansion ratio: source PDF bytes vs the Postgres footprint.
 *
 * Every cost projection for a corpus this size currently rests on a GUESSED
 * ratio between source PDF bytes and what lands in Postgres. This closes that
 * gap by actually loading the fixture corpus into corpus.documents and
 * measuring source bytes, extracted text bytes, and on-disk table bytes per
 * fixture and per genre.
 *
 * EXTRACTION HERE IS LOCAL (`pdftotext`, poppler-utils), not the Edge
 * Function G02 measures. That is deliberate, not an oversight: G02 is about
 * whether the platform's OWN runtime can run the extraction step and where
 * that stops; G03 is about storage economics once text exists, which does
 * not depend on where the extraction happened. Coupling this test's numbers
 * to G02's ceiling would silently lose the largest fixtures' ratios exactly
 * when the platform runtime cannot produce them - a worse experiment.
 *
 * TOAST COMPRESSION IS THE POINT, NOT A FOOTNOTE. `extracted_bytes` is the
 * logical UTF-8 byte length of the extracted text; `pg_column_size` is what
 * Postgres actually stores after TOAST compression. Extracted text is highly
 * compressible prose/tables, so reporting only the logical size overstates
 * the footprint substantially - GUIDE.md calls this out explicitly, and it is
 * the single most common way to misread this experiment.
 *
 * Idempotent: a fixture already present in corpus.documents is not
 * re-fetched or re-extracted; the load step records "reused" for it.
 */
import { $ } from "bun";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { BY_SIZE, UA, type Fixture } from "../lib/fixtures";
import { file, instanceSize, q, scalar } from "../lib/pg";
import { ensureDocumentsTable, relationTotalBytes } from "../lib/schema";

async function alreadyLoaded(ctx: Ctx, slug: string): Promise<boolean> {
  const n = await scalar(ctx, `select count(*) from corpus.documents where slug = '${slug}'`);
  return Number(n ?? 0) > 0;
}

/** Fetch + extract + insert one fixture. Base64-encodes the extracted text
 * before it ever reaches a shell argument or a SQL string literal - PDF text
 * can contain quotes, backslashes and arbitrary bytes, and base64 sidesteps
 * both shell-quoting and SQL-quoting hazards entirely rather than trying to
 * escape either. The SQL itself goes through a scratch file and `file()`
 * (psql -f), not `-c`, because the base64 for the largest fixture can run to
 * a few MB and a single `-c` argv risks the OS argument-length limit. */
async function loadFixture(
  ctx: Ctx,
  fx: Fixture,
): Promise<{ ok: boolean; detail: string; extractedBytes?: number }> {
  let bytes: Uint8Array;
  try {
    const res = await fetch(fx.url, { headers: { "User-Agent": UA } });
    if (!res.ok) return { ok: false, detail: `fetch HTTP ${res.status}` };
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    return { ok: false, detail: `fetch failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  const sizeDrift =
    bytes.length !== fx.expectBytes
      ? ` (size drift: expected ${fx.expectBytes}, got ${bytes.length} - upstream document may have been revised)`
      : "";

  const pdfPath = `/tmp/pvlab-g03-${fx.slug}.pdf`;
  await Bun.write(pdfPath, bytes);
  const extract = await $`pdftotext ${pdfPath} -`.quiet().nothrow();
  await $`rm -f ${pdfPath}`.quiet().nothrow();
  if (extract.exitCode !== 0) {
    return { ok: false, detail: `pdftotext exit ${extract.exitCode}: ${extract.stderr.toString().slice(0, 200)}` };
  }
  const text = extract.stdout.toString();
  const extractedBytes = Buffer.byteLength(text, "utf8");
  const b64 = Buffer.from(text, "utf8").toString("base64");

  const sqlPath = `/tmp/pvlab-g03-${fx.slug}.sql`;
  await Bun.write(
    sqlPath,
    `insert into corpus.documents (slug, genre, source_url, source_bytes, extracted_text, extracted_bytes)
     values ('${fx.slug}', '${fx.genre}', '${fx.url}', ${bytes.length},
             convert_from(decode('${b64}', 'base64'), 'UTF8'), ${extractedBytes})
     on conflict (slug) do nothing;`,
  );
  const insertRes = await file(ctx, sqlPath, 300);
  await $`rm -f ${sqlPath}`.quiet().nothrow();
  if (!insertRes.ok) return { ok: false, detail: `insert failed: ${insertRes.raw.slice(0, 200)}` };

  return { ok: true, detail: `loaded${sizeDrift}`, extractedBytes };
}

const mod: TestModule = {
  id: "G03",
  title: "Expansion ratio: source bytes vs extracted text vs on-disk Postgres bytes",
  where: "local",
  requires: ["pooler"],
  async run(ctx: Ctx): Promise<TestResult[]> {
    const ensured = await ensureDocumentsTable(ctx);
    if (!ensured.ok) {
      return [
        {
          id: "G03",
          title: mod.title,
          status: "fail",
          detail: "could not create corpus.documents",
          evidence: ensured.raw.slice(0, 1000),
        },
      ];
    }

    const results: TestResult[] = [];
    for (const fx of BY_SIZE) {
      const key = fx.slug.replace(/-/g, "_");
      if (await alreadyLoaded(ctx, fx.slug)) {
        results.push({
          id: `G03-${key}`,
          title: `Load: ${fx.slug}`,
          status: "info",
          detail: "reused - already in corpus.documents",
          measurements: { instance_size: instanceSize(), load: "reused" },
        });
        continue;
      }
      const r = await loadFixture(ctx, fx);
      results.push({
        id: `G03-${key}`,
        title: `Load: ${fx.slug}`,
        status: r.ok ? "info" : "fail",
        detail: r.detail,
        measurements: {
          instance_size: instanceSize(),
          load: r.ok ? "loaded" : "failed",
          ...(r.extractedBytes != null ? { extracted_bytes: r.extractedBytes } : {}),
        },
      });
    }

    // The ratio itself, read back from the table so it reflects rows that
    // were "reused" from a prior run identically to ones just loaded.
    const rows = await q(
      ctx,
      `select slug, genre, source_bytes, extracted_bytes, pg_column_size(extracted_text)
       from corpus.documents order by source_bytes asc`,
    );
    if (!rows.ok || rows.rows.length === 0) {
      results.push({
        id: "G03",
        title: mod.title,
        status: "fail",
        detail: "no rows in corpus.documents after the load pass - nothing to compute a ratio from",
        evidence: rows.raw.slice(0, 500),
      });
      return results;
    }

    const perGenre = new Map<string, { source: number; extracted: number; column: number; n: number }>();
    const measurements: Record<string, number | string> = { instance_size: instanceSize() };
    let totalSource = 0;
    let totalExtracted = 0;
    let totalColumn = 0;

    for (const [slug, genre, srcS, extS, colS] of rows.rows) {
      const src = Number(srcS ?? 0);
      const ext = Number(extS ?? 0);
      const col = Number(colS ?? 0);
      const key = String(slug).replace(/-/g, "_");
      measurements[`${key}_source_bytes`] = src;
      measurements[`${key}_extracted_bytes`] = ext;
      measurements[`${key}_column_bytes_toasted`] = col;
      measurements[`${key}_expansion_ratio`] = src > 0 ? Number((ext / src).toFixed(4)) : 0;
      measurements[`${key}_toast_compression_ratio`] = ext > 0 ? Number((col / ext).toFixed(4)) : 0;

      const g = String(genre ?? "unknown");
      const agg = perGenre.get(g) ?? { source: 0, extracted: 0, column: 0, n: 0 };
      agg.source += src;
      agg.extracted += ext;
      agg.column += col;
      agg.n += 1;
      perGenre.set(g, agg);

      totalSource += src;
      totalExtracted += ext;
      totalColumn += col;
    }

    for (const [genre, agg] of perGenre) {
      measurements[`genre_${genre}_source_bytes_total`] = agg.source;
      measurements[`genre_${genre}_extracted_bytes_total`] = agg.extracted;
      measurements[`genre_${genre}_avg_expansion_ratio`] =
        agg.source > 0 ? Number((agg.extracted / agg.source).toFixed(4)) : 0;
      measurements[`genre_${genre}_fixtures`] = agg.n;
    }

    const tableBytes = await relationTotalBytes(ctx, "corpus.documents");
    measurements.documents_total_relation_bytes = tableBytes ?? -1;
    measurements.fixtures_loaded = rows.rows.length;
    measurements.aggregate_expansion_ratio = totalSource > 0 ? Number((totalExtracted / totalSource).toFixed(4)) : 0;
    measurements.aggregate_toast_compression_ratio =
      totalExtracted > 0 ? Number((totalColumn / totalExtracted).toFixed(4)) : 0;

    results.push({
      id: "G03",
      title: mod.title,
      status: "info",
      detail:
        `${rows.rows.length} fixtures; aggregate expansion ratio (extracted/source) = ` +
        `${measurements.aggregate_expansion_ratio}; TOAST compresses extracted text to ` +
        `${measurements.aggregate_toast_compression_ratio}x its logical size; documents table on disk: ` +
        `${tableBytes ?? "unknown"} bytes`,
      measurements,
    });

    return results;
  },
};

export default mod;
