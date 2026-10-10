import { describe, expect, test } from "bun:test";
import { CREDENTIALS, MODES, expected, headersFor, verdict, type TokenBag } from "./matrix";

const bag: TokenBag = { anon: "A", service: "S", publishable: "P", secret: "K", user: "U", expired: "E", tpa: "T", foreign: "F", hs256: "H" };

describe("matrix expectations", () => {
  test("every mode x credential has an expectation", () => {
    for (const m of MODES) for (const c of CREDENTIALS) expect(["ran", "refuse", "undoc"]).toContain(expected(m, c));
  });
  test("a cell is never both ran and refuse", () => {
    for (const m of MODES) for (const c of CREDENTIALS) {
      // expected() resolves ran first; refuse only reachable when not ran.
      if (expected(m, c) === "refuse") expect(verdict(m, c, true)).toBe("MISMATCH");
    }
  });
  test("user mode refuses a bad JWT even when a publishable apikey is also sent", () => {
    expect(expected("user", "expired_jwt_pub")).toBe("refuse");
    expect(expected("user_secret", "expired_jwt_pub")).toBe("refuse");
  });
  test("none mode runs without credentials", () => {
    expect(verdict("none", "no_credentials", true)).toBe("match");
  });
  test("headers: legacy keys travel as apikey and bearer, publishable only as apikey", () => {
    expect(headersFor("legacy_anon", bag)).toEqual({ apikey: "A", Authorization: "Bearer A" });
    expect(headersFor("publishable", bag)).toEqual({ apikey: "P" });
    expect(headersFor("no_credentials", bag)).toEqual({});
    expect(headersFor("user_jwt", bag)).toEqual({ Authorization: "Bearer U" });
  });
});
