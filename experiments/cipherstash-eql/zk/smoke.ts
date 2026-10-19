// Local smoke check against ZeroKMS with the CLI device session (no CS_* env):
// encrypt/decrypt per v3 type, one bulk call, payload keys only (no values).
import { Encryption } from "@cipherstash/stack/v3";
import { encryptedTable, types } from "@cipherstash/stack/eql/v3";

const t = encryptedTable("smoke", {
  ref: types.TextEq("ref"),
  label: types.TextOrd("label"),
  score: types.IntegerOrd("score"),
  blob: types.Text("blob"),
});

const t0 = performance.now();
const client = await Encryption({ schemas: [t] });
const initMs = performance.now() - t0;
const out: Record<string, unknown> = { initMs: Math.round(initMs) };

for (const [col, v] of [["ref", "S-001"], ["label", "beta"], ["score", 42], ["blob", "x".repeat(44)]] as const) {
  const a = performance.now();
  const enc = await client.encrypt(v as never, { table: t, column: (t as never as Record<string, never>)[col] } as never);
  const b = performance.now();
  if (enc.failure) { out[col] = { encryptFailure: enc.failure.type, message: enc.failure.message }; continue; }
  const dec = await client.decrypt(enc.data as never);
  const c = performance.now();
  out[col] = {
    payloadKeys: Object.keys(enc.data as object).sort(),
    roundTrip: dec.failure ? `failure ${dec.failure.type}` : dec.data === v,
    encryptMs: Math.round(b - a),
    decryptMs: Math.round(c - b),
  };
}

const items = Array.from({ length: 100 }, (_, i) => ({ id: `r${i}`, plaintext: `S-${i}` }));
const a = performance.now();
const bulk = await client.bulkEncrypt(items as never, { table: t, column: t.ref } as never);
const b = performance.now();
const bd = bulk.failure ? null : await client.bulkDecrypt(bulk.data as never);
const c = performance.now();
out.bulk100 = bulk.failure
  ? { failure: bulk.failure.type, message: bulk.failure.message }
  : {
      encryptMs: Math.round(b - a),
      decryptMs: Math.round(c - b),
      allMatch: !bd?.failure && (bd?.data as Array<{ id: string; data?: unknown }>).every((x, i) => x.data === items[i].plaintext),
    };
console.log(JSON.stringify(out, null, 2));
