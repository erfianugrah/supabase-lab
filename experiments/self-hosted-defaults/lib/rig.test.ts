import { expect, test } from "bun:test";
import { jwtParts, parseEnv, scrub, type Rig } from "./rig";

test("parseEnv reads KEY=value lines, strips quotes, ignores comments", () => {
  const e = parseEnv('# c\nA=1\nB="two words"\nC=\nlower=ignored\nD=x=y\n');
  expect(e).toEqual({ A: "1", B: "two words", C: "", D: "x=y" });
});

test("scrub replaces secret-looking values by key name and leaves the rest", () => {
  const rig: Rig = { dir: "", gw: "", env: { POSTGRES_PASSWORD: "hunter2hunter2", SITE_URL: "http://localhost:3000", SHORT_KEY: "abc" } };
  expect(scrub(rig, "pw=hunter2hunter2 url=http://localhost:3000 k=abc")).toBe("pw=<POSTGRES_PASSWORD> url=http://localhost:3000 k=abc");
});

test("jwtParts decodes header and payload, rejects non-JWTs", () => {
  const b = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const t = `${b({ alg: "ES256", kid: "k" })}.${b({ iss: "i", role: "anon" })}.sig`;
  expect(jwtParts(t)).toEqual({ header: { alg: "ES256", kid: "k" }, payload: { iss: "i", role: "anon" } });
  expect(jwtParts("sb_secret_x")).toBeNull();
});
