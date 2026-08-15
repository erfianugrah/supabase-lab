/**
 * Generates the lab-controlled ES256 JWT issuer keypair.
 *
 * ES256 because current projects bootstrap with an ES256 `in_use` signing key,
 * so third-party auth integrations built on this pair exercise the same
 * verification path a real customer issuer would. The public JWK is safe to
 * commit (it is served publicly at the worker's jwks.json); the private JWK
 * never leaves jwks/private.json, which is gitignored.
 */
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";

const dir = new URL("../jwks/", import.meta.url).pathname;
const privPath = `${dir}private.json`;
const pubPath = `${dir}public.json`;

if (existsSync(privPath)) {
  console.error("jwks/private.json already exists - refusing to rotate");
  process.exit(1);
}
mkdirSync(dir, { recursive: true });

const kid = randomUUID().replaceAll("-", "");
const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });

const pub = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
const priv = privateKey.export({ format: "jwk" }) as Record<string, unknown>;
Object.assign(pub, { kid, alg: "ES256", use: "sig" });
Object.assign(priv, { kid, alg: "ES256", use: "sig" });

writeFileSync(pubPath, JSON.stringify(pub, null, 2));
writeFileSync(privPath, JSON.stringify(priv, null, 2), { mode: 0o600 });
console.log(`kid=${kid}`);
console.log(`public  -> ${pubPath}`);
console.log(`private -> ${privPath} (mode 600, gitignored)`);
