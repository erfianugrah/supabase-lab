#!/usr/bin/env bun
/**
 * load-au-corpus.ts - fetch + extract + load the AU council corpus.
 *
 * Reads demo/seed/au-corpus.json (the committed manifest: slug, genre,
 * doc_date, source_url per document), fetches each PDF with a browser UA
 * (council sites 403 non-browser agents), extracts text, and upserts into
 * corpus.documents with doc_date set - the time axis the editorial queries
 * filter on (plan Track F2).
 *
 * Extraction route per G09's measured threshold: under ~270 chars/page the
 * PDF is treated as image-only and routed through OCR (pdftoppm + tesseract)
 * instead of pdftotext. The route is printed per document so the RUNLOG can
 * record how much of the corpus needed it (plan Track G14).
 *
 * DB writes go through one staged \copy (CSV handles the embedded newlines
 * and quotes in extracted text; per-row psql -c would be quoting roulette at
 * 30 MB of text). Idempotent: upsert on slug, refetch only when the cache
 * file is absent.
 *
 * Usage:
 *   bun scripts/load-au-corpus.ts            # fetch + extract + load
 *   PGURL=... bun scripts/load-au-corpus.ts  # explicit connection string
 *   CACHE_DIR=/path bun scripts/load-au-corpus.ts
 */
import { $ } from "bun";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const EXP = join(import.meta.dir, "..");
const MANIFEST = join(EXP, "demo/seed/au-corpus.json");
const CACHE = process.env.CACHE_DIR ?? "/tmp/pggraph-au-corpus-cache";
// Same UA string the corpus was enumerated with; the council site 403s
// non-browser agents (measured during curation, 2026-08-14).
const UA =
  "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0";
const OCR_CPP_THRESHOLD = 270; // chars/page, per G09's measured boundary

interface Doc {
  slug: string;
  genre: string;
  doc_date: string;
  source_url: string;
  source_bytes: number;
}

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as {
  documents: Doc[];
};
mkdirSync(CACHE, { recursive: true });
mkdirSync(join(CACHE, "pdf"), { recursive: true });
mkdirSync(join(CACHE, "txt"), { recursive: true });

interface Row extends Doc {
  extracted_text: string;
  extracted_bytes: number;
  route: "pdftotext" | "ocr" | "empty";
}

const rows: Row[] = [];
let fetched = 0;
let cached = 0;

for (const doc of manifest.documents) {
  const pdf = join(CACHE, "pdf", `${doc.slug}.pdf`);
  const txt = join(CACHE, "txt", `${doc.slug}.txt`);

  if (!existsSync(pdf)) {
    const res = await fetch(doc.source_url, { headers: { "user-agent": UA } });
    if (!res.ok)
      throw new Error(`fetch ${doc.slug}: HTTP ${res.status} ${doc.source_url}`);
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("pdf"))
      throw new Error(`fetch ${doc.slug}: content-type ${ct}, not a pdf`);
    writeFileSync(pdf, Buffer.from(await res.arrayBuffer()));
    fetched++;
  } else {
    cached++;
  }

  let text: string;
  let route: Row["route"];
  if (existsSync(txt)) {
    text = readFileSync(txt, "utf8");
    // The sidecar keeps the true route across cache hits (two tender notices
    // are scans; labelling their cached text "pdftotext" would falsify the
    // RUNLOG's OCR count).
    route = existsSync(`${txt}.route`)
      ? (readFileSync(`${txt}.route`, "utf8").trim() as Row["route"])
      : "pdftotext";
  } else {
    const pages = Number(
      (await $`pdfinfo ${pdf}`.text()).match(/^Pages:\s+(\d+)/m)?.[1] ?? "0",
    );
    text = await $`pdftotext ${pdf} -`.text().catch(() => "");
    const cpp = pages > 0 ? text.length / pages : 0;
    if (pages > 0 && cpp < OCR_CPP_THRESHOLD) {
      // G14: image-only scan. Rasterize and OCR page by page.
      const prefix = join(CACHE, `ocr-${doc.slug}`);
      await $`pdftoppm -r 200 -gray ${pdf} ${prefix}`.quiet();
      const glob = new Bun.Glob(`ocr-${doc.slug}-*.pgm`);
      const parts: string[] = [];
      for await (const pgm of glob.scan(CACHE)) {
        parts.push(await $`tesseract ${join(CACHE, pgm)} - -l eng`.text());
      }
      text = parts.join("\n\n");
      route = "ocr";
      await $`rm -f ${join(CACHE, `ocr-${doc.slug}-*.pgm`)}`.quiet().nothrow();
    } else {
      route = text.length > 0 ? "pdftotext" : "empty";
    }
    writeFileSync(txt, text);
    writeFileSync(`${txt}.route`, route);
  }

  rows.push({
    ...doc,
    extracted_text: text,
    extracted_bytes: Buffer.byteLength(text, "utf8"),
    route,
  });
  console.log(
    `${doc.slug}  ${doc.genre}  ${doc.doc_date}  ${route}  ${rows.at(-1)!.extracted_bytes}B`,
  );
}

// CSV: quote every field, double internal quotes. Postgres CSV COPY handles
// embedded newlines inside quoted fields.
const csv = rows
  .map((r) =>
    [
      r.slug,
      r.genre,
      r.source_url,
      String(r.source_bytes),
      r.doc_date,
      r.extracted_text,
      String(r.extracted_bytes),
    ]
      .map((v) => `"${v.replaceAll('"', '""')}"`)
      .join(","),
  )
  .join("\n");
const csvPath = join(CACHE, "load.csv");
writeFileSync(csvPath, csv);

const pgurl =
  process.env.PGURL ??
  (await $`make --no-print-directory -C ${EXP} pgurl`.text()).trim();

const sql = `
set search_path = corpus, public;
-- Transaction pooling hands back dirty backends: a prior run's temp table can
-- still be sitting on this backend (pg_temp_<n> is the BACKEND's, not the
-- client session's). Drop before create or the second run collides.
drop table if exists pg_temp.st_au;
create temporary table st_au (
  slug text, genre text, source_url text, source_bytes bigint,
  doc_date date, extracted_text text, extracted_bytes bigint
);
\\copy st_au from '${csvPath}' csv
insert into corpus.documents
  (slug, genre, source_url, source_bytes, doc_date, extracted_text, extracted_bytes)
select slug, genre, source_url, source_bytes, doc_date, extracted_text, extracted_bytes
  from st_au
on conflict (slug) do update set
  genre = excluded.genre,
  source_url = excluded.source_url,
  source_bytes = excluded.source_bytes,
  doc_date = excluded.doc_date,
  extracted_text = excluded.extracted_text,
  extracted_bytes = excluded.extracted_bytes;
select count(*) as loaded from st_au;
`;
// \copy is a psql meta-command: psql -c with multiple statements goes down
// the simple-query path where meta-commands are not interpreted ("syntax
// error at or near \"\\\""). A -f file gets the full parser.
const sqlPath = join(CACHE, "load.sql");
writeFileSync(sqlPath, sql);
const out = await $`psql ${pgurl} -qAt -v ON_ERROR_STOP=1 -f ${sqlPath}`.text();
console.log(`\nloaded: ${out.trim()} documents (fetched ${fetched}, cache hits ${cached})`);
const routes = rows.reduce<Record<string, number>>((a, r) => {
  a[r.route] = (a[r.route] ?? 0) + 1;
  return a;
}, {});
console.log("routes:", JSON.stringify(routes));
console.log(
  `total extracted: ${rows.reduce((a, r) => a + r.extracted_bytes, 0)} bytes from ${rows.reduce((a, r) => a + r.source_bytes, 0)} source bytes`,
);
