/**
 * activateWithRetry is HS04's answer to the 2026-10-06 activate 400 (refused
 * right after verification, accepted by hand about ten minutes later). The
 * live re-run got 201 first time, so the retry branch has only ever run here.
 */
import { describe, expect, test } from "bun:test";
import { activateWithRetry } from "./activate";

function scripted(statuses: number[]) {
  let i = 0;
  const calls: number[] = [];
  return {
    calls,
    call: async () => {
      const status = statuses[Math.min(i, statuses.length - 1)] ?? 0;
      i++;
      calls.push(status);
      return { status, text: status >= 300 ? `{"message":"refused ${i}"}` : "{}" };
    },
  };
}

describe("activateWithRetry", () => {
  test("first call accepted: one attempt, no wait", async () => {
    const s = scripted([201]);
    const waits: number[] = [];
    const out = await activateWithRetry(s.call, async (ms) => void waits.push(ms));
    expect(out).toEqual({ first: "HTTP 201", attempts: 1, lastStatus: 201 });
    expect(waits).toEqual([]);
  });

  test("400, 400, 201: retries until accepted and keeps the first refusal's body", async () => {
    const s = scripted([400, 400, 201]);
    const waits: number[] = [];
    const out = await activateWithRetry(s.call, async (ms) => void waits.push(ms), { retries: 15, waitMs: 40_000 });
    expect(out.attempts).toBe(3);
    expect(out.lastStatus).toBe(201);
    expect(out.first).toBe('HTTP 400 {"message":"refused 1"}');
    expect(waits).toEqual([40_000, 40_000]);
  });

  test("never accepted: stops after the retry budget and reports the last refusal", async () => {
    const s = scripted([400]);
    const out = await activateWithRetry(s.call, async () => {}, { retries: 3, waitMs: 1 });
    expect(out.attempts).toBe(4);
    expect(out.lastStatus).toBe(400);
  });
});
