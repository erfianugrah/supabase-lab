import { describe, expect, test } from "bun:test";
import { MODES } from "./matrix";
import { AUTH_TABLE, NAMED_CREDENTIALS, NAMED_MODES, namedExpected, namedHeaders, namedVerdict, passDiff, scrub, type NamedKeys } from "./named";

const keys: NamedKeys = { pubDefault: "PD", pubNamed: "PN", secDefault: "SD", secNamed: "SN", user: "U" };

describe("named-key expectations", () => {
  test("every server-side id is in the auth table", () => {
    for (const m of [...MODES, ...NAMED_MODES]) expect(AUTH_TABLE[m]).toBeDefined();
  });
  test("every named mode x credential has an expectation", () => {
    for (const m of NAMED_MODES) for (const c of NAMED_CREDENTIALS) expect(["ran", "refuse", "undoc"]).toContain(namedExpected(m, c));
  });
  test("bare modes accept only the default key", () => {
    expect(namedExpected("n_pub_bare", "pub_default")).toBe("ran");
    expect(namedExpected("n_pub_bare", "pub_named")).toBe("refuse");
    expect(namedExpected("n_sec_bare", "sec_named")).toBe("refuse");
  });
  test("wildcard accepts both keys of its kind and neither of the other kind", () => {
    expect(namedExpected("n_sec_any", "sec_default")).toBe("ran");
    expect(namedExpected("n_sec_any", "sec_named")).toBe("ran");
    expect(namedExpected("n_sec_any", "pub_default")).toBe("refuse");
  });
  test("a missing name never runs; a later mode in the array still can", () => {
    for (const c of NAMED_CREDENTIALS) expect(namedExpected("n_pub_missing", c)).toBe("refuse");
    expect(namedVerdict("n_pub_missing_or_sec", "sec_default", true)).toBe("match");
  });
  test("a user token plus a named publishable key is a docs-silent cell in publishable-only modes", () => {
    expect(namedExpected("n_pub_named", "user_jwt_pub_named")).toBe("undoc");
    expect(namedExpected("n_user_or_pub_named", "user_jwt_pub_named")).toBe("ran");
  });
  test("headers", () => {
    expect(namedHeaders("pub_named", keys)).toEqual({ apikey: "PN" });
    expect(namedHeaders("user_jwt_pub_named", keys)).toEqual({ apikey: "PN", Authorization: "Bearer U" });
    expect(namedHeaders("no_credentials", keys)).toEqual({});
  });
});

describe("helpers", () => {
  test("scrub replaces values of 8 or more characters only", () => {
    expect(scrub("key sb_secret_abcdef here, short K", { sec: "sb_secret_abcdef", s: "K" })).toBe("key <sec> here, short K");
  });
  test("passDiff lists keys whose cell text differs", () => {
    expect(passDiff({ a: "200", b: "401" }, { a: "200", b: "500", c: "1" })).toEqual(["b", "c"]);
  });
});
