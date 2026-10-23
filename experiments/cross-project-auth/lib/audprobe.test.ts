import { describe, expect, test } from "bun:test";
import { claimSet, decode } from "./audprobe";

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const tok = (h: unknown, c: unknown) => `${b64(h)}.${b64(c)}.sig`;

describe("claimSet", () => {
  test("keeps aud as JSON so a string and a one-element array stay distinct", () => {
    const s = claimSet(tok({ alg: "ES256", kid: "k1" }, { aud: "spoke-api", iat: 100, exp: 3700 }));
    const a = claimSet(tok({ alg: "ES256" }, { aud: ["spoke-api"], iat: 100, exp: 3700 }));
    expect(s.aud).toBe('"spoke-api"');
    expect(a.aud).toBe('["spoke-api"]');
    expect(s.ttl_s).toBe(3600);
  });

  test("a removed aud reads null, not the default", () => {
    expect(claimSet(tok({ alg: "ES256" }, { sub: "u" })).aud).toBe("null");
  });

  test("reduces identifying values to presence and keeps every claim name", () => {
    const c = claimSet(
      tok({ alg: "ES256", kid: "4b9f" }, { sub: "u1", session_id: "s1", client_id: "c1", scope: "openid email", app_metadata: { tenant_id: "tenant-a" }, amr: [{ method: "oauth_provider/authorization_code" }] }),
    );
    expect(c.kid).toBe("present");
    expect(c.client_id).toBe("present");
    expect(c.scope).toBe("openid email");
    expect(c.tenant_id).toBe("tenant-a");
    expect(c.amr).toBe("oauth_provider/authorization_code");
    expect(c.claim_names).toBe("amr,app_metadata,client_id,scope,session_id,sub");
    expect(JSON.stringify(c)).not.toContain("u1");
    expect(JSON.stringify(c)).not.toContain("4b9f");
  });

  test("decode tolerates a malformed token", () => {
    expect(decode("not-a-jwt")).toEqual({ header: {}, claims: {} });
  });
});
