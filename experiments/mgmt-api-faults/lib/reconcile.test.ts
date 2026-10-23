import { describe, expect, test } from "bun:test";
import { reconcile, type Listed } from "./reconcile";

const now = new Date("2026-10-23T10:00:00Z");
const ms = (minAgo: number) => now.getTime() - minAgo * 60_000;
// created_at is deliberately old for every row: MF07e saw it precede the create by minutes,
// so classification must not depend on it.
const p = (ref: string, name: string, org?: string): Listed => ({ ref, name, created_at: "2026-10-23T09:00:00Z", org });

describe("reconcile", () => {
  const listed = [p("r1", "mf-a"), p("r2", "mf-b"), p("r3", "mf-c"), p("r4", "mf-d"), p("r5", "other")];
  const ledger = [{ name: "mf-a", ref: "r1" }, { name: "mf-b" }, { name: "mf-gone", ref: "r9" }];
  const prior = { r3: ms(20), r8: ms(60) };
  const r = reconcile(listed, ledger, { prefix: "mf-", now, graceMs: 5 * 60_000, firstSeen: prior });

  test("matches by ref or by name", () => {
    expect(r.tracked.map((x) => x.ref).sort()).toEqual(["r1", "r2"]);
  });
  test("an unmatched project first seen before the grace window is an orphan", () => {
    expect(r.orphan.map((x) => x.ref)).toEqual(["r3"]);
  });
  test("an unmatched project first seen now is young, whatever its created_at", () => {
    expect(r.young.map((x) => x.ref)).toEqual(["r4"]);
  });
  test("state carries first sightings forward and drops refs no longer listed", () => {
    expect(r.firstSeen).toEqual({ r3: ms(20), r4: now.getTime() });
  });
  test("ignores other prefixes", () => {
    expect([...r.tracked, ...r.young, ...r.orphan].map((x) => x.ref)).not.toContain("r5");
  });
  test("reports ledger entries with no listed project", () => {
    expect(r.absent).toEqual([{ name: "mf-gone", ref: "r9" }]);
  });
  test("grace 0 flags an unmatched project on first sight", () => {
    const x = reconcile([p("r4", "mf-d")], [], { prefix: "mf-", now, graceMs: 0 });
    expect(x.orphan.map((y) => y.ref)).toEqual(["r4"]);
  });
  test("a second pass after the grace window turns young into orphan", () => {
    const first = reconcile([p("r4", "mf-d")], [], { prefix: "mf-", now, graceMs: 30_000 });
    expect(first.young.length).toBe(1);
    const later = reconcile([p("r4", "mf-d")], [], { prefix: "mf-", now: new Date(now.getTime() + 31_000), graceMs: 30_000, firstSeen: first.firstSeen });
    expect(later.orphan.map((y) => y.ref)).toEqual(["r4"]);
  });
  test("an org filter drops projects listed under another org", () => {
    const x = reconcile([p("ra", "mf-x", "o2"), p("rb", "mf-y", "o1")], [], { prefix: "mf-", now, org: "o1", graceMs: 0 });
    expect(x.orphan.map((y) => y.ref)).toEqual(["rb"]);
  });
});
