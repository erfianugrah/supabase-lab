import { describe, expect, test } from "bun:test";
import { parsePlan } from "./selfprov";

describe("parsePlan", () => {
  test("no plan: PD_ONLY repeated PD_PASSES times, no age floor", () => {
    expect(parsePlan(undefined, "D01,D02", 2)).toEqual([
      { only: "D01,D02", minAgeS: 0 },
      { only: "D01,D02", minAgeS: 0 },
    ]);
  });
  test("plan overrides, one pass per entry, optional @age", () => {
    expect(parsePlan("MS02; MS07;MS07@3600;", "ignored", 5)).toEqual([
      { only: "MS02", minAgeS: 0 },
      { only: "MS07", minAgeS: 0 },
      { only: "MS07", minAgeS: 3600 },
    ]);
  });
});
