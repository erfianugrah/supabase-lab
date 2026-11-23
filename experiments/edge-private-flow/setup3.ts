// setup3: run 3 function secrets. Needs setup.ts, setup2 and `bun cf3.ts up`.
// Env: SUPABASE_ACCESS_TOKEN.
import { readFileSync } from "node:fs";

const dir = import.meta.dir;
const S = JSON.parse(readFileSync(`${dir}/evidence/state.json`, "utf8"));
const C3 = JSON.parse(readFileSync(`${dir}/evidence/cf3.json`, "utf8"));
const tun = JSON.parse(readFileSync(`${dir}/certs/tun-token.json`, "utf8"));
const front = readFileSync(`${dir}/evidence/front.url`, "utf8").trim();
const c = (f: string) => readFileSync(`${dir}/certs/${f}`, "utf8");

const r = await fetch(`https://api.supabase.com/v1/projects/${S.ref}/secrets`, {
  method: "POST",
  headers: { authorization: `Bearer ${process.env.SUPABASE_ACCESS_TOKEN}`, "content-type": "application/json" },
  body: JSON.stringify([
    { name: "OWN_URL", value: `https://${C3.own}` },
    { name: "OWN_RSA_CERT", value: c("own-rsa.crt") },
    { name: "OWN_RSA_KEY", value: c("own-rsa.key") },
    { name: "OWN_EC_CERT", value: c("own-ec.crt") },
    { name: "OWN_EC_KEY", value: c("own-ec.key") },
    { name: "TUN_URL", value: `https://${C3.tun}` },
    { name: "TUN_ID", value: tun.id },
    { name: "TUN_SECRET", value: tun.secret },
    { name: "FRONT_URL", value: front },
    { name: "ROT_CERT", value: c("rot-a.crt") },
    { name: "ROT_KEY", value: c("rot-a.key") },
  ]),
});
console.log(`run 3 secrets: ${r.status}`);
if (!r.ok) throw new Error(await r.text());
