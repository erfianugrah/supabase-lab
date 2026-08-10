/**
 * G02 - PDF text extraction inside a Supabase Edge Function.
 *
 * This is the CUSTOMER-OWNED extraction step under test (PDF -> text). The
 * platform ships no PDF product; this is what a customer would actually
 * deploy. Deployed and invoked by
 * ../../tests/g02-edge-function-pdf-extraction.ts, which walks the fixture
 * corpus by size and records where this stops working.
 *
 * `npm:unpdf` wraps a serverless build of Mozilla's pdf.js with no native
 * dependencies, and is documented (supabase.com/docs/guides/functions/import-maps)
 * as importable via the `npm:` specifier directly in an Edge Function, no
 * `deno.json` required. Pinned to 1.8.0 (the version on the npm registry at
 * authoring time) so a redeploy is reproducible rather than picking up a new
 * major silently.
 *
 * Every failure path returns structured JSON with a `stage`, so the caller
 * can tell "the fetch of the fixture failed" from "extraction itself failed"
 * from "the isolate never got a chance to answer" (that last one shows up to
 * the caller as something other than this function's own JSON contract -
 * a non-2xx with no matching body, a connection reset, or a client-side
 * timeout - which is the actual ceiling this experiment is looking for).
 */
import { extractText, getDocumentProxy } from "npm:unpdf@1.8.0";

const UA = "Mozilla/5.0 (compatible; supabase-lab/1.0)";

Deno.serve(async (req: Request) => {
  const t0 = performance.now();

  let url: string | null = null;
  if (req.method === "POST") {
    const body = await req.json().catch(() => ({}) as Record<string, unknown>);
    url = typeof body.url === "string" ? body.url : null;
  } else {
    url = new URL(req.url).searchParams.get("url");
  }

  if (!url) {
    return Response.json({ ok: false, stage: "input", error: "missing url" }, { status: 400 });
  }

  const tFetch0 = performance.now();
  let bytes: Uint8Array;
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) {
      return Response.json(
        { ok: false, stage: "fetch", error: `upstream HTTP ${res.status}` },
        { status: 502 },
      );
    }
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    return Response.json(
      { ok: false, stage: "fetch", error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
  const fetchMs = performance.now() - tFetch0;

  const tExtract0 = performance.now();
  try {
    const pdf = await getDocumentProxy(bytes);
    const { totalPages, text } = await extractText(pdf, { mergePages: true });
    const extractMs = performance.now() - tExtract0;
    return Response.json({
      ok: true,
      sourceBytes: bytes.length,
      extractedChars: text.length,
      pages: totalPages,
      fetchMs: Math.round(fetchMs),
      extractMs: Math.round(extractMs),
      totalMs: Math.round(performance.now() - t0),
    });
  } catch (e) {
    return Response.json(
      {
        ok: false,
        stage: "extract",
        error: e instanceof Error ? e.message : String(e),
        sourceBytes: bytes.length,
        fetchMs: Math.round(fetchMs),
      },
      { status: 500 },
    );
  }
});
