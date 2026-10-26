import { expect, test } from "bun:test";
import { ranges, spearman } from "./ck06-ranged-reads";

test("spearman: monotone up, monotone down, too few points", () => {
  expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBe(1);
  expect(spearman([1, 2, 3, 4], [40, 30, 20, 10])).toBe(-1);
  expect(spearman([1, 2], [1, 2])).toBe(-2);
});

test("ranges past 2 GiB: a 2250 MiB fixture gets starts beyond 2^31 and stays in bounds", () => {
  const size = 2250 * 1024 * 1024;
  const rs = ranges(size);
  expect(rs.every(([s, e]) => s >= 0 && e <= size && e > s)).toBe(true);
  expect(rs.some(([s]) => s > 2 ** 31)).toBe(true);
});
