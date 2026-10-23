import { describe, expect, test } from "bun:test";
import { fmtLsn, lsnNum, segOfLsn, segOfWalName, stopLsnFromLog, timeAtLsn } from "./wal";

const SEG = 16 * 1024 * 1024;

describe("wal helpers", () => {
  test("lsnNum parses hi/lo hex and rejects junk", () => {
    expect(lsnNum("0/501CA08")).toBe(0x501ca08);
    expect(lsnNum("1/0")).toBe(2 ** 32);
    expect(lsnNum("nope")).toBeNull();
    expect(lsnNum("")).toBeNull();
  });

  test("fmtLsn round-trips", () => {
    expect(fmtLsn(0x501ca08)).toBe("0/501CA08");
    expect(fmtLsn(2 ** 32 + 0x10)).toBe("1/10");
  });

  test("segment of an LSN matches the segment number in the WAL file name", () => {
    // 0/501CA08 lies in segment 000000010000000000000005 (R24, 2026-10-23 UTC)
    expect(segOfLsn(0x501ca08)).toBe(5);
    expect(segOfWalName("000000010000000000000005")).toBe(5);
    // 1/0 is segment 256: xlogid 1, seg 00
    expect(segOfLsn(2 ** 32)).toBe(256);
    expect(segOfWalName("000000020000000100000000")).toBe(256);
    expect(segOfWalName("short")).toBeNull();
    expect(segOfLsn(SEG * 3 - 1)).toBe(2);
  });

  test("stopLsnFromLog takes the first LSN after 'WAL location (LSN)'", () => {
    expect(stopLsnFromLog('starting point-in-time recovery to WAL location (LSN) "0/501CA08"')).toBe("0/501CA08");
    expect(stopLsnFromLog('recovery stopping after WAL location (LSN) "2/A0000028"')).toBe("2/A0000028");
    expect(stopLsnFromLog("redo done at 0/5 system usage")).toBeNull();
  });

  test("timeAtLsn interpolates between samples and refuses to extrapolate", () => {
    const s = [
      { t: 100, lsn: 1000 },
      { t: 110, lsn: 2000 },
      { t: 120, lsn: 4000 },
    ];
    expect(timeAtLsn(s, 1500)).toBe(105);
    expect(timeAtLsn(s, 3000)).toBe(115);
    expect(timeAtLsn(s, 2000)).toBe(110);
    expect(timeAtLsn(s, 500)).toBeNull();
    expect(timeAtLsn(s, 5000)).toBeNull();
    expect(timeAtLsn([], 5)).toBeNull();
  });
});
