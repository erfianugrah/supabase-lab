import { describe, expect, test } from "bun:test";
import { FUNCTIONS_PER_PROJECT, normalisePlan, planForFunctionCap, SECRETS } from "./docs";

describe("docs table", () => {
  test("a cap of exactly 1000 identifies Pro, 2000 Team, 100 Free", () => {
    expect(planForFunctionCap(1000)).toBe("pro");
    expect(planForFunctionCap(2000)).toBe("team");
    expect(planForFunctionCap(100)).toBe("free");
  });

  test("the pre-August-2026 figures identify no plan - a customer quoting them is reading a stale note", () => {
    expect(planForFunctionCap(500)).toBeUndefined();
  });

  test("enterprise is unlimited, not a number", () => {
    expect(FUNCTIONS_PER_PROJECT.enterprise).toBe("unlimited");
  });

  test("48 KiB and 24,576 characters describe the same secret value ceiling at two bytes per character", () => {
    expect(SECRETS.maxValueBytes).toBe(SECRETS.maxValueChars * 2);
  });

  test("plan names normalise from whatever the API returns", () => {
    expect(normalisePlan("Pro")).toBe("pro");
    expect(normalisePlan("TEAM")).toBe("team");
    expect(normalisePlan("platform")).toBeUndefined();
    expect(normalisePlan(undefined)).toBeUndefined();
  });
});
