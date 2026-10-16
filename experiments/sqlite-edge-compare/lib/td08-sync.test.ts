import { describe, expect, test } from "bun:test";
import { conflictOutcome } from "./td08-sync";

describe("conflictOutcome", () => {
  test("names the surviving write and whether the clients converged", () => {
    expect(conflictOutcome({ first: "a", second: "b", afterFirst: "b", afterSecond: "b", secondPushError: null })).toBe("last-push-wins");
    expect(conflictOutcome({ first: "a", second: "b", afterFirst: "a", afterSecond: "a", secondPushError: null })).toBe("first-push-wins");
    expect(conflictOutcome({ first: "a", second: "b", afterFirst: "a", afterSecond: "b", secondPushError: null })).toBe("diverged");
    expect(conflictOutcome({ first: "a", second: "b", afterFirst: "a", afterSecond: "a", secondPushError: "conflict" })).toBe("second-push-refused");
    expect(conflictOutcome({ first: "a", second: "b", afterFirst: "x", afterSecond: "x", secondPushError: null })).toBe("other");
  });
});
