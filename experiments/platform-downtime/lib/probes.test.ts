import { afterAll, beforeAll, expect, test } from "bun:test";
import net from "node:net";
import { poolerProbe } from "./probes";

/**
 * A fake pooler that completes startup and then answers nothing: what
 * Supavisor looks like while it holds a query for a database that is away.
 * On 2026-10-23 a pooler sample stuck in that state (a `select 1` with no
 * query timeout) pinned its sampler loop for good (#211). Plaintext, because
 * Bun 1.3.14's server-side `new tls.TLSSocket(socket, { isServer: true })`
 * never completed a handshake here; the hang is after TLS anyway.
 */
const msg = (type: string, body: Buffer) => {
  const h = Buffer.alloc(5);
  h.write(type, 0);
  h.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([h, body]);
};

let server: net.Server;
let port = 0;

beforeAll(async () => {
  server = net.createServer((s) => {
    s.on("error", () => {});
    let started = false;
    s.on("data", () => {
      if (started) return; // hold every query
      started = true;
      s.write(Buffer.concat([msg("R", Buffer.from([0, 0, 0, 0])), msg("Z", Buffer.from("I"))]));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as net.AddressInfo).port;
});

afterAll(() => server?.close());

test("a pooler that holds the query makes the probe fail at its timeout instead of hanging", async () => {
  const t0 = Date.now();
  const out = await Promise.race([
    poolerProbe("127.0.0.1", port, "u", "p", false).run(),
    Bun.sleep(15_000).then(() => ({ ok: false, error: "STILL PENDING" })),
  ]);
  expect(out).toEqual({ ok: false, error: "Query read timeout" });
  expect(Date.now() - t0).toBeLessThan(10_000);
}, 20_000);
