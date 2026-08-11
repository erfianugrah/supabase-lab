/**
 * G09 - what a scanned PDF does: chars-per-page against born-digital.
 *
 * The corpus in scope spans 2000-2026 and the early end is very likely
 * scanned. form-1040 already hints at this: ratio 0.048 and zero entities.
 *
 * This adds an image-only PDF fixture, runs it through the SAME extraction
 * path G02 uses (the deployed pdf-extract Edge Function), and records
 * chars-per-page against the born-digital fixtures so there is a measured
 * threshold distinguishing "scanned" from "sparse". That threshold is the
 * deliverable - it is what a real pipeline branches on to route to OCR.
 *
 * Do NOT build an OCR pipeline. Record that OCR is required, is unavailable
 * in-database (plpython3u absent), and note the measured detection threshold.
 *
 * The function is reused from G02 (slug `pdf-extract-g02`). If G02 was not
 * run or the function was deleted, this deploys it idempotently.
 */
import { $ } from "bun";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { mgmt } from "../../../harness/src/mgmt";
import { FIXTURES } from "../lib/fixtures";
import { instanceSize, q } from "../lib/pg";

const FUNC_SLUG = "pdf-extract-g02";
const FUNCTION_SRC = join(process.cwd(), "functions", "pdf-extract", "index.ts");
const INVOKE_TIMEOUT_MS = 150_000;

// Born-digital fixtures to compare against: both must succeed on the Supabase
// Edge Function (G02 measured the ceiling between 2.5 MB and 3.6 MB; nist-sp-800-53r5
// at 6 MB fails with HTTP 546 WORKER_RESOURCE_LIMIT, so it cannot serve as a
// comparison baseline here). bill-hr3746 (191 KB) and budget-2025-bud (2.5 MB)
// both succeed and span the workable size range.
const BORN_DIGITAL_SLUGS = ["bill-hr3746", "budget-2025-bud"];

async function listFunctionSlugs(ctx: Ctx): Promise<{ ok: boolean; slugs: string[] }> {
  const r = await mgmt(ctx, "GET", `/projects/${ctx.ref}/functions`);
  const arr = Array.isArray(r.json) ? (r.json as Record<string, unknown>[]) : [];
  return { ok: r.status === 200, slugs: arr.map((f) => String(f.slug ?? "")) };
}

async function deploy(ctx: Ctx): Promise<{ ok: boolean; detail: string }> {
  const which = await $`which supabase`.quiet().nothrow();
  if (which.exitCode !== 0) return { ok: false, detail: "supabase CLI not on PATH" };

  const workdir = join(tmpdir(), `pvlab-g09-${crypto.randomUUID()}`);
  const destDir = join(workdir, "supabase", "functions", FUNC_SLUG);
  await $`mkdir -p ${destDir}`.quiet().nothrow();
  await Bun.write(join(destDir, "index.ts"), await Bun.file(FUNCTION_SRC).text());

  const p = await $`supabase functions deploy ${FUNC_SLUG} --project-ref ${ctx.ref} --use-api --no-verify-jwt --workdir ${workdir}`
    .env({ ...process.env, SUPABASE_ACCESS_TOKEN: ctx.pat ?? "" })
    .quiet()
    .nothrow();
  const out = (p.stdout.toString() + p.stderr.toString()).trim();
  await $`rm -rf ${workdir}`.quiet().nothrow();
  return { ok: p.exitCode === 0, detail: out.slice(0, 500) || `exit ${p.exitCode}` };
}

async function invoke(ctx: Ctx, url: string): Promise<{
  didSucceed: boolean;
  chars: number;
  pages: number;
  wallMs: number;
  detail: string;
}> {
  const endpoint = `https://${ctx.apiHost}/functions/v1/${FUNC_SLUG}?url=${encodeURIComponent(url)}`;
  const t0 = performance.now();
  try {
    const res = await fetch(endpoint, { signal: AbortSignal.timeout(INVOKE_TIMEOUT_MS) });
    const wallMs = performance.now() - t0;
    const text = await res.text();
    let body: Record<string, unknown> | undefined;
    try { body = JSON.parse(text) as Record<string, unknown>; } catch { body = undefined; }

    if (res.ok && body?.ok === true) {
      return {
        didSucceed: true,
        chars: Number(body.extractedChars ?? 0),
        pages: Number(body.pages ?? 0),
        wallMs,
        detail: "extracted",
      };
    }
    if (body && body.ok === false) {
      return { didSucceed: false, chars: 0, pages: 0, wallMs, detail: `${String(body.stage ?? "unknown")}: ${String(body.error ?? "")}`.slice(0, 200) };
    }
    return { didSucceed: false, chars: 0, pages: 0, wallMs, detail: `HTTP ${res.status}: ${text.slice(0, 200)}` };
  } catch (e) {
    const wallMs = performance.now() - t0;
    return { didSucceed: false, chars: 0, pages: 0, wallMs, detail: `fetch error: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200) };
  }
}

function charsPerPage(chars: number, pages: number): number | null {
  if (pages <= 0) return null;
  return Math.round((chars / pages) * 100) / 100;
}

const mod: TestModule = {
  id: "G09",
  title: "Scanned PDF: chars-per-page against born-digital, to derive an OCR-routing threshold",
  where: "local",
  requires: ["pat", "pooler"],
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!ctx.ref || !ctx.apiHost) {
      return [{ id: "G09", title: mod.title, status: "skip", detail: "PVLAB_REF not set - no project to invoke against" }];
    }

    // Ensure the extraction function is deployed.
    const existing = await listFunctionSlugs(ctx);
    let deployNote: string;
    if (existing.ok && existing.slugs.includes(FUNC_SLUG)) {
      deployNote = "reused - function already deployed";
    } else {
      const d = await deploy(ctx);
      if (!d.ok) {
        return [{
          id: "G09",
          title: mod.title,
          status: "skip",
          detail: `Edge Function deployment failed and cannot be reused: ${d.detail}`,
          measurements: { instance_size: instanceSize() },
        }];
      }
      deployNote = "deployed just now";
      await Bun.sleep(3000);
    }

    // Find the scanned fixture.
    const scannedFx = FIXTURES.find((f) => f.slug === "jfk-104-10004-10143");
    if (!scannedFx) {
      return [{
        id: "G09",
        title: mod.title,
        status: "fail",
        detail: "scanned fixture jfk-104-10004-10143 not found in FIXTURES",
        measurements: { instance_size: instanceSize() },
      }];
    }

    // Verify the fixture's Content-Length against the live server.
    // expectBytes is the anchor; a mismatch means the upstream document was
    // revised and the probe must report it (GUIDE.md).
    let actualContentLength: number | null = null;
    try {
      const headResp = await fetch(scannedFx.url, { method: "HEAD" });
      const cl = headResp.headers.get("content-length");
      actualContentLength = cl != null ? Number(cl) : null;
    } catch { actualContentLength = null; }
    const clMismatch = actualContentLength != null && actualContentLength !== scannedFx.expectBytes;

    // Probe pg_available_extensions for plpython3u - the in-database OCR path.
    // This is a MEASURED fact, not a recalled claim (GUIDE cardinal rule).
    const extResult = await q(
      ctx,
      "select name, default_version from pg_available_extensions where name = 'plpython3u'",
    );
    const plpython3uAvailable = extResult.ok && extResult.rows.length > 0;
    const plpython3uVersion = plpython3uAvailable ? (extResult.rows[0]?.[1] ?? "unknown") : null;

    const results: TestResult[] = [];
    const charsPerPageValues: Record<string, number | string> = {};

    // Probe the scanned fixture.
    const scanned = await invoke(ctx, scannedFx.url);
    const scannedCpp = charsPerPage(scanned.chars, scanned.pages);
    results.push({
      id: "G09a",
      title: `Scanned PDF: ${scannedFx.slug}`,
      status: "info",
      detail: scanned.didSucceed
        ? `extracted ${scanned.chars} chars from ${scanned.pages} pages (${scannedCpp ?? "N/A"} chars/page) in ${Math.round(scanned.wallMs)}ms wall`
        : `extraction failed: ${scanned.detail}`,
      measurements: {
        instance_size: instanceSize(),
        slug: scannedFx.slug,
        genre: "scanned-candidate",
        source_bytes: actualContentLength ?? scannedFx.expectBytes,
        extracted_chars: scanned.chars,
        pages: scanned.pages,
        chars_per_page: scannedCpp ?? "N/A",
        wall_ms: Math.round(scanned.wallMs),
        ok: String(scanned.didSucceed),
      },
    });
    if (scannedCpp != null) charsPerPageValues[scannedFx.slug] = scannedCpp;

    // Probe born-digital comparison fixtures.
    for (let i = 0; i < BORN_DIGITAL_SLUGS.length; i++) {
      const slug = BORN_DIGITAL_SLUGS[i] as string;
      const subId = `G09${String.fromCharCode(98 + i)}`; // G09b, G09c
      const fx = FIXTURES.find((f) => f.slug === slug);
      if (!fx) continue;
      const r = await invoke(ctx, fx.url);
      const cpp = charsPerPage(r.chars, r.pages);
      results.push({
        id: subId,
        title: `Born-digital baseline: ${slug} (${fx.genre}, ${fx.expectBytes}B)`,
        status: "info",
        detail: r.didSucceed
          ? `extracted ${r.chars} chars from ${r.pages} pages (${cpp ?? "N/A"} chars/page) in ${Math.round(r.wallMs)}ms wall`
          : `extraction failed: ${r.detail}`,
        measurements: {
          instance_size: instanceSize(),
          slug,
          genre: fx.genre,
          source_bytes: fx.expectBytes,
          extracted_chars: r.chars,
          pages: r.pages,
          chars_per_page: cpp ?? "N/A",
          wall_ms: Math.round(r.wallMs),
          ok: String(r.didSucceed),
        },
      });
      if (cpp != null) charsPerPageValues[slug] = cpp;
    }

    // The threshold finding: scanned chars-per-page vs born-digital range.
    const bornDigitalCpps = BORN_DIGITAL_SLUGS
      .map((s) => charsPerPageValues[s])
      .filter((v): v is number => typeof v === "number");
    const bornMin = bornDigitalCpps.length > 0 ? Math.min(...bornDigitalCpps) : null;
    const bornMax = bornDigitalCpps.length > 0 ? Math.max(...bornDigitalCpps) : null;
    const scannedVal = typeof charsPerPageValues[scannedFx.slug] === "number"
      ? (charsPerPageValues[scannedFx.slug] as number)
      : null;

    const thresholdDetail =
      scannedVal != null && bornMin != null
        ? `scanned chars/page=${scannedVal} vs born-digital range [${bornMin}-${bornMax}]. ` +
          `THRESHOLD CANDIDATE: documents below ~${Math.round(bornMin * 0.1)} chars/page are likely scanned/image-only. ` +
          `OCR IS REQUIRED. In-database OCR via plpython3u is ${plpython3uAvailable ? `available@${plpython3uVersion}` : "UNAVAILABLE"} ` +
          `(queried pg_available_extensions). A real pipeline must route documents below this threshold to an external OCR step.` +
          (clMismatch ? ` FIXTURE ANCHOR DRIFT: expectBytes=${scannedFx.expectBytes}, actual Content-Length=${actualContentLength}.` : "")
        : `could not compute threshold: scanned=${scannedVal ?? "N/A"}, born-digital range unavailable. ` +
          `OCR IS REQUIRED for image-only PDFs. In-database OCR via plpython3u is ${plpython3uAvailable ? `available@${plpython3uVersion}` : "UNAVAILABLE"} ` +
          `(queried pg_available_extensions).` +
          (clMismatch ? ` FIXTURE ANCHOR DRIFT: expectBytes=${scannedFx.expectBytes}, actual Content-Length=${actualContentLength}.` : "");

    results.unshift({
      id: "G09",
      title: mod.title,
      status: "info",
      detail: `${deployNote}; ${thresholdDetail}`,
      measurements: {
        instance_size: instanceSize(),
        deploy: deployNote.startsWith("reused") ? "reused" : "deployed",
        scanned_chars_per_page: scannedVal ?? "N/A",
        born_digital_min_chars_per_page: bornMin ?? "N/A",
        born_digital_max_chars_per_page: bornMax ?? "N/A",
        plpython3u_in_catalogue: String(plpython3uAvailable),
        plpython3u_version: plpython3uVersion ?? "N/A",
        scanned_fixture_expect_bytes: scannedFx.expectBytes,
        scanned_fixture_actual_content_length: actualContentLength ?? "N/A",
        fixture_anchor_match: String(!clMismatch),
      },
    });

    return results;
  },
};

export default mod;