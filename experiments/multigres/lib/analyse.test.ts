import { describe, expect, test } from "bun:test";
import { parsePs } from "./cluster";
import { analyse, type WriteEvent } from "./load";
import { analysePgbench, parsePgbenchLog } from "./pgbench";

const ev = (w: number, n: number, t0: number, t1: number, ok = true): WriteEvent => ({ w, n, t0, t1, ok, ...(ok ? {} : { err: "boom" }) });

describe("analyse", () => {
  test("counts an acked row missing from the table as lost", () => {
    const events = [ev(0, 1, 0, 5), ev(0, 2, 5, 10), ev(1, 1, 0, 6)];
    const present = new Set(["0:1", "1:1"]);
    const a = analyse(events, present, 100);
    expect(a.acked).toBe(3);
    expect(a.lost).toBe(1);
  });

  test("an errored row that landed is committed-unacked, not lost", () => {
    const events = [ev(0, 1, 0, 5), ev(0, 2, 5, 9, false), ev(0, 3, 9, 12, false)];
    const present = new Set(["0:1", "0:2"]);
    const a = analyse(events, present, 6);
    expect(a.lost).toBe(0);
    expect(a.committedUnacked).toBe(1);
    expect(a.erroredAbsent).toBe(1);
    expect(a.errorModes).toEqual([["boom", 2]]);
  });

  test("stall is the longest ack-free interval ending after the fault", () => {
    // acks at 1,2,3, then a 2000 ms hole, then 2003, 2004; fault at 3
    const events = [1, 2, 3, 2003, 2004].map((t, i) => ev(0, i + 1, t - 1, t));
    const a = analyse(events, new Set(events.map((e) => `0:${e.n}`)), 3);
    expect(a.stallMs).toBe(2000);
  });

  test("a gap that ends before the fault is not the stall", () => {
    const events = [1, 1001, 1002, 1003].map((t, i) => ev(0, i + 1, t - 1, t));
    const a = analyse(events, new Set(events.map((e) => `0:${e.n}`)), 1500);
    expect(a.stallMs).toBeNull();
  });

  test("recovery is the first ack after the last error", () => {
    const events = [ev(0, 1, 0, 10), ev(0, 2, 20, 120, false), ev(1, 1, 30, 150, false), ev(0, 3, 160, 170)];
    const a = analyse(events, new Set(["0:1", "0:3"]), 15);
    expect(a.firstErrorAfterFaultMs).toBe(5);
    expect(a.lastErrorAfterFaultMs).toBe(135);
    expect(a.recoveredMs).toBe(155);
  });
});

describe("parsePs", () => {
  const ps = [
    "   78 /usr/local/bin/pgctld server --pooler-dir /multigres/cluster/data/pooler_8lgbhz82 --grpc-port 15471 --pg-port 25433 --pg-user postgres",
    "  170 /usr/local/bin/multipooler --http-port 15201 --cell zone2 --service-id 8lgbhz82 --grpc-socket-file /x",
    "   88 /usr/local/bin/pgctld server --pooler-dir /multigres/cluster/data/pooler_4vtlvnx2 --pg-port 25432",
    "  191 /usr/local/bin/multipooler --cell zone1 --service-id 4vtlvnx2",
    "   75 /usr/local/bin/multigateway --pg-port 15433",
  ].join("\n");
  test("joins pgctld and multipooler by service id, sorted by pg port", () => {
    const cs = parsePs(ps);
    expect(cs.map((c) => [c.cell, c.pgPort, c.pgctldPid, c.poolerPid])).toEqual([
      ["zone1", 25432, 88, 191],
      ["zone2", 25433, 78, 170],
    ]);
  });
});

describe("pgbench log", () => {
  const log = ["0 1 900 0 1000 500000", "1 1 950 0 1000 600000", "0 2 900 0 1003 600000"].join("\n");
  test("parses completion times and flags a client with fewer rows than log lines", () => {
    const lines = parsePgbenchLog(log);
    expect(lines.length).toBe(3);
    const a = analysePgbench(lines, new Map([[0, 1], [1, 1]]), 1000_700);
    expect(a.acked).toBe(3);
    expect(a.lost).toBe(1);
    expect(a.stallMs).toBe(3000);
    expect(a.clientsAlive).toBe(1);
  });
});
