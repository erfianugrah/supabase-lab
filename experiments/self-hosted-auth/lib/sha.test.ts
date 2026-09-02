import { describe, expect, test } from "bun:test";
import { codeOf, jwtShape } from "./sha";

function b64url(s: string): string {
  return Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const token = (h: object, c: object) => `${b64url(JSON.stringify(h))}.${b64url(JSON.stringify(c))}.sig`;

describe("jwtShape", () => {
  test("reads alg, kid, iss, aud, role, ttl and session from an unverified token", () => {
    const t = token(
      { alg: "ES256", typ: "JWT", kid: "2947dfb3-62e7" },
      { iss: "https://ref.supabase.co/auth/v1", aud: "authenticated", role: "authenticated", sub: "u1", iat: 1000, exp: 4600, session_id: "s1" },
    );
    expect(jwtShape(t)).toEqual({
      alg: "ES256",
      kid: "2947dfb3-62e7",
      iss: "https://ref.supabase.co/auth/v1",
      aud: "authenticated",
      role: "authenticated",
      sub: "u1",
      ttlS: 3600,
      sessionId: "s1",
    });
  });

  test("an HS256 token from the self-hosted side has no kid, and that reads as empty rather than undefined", () => {
    const t = token({ alg: "HS256", typ: "JWT" }, { iss: "x", aud: "authenticated", role: "authenticated", iat: 0, exp: 3600 });
    expect(jwtShape(t)?.kid).toBe("");
    expect(jwtShape(t)?.alg).toBe("HS256");
  });

  test("a non-token is undefined, not a throw", () => {
    expect(jwtShape("")).toBeUndefined();
    expect(jwtShape("not.a.jwt")).toBeUndefined();
  });
});

describe("codeOf", () => {
  const p = (json: Record<string, unknown>) => ({ status: 400, json, text: "", ms: 1 });
  test("prefers GoTrue's error_code, then PostgREST's code, then messages", () => {
    expect(codeOf(p({ error_code: "refresh_token_not_found", msg: "Invalid Refresh Token" }))).toBe("refresh_token_not_found");
    expect(codeOf(p({ code: "PGRST301", message: "JWSError" }))).toBe("PGRST301");
    expect(codeOf(p({ msg: "Invalid Refresh Token" }))).toBe("Invalid Refresh Token");
    expect(codeOf(p({}))).toBe("");
  });
});
