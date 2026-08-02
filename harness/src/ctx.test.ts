import { describe, expect, test } from "bun:test";
import { deriveCapabilities } from "./ctx";

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

  test("empty input yields no capabilities", () => {
    expect(deriveCapabilities({}).size).toBe(0);
  });
});
