import { describe, expect, test } from "bun:test";
import { Ledger, bigToLsn, gaps, lsnToBig, parsePgoutput, parseWal2json, phaseCounts } from "./slots";

// Messages as returned by pg_logical_slot_get_binary_changes(..., 'proto_version', '1')
// on a managed Postgres 17.11 project (feasibility run 2026-10-23): B, R, I, C.
const B = Buffer.from("4200000000050147f80003017c07328fee000004be", "hex");
const R = Buffer.from("52000044c67075626c69630072705f736c6f745f6576656e7473006400020169640000000014ffffffff", "hex");
const ts = Buffer.from("2026-10-23 07:52:18.457894+00", "utf8");
const I = (id: string) =>
  Buffer.concat([
    Buffer.from("49000044c64e0002", "hex"),
    Buffer.from("74", "hex"),
    Buffer.from(id.length.toString(16).padStart(8, "0"), "hex"),
    Buffer.from(id, "utf8"),
    Buffer.from("74", "hex"),
    Buffer.from(ts.length.toString(16).padStart(8, "0"), "hex"),
    ts,
  ]);
const C = Buffer.from("430000000000050147f800000000050148280003017c07328fee", "hex");

describe("lsn", () => {
  test("round trip", () => {
    expect(bigToLsn(lsnToBig("0/5014828"))).toBe("0/5014828");
    expect(lsnToBig("1/0")).toBe(1n << 32n);
    expect(lsnToBig("16/B374D848") > lsnToBig("15/FFFFFFFF")).toBe(true);
  });
});

describe("parsePgoutput", () => {
  test("one tx with two inserts, relation message skipped", () => {
    const txs = parsePgoutput([B, R, I("1"), I("12"), C]);
    expect(txs).toHaveLength(1);
    expect(txs[0]?.ids).toEqual([1, 12]);
    expect(bigToLsn(txs[0]!.endLsn)).toBe("0/5014828");
  });
  test("an incomplete tx (no C) is not returned", () => {
    expect(parsePgoutput([B, I("3")])).toHaveLength(0);
  });
});

describe("parseWal2json", () => {
  test("format-version 2 lines", () => {
    const lines = [
      '{"action":"B","lsn":"0/50147F8","nextlsn":"0/5014828"}',
      '{"action":"I","lsn":"0/5014688","schema":"public","table":"rp_slot_events","columns":[{"name":"id","type":"bigint","value":1}]}',
      '{"action":"I","lsn":"0/5014770","schema":"public","table":"rp_slot_events","columns":[{"name":"id","type":"bigint","value":2}]}',
      '{"action":"C","lsn":"0/50147F8","nextlsn":"0/5014828"}',
      "",
    ];
    const txs = parseWal2json(lines);
    expect(txs).toHaveLength(1);
    expect(txs[0]?.ids).toEqual([1, 2]);
    expect(bigToLsn(txs[0]!.endLsn)).toBe("0/5014828");
  });
});

describe("Ledger", () => {
  test("a redelivery at or before the confirmed position is a rewind, after it is not", () => {
    const l = new Ledger("x");
    l.take({ endLsn: 100n, ids: [1] }, "a", 0n);
    l.take({ endLsn: 200n, ids: [2] }, "a", 100n);
    // consumer had confirmed 200; slot came back at 100 and resent both
    l.take({ endLsn: 100n, ids: [1] }, "b", 200n);
    l.take({ endLsn: 200n, ids: [2] }, "b", 200n);
    // stream case: confirmed 200, resent a tx ending at 300 that was received but not confirmed
    l.take({ endLsn: 300n, ids: [3] }, "b", 200n);
    l.take({ endLsn: 300n, ids: [3] }, "b", 200n);
    expect(l.redeliveries.map((r) => [r.id, r.rewind])).toEqual([
      [1, true],
      [2, true],
      [3, false],
    ]);
    const acked = new Map<number, string>([
      [1, "a"],
      [2, "a"],
      [3, "b"],
      [4, "b"],
    ]);
    expect(gaps(acked, l)).toEqual([{ id: 4, phase: "b" }]);
    expect(phaseCounts("b", acked, l)).toEqual({ dup: 3, dupRewind: 2, gap: 1, recv: 4 });
  });
});
