/**
 * Offline checks of the connection-fault proxy against a local stand-in
 * upstream: the parser, that reset-before never reaches upstream, that
 * reset-after does, that the reset is an RST (curl exit 56) and close-before a
 * FIN (curl exit 52), and that a passthrough relays the body over keep-alive.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { parseRequest, refusedUrl, startConnProxy, startTlsTrap } from "./connfault";

let upstreamHits = 0;
const upstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (req) => {
    upstreamHits++;
    const body = req.method === "POST" ? await req.text() : "";
    return Response.json({ ref: "stand-in", echo: body.length }, { status: req.method === "POST" ? 201 : 200 });
  },
});
const px = startConnProxy(`http://127.0.0.1:${upstream.port}`);

async function curl(url: string, extra: string[] = []): Promise<{ code: number; err: string; out: string }> {
  const p = Bun.spawn(["curl", "-sS", "-m", "5", ...extra, url], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, err, out };
}

beforeAll(() => {
  upstreamHits = 0;
});
afterAll(() => {
  px.stop();
  upstream.stop(true);
});

describe("parseRequest", () => {
  test("needs the whole body before it returns", () => {
    const head = "POST /v1/projects HTTP/1.1\r\nHost: x\r\nContent-Length: 4\r\n\r\n";
    expect(parseRequest(Buffer.from(head + "ab"))).toBeNull();
    const r = parseRequest(Buffer.from(head + "abcdGET"));
    expect(r && !("error" in r) ? [r.method, r.path, r.body.toString(), r.used] : null).toEqual(["POST", "/v1/projects", "abcd", head.length + 4]);
  });
  test("refuses a chunked body", () => {
    expect(parseRequest(Buffer.from("POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n"))).toEqual({ error: "chunked request body" });
  });
});

describe("startConnProxy", () => {
  test("pass relays status and body, two requests on one connection", async () => {
    px.reset();
    const r = await curl(`${px.url}/v1/projects`, ["-w", "%{http_code}\\n", "-o", "/dev/null", "-o", "/dev/null", `${px.url}/v1/projects`]);
    expect(r.code).toBe(0);
    expect(r.out.trim().split("\n")).toEqual(["200", "200"]);
    expect(px.conns()).toBe(1);
    expect(px.log().length).toBe(2);
  });
  test("reset-before is an RST and never reaches upstream", async () => {
    px.reset();
    const before = upstreamHits;
    px.setRules([{ id: "rb", method: "POST", path: "^/v1/projects$", mode: "reset-before" }]);
    const r = await curl(`${px.url}/v1/projects`, ["-X", "POST", "-d", "{}"]);
    expect(r.code).toBe(56);
    expect(r.err).toContain("reset by peer");
    expect(upstreamHits).toBe(before);
    expect(px.log()[0]?.action).toBe("reset-before");
  });
  test("close-before is a clean close (empty reply)", async () => {
    px.reset();
    px.setRules([{ id: "cb", method: "POST", path: "^/v1/projects$", mode: "close-before" }]);
    const r = await curl(`${px.url}/v1/projects`, ["-X", "POST", "-d", "{}"]);
    expect(r.code).toBe(52);
  });
  test("reset-after reaches upstream, records its answer, then resets", async () => {
    px.reset();
    const before = upstreamHits;
    px.setRules([{ id: "ra", method: "POST", path: "^/v1/projects$", mode: "reset-after", times: 1 }]);
    const r = await curl(`${px.url}/v1/projects`, ["-X", "POST", "-d", "{}"]);
    expect(r.code).toBe(56);
    expect(upstreamHits).toBe(before + 1);
    const row = px.log()[0]!;
    expect([row.action, row.upstreamStatus, row.upstreamRef]).toEqual(["reset-after", 201, "stand-in"]);
    // budget spent: the next POST passes
    const r2 = await curl(`${px.url}/v1/projects`, ["-X", "POST", "-d", "{}", "-w", "%{http_code}", "-o", "/dev/null"]);
    expect(r2.out).toBe("201");
  });
});

describe("refused and TLS", () => {
  test("refusedUrl has nothing listening", async () => {
    const r = await curl(`${refusedUrl()}/v1/projects`);
    expect(r.code).toBe(7);
  });
  test("the TLS trap fails verification before any request byte", async () => {
    const trap = startTlsTrap();
    try {
      const r = await curl(`${trap.url}/v1/projects`);
      expect(r.code).toBe(60);
      const c = trap.counts();
      expect(c.conns).toBe(1);
      expect(c.dataEvents).toBe(0);
      expect(c.handshakeOk).toBe(0);
    } finally {
      trap.stop();
    }
  });
});
