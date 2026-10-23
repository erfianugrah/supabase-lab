/**
 * #211: the 2026-10-23 "silent run" in miniature, all local. A healthy HTTP
 * probe and a pg probe whose 4th connection a fake pooler holds (startup
 * completes, the query is never answered), sampled for 6 s.
 *
 *   git show 1e4cb33:harness/src/sampler.ts > /tmp/sampler-precap.ts
 *   bun harness/scripts/repro-pinned-loop.ts /tmp/sampler-precap.ts      # never returns
 *   bun harness/scripts/repro-pinned-loop.ts harness/src/sampler.ts       # returns at ~7 s
 *   bun harness/scripts/repro-pinned-loop.ts harness/src/sampler.ts 2000  # + pg query_timeout
 *
 * With the pre-cap sampler the process stays alive at 0 % CPU, main thread in
 * kevent64 (`sample <pid>`), printing nothing: the pooler loop awaits a query
 * that never settles and `sampleDuring` awaits every loop.
 */
import net from "node:net";
import { Client } from "pg";
import { resolve } from "node:path";
const which = process.argv[2] ?? "harness/src/sampler.ts";
const qt = Number(process.argv[3] ?? 0);
const { sampleDuring } = await import(resolve(which));
const msg = (type: string, body: Buffer) => { const h = Buffer.alloc(5); h.write(type, 0); h.writeInt32BE(body.length + 4, 1); return Buffer.concat([h, body]); };
let n = 0;
const pooler = net.createServer((s) => {
  n += 1; const conn = n; let started = false;
  s.on("data", (d) => {
    if (!started) { started = true; return void s.write(Buffer.concat([msg("R", Buffer.from([0, 0, 0, 0])), msg("Z", Buffer.from("I"))])); }
    // Simple query 'Q': answer the first 3 connections, then hold every query (database away).
    if (d[0] === 0x51 && conn <= 3) s.write(Buffer.concat([msg("C", Buffer.from("SELECT 1\0")), msg("Z", Buffer.from("I"))]));
  });
});
await new Promise<void>((r) => pooler.listen(0, "127.0.0.1", () => r()));
const port = (pooler.address() as net.AddressInfo).port;
const web = Bun.serve({ port: 0, fetch: () => new Response("ok") });
const probes = [
  { name: "rest_http", async run() { try { const r = await fetch(`http://127.0.0.1:${web.port}/`, { signal: AbortSignal.timeout(5000) }); await r.text(); return { ok: r.ok }; } catch (e: any) { return { ok: false, error: e.message }; } } },
  { name: "pooler", async run() {
      const c = new Client({ host: "127.0.0.1", port, user: "u", database: "d", password: "p", connectionTimeoutMillis: 5000, ...(qt ? { query_timeout: qt } : {}) });
      try { await c.connect(); await c.query("select 1"); return { ok: true }; }
      catch (e: any) { return { ok: false, error: e.message }; }
      finally { await c.end().catch(() => {}); } } },
];
console.log(`pid ${process.pid} sampler=${which} query_timeout=${qt || "unset"}`);
const t0 = Date.now();
const ws = await sampleDuring(probes, { intervalMs: 200, maxWaitMs: 6000, settleMs: 1000, sampleDeadlineMs: 3000, log: (m: string) => console.log(`  ${m}`) }, async () => {});
console.log(`returned after ${Date.now() - t0} ms: ` + ws.map((w: any) => `${w.name} samples=${w.samples} failures=${w.failures} modes=${JSON.stringify(w.modes)}`).join(" | "));
web.stop(true); pooler.close();
process.exit(0);
