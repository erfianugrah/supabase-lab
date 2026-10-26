import { describe, expect, test } from "bun:test";
import { errorSpan, headerNames, parseRawHttp, rywSummary, seqStats } from "./rr04";

describe("parseRawHttp", () => {
  test("a HEAD answer with a declared length and no body bytes", () => {
    const r = parseRawHttp(Buffer.from("HTTP/1.1 400 Bad Request\r\nContent-Type: text/plain\r\nContent-Length: 71\r\nServer: cloudflare\r\n\r\n"));
    expect(r.status).toBe(400);
    expect(r.statusLine).toBe("HTTP/1.1 400 Bad Request");
    expect(r.headers).toEqual([
      ["content-type", "text/plain"],
      ["content-length", "71"],
      ["server", "cloudflare"],
    ]);
    expect(r.body.length).toBe(0);
  });
  test("a chunked GET body is de-chunked", () => {
    const raw = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n";
    const r = parseRawHttp(Buffer.from(raw));
    expect(r.status).toBe(200);
    expect(r.body.toString()).toBe("hello world");
  });
  test("a body with content-length is kept as sent", () => {
    const r = parseRawHttp(Buffer.from("HTTP/1.1 400 Bad Request\r\nContent-Length: 3\r\n\r\nabc"));
    expect(r.body.toString()).toBe("abc");
  });
  test("no header terminator: status 0, raw kept for evidence", () => {
    const r = parseRawHttp(Buffer.from("garbage"));
    expect(r.status).toBe(0);
    expect(r.statusLine).toBe("garbage");
  });
});

describe("headerNames", () => {
  test("lowercased, sorted, unique", () => {
    expect(headerNames([["B", "1"], ["a", "2"], ["b", "3"]])).toEqual(["a", "b"]);
  });
});

describe("seqStats", () => {
  test("strict alternation switches at every transition", () => {
    expect(seqStats("RPRP")).toEqual({ switches: 3, max_run: 1 });
  });
  test("sticky", () => {
    expect(seqStats("RRRRP")).toEqual({ switches: 1, max_run: 4 });
  });
  test("empty", () => {
    expect(seqStats("")).toEqual({ switches: 0, max_run: 0 });
  });
});

describe("errorSpan", () => {
  const ticks = [
    { t: 0, src: "primary", status: 200, node: "primary" as const },
    { t: 1000, src: "primary", status: 0, err: "fetch failed" },
    { t: 2000, src: "replica", status: 200, node: "replica" as const },
    { t: 3000, src: "primary", status: 503, err: "HTTP 503" },
    { t: 4000, src: "primary", status: 200, node: "primary" as const },
  ];
  test("first and last failing tick of one source", () => {
    expect(errorSpan(ticks, "primary")).toEqual({ from: 1000, to: 3000, errors: 2 });
  });
  test("a source with no failure", () => {
    expect(errorSpan(ticks, "replica")).toBeNull();
  });
});

describe("rywSummary", () => {
  test("counts stale reads only where the replica served and did not see the row", () => {
    const s = rywSummary([
      { node: "replica", seen: true, postMs: 20, getMs: 18 },
      { node: "replica", seen: false, postMs: 21, getMs: 19, untilSeenMs: 4, retries: 1 },
      { node: "primary", seen: true, postMs: 22, getMs: 20 },
      { err: "HTTP 503", postMs: 22, getMs: 20 },
    ]);
    expect(s).toMatchObject({ n: 4, replica: 2, primary: 1, errors: 1, stale: 1, stale_of_replica_reads: "1 of 2", primary_unseen: 0, until_seen_max_ms: 4 });
  });
});
