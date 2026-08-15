import { createPrivateKey, createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/**
 * Mint an ES256 compact JWS.
 *
 * Uses node:crypto createSign with dsaEncoding:"ieee-p1363" so the signature
 * is raw R||S (64 bytes) rather than DER - JOSE requires the ieee-p1363 form.
 * The key options form { key, dsaEncoding } is required; passing dsaEncoding
 * as the second positional string arg treats it as outputEncoding and throws.
 */
export async function mintEs256(privJwkPath: string, claims: object): Promise<string> {
  const jwk = JSON.parse(await readFile(privJwkPath, "utf-8"));
  const header = { alg: "ES256", typ: "JWT", kid: jwk.kid };

  const encodedHeader = base64url(Buffer.from(JSON.stringify(header)));
  const encodedPayload = base64url(Buffer.from(JSON.stringify(claims)));
  const signingInput = Buffer.from(`${encodedHeader}.${encodedPayload}`);

  const key = createPrivateKey({ key: jwk, format: "jwk" });

  const signature = createSign("sha256")
    .update(signingInput)
    .sign({ key, dsaEncoding: "ieee-p1363" });

  return `${encodedHeader}.${encodedPayload}.${base64url(signature)}`;
}
