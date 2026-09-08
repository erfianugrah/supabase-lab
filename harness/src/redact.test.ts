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
import { redact } from "../scripts/publish-evidence";

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
];

describe("redact removes every identifier class from a published artifact", () => {
  for (const c of CASES) {
    test(c.name, () => {
      expect(redact(c.input)).toBe(c.expected);
    });
  }

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
