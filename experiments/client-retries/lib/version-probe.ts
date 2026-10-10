/**
 * Standalone probe, copied next to an installed `@supabase/supabase-js` by
 * CR03 and run under `bun` and under `node` (type stripping): it uses only
 * node:http and the package under test, so the same file answers "what does
 * THIS version do on THIS runtime" with no project involved.
 *
 * Prints one JSON line: { version, runtime, cases: { name: { attempts, wire,
 * rc, elapsedMs, status, code } } }. `attempts` counts distinct X-Retry-Count
 * values (absent = 0); `wire` counts requests that reached the mock.
 */
import { createServer } from "node:http";
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

type Mode = "503" | "525" | "reset";
interface Case {
  name: string;
  mode: Mode;
  run: (url: string) => PromiseLike<{ error: { code?: string; message?: string } | null; status: number }>;
}

const key = "anon";
const mk = (url: string, db: Record<string, unknown> = {}) =>
  createClient(url, key, { db: db as never, auth: { persistSession: false, autoRefreshToken: false } });

const cases: Case[] = [
  { name: "get_503", mode: "503", run: (u) => mk(u).from("t").select("*") },
  { name: "get_525", mode: "525", run: (u) => mk(u).from("t").select("*") },
  { name: "get_reset", mode: "reset", run: (u) => mk(u).from("t").select("*") },
  { name: "post_503", mode: "503", run: (u) => mk(u).from("t").insert({ a: 1 }) },
  { name: "post_reset", mode: "reset", run: (u) => mk(u).from("t").insert({ a: 1 }) },
  {
    name: "get_503_retry_false_method",
    mode: "503",
    run: async (u) => {
      const b = mk(u).from("t").select("*") as unknown as { retry?: (v: boolean) => unknown };
      if (typeof b.retry === "function") b.retry(false);
      return (await (b as unknown as PromiseLike<{ error: { code?: string; message?: string } | null; status: number }>));
    },
  },
  {
    // The signal the supabase docs recommend: created inline, nothing else holds a listener.
    name: "get_503_abort_timeout_2500",
    mode: "503",
    run: (u) => mk(u).from("t").select("*").abortSignal(AbortSignal.timeout(2500)),
  },
  {
    name: "get_503_abort_controller_2500",
    mode: "503",
    run: (u) => {
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 2500);
      return mk(u).from("t").select("*").abortSignal(ac.signal);
    },
  },
  { name: "get_503_db_retry_false", mode: "503", run: (u) => mk(u, { retry: false }).from("t").select("*") },
  { name: "get_503_db_retryEnabled_false", mode: "503", run: (u) => mk(u, { retryEnabled: false }).from("t").select("*") },
];

async function runCase(c: Case) {
  const seen: (string | undefined)[] = [];
  const server = createServer((req, res) => {
    seen.push(req.headers["x-retry-count"] as string | undefined);
    req.resume();
    if (c.mode === "reset") return void req.socket.destroy();
    res.writeHead(c.mode === "503" ? 503 : 525, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: "PGRST002", message: "mock" }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const t0 = performance.now();
  let status = -1;
  let code = "";
  try {
    const r = await c.run(`http://127.0.0.1:${port}`);
    status = r.status;
    code = r.error?.code ?? (r.error ? "error" : "");
  } catch (e) {
    code = `threw ${(e as Error).name}`;
  }
  const elapsedMs = Math.round(performance.now() - t0);
  server.closeAllConnections();
  server.close();
  return {
    name: c.name,
    attempts: new Set(seen.map((s) => s ?? "0")).size,
    wire: seen.length,
    rc: seen.map((s) => s ?? "-").join(","),
    elapsedMs,
    status,
    code,
  };
}

const pkg = JSON.parse(readFileSync(new URL("./node_modules/@supabase/supabase-js/package.json", import.meta.url), "utf8")) as { version: string };
const rows = await Promise.all(cases.map(runCase));
const runtime = typeof (globalThis as { Bun?: { version: string } }).Bun !== "undefined" ? `bun ${(globalThis as unknown as { Bun: { version: string } }).Bun.version}` : `node ${process.version}`;
const hasRetryMethod = typeof (mk("http://127.0.0.1:1").from("t").select("*") as unknown as { retry?: unknown }).retry === "function";
console.log(JSON.stringify({ version: pkg.version, runtime, hasRetryMethod, cases: Object.fromEntries(rows.map((r) => [r.name, r])) }));
process.exit(0);
