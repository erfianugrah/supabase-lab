import { afterAll, beforeAll, expect, test } from "bun:test";
import { always, firstN, retryCounts, startFaultProxy, type FaultProxy } from "./faultproxy";

let up: ReturnType<typeof Bun.serve>;
let proxy: FaultProxy;

beforeAll(async () => {
  up = Bun.serve({
    port: 0,
    fetch: (req) => new Response(JSON.stringify({ path: new URL(req.url).pathname, method: req.method }), { headers: { "content-type": "application/json" } }),
  });
  proxy = await startFaultProxy(`http://127.0.0.1:${up.port}`);
});
afterAll(async () => {
  await proxy.stop();
  up.stop(true);
});

test("pass forwards and logs", async () => {
  proxy.reset();
  const r = await fetch(`${proxy.url}/rest/v1/t`, { headers: { "x-retry-count": "2" } });
  expect(r.status).toBe(200);
  expect(((await r.json()) as { path: string }).path).toBe("/rest/v1/t");
  expect(proxy.seen[0]?.retryCount).toBe("2");
  expect(proxy.seen[0]?.upstreamStatus).toBe(200);
});

test("firstN answers synthetic status then passes; only governed paths advance k", async () => {
  proxy.reset();
  proxy.setScript(firstN(2, { kind: "status", status: 520 }));
  const a = await fetch(`${proxy.url}/auth/v1/health`);
  const b = await fetch(`${proxy.url}/rest/v1/t`);
  const c = await fetch(`${proxy.url}/rest/v1/t`);
  const d = await fetch(`${proxy.url}/rest/v1/t`);
  expect([a.status, b.status, c.status, d.status]).toEqual([200, 520, 520, 200]);
  expect(proxy.governed().length).toBe(3);
  expect(retryCounts(proxy.seen)).toBe("-,-,-,-");
});

test("reset destroys the connection; hang is flagged clientAborted when the client gives up", async () => {
  proxy.reset();
  proxy.setScript(always({ kind: "reset" }));
  await expect(fetch(`${proxy.url}/rest/v1/t`)).rejects.toBeDefined();
  proxy.setScript(always({ kind: "hang" }));
  const t = Date.now();
  await expect(fetch(`${proxy.url}/rest/v1/t`, { signal: AbortSignal.timeout(300) })).rejects.toBeDefined();
  expect(Date.now() - t).toBeLessThan(2000);
  await Bun.sleep(300);
  expect(proxy.seen.at(-1)?.clientAborted).toBe(true);
  proxy.setScript(() => ({ kind: "pass" }));
});
