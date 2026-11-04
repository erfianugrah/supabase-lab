import { describe, expect, test } from "bun:test";
import { burst, classify, clientLimited, coloOf, errorTimeline, firstBodies, histogram, openLoop, pct, rpcStatus, summarise, type Answer, type LoadRun, type Shot } from "./load";

// Verbatim bodies from published artifacts: edge-function-limits
// out/2026-09-02 (EF10, EF07) and data-api-capacity out/2026-10-23 (DC08).
const RLE = '{"code":"RATE_LIMIT_EXCEEDED","message":"Too many requests. Re-try the request in 1 seconds."}';
const BOOT = '{"code":"BOOT_ERROR","message":"Function failed to start (please check logs)"}';
const WRL = '{"code":"WORKER_RESOURCE_LIMIT","message":"Function failed due to not having enough compute resources (please check logs)"}';
const json = "application/json";

describe("classify", () => {
  test("platform codes keep status and code", () => {
    expect(classify({ status: 429, contentType: json, text: RLE })).toBe("429_RATE_LIMIT_EXCEEDED");
    expect(classify({ status: 503, contentType: json, text: BOOT })).toBe("503_BOOT_ERROR");
    expect(classify({ status: 546, contentType: json, text: WRL })).toBe("546_WORKER_RESOURCE_LIMIT");
  });
  test("a 429 without the code is not counted as RATE_LIMIT_EXCEEDED", () => {
    expect(classify({ status: 429, contentType: "text/plain", text: "slow down" })).toBe("429_other");
  });
  test("empty 503 (seen in DC08) and Cloudflare HTML", () => {
    expect(classify({ status: 503, contentType: "", text: "" })).toBe("503_empty");
    expect(classify({ status: 403, contentType: "text/html; charset=UTF-8", text: "<!DOCTYPE html><html>" })).toBe("html_403");
    expect(classify({ status: 502, contentType: "", text: "  <html><body>bad gateway" })).toBe("html_502");
  });
  test("200 is ok whatever the body", () => {
    expect(classify({ status: 200, contentType: json, text: '{"rpc":500}' })).toBe("ok");
  });
  test("client-side failures", () => {
    expect(classify({ status: 0, contentType: "", text: "", err: "Network is unreachable (os error 51)" })).toBe("client_unreachable");
    expect(classify({ status: 0, contentType: "", text: "", err: "The operation timed out." })).toBe("client_timeout");
    expect(classify({ status: 0, contentType: "", text: "", err: "The socket connection was closed unexpectedly." })).toBe("client_socket");
    expect(classify({ status: 0, contentType: "", text: "", err: "something else" })).toBe("client_other");
  });
});

test("rpcStatus and coloOf", () => {
  expect(rpcStatus('{"ok":true,"rpc":200,"rpc_ms":4}')).toBe("200");
  expect(rpcStatus('{"ok":false,"rpc":null}')).toBe("null");
  expect(rpcStatus('{"ok":true}')).toBe("");
  expect(coloOf("8f1c2a3b4c5d6e7f-SIN")).toBe("SIN");
  expect(coloOf(null)).toBe("");
});

test("pct and histogram", () => {
  expect(pct([], 0.5)).toBe(-1);
  expect(pct([5, 1, 3, 2, 4], 0.5)).toBe(3);
  expect(pct([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.99)).toBe(10);
  expect(histogram(["200", "429", "200", ""])).toBe("200:2|-:1|429:1");
});

const shot = (p: Partial<Shot>): Shot => ({ schedMs: 0, sendMs: 0, ms: 10, status: 200, cls: "ok", region: "ap-northeast-1", colo: "SIN", body: "", rpc: "", ...p });

test("errorTimeline buckets non-ok by send second", () => {
  const sh = [shot({ sendMs: 1000 }), shot({ sendMs: 3000, cls: "429_RATE_LIMIT_EXCEEDED" }), shot({ sendMs: 12_000, cls: "503_BOOT_ERROR" }), shot({ sendMs: 14_000, cls: "503_BOOT_ERROR" })];
  expect(errorTimeline(sh)).toBe("0:1|10:2");
  expect(errorTimeline([shot({})])).toBe("none");
});

test("firstBodies keeps one body per class, scrubbed", () => {
  const sh = [shot({ cls: "429_RATE_LIMIT_EXCEEDED", body: RLE }), shot({ cls: "429_RATE_LIMIT_EXCEEDED", body: "second" }), shot({ cls: "503_empty", body: "" })];
  expect(firstBodies(sh, (s) => s.replace("Too many", "TOO MANY"))).toBe(`429_RATE_LIMIT_EXCEEDED => ${RLE.replace("Too many", "TOO MANY")}\n503_empty => (empty)`);
});

describe("clientLimited", () => {
  const run = (shots: Shot[], extra: Partial<LoadRun> = {}): LoadRun => ({ shots, scheduled: shots.length, skipped: 0, maxInFlightSeen: 1, wallMs: 1000, monoMs: 1000, ...extra });
  const onTime = Array.from({ length: 101 }, (_, i) => shot({ schedMs: i * 10, sendMs: i * 10 + 1 }));
  test("on schedule is not limited", () => {
    expect(clientLimited(run(onTime), 100)).toEqual({ limited: false, reason: "none" });
  });
  test("skips, slow sends, lag and a host pause each flag the step", () => {
    expect(clientLimited(run(onTime, { skipped: 3 }), 100).reason).toContain("3 skipped");
    const slow = Array.from({ length: 101 }, (_, i) => shot({ schedMs: i * 10, sendMs: i * 20 }));
    const r = clientLimited(run(slow), 100);
    expect(r.limited).toBe(true);
    expect(r.reason).toContain("achieved");
    expect(r.reason).toContain("p99 send lag");
    expect(clientLimited(run(onTime, { wallMs: 9000, monoMs: 1000 }), 100).reason).toContain("host paused 8 s");
  });
  test("requests without an HTTP answer flag a burst too (rate 0)", () => {
    const r = clientLimited(run([shot({}), shot({ status: 0, cls: "client_other" }), shot({ status: 0, cls: "client_socket" })]), 0);
    expect(r).toEqual({ limited: true, reason: "2 without an HTTP answer" });
  });
});

test("summarise counts RATE_LIMIT_EXCEEDED and error share", () => {
  const sh = [shot({ sendMs: 0 }), shot({ sendMs: 500, status: 429, cls: "429_RATE_LIMIT_EXCEEDED", body: RLE }), shot({ sendMs: 1000, status: 0, cls: "client_timeout" }), shot({ sendMs: 1500, rpc: "200" })];
  const s = summarise({ shots: sh, scheduled: 4, skipped: 0, maxInFlightSeen: 2, wallMs: 1600, monoMs: 1600 }, 0, 100);
  expect(s.rle).toBe(1);
  expect(s.errorShare).toBe(0.5);
  expect(s.measurements.rate_limit_exceeded).toBe(1);
  expect(s.measurements.rle_first_send_s).toBe(0.5);
  expect(s.measurements.status_histogram).toBe("200:2|0:1|429:1");
  expect(s.measurements.rpc_histogram).toBe("200:1");
  expect(s.measurements.send_lag_p99_ms).toBe(-1);
});

const fake =
  (ms: number, a: Partial<Answer> = {}) =>
  async (): Promise<Answer> => {
    await Bun.sleep(ms);
    return { status: 200, contentType: json, text: "{}", region: "ap-northeast-1", colo: "SIN", ...a };
  };

test("openLoop keeps the schedule against a fast target", async () => {
  const r = await openLoop({ rate: 200, durationMs: 1000, maxInFlight: 50, fire: fake(20) });
  expect(r.scheduled).toBe(200);
  expect(r.shots.length).toBe(200);
  expect(r.skipped).toBe(0);
  expect(clientLimited(r, 200).limited).toBe(false);
});

test("openLoop skips at the in-flight cap instead of queueing", async () => {
  const r = await openLoop({ rate: 200, durationMs: 500, maxInFlight: 5, fire: fake(200) });
  expect(r.scheduled).toBe(100);
  expect(r.skipped).toBeGreaterThan(50);
  expect(r.shots.length + r.skipped).toBe(100);
  expect(r.maxInFlightSeen).toBe(5);
  expect(clientLimited(r, 200).limited).toBe(true);
});

test("burst sends n through at most maxInFlight lanes", async () => {
  const r = await burst({ n: 30, maxInFlight: 10, fire: fake(10) });
  expect(r.shots.length).toBe(30);
  expect(r.maxInFlightSeen).toBe(10);
});
