import { describe, expect, test } from "bun:test";
import { classify, lintsFrom, mentions, type AuditRow, type Lint } from "./matrix";

describe("mentions", () => {
  test("whole identifier only", () => {
    expect(mentions("public.av_f01_rls_off", "av_f01_rls_off")).toBe(true);
    expect(mentions("public.av_f01_rls_off_x", "av_f01_rls_off")).toBe(false);
    expect(mentions("Table `public.av_f24_child` has a foreign key", "av_f24_child")).toBe(true);
    expect(mentions("public.av_f24_child_b", "av_f24_child")).toBe(false);
  });
  test("regex metacharacters in a marker are literal", () => {
    expect(mentions("pg_trgm", "pg.trgm")).toBe(false);
  });
});

const rows: AuditRow[] = [
  { severity: "CRITICAL", check: "RLS disabled", object: "public.av_f15_secret_exact" },
  { severity: "HIGH", check: "Secret-shaped column exposed", object: "public.av_f15_secret_exact.password" },
  { severity: "CRITICAL", check: "RLS disabled", object: "public.av_f16_secret_substring" },
];
const lints: Lint[] = [
  { name: "rls_disabled_in_public", level: "ERROR", detail: "Table `public.av_f15_secret_exact` is public, but RLS has not been enabled." },
  { name: "sensitive_columns_exposed", level: "ERROR", detail: "x", metadata: { schema: "public", name: "av_f15_secret_exact" } },
  { name: "rls_disabled_in_public", level: "ERROR", detail: "Table `public.av_f16_secret_substring` is public, but RLS has not been enabled." },
];

describe("classify", () => {
  test("both sides on the category's own checks", () => {
    const c = classify("av_f15_secret_exact", ["Secret-shaped column exposed"], ["sensitive_columns_exposed"], rows, lints);
    expect(c.cell).toBe("both");
    expect(c.audit).toEqual(["HIGH Secret-shaped column exposed"]);
    expect(c.advisors).toEqual(["ERROR sensitive_columns_exposed"]);
    expect(c.otherAudit).toEqual(["CRITICAL RLS disabled"]);
    expect(c.otherAdvisors).toEqual(["ERROR rls_disabled_in_public"]);
  });

  test("incidental findings do not decide the cell", () => {
    const c = classify("av_f16_secret_substring", ["Secret-shaped column exposed"], ["sensitive_columns_exposed"], rows, lints);
    expect(c.cell).toBe("neither");
    expect(c.otherAudit).toEqual(["CRITICAL RLS disabled"]);
    expect(c.otherAdvisors).toEqual(["ERROR rls_disabled_in_public"]);
  });

  test("tool only and advisors only", () => {
    expect(classify("av_f15_secret_exact", ["RLS disabled"], ["nope"], rows, lints).cell).toBe("tool only");
    expect(classify("av_f15_secret_exact", ["nope"], ["rls_disabled_in_public"], rows, lints).cell).toBe("advisors only");
  });

  test("metadata match counts when detail does not name the object", () => {
    const c = classify("av_f15_secret_exact", [], ["sensitive_columns_exposed"], [], lints);
    expect(c.cell).toBe("advisors only");
  });
});

describe("lintsFrom", () => {
  test("reads { lints } and tolerates anything else", () => {
    expect(lintsFrom({ lints: [{ name: "a", level: "INFO", detail: "" }] })).toHaveLength(1);
    expect(lintsFrom({ message: "nope" })).toEqual([]);
    expect(lintsFrom(undefined)).toEqual([]);
  });
});
