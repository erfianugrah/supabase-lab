import { describe, expect, test } from "bun:test";
import { findPoolerHosts } from "./lint-pooler-hosts";

// Fixtures are assembled at run time so this file does not itself contain a
// literal the lint would flag when run over the repo.
const host = (n: number, region: string) => `${["aws", String(n), region].join("-")}.pooler.supabase.com`;

describe("findPoolerHosts", () => {
  test("flags aws-0 in a URL, a .env line and a YAML value", () => {
    const text = [
      `DATABASE_URL=postgres://postgres.abc:pw@${host(0, "ap-southeast-1")}:6543/postgres`,
      `host: ${host(0, "us-east-1")}`,
      `const h = "${host(0, "eu-central-1")}";`,
    ].join("\n");
    const hits = findPoolerHosts("x.env", text);
    expect(hits.map((h) => h.line)).toEqual([1, 2, 3]);
    expect(hits[0]?.host).toBe(host(0, "ap-southeast-1"));
  });

  test("default mode leaves other prefixes alone; --all-prefixes flags them", () => {
    const text = `host=${host(1, "ap-southeast-1")}`;
    expect(findPoolerHosts("f", text)).toHaveLength(0);
    expect(findPoolerHosts("f", text, true)).toHaveLength(1);
  });

  test("does not flag the dedicated pooler, direct host, or a lookalike domain", () => {
    const text = ["db.abcdefghijklmnopqrst.supabase.co:6543", "aws-0-ap-southeast-1.pooler.example.com"].join("\n");
    expect(findPoolerHosts("f", text)).toHaveLength(0);
  });

  test("allow marker suppresses a line", () => {
    const text = `host=${host(0, "us-west-1")} # lint-pooler-hosts: allow`;
    expect(findPoolerHosts("f", text)).toHaveLength(0);
  });

  test("two hosts on one line give two hits", () => {
    const text = `${host(0, "us-east-1")} ${host(0, "us-west-1")}`;
    expect(findPoolerHosts("f", text)).toHaveLength(2);
  });
});
