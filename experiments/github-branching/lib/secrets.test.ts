import { describe, expect, test } from "bun:test";
import { dotenvxFile, listedClass, PROBE_FN, PROBED, sha256, terminal } from "./secrets";

describe("listedClass", () => {
  const v = "gb07-known";
  test("a digest of the set value, the value itself, and an unrelated string are told apart", () => {
    expect(listedClass(sha256(v), v)).toBe("sha256");
    expect(listedClass(v, v)).toBe("plaintext");
    expect(listedClass("something-else", v)).toBe("other");
  });
  test("a name that is not listed is absent, with or without an expectation", () => {
    expect(listedClass(undefined, v)).toBe("absent");
    expect(listedClass(undefined, undefined)).toBe("absent");
  });
  test("the digest of an empty string is named, since an unset env() may resolve to it", () => {
    expect(listedClass(sha256(""), v)).toBe("sha256-of-empty");
    expect(listedClass(sha256(""), undefined)).toBe("sha256-of-empty");
    expect(listedClass("anything", undefined)).toBe("listed");
  });
});

describe("terminal", () => {
  test("no run yet is not terminal", () => {
    expect(terminal("")).toBe(false);
  });
  test("every step exited is terminal", () => {
    expect(terminal("clone:EXITED,pull:EXITED,health:EXITED,configure:EXITED,migrate:EXITED,seed:EXITED,deploy:EXITED")).toBe(true);
  });
  test("a step still created or running is not", () => {
    expect(terminal("clone:EXITED,pull:RUNNING,deploy:CREATED")).toBe(false);
    expect(terminal("clone:EXITED,deploy:CREATED")).toBe(false);
  });
  test("a dead step is terminal even with later steps left at CREATED (GB03's shape)", () => {
    expect(terminal("clone:EXITED,migrate:DEAD,seed:CREATED,deploy:CREATED")).toBe(true);
  });
});

describe("PROBE_FN", () => {
  test("probes every name and is plain JS the edge runtime can parse", () => {
    for (const n of PROBED) expect(PROBE_FN).toContain(n);
    expect(PROBE_FN).not.toContain("export ");
    // Deno.serve is the only global it needs beyond crypto/TextEncoder; parse only.
    expect(() => new Function("Deno", PROBE_FN.replace(/Deno\.serve\(/, "(() => {})("))).not.toThrow();
  });
});

describe("dotenvxFile", () => {
  test("writes an encrypted .env.preview and returns the matching private key", () => {
    const { envPreview, privateKey } = dotenvxFile("PVLAB_T", "throwaway-value");
    expect(envPreview).toContain('PVLAB_T="encrypted:');
    expect(envPreview).toContain("DOTENV_PUBLIC_KEY_PREVIEW=");
    expect(envPreview).not.toContain("throwaway-value");
    expect(privateKey).toMatch(/^[0-9a-f]{64}$/);
  }, 60_000);
  test("two calls give two different keypairs (the wrongkey shape depends on it)", () => {
    const a = dotenvxFile("PVLAB_T", "x");
    const b = dotenvxFile("PVLAB_T", "x");
    expect(a.privateKey).not.toBe(b.privateKey);
  }, 60_000);
});
