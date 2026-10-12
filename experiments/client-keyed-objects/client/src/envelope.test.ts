import { describe, expect, test } from "bun:test";
import { CkError } from "./errors";
import { CHUNK, TAG, cipherSize, chunkCount, decryptChunk, encryptChunk, importDek, span } from "./envelope";

describe("layout", () => {
  test("cipher size adds one tag per chunk", () => {
    expect(chunkCount(2 * 1024 ** 3)).toBe(256);
    expect(cipherSize(2 * 1024 ** 3)).toBe(2 * 1024 ** 3 + 256 * TAG);
    expect(cipherSize(CHUNK + 1)).toBe(CHUNK + 1 + 2 * TAG);
  });
  test("span maps a plaintext range to the covering chunks", () => {
    const size = 3 * CHUNK + 100;
    expect(span(0, 1, size)).toEqual({ first: 0, last: 0, cStart: 0, cEnd: CHUNK + TAG - 1 });
    const s = span(CHUNK - 1, CHUNK + 1, size);
    expect([s.first, s.last, s.cStart, s.cEnd]).toEqual([0, 1, 0, 2 * (CHUNK + TAG) - 1]);
    const tail = span(3 * CHUNK + 10, size, size);
    expect([tail.first, tail.last, tail.cStart, tail.cEnd]).toEqual([3, 3, 3 * (CHUNK + TAG), 3 * (CHUNK + TAG) + 100 + TAG - 1]);
    expect(() => span(5, 5, size)).toThrow();
  });
});

describe("AEAD binding", async () => {
  const key = await importDek(new Uint8Array(32).fill(3));
  const prefix = new Uint8Array(8).fill(9);
  const id = "00000000-0000-4000-8000-000000000001";
  const p0 = new Uint8Array(64).fill(1);
  const c0 = await encryptChunk(key, prefix, id, 0, 2, p0);
  test("round trip", async () => {
    expect(await decryptChunk(key, prefix, id, 0, 2, c0)).toEqual(p0);
  });
  const code = async (f: () => Promise<unknown>) => f().then(() => "ok", (e) => (e instanceof CkError ? e.code : "other"));
  test("moved to another index, asset or count fails closed", async () => {
    expect(await code(() => decryptChunk(key, prefix, id, 1, 2, c0))).toBe("ChunkAuthFailed");
    expect(await code(() => decryptChunk(key, prefix, "00000000-0000-4000-8000-000000000002", 0, 2, c0))).toBe("ChunkAuthFailed");
    expect(await code(() => decryptChunk(key, prefix, id, 0, 1, c0))).toBe("ChunkAuthFailed");
  });
  test("one flipped bit fails closed", async () => {
    const t = c0.slice();
    t[5] = t[5]! ^ 1;
    expect(await code(() => decryptChunk(key, prefix, id, 0, 2, t))).toBe("ChunkAuthFailed");
  });
});
