import { describe, expect, test } from "bun:test";
import { compareDefaultAcl, normaliseAcl, parseAcl, restoreDefaultAclSql, type DefaultAclRow } from "./acl";

// The two states PT01a can read: the legacy grant (data-api-defaults DD01a,
// partitioned-tenancy PT01a 2026-10-22) and the state after the DD01c revoke
// (PT01i's new-partition ACL, 2026-10-22).
const LEGACY_R = "{postgres=arwdDxtm/postgres,anon=arwdDxtm/postgres,authenticated=arwdDxtm/postgres,service_role=arwdDxtm/postgres}";
const REVOKED_R = "{postgres=arwdDxtm/postgres,anon=Dxtm/postgres,authenticated=Dxtm/postgres,service_role=Dxtm/postgres}";
const LEGACY_S = "{postgres=rwU/postgres,anon=rwU/postgres,authenticated=rwU/postgres,service_role=rwU/postgres}";
const REVOKED_S = "{postgres=rwU/postgres,anon=w/postgres,authenticated=w/postgres,service_role=w/postgres}";
const PRE = "alter default privileges for role \"postgres\" in schema \"public\"";

const legacy: DefaultAclRow[] = [
  { objtype: "S", acl: LEGACY_S },
  { objtype: "r", acl: LEGACY_R },
];
const revoked: DefaultAclRow[] = [
  { objtype: "S", acl: REVOKED_S },
  { objtype: "r", acl: REVOKED_R },
];

describe("parseAcl", () => {
  test("reads grantee, privileges and grantor; PUBLIC is the empty grantee", () => {
    expect(parseAcl("{=X/postgres,anon=Dxtm/postgres}")).toEqual([
      { grantee: "", privs: "X", grantable: "", grantor: "postgres" },
      { grantee: "anon", privs: "Dxtm", grantable: "", grantor: "postgres" },
    ]);
  });
  test("a star marks the letter before it as held with grant option", () => {
    expect(parseAcl("{anon=r*w/postgres}")[0]).toEqual({ grantee: "anon", privs: "rw", grantable: "r", grantor: "postgres" });
  });
  test("absent, empty and {} are no items; garbage and quoted roles throw", () => {
    expect(parseAcl("absent")).toEqual([]);
    expect(parseAcl("")).toEqual([]);
    expect(parseAcl("{}")).toEqual([]);
    expect(() => parseAcl("arwd")).toThrow();
    expect(() => parseAcl('{"a b"=r/postgres}')).toThrow();
  });
});

describe("restoreDefaultAclSql", () => {
  test("restoring the revoked state over the legacy grant revokes, it does not grant all (the DD01c / opt-in case)", () => {
    const s = restoreDefaultAclSql(revoked, legacy);
    expect(s).not.toMatch(/grant all/);
    // every grantee is cleared, then the recorded letters come back in ACL order
    expect(s.split("\n")).toEqual([
      `${PRE} revoke all on sequences from "postgres";`,
      `${PRE} revoke all on sequences from "anon";`,
      `${PRE} revoke all on sequences from "authenticated";`,
      `${PRE} revoke all on sequences from "service_role";`,
      `${PRE} grant select, update, usage on sequences to "postgres";`,
      `${PRE} grant update on sequences to "anon";`,
      `${PRE} grant update on sequences to "authenticated";`,
      `${PRE} grant update on sequences to "service_role";`,
      `${PRE} revoke all on tables from "postgres";`,
      `${PRE} revoke all on tables from "anon";`,
      `${PRE} revoke all on tables from "authenticated";`,
      `${PRE} revoke all on tables from "service_role";`,
      `${PRE} grant insert, select, update, delete, truncate, references, trigger, maintain on tables to "postgres";`,
      `${PRE} grant truncate, references, trigger, maintain on tables to "anon";`,
      `${PRE} grant truncate, references, trigger, maintain on tables to "authenticated";`,
      `${PRE} grant truncate, references, trigger, maintain on tables to "service_role";`,
    ]);
  });

  test("restoring the legacy state over the revoked one grants the four DML letters back", () => {
    const s = restoreDefaultAclSql(legacy, revoked);
    expect(s).toContain(`${PRE} grant insert, select, update, delete, truncate, references, trigger, maintain on tables to "anon";`);
    expect(s).toContain(`${PRE} grant select, update, usage on sequences to "service_role";`);
  });

  test("nothing to do when the rows already match", () => {
    expect(restoreDefaultAclSql(revoked, revoked)).toBe("");
    expect(restoreDefaultAclSql([], [])).toBe("");
  });

  test("a type absent from the recording is cleared, not left as found", () => {
    const s = restoreDefaultAclSql([{ objtype: "r", acl: REVOKED_R }], revoked);
    expect(s).toContain(`${PRE} revoke all on sequences from "anon";`);
    expect(s).not.toMatch(/grant [a-z, ]+ on sequences/);
  });

  test("a grantee present now but not in the recording is revoked", () => {
    const now: DefaultAclRow[] = [{ objtype: "r", acl: `${REVOKED_R.slice(0, -1)},extra=r/postgres}` }];
    expect(restoreDefaultAclSql([{ objtype: "r", acl: REVOKED_R }], now)).toContain(`${PRE} revoke all on tables from "extra";`);
  });

  test("grant options and PUBLIC survive the round trip", () => {
    const s = restoreDefaultAclSql([{ objtype: "f", acl: "{=X/postgres,anon=X*/postgres}" }], []);
    expect(s.split("\n")).toEqual([
      `${PRE} revoke all on functions from public;`,
      `${PRE} revoke all on functions from "anon";`,
      `${PRE} grant execute on functions to public;`,
      `${PRE} grant execute on functions to "anon" with grant option;`,
    ]);
  });

  test("refuses what ALTER DEFAULT PRIVILEGES cannot express", () => {
    expect(() => restoreDefaultAclSql([{ objtype: "r", acl: "{anon=r/someone_else}" }], [])).toThrow(/grantor/);
    expect(() => restoreDefaultAclSql([{ objtype: "S", acl: "{anon=X/postgres}" }], [])).toThrow(/not valid/);
    expect(() => restoreDefaultAclSql([{ objtype: "L", acl: "{anon=r/postgres}" }], [])).toThrow(/unsupported/);
  });
});

describe("compareDefaultAcl", () => {
  test("legacy against revoked differs on both types", () => {
    const c = compareDefaultAcl(revoked, legacy);
    expect(c.same).toBe(false);
    expect(c.exact).toBe(false);
    expect(c.diff).toHaveLength(2);
  });
  test("same items in another order are the same but not exact", () => {
    const reordered = [{ objtype: "r", acl: "{anon=Dxtm/postgres,postgres=arwdDxtm/postgres,authenticated=Dxtm/postgres,service_role=Dxtm/postgres}" }];
    const c = compareDefaultAcl([{ objtype: "r", acl: REVOKED_R }], reordered);
    expect(c).toEqual({ exact: false, same: true, diff: [] });
    expect(normaliseAcl(REVOKED_R)).toBe(normaliseAcl(reordered[0]?.acl ?? ""));
  });
  test("an absent row equals an empty one", () => {
    expect(compareDefaultAcl([], [{ objtype: "r", acl: "{}" }]).same).toBe(true);
  });
});
