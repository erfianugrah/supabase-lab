/**
 * The corpus. Public-domain US federal documents, fetched at run time.
 *
 * WHY THESE. The use case under test is a decades-deep archive of public
 * documents - legislation, regulation, budget and financial filings, standards
 * - so the fixtures are drawn from those genres rather than from whatever PDF
 * was convenient. Extraction difficulty is a property of the genre: a budget
 * appendix is a wall of tables, a Constitution annotation is prose with dense
 * citation structure, and a tax form is a positioned layout with almost no
 * running text. A ratio measured only on clean prose would not survive contact
 * with the other three.
 *
 * WHY PUBLIC DOMAIN SPECIFICALLY. US federal government works carry no
 * copyright, so the corpus can be re-fetched by anyone reproducing this run,
 * and this repo is public. arXiv and most annual reports fail one or both.
 *
 * SIZES SPAN 191 KB TO 15 MB ON PURPOSE. Half of X02 is finding where Edge
 * Function PDF extraction stops, and a ceiling can only be found by crossing
 * it. Sizes below are the Content-Length observed 2026-08-10 and are recorded
 * so a silent upstream revision shows up as a mismatch rather than as a
 * mysterious change in the expansion ratio.
 *
 * GOTCHA: nvlpubs.nist.gov 404s a request whose User-Agent does not look like
 * a browser. `-A 'supabase-lab/1.0'` returns 404 for a URL that returns 200
 * under `Mozilla/5.0`. That is a UA gate presenting as a dead link, and it
 * cost a fixture-selection round here - do not conclude a NIST slug is stale
 * without retrying with a browser UA.
 */

export interface Fixture {
  /** Stable slug, used as the storage object name and the documents.slug key. */
  slug: string;
  url: string;
  /** Content-Length observed 2026-08-10, in bytes. */
  expectBytes: number;
  /** Document genre - the axis extraction difficulty actually varies along. */
  genre: "legislation" | "regulation" | "budget" | "standard" | "form" | "scanned";
  note: string;
}

export const UA = "Mozilla/5.0 (compatible; supabase-lab/1.0)";

export const FIXTURES: Fixture[] = [
  {
    slug: "bill-hr3746",
    url: "https://www.govinfo.gov/content/pkg/BILLS-118hr3746enr/pdf/BILLS-118hr3746enr.pdf",
    expectBytes: 191290,
    genre: "legislation",
    note: "Enrolled bill. Short, heavily structured, section/subsection numbering.",
  },
  {
    slug: "form-1040",
    url: "https://www.irs.gov/pub/irs-pdf/f1040.pdf",
    expectBytes: 220237,
    genre: "form",
    note: "Positioned form layout, almost no running prose. The adversarial case for text extraction.",
  },
  {
    slug: "budget-2025-bud",
    url: "https://www.govinfo.gov/content/pkg/BUDGET-2025-BUD/pdf/BUDGET-2025-BUD.pdf",
    expectBytes: 2504695,
    genre: "budget",
    note: "Narrative budget with embedded tables. Mixed prose/numeric.",
  },
  {
    slug: "cfr-t17-v4",
    url: "https://www.govinfo.gov/content/pkg/CFR-2024-title17-vol4/pdf/CFR-2024-title17-vol4.pdf",
    expectBytes: 3595043,
    genre: "regulation",
    note: "Dense regulation, uniform typography, long cross-reference chains.",
  },
  {
    slug: "nist-sp-800-53r5",
    url: "https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-53r5.pdf",
    expectBytes: 6073678,
    genre: "standard",
    note: "Control catalogue. Entity-rich and explicitly relational - controls reference controls.",
  },
  {
    slug: "conan-2022",
    url: "https://www.govinfo.gov/content/pkg/GPO-CONAN-2022/pdf/GPO-CONAN-2022.pdf",
    expectBytes: 14034445,
    genre: "regulation",
    note: "Constitution Annotated. Very large, prose plus a citation apparatus.",
  },
  {
    slug: "budget-2025-app",
    url: "https://www.govinfo.gov/content/pkg/BUDGET-2025-APP/pdf/BUDGET-2025-APP.pdf",
    expectBytes: 14930674,
    genre: "budget",
    note: "Budget appendix. Table-dominated and the largest fixture - the ceiling probe.",
  },
  {
    slug: "jfk-104-10004-10143",
    url: "https://www.archives.gov/files/research/jfk/releases/2025/0318/104-10004-10143.pdf",
    expectBytes: 415346,
    genre: "scanned",
    note: "NARA JFK assassination record - image-only scanned PDF (2 chars from 2 pages via pdftotext). The deliverable is chars-per-page against born-digital.",
  },
];

export function fixture(slug: string): Fixture {
  const f = FIXTURES.find((x) => x.slug === slug);
  if (!f) throw new Error(`no fixture ${slug}`);
  return f;
}

/** Ascending by size - the order a ceiling probe has to walk. */
export const BY_SIZE = [...FIXTURES].sort((a, b) => a.expectBytes - b.expectBytes);
