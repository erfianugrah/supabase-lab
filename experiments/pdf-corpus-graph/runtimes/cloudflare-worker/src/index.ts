/**
 * Where does PDF text extraction stop on Cloudflare Workers?
 *
 * The comparison this exists for: the same task on Supabase Edge Functions
 * succeeded at 2504695 B and returned HTTP 546 WORKER_RESOURCE_LIMIT at
 * 3595043 B. Both runtimes are V8 isolates running the same pdf.js build via
 * unpdf, so the difference measured here is the runtime's resource envelope
 * rather than the parser.
 *
 * Reports fetch and extract time separately, because on the Supabase side
 * fetching dominated (9788 ms of an 11601 ms request) and an aggregate number
 * would hide that.
 *
 * Failure modes are distinguished rather than collapsed into "error": a
 * memory eviction, a CPU-time limit and a parser throw are three different
 * findings and only one of them is about size.
 */

interface Probe {
  url: string;
  ok: boolean;
  mode: "ok" | "memory" | "cpu" | "parse" | "fetch";
  source_bytes?: number;
  pages?: number;
  chars?: number;
  fetch_ms?: number;
  extract_ms?: number;
  total_ms?: number;
  error?: string;
}

const UA = "Mozilla/5.0 (compatible; supabase-lab/1.0)";

export default {
  async fetch(req: Request): Promise<Response> {
    const u = new URL(req.url);
    const target = u.searchParams.get("url");

    if (!target) {
      return Response.json(
        { error: "pass ?url=<pdf-url>" },
        { status: 400 },
      );
    }

    const t0 = Date.now();
    const out: Probe = { url: target, ok: false, mode: "fetch" };

    let buf: ArrayBuffer;
    try {
      const res = await fetch(target, { headers: { "User-Agent": UA } });
      if (!res.ok) {
        out.error = `fetch HTTP ${res.status}`;
        return Response.json(out, { status: 200 });
      }
      buf = await res.arrayBuffer();
      out.source_bytes = buf.byteLength;
      out.fetch_ms = Date.now() - t0;
    } catch (e) {
      out.error = `fetch threw: ${String(e).slice(0, 200)}`;
      return Response.json(out, { status: 200 });
    }

    const t1 = Date.now();
    try {
      // Imported lazily so a memory failure is attributable to the parse rather
      // than to module instantiation at isolate startup.
      const { extractText, getDocumentProxy } = await import("unpdf");
      const pdf = await getDocumentProxy(new Uint8Array(buf));
      const { totalPages, text } = await extractText(pdf, { mergePages: true });

      out.ok = true;
      out.mode = "ok";
      out.pages = totalPages;
      out.chars = typeof text === "string" ? text.length : String(text).length;
      out.extract_ms = Date.now() - t1;
      out.total_ms = Date.now() - t0;
      return Response.json(out, { status: 200 });
    } catch (e) {
      const msg = String(e);
      out.extract_ms = Date.now() - t1;
      out.total_ms = Date.now() - t0;
      out.error = msg.slice(0, 300);
      // Classify rather than collapse. A Worker exceeding memory is usually
      // killed without a catchable error, so reaching this branch at all is
      // informative: it means the parser failed inside the envelope.
      out.mode = /memory|allocation|heap/i.test(msg)
        ? "memory"
        : /cpu|time limit|exceeded/i.test(msg)
          ? "cpu"
          : "parse";
      return Response.json(out, { status: 200 });
    }
  },
};
