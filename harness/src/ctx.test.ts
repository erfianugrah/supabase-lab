import { describe, expect, test } from "bun:test";
import { deriveCapabilities, readPeers } from "./ctx";

describe("deriveCapabilities", () => {
  test("db needs BOTH a password and a host", () => {
    expect(deriveCapabilities({ dbPassword: "x" }).has("db")).toBe(false);
    expect(deriveCapabilities({ phzHost: "db.x.supabase.co" }).has("db")).toBe(false);
    expect(deriveCapabilities({ dbPassword: "x", phzHost: "db.x.supabase.co" }).has("db")).toBe(true);
  });

  test("endpoint capability requires at least one resolved IP", () => {
    // Run 7 bug: the runner is replaced during phase 2, so its baked env has
    // no IPs and every endpoint-dependent test vanished silently.
    expect(deriveCapabilities({ endpointIps: [] }).has("endpoint")).toBe(false);
    expect(deriveCapabilities({ endpointIps: ["10.42.1.1"] }).has("endpoint")).toBe(true);
  });

  test("lambda is a local-vantage capability only", () => {
    expect(deriveCapabilities({ lambdaEnabled: true, where: "runner" }).has("lambda")).toBe(false);
    expect(deriveCapabilities({ lambdaEnabled: true, where: "local" }).has("lambda")).toBe(true);
  });

  test("tool capabilities come from probe results, not guesses", () => {
    const caps = deriveCapabilities({ hasPgbench: true, hasOpenssl: false });
    expect(caps.has("pgbench")).toBe(true);
    expect(caps.has("openssl")).toBe(false);
  });

  test("peer needs at least one entry, not just the key existing", () => {
    expect(deriveCapabilities({ peers: {} }).has("peer")).toBe(false);
    expect(deriveCapabilities({ peers: { target: "abc" } }).has("peer")).toBe(true);
  });

  test("org comes from supplied slugs", () => {
    expect(deriveCapabilities({ orgSlugs: [] }).has("org")).toBe(false);
    expect(deriveCapabilities({ orgSlugs: ["acme"] }).has("org")).toBe(true);
  });

  test("empty input yields no capabilities", () => {
    expect(deriveCapabilities({}).size).toBe(0);
  });
});

describe("readPeers", () => {
  test("lowercases the role and ignores unrelated env", () => {
    expect(readPeers({ PVLAB_PEER_TARGET: "abc", PATH: "/usr/bin", PVLAB_REF: "zzz" })).toEqual({
      target: "abc",
    });
  });

  test("carries several roles, so a three-project experiment needs no harness change", () => {
    expect(readPeers({ PVLAB_PEER_SHARED: "a", PVLAB_PEER_DEDICATED: "b" })).toEqual({
      shared: "a",
      dedicated: "b",
    });
  });

  test("an empty value is absent, not an empty-string peer", () => {
    // A Makefile that interpolates a missing tofu output exports the name with
    // an empty value; treating that as present is how a test gets planned and
    // then fails on a blank ref instead of skipping with a reason.
    expect(readPeers({ PVLAB_PEER_TARGET: "" })).toEqual({});
  });
});
