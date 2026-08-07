import { describe, expect, test } from "bun:test";
import { deriveCapabilities, readEndpoints, readPeers } from "./ctx";

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

describe("readEndpoints", () => {
  test("PVLAB_ENDPOINT_POOLER=host -> { pooler: host }, lowercased", () => {
    expect(
      readEndpoints({
        PVLAB_ENDPOINT_POOLER: "pooler.example.test",
        PVLAB_ENDPOINT_CUSTOM_DOMAIN: "db.example.test",
        UNRELATED: "x",
      }),
    ).toEqual({ pooler: "pooler.example.test", custom_domain: "db.example.test" });
  });

  test("an empty value counts as absent", () => {
    // A Makefile interpolating a missing tofu output exports exactly this.
    expect(readEndpoints({ PVLAB_ENDPOINT_POOLER: "" })).toEqual({});
  });

  test("PVLAB_ENDPOINT_IPS is NOT an endpoint", () => {
    // It predates this and is parsed separately in buildCtx; a greedy prefix
    // match would swallow it into endpoints.ips.
    expect(readEndpoints({ PVLAB_ENDPOINT_IPS: "10.0.0.1 10.0.0.2" })).toEqual({});
  });
});

test("pooler capability comes from a supplied endpoint", () => {
  expect(deriveCapabilities({ endpoints: {} }).has("pooler")).toBe(false);
  expect(deriveCapabilities({ endpoints: { pooler: "h" } }).has("pooler")).toBe(true);
});

test("second-vpc is a local-vantage capability only, like lambda", () => {
  expect(
    deriveCapabilities({ endpoints: { second_vpc_lambda: "fn" }, where: "runner" }).has("second-vpc"),
  ).toBe(false);
  expect(
    deriveCapabilities({ endpoints: { second_vpc_lambda: "fn" }, where: "local" }).has("second-vpc"),
  ).toBe(true);
});

test("service-network is a runner-vantage capability only - the DNS name only resolves in-VPC", () => {
  expect(
    deriveCapabilities({ endpoints: { service_network_dns: "h" }, where: "local" }).has("service-network"),
  ).toBe(false);
  expect(
    deriveCapabilities({ endpoints: { service_network_dns: "h" }, where: "runner" }).has("service-network"),
  ).toBe(true);
});
