import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { codeOf, jwtShape, refusedBy, resignHs256, transition } from "./sha";

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

describe("refusedBy", () => {
  const p = (status: number, json: Record<string, unknown>, text = JSON.stringify(json)) => ({ status, json, text, ms: 1 });
  test("a 2xx was refused by nobody", () => {
    expect(refusedBy(p(200, {}))).toBe("");
  });
  test("a PGRST code means the request reached PostgREST and PostgREST refused it", () => {
    expect(refusedBy(p(401, { code: "PGRST301", message: "No suitable key or wrong key type" }))).toBe("postgrest");
  });
  test("an api-key message with no PGRST code is the gateway", () => {
    expect(refusedBy(p(401, { message: "Invalid API key", hint: "Double check your Supabase `anon` or `service_role` API key." }))).toBe("gateway");
    expect(refusedBy(p(401, { message: "Legacy API keys are disabled" }))).toBe("gateway");
  });
  test("anything else is other, so an unseen shape is not filed under a layer", () => {
    expect(refusedBy(p(503, {}, "upstream connect error"))).toBe("other");
    expect(refusedBy(p(0, {}, "ERR:timeout"))).toBe("other");
  });
});

describe("resignHs256", () => {
  test("keeps header and payload, replaces the signature with one under the given secret", () => {
    const original = `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64url(JSON.stringify({ role: "anon", iss: "supabase" }))}.origsig`;
    const forged = resignHs256(original, "not-the-project-secret");
    const [h, c, s] = forged.split(".");
    expect(`${h}.${c}`).toBe(original.split(".").slice(0, 2).join("."));
    const want = createHmac("sha256", "not-the-project-secret").update(`${h}.${c}`).digest("base64url");
    expect(s).toBe(want);
    expect(s).not.toBe("origsig");
  });
  test("a claim patch changes the token string but keeps the rest of the claims", () => {
    const original = `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64url(JSON.stringify({ role: "anon", iat: 100, exp: 200 }))}.origsig`;
    const forged = resignHs256(original, "s", { iat: 101 });
    const [h, c, s] = forged.split(".");
    expect(JSON.parse(Buffer.from(c!, "base64url").toString("utf8"))).toEqual({ role: "anon", iat: 101, exp: 200 });
    expect(s).toBe(createHmac("sha256", "s").update(`${h}.${c}`).digest("base64url"));
    expect(forged).not.toBe(resignHs256(original, "s"));
  });
});

describe("transition", () => {
  test("200 at every mark", () => {
    expect(transition([{ t: 10, status: 200 }, { t: 600, status: 200 }])).toEqual({ label: "200 throughout", flipAt: null, monotonic: true });
  });
  test("first non-200 mark that stays non-200", () => {
    expect(transition([{ t: 10, status: 200 }, { t: 45, status: 200 }, { t: 60, status: 401 }, { t: 120, status: 401 }])).toEqual({ label: "flipped between 45 s and 60 s", flipAt: 60, monotonic: true });
  });
  test("non-200 from the first mark", () => {
    expect(transition([{ t: 10, status: 401 }, { t: 30, status: 401 }])).toEqual({ label: "non-200 from the first mark (10 s)", flipAt: 10, monotonic: true });
  });
  test("flapping is reported as such, not as a flip", () => {
    const r = transition([{ t: 10, status: 200 }, { t: 30, status: 401 }, { t: 45, status: 200 }]);
    expect(r.monotonic).toBe(false);
    expect(r.flipAt).toBeNull();
    expect(r.label).toBe("non-monotonic: 10:200 30:401 45:200");
  });
});
