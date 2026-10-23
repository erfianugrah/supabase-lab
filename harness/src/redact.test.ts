/**
 * Cases for the publish-evidence redactor, one per class it has to remove.
 *
 * Fixture values are synthetic on purpose: identifiers.test.ts scans tracked
 * source for these shapes, and a test that pasted the real PAT id to prove it
 * gets redacted would itself be the leak.
 *
 * The credential-id rows exist because they were missed: audit-integrity A03d
 * captures the provenance comment the platform appends to statements it runs
 * ("-- user: pat:<digits>"), and four artifacts were published on 2026-09-08
 * carrying the account's real PAT id before the rule existed. Every row here
 * is a defect that reached a published file or would have.
 */
import { describe, expect, test } from "bun:test";
import { REF_SHAPE, redact } from "../scripts/publish-evidence";

const CASES: { name: string; input: string; expected: string }[] = [
  {
    name: "project ref on its own",
    input: "project abcdefghijklmnopqrst is healthy",
    expected: "project <ref> is healthy",
  },
  {
    name: "database hostname",
    input: "host db.abcdefghijklmnopqrst.supabase.co",
    expected: "host db.<ref>.supabase.co",
  },
  {
    name: "api hostname",
    input: "https://abcdefghijklmnopqrst.supabase.co/auth/v1/token",
    expected: "https://<ref>.supabase.co/auth/v1/token",
  },
  {
    name: "pooler hostname",
    input: "aws-0-ap-southeast-1.pooler.supabase.com:5432",
    expected: "<pooler-host>:5432",
  },
  // work-supabase-lab#10: `\b` treats `_` as a word character, so a ref joined
  // with underscores passed through - in a measurement key and in a value.
  {
    name: "project ref after an underscore (measurement key)",
    input: '{"postgres_abcdefghijklmnopqrst":1}',
    expected: '{"postgres_<ref>":1}',
  },
  {
    name: "project ref before an underscore (value)",
    input: '{"user":"abcdefghijklmnopqrst_ok"}',
    expected: '{"user":"<ref>_ok"}',
  },
  {
    name: "a 21-letter lowercase word is not a ref",
    input: "abcdefghijklmnopqrstu stays",
    expected: "abcdefghijklmnopqrstu stays",
  },
  {
    name: "email address",
    input: "actor somebody@example.org logged in",
    expected: "actor <email> logged in",
  },
  {
    name: "PAT id in a provenance comment",
    input: "-- user: pat:1234567",
    expected: "-- user: pat:<id>",
  },
  {
    name: "OAuth client id in a provenance comment",
    input: "-- user: oauth:0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d",
    expected: "-- user: oauth:<id>",
  },
  // Stack traces and captured stderr name the operator's home directory
  // (auth-providers AU03, pooler-checkout PC03, 2026-10-10); caught by the
  // 2026-10-13 backlog plan's dry-run before either was published.
  {
    name: "macOS home directory in a stack trace",
    input: "at run (/Users/someone/work/lab/tests/x.ts:10:5)",
    expected: "at run (~/work/lab/tests/x.ts:10:5)",
  },
  {
    name: "Linux home directory",
    input: "open /home/someone/.cache/x failed",
    expected: "open ~/.cache/x failed",
  },
  // redact() runs on the raw JSON text, where a newline inside a string is
  // the two characters `\n`: the ref after it read as a 21-letter token and
  // survived, in usage-metering M05a's per-project list (one ref per line),
  // caught by hand before publishing on 2026-10-13.
  {
    name: "ref after a JSON-escaped newline or tab",
    input: '"<ref> $9.81/mo\\nabcdefghijklmnopqrst $9.81/mo\\tabcdefghijklmnopqrst"',
    expected: '"<ref> $9.81/mo\\n<ref> $9.81/mo\\t<ref>"',
  },
];

describe("redact removes every identifier class from a published artifact", () => {
  for (const c of CASES) {
    test(c.name, () => {
      expect(redact(c.input)).toBe(c.expected);
    });
  }

  test("the leftover check and the identifier scan see a ref behind a JSON escape", () => {
    expect('x\\nabcdefghijklmnopqrst y'.match(REF_SHAPE)).toEqual(["abcdefghijklmnopqrst"]);
    expect("postgres_abcdefghijklmnopqrst".match(REF_SHAPE)).toEqual(["abcdefghijklmnopqrst"]);
    expect("nabcdefghijklmnopqrst".match(REF_SHAPE)).toBeNull();
  });

  test("a full provenance footer survives with nothing identifying left", () => {
    const footer = [
      "statement: create table public.probe(a int)",
      "-- source: POST /v1/projects/:ref/database/query",
      "-- user: pat:1234567",
      "-- date: 2026-09-08T05:40:26.577Z",
    ].join("\n");
    const out = redact(footer);
    expect(out).toContain("pat:<id>");
    expect(out).not.toMatch(/pat:\d/);
    expect(out).toContain("-- date: 2026-09-08T05:40:26.577Z");
  });
});

// The vantage's own egress address reached four tls-surface artifacts on
// 2026-10-02 (Postgres names the client in hba refusals and
// inet_client_addr()). Addresses are redacted by literal, not by shape:
// other artifacts deliberately carry documentation-range addresses as test
// inputs (x-forwarded-for=203.0.113.9), and a shape rule would erase them.
describe("redact removes the addresses it is told to, and only those", () => {
  test("the Erlang tuple form Supavisor prints becomes {<vantage-ip>}", () => {
    expect(redact("(EADDRNOTALLOWED) address not in tenant allow_list: {192, 0, 2, 44}", ["192.0.2.44"])).toBe(
      "(EADDRNOTALLOWED) address not in tenant allow_list: {<vantage-ip>}",
    );
    expect(redact("allow_list: {192, 0, 2, 4}", ["192.0.2.44"])).toBe("allow_list: {192, 0, 2, 4}");
  });
  test("a listed IPv6 literal followed by :port is still replaced", () => {
    expect(redact("connect ECONNREFUSED 2001:db8:1:2::abcd:5432", [], ["2001:db8:1:2::abcd"])).toBe("connect ECONNREFUSED <addr>:5432");
    expect(redact("2001:db8:1:2::abcd:5432:1", [], ["2001:db8:1:2::abcd"])).toBe("2001:db8:1:2::abcd:5432:1");
  });
  test("a listed IPv4 literal followed by :port is replaced (2026-10-23, #208)", () => {
    expect(redact("connect ECONNREFUSED 192.0.2.44:6543", [], ["192.0.2.44"])).toBe("connect ECONNREFUSED <addr>:6543");
    expect(redact("192.0.2.4:6543", [], ["192.0.2.44"])).toBe("192.0.2.4:6543");
    // IPv4 has no longer-address reading, so a colon after the port is text
    // (`<addr>:5432: connection refused`) and must not shield the address.
    expect(redact("192.0.2.44:6543:1", [], ["192.0.2.44"])).toBe("<addr>:6543:1");
    expect(redact("192.0.2.44:5432: Connection refused", [], ["192.0.2.44"])).toBe("<addr>:5432: Connection refused");
    expect(redact("192.0.2.44:65432", [], ["192.0.2.44"])).toBe("<addr>:65432");
  });
  test("a listed IPv4 literal becomes <vantage-ip>", () => {
    expect(redact('no pg_hba.conf entry for host "192.0.2.44", user "postgres"', ["192.0.2.44"])).toBe('no pg_hba.conf entry for host "<vantage-ip>", user "postgres"');
  });
  test("a listed literal is matched whole, not as a prefix of a longer address", () => {
    expect(redact("192.0.2.4 and 192.0.2.44", ["192.0.2.4"])).toBe("<vantage-ip> and 192.0.2.44");
  });
  test("operator-named addresses become <addr>, IPv6 included", () => {
    expect(redact("from 2001:db8::7 and 198.51.100.20 via 192.0.2.44", ["192.0.2.44"], ["2001:db8::7", "198.51.100.20"])).toBe("from <addr> and <addr> via <vantage-ip>");
  });
  test("unlisted addresses and version strings are left alone", () => {
    const s = "x-forwarded-for=203.0.113.9 image supabase-postgres-17.6.1.171 pinned to 1.1.1.1";
    expect(redact(s, ["192.0.2.44"])).toBe(s);
  });
});

// sqlite-edge-compare (2026-10-15): Turso database hostnames carry the org
// slug and workers.dev hostnames the account's subdomain, so both go by shape;
// shapeless account ids (a D1 database id, an org slug inside an error body)
// go by literal through PVLAB_REDACT_LITERALS.
describe("redact: edge vendors", () => {
  test("Turso database host", () => {
    expect(redact("url https://sec-td-x-someorg.aws-ap-southeast-2.turso.io/v2/pipeline")).toBe("url https://<turso-host>/v2/pipeline");
  });
  test("workers.dev host", () => {
    expect(redact("POST https://sec-probe-x.somesub.workers.dev/run")).toBe("POST https://<worker-host>/run");
  });
  test("api.turso.tech is a public endpoint and stays", () => {
    expect(redact("https://api.turso.tech/v1/locations")).toBe("https://api.turso.tech/v1/locations");
  });
  test("literals, longest first; short ones ignored", () => {
    expect(redact("org someorg db 0f0f0f0f-1111-2222-3333-444444444444 abc", [], [], ["someorg", "0f0f0f0f-1111-2222-3333-444444444444", "abc"])).toBe("org <id> db <id> abc");
  });
});
