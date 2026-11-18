/**
 * DD06 - does the Data API compress responses?
 *
 * Whether the Data API compresses on Accept-Encoding matters for egress, and
 * no module had read its response headers. One table of 2000 rows of repetitive
 * text, read with the service key through fetch with decompression off, so the
 * byte count is what crossed the wire:
 *
 *   DD06a  Accept-Encoding absent, identity, gzip, br, and "gzip, deflate, br":
 *          status, Content-Encoding, Vary, and bytes downloaded
 *   DD06b  the same for a 3-row response, to see whether small bodies are left
 *          uncompressed
 *
 * Runs on the module's shared project (DD99 deletes it).
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { ensureProject, skipWithoutPro, sql } from "../lib/project";

const TABLE = "dd06_text";
const ENCODINGS: Array<[string, string | null]> = [
  ["none", null],
  ["identity", "identity"],
  ["gzip", "gzip"],
  ["br", "br"],
  ["browser", "gzip, deflate, br"],
];

async function fetchRaw(url: string, key: string, accept: string | null): Promise<{ status: number; encoding: string; vary: string; bytes: number }> {
  // Bun-specific: decompress false keeps the body as it crossed the wire, so
  // byteLength is the transfer size; keys stay in headers, never in argv.
  const headers: Record<string, string> = { apikey: key, Authorization: `Bearer ${key}` };
  if (accept !== null) headers["Accept-Encoding"] = accept;
  try {
    const res = await fetch(url, { headers, decompress: false, signal: AbortSignal.timeout(30_000) } as RequestInit);
    const buf = await res.arrayBuffer();
    return {
      status: res.status,
      encoding: res.headers.get("content-encoding") ?? "(none)",
      vary: res.headers.get("vary") ?? "(none)",
      bytes: buf.byteLength,
    };
  } catch {
    return { status: 0, encoding: "error", vary: "", bytes: -1 };
  }
}

const mod: TestModule = {
  id: "DD06",
  title: "Data API response compression by Accept-Encoding",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const skip = skipWithoutPro(ctx, "DD06");
    if (skip) return skip;
    const out: TestResult[] = [];
    const p = await ensureProject(ctx);
    const setup = await sql(ctx, p.ref, `
create table if not exists public.${TABLE} (id int primary key, body text);
truncate public.${TABLE};
insert into public.${TABLE} select g, repeat('supabase lab compression probe ', 8) from generate_series(1, 2000) g;
grant select on public.${TABLE} to service_role;
notify pgrst, 'reload schema';`);
    if (setup.error) return [{ id: "DD06", title: this.title, status: "fail", detail: `setup: ${setup.error}` }];
    const url = (limit: number) => `https://${p.host}/rest/v1/${TABLE}?select=id,body&order=id&limit=${limit}`;
    for (let i = 0; i < 20; i++) {
      if ((await fetchRaw(url(1), p.keys.service, null)).status === 200) break;
      await new Promise((r) => setTimeout(r, 3_000));
    }
    for (const [id, limit] of [["DD06a", 2000], ["DD06b", 3]] as const) {
      const rows: string[] = [];
      const m: Record<string, string | number> = { rows: limit };
      for (const [label, enc] of ENCODINGS) {
        const r = await fetchRaw(url(limit), p.keys.service, enc);
        rows.push(`${label}: ${r.status}, Content-Encoding ${r.encoding}, ${r.bytes} bytes`);
        m[`${label}_status`] = r.status;
        m[`${label}_encoding`] = r.encoding;
        m[`${label}_bytes`] = r.bytes;
        if (label === "gzip") m.vary = r.vary;
      }
      out.push({
        id,
        title: `${limit}-row response, by Accept-Encoding`,
        status: "info",
        detail: `GET /rest/v1/${TABLE}?limit=${limit} with the legacy service_role key, fetch with decompression off. ${rows.join("; ")}. Vary on the gzip request: ${String(m.vary)}.`,
        measurements: m,
      });
    }
    await sql(ctx, p.ref, `drop table if exists public.${TABLE}; notify pgrst, 'reload schema';`);
    return out;
  },
};
export default mod;
