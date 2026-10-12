import { expect, test } from "bun:test";
import { needleCounter } from "./read";

test("needle counter finds matches inside and across windows", () => {
  const c = needleCounter("MARKER");
  const e = (s: string) => new TextEncoder().encode(s);
  c.feed(e("xxMARKERyyMAR"));
  c.feed(e("KERzzMA"));
  c.feed(e("RKER"));
  c.feed(e("nothing"));
  expect(c.hits).toBe(3);
});
