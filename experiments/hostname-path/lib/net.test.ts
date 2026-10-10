import { expect, test } from "bun:test";
import { missingTool, parseDig, parseDoh, pct, phasesFrom } from "./net";

test("parseDig reads rcode, flags, answers and query time", () => {
  const out = `;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 1
;; flags: qr rd ra ad; QUERY: 1, ANSWER: 2, AUTHORITY: 0, ADDITIONAL: 1

x.example.test.   60  IN  CNAME  y.example.test.
y.example.test.   300 IN  A      192.0.2.1

;; Query time: 23 msec
`;
  const r = parseDig(out);
  expect(r.rcode).toBe("NOERROR");
  expect(r.flags).toEqual(["qr", "rd", "ra", "ad"]);
  expect(r.answers.map((a) => a.type)).toEqual(["CNAME", "A"]);
  expect(r.answers[1]?.ttl).toBe(300);
  expect(r.queryMs).toBe(23);
});

test("parseDig on silence is NO-REPLY", () => {
  expect(parseDig("").rcode).toBe("NO-REPLY");
});

test("parseDoh maps types and flags", () => {
  const r = parseDoh(200, JSON.stringify({ Status: 0, AD: false, Answer: [{ name: "a.", type: 5, TTL: 60, data: "b." }, { name: "b.", type: 1, TTL: 30, data: "192.0.2.2" }] }));
  expect(r.rcode).toBe(0);
  expect(r.answers.map((a) => a.type)).toEqual(["CNAME", "A"]);
  expect(parseDoh(200, "<html>").error).toBeDefined();
});

test("phasesFrom converts cumulative seconds to per-phase milliseconds", () => {
  const p = phasesFrom("200\t0.010\t0.030\t0.070\t0.120\t0.125\t192.0.2.3\t8abc-SIN");
  expect(p.dnsMs).toBeCloseTo(10);
  expect(p.tcpMs).toBeCloseTo(20);
  expect(p.tlsMs).toBeCloseTo(40);
  expect(p.ttfbMs).toBeCloseTo(50);
  expect(p.colo).toBe("SIN");
});

test("pct picks a rank", () => {
  expect(pct([5, 1, 3, 2, 4], 0.5)).toBe(3);
  expect(pct([], 0.5)).toBeNaN();
});

test("missingTool names the first absent binary, null when all present", () => {
  expect(missingTool("sh")).toBeNull();
  expect(missingTool("sh", "hp-no-such-tool-xyz")).toBe("hp-no-such-tool-xyz");
});
