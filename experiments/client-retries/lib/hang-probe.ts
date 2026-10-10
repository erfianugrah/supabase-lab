/**
 * Standalone: one default supabase-js GET against a URL that accepts the
 * request and never answers. Prints one JSON line when the call settles or
 * `maxMs` passes, whichever is first. Run under `bun` and under `node` by CR04.
 *
 *   bun hang-probe.ts <url> <maxMs>
 */
import { createClient } from "@supabase/supabase-js";

const url = process.argv[2] ?? "";
const maxMs = Number(process.argv[3] ?? 330_000);
const runtime = typeof (globalThis as { Bun?: { version: string } }).Bun !== "undefined" ? `bun ${(globalThis as unknown as { Bun: { version: string } }).Bun.version}` : `node ${process.version}`;
const t0 = performance.now();

const client = createClient(url, "anon", { auth: { persistSession: false, autoRefreshToken: false } });
const call = client
  .from("t")
  .select("*")
  .then(
    (r) => ({ settled: true, status: r.status, error: r.error ? `${r.error.name}: ${r.error.message}`.slice(0, 160) : "" }),
    (e: unknown) => ({ settled: true, status: -1, error: `threw ${String(e)}`.slice(0, 160) }),
  );
const cap = new Promise<{ settled: false; status: number; error: string }>((r) => setTimeout(() => r({ settled: false, status: 0, error: "" }), maxMs));
const out = await Promise.race([call, cap]);
console.log(JSON.stringify({ runtime, maxMs, ...out, elapsedMs: Math.round(performance.now() - t0) }));
process.exit(0);
