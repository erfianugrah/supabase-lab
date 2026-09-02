#!/usr/bin/env bun
/**
 * Generate an ES256 (P-256) signing key pair as JWKs for the self-hosted
 * GoTrue's own-key mode (`make gotrue-up OWNKEY=1`).
 *
 *   bun lib/keygen.ts <outdir>
 *
 * Writes <outdir>/own-es256.private.json (the JWK with `d`, key_ops
 * ["sign","verify"], the one GoTrue signs with) and
 * <outdir>/own-es256.public.json (no `d`, key_ops ["verify"], the one the
 * Edge Function publishes as the JWKS that third-party auth resolves).
 * Both carry the same random kid. The outdir is evidence/, which is
 * gitignored; a private signing key never belongs in the repo.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const outdir = process.argv[2];
if (!outdir) {
  console.error("usage: bun lib/keygen.ts <outdir>");
  process.exit(2);
}
const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const priv = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey & Record<string, unknown>;
const pub = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey & Record<string, unknown>;
const kid = crypto.randomUUID();
const privateJwk = { kty: priv.kty, crv: priv.crv, x: priv.x, y: priv.y, d: priv.d, alg: "ES256", kid, key_ops: ["sign", "verify"] };
const publicJwk = { kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y, alg: "ES256", kid, key_ops: ["verify"] };
await mkdir(outdir, { recursive: true });
await writeFile(join(outdir, "own-es256.private.json"), JSON.stringify(privateJwk));
await writeFile(join(outdir, "own-es256.public.json"), JSON.stringify(publicJwk));
console.log(`wrote own-es256.{private,public}.json (kid ${kid}) to ${outdir}`);
