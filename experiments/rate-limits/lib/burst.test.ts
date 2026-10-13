import { describe, expect, test } from "bun:test";
import { bodyClass, SHAPES, summariseCell, type Sample } from "./burst";

const s = (n: number, status: number, extra: Partial<Sample> = {}): Sample => ({
  n,
  status,
  contentType: "application/json",
  retryAfter: "",
  rateLimitRemaining: "",
  body: "",
  ...extra,
});

describe("bodyClass", () => {
  test("the API's own throttler (L01c's body)", () => {
    expect(bodyClass("application/json", '{"message":"ThrottlerException: Too Many Requests"}')).toBe("json-throttler");
  });

  test("an HTML page, by header or by body shape", () => {
    expect(bodyClass("text/html; charset=UTF-8", "<!DOCTYPE html><html>...")).toBe("html");
    expect(bodyClass("application/json", "<html><body>nope</body></html>")).toBe("html");
  });

  test("other JSON, plain text and an empty body", () => {
    expect(bodyClass("application/json", '{"message":"Unauthorized"}')).toBe("json-other");
    expect(bodyClass("text/plain", "Internal Server Error")).toBe("text");
    expect(bodyClass(null, "  ")).toBe("empty");
  });
});

describe("summariseCell", () => {
  test("a serial burst that hits the JSON throttler at request 118", () => {
    const samples = [
      ...Array.from({ length: 117 }, (_, i) => s(i + 1, 200, { rateLimitRemaining: i === 0 ? "119" : "" })),
      s(118, 429, { retryAfter: "60", body: '{"message":"ThrottlerException: Too Many Requests"}' }),
    ];
    const c = summariseCell(samples);
    expect(c.requests_sent).toBe(118);
    expect(c.ok_2xx).toBe(117);
    expect(c.first_non2xx_at).toBe(118);
    expect(c.first_non2xx_status).toBe(429);
    expect(c.first_non2xx_class).toBe("json-throttler");
    expect(c.retry_after).toBe("60");
    expect(c.statuses).toBe("200:117|429:1");
    expect(c.classes).toBe("json-throttler:1");
    expect(c.remaining_at_first).toBe("119");
  });

  test("a spike where the edge answers HTML, samples out of order", () => {
    const c = summariseCell([
      s(3, 403, { contentType: "text/html", body: "<!DOCTYPE html><title>Just a moment...</title>" }),
      s(1, 200),
      s(2, 0, { contentType: "", body: "TimeoutError" }),
    ]);
    expect(c.first_non2xx_at).toBe(2);
    expect(c.first_non2xx_status).toBe(0);
    expect(c.first_non2xx_class).toBe("text");
    expect(c.classes).toBe("html:1|text:1");
    expect(c.statuses).toBe("0:1|200:1|403:1");
  });

  test("no breach", () => {
    const c = summariseCell([s(1, 200), s(2, 200)]);
    expect(c.first_non2xx_at).toBe("none");
    expect(c.first_non2xx_class).toBe("none");
    expect(c.retry_after).toBe("none");
    expect(c.classes).toBe("none");
  });
});

describe("SHAPES", () => {
  test("every shape issues at most 150 requests; only the spike ignores the first breach", () => {
    for (const shape of Object.values(SHAPES)) expect(shape.max).toBe(150);
    expect(SHAPES["spike-150"].stopOnFirstNon2xx).toBe(false);
    expect(SHAPES.serial.concurrency).toBe(1);
  });
});
