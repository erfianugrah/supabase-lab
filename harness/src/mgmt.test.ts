import { describe, expect, test } from "bun:test";
import { classifyBody } from "./mgmt";

describe("classifyBody", () => {
  test("parses a JSON object", () => {
    const r = classifyBody("application/json", '{"a":1}');
    expect(r.throttled).toBe(false);
    expect(r.json).toEqual({ a: 1 });
  });

  test("parses a JSON array - list endpoints return one", () => {
    expect(classifyBody("application/json", "[1,2]").json).toEqual([1, 2]);
  });

  test("an HTML content-type is a throttle, not a parse failure", () => {
    // The consolidation run's finding: sequential probing earns a Cloudflare
    // interstitial, not a JSON 429. Treating it as a parse error records a
    // test bug where the truth is "back off".
    const r = classifyBody("text/html; charset=UTF-8", "<!DOCTYPE html><html>...");
    expect(r.throttled).toBe(true);
    expect(r.json).toBeUndefined();
  });

  test("HTML is detected by body shape even when the header lies", () => {
    expect(classifyBody("application/json", "<html><body>nope</body></html>").throttled).toBe(true);
  });

  test("a non-JSON non-HTML body is neither parsed nor called a throttle", () => {
    const r = classifyBody("text/plain", "Internal Server Error");
    expect(r.throttled).toBe(false);
    expect(r.json).toBeUndefined();
  });

  test("an empty body (204) is not a throttle", () => {
    // PATCH /config/realtime answers 204 with no body; misreading that as a
    // challenge would make every successful write look retryable.
    expect(classifyBody(null, "")).toEqual({ throttled: false });
  });
});
