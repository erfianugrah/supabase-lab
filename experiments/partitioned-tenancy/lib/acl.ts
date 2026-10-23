/**
 * Record and restore the default privileges (pg_default_acl) of one role in
 * one schema, exactly as read.
 *
 * PT01a records the rows; PT01i changes them (the data-api-defaults DD01c
 * revoke); PT01z puts back what PT01a recorded, so PT02-PT06 run under the
 * state the project started with: the legacy `arwdDxtm` grant to
 * anon/authenticated/service_role, or the revoked state (DD01c's statements,
 * the lab's wording of the opt-in the platform enforces 2026-10-30). A blanket `grant all` (the earlier PT01z) was
 * right only for the first.
 *
 * Per-schema rows add to the global defaults (ALTER DEFAULT PRIVILEGES docs),
 * so an absent row restores as "every grantee revoked". The restore revokes everything from every grantee named in the
 * current or recorded ACL, then grants the recorded privileges back in the
 * recorded order (grant options included), which reproduces the row as text.
 */

export interface DefaultAclRow {
  /** pg_default_acl.defaclobjtype: r tables, S sequences, f functions, T types, n schemas. */
  objtype: string;
  /** defaclacl::text, e.g. {postgres=arwdDxtm/postgres,anon=Dxtm/postgres}. */
  acl: string;
}

export interface AclItem {
  /** Role name; "" is PUBLIC. */
  grantee: string;
  /** Privilege letters without grant-option marks, in ACL order. */
  privs: string;
  /** Letters held WITH GRANT OPTION (subset of privs). */
  grantable: string;
  grantor: string;
}

/** All default-ACL rows for `role` in `schema`, one per object type. */
export const defaultAclSql = (role = "postgres", schema = "public"): string =>
  `select defaclobjtype::text as objtype, defaclacl::text as acl from pg_default_acl
   where defaclrole = ${lit(role)}::regrole and defaclnamespace = ${lit(schema)}::regnamespace order by 1`;

const OBJ: Record<string, { kw: string; privs: Record<string, string> }> = {
  r: { kw: "tables", privs: { a: "insert", r: "select", w: "update", d: "delete", D: "truncate", x: "references", t: "trigger", m: "maintain" } },
  S: { kw: "sequences", privs: { r: "select", w: "update", U: "usage" } },
  f: { kw: "functions", privs: { X: "execute" } },
  T: { kw: "types", privs: { U: "usage" } },
  n: { kw: "schemas", privs: { U: "usage", C: "create" } },
};

const lit = (s: string) => `'${s.replaceAll("'", "''")}'`;
/** PUBLIC for the empty grantee, else the role quoted. */
const ident = (s: string) => (s === "" ? "public" : `"${s.replaceAll('"', '""')}"`);

/**
 * Parse an aclitem[] text ("{a=r/b,...}"; "", "absent" or "{}" = no items).
 * simplify: role names that need quoting (a space, a quote, upper case) are
 * rejected rather than parsed; the lab's roles are plain identifiers.
 */
export function parseAcl(text: string): AclItem[] {
  const t = text.trim();
  if (t === "" || t === "absent" || t === "{}") return [];
  if (!t.startsWith("{") || !t.endsWith("}")) throw new Error(`not an aclitem[]: ${t}`);
  if (t.includes('"')) throw new Error(`quoted role names are not supported: ${t}`);
  return t
    .slice(1, -1)
    .split(",")
    .map((raw) => {
      const m = raw.match(/^([^=]*)=([A-Za-z*]*)\/(.+)$/);
      if (!m) throw new Error(`not an aclitem: ${raw}`);
      const letters = m[2] ?? "";
      let privs = "";
      let grantable = "";
      for (let i = 0; i < letters.length; i++) {
        const c = letters[i] ?? "";
        if (c === "*") continue;
        privs += c;
        if (letters[i + 1] === "*") grantable += c;
      }
      return { grantee: m[1] ?? "", privs, grantable, grantor: m[3] ?? "" };
    });
}

/** Order-independent form of an ACL, for comparing two readings. */
export function normaliseAcl(text: string): string {
  return parseAcl(text)
    .map((i) => `${i.grantee}=${[...i.privs].sort().join("")}*${[...i.grantable].sort().join("")}/${i.grantor}`)
    .sort()
    .join(",");
}

const privList = (objtype: string, letters: string): string =>
  [...letters]
    .map((c) => {
      const kw = OBJ[objtype]?.privs[c];
      if (!kw) throw new Error(`privilege '${c}' is not valid for object type '${objtype}'`);
      return kw;
    })
    .join(", ");

/**
 * Statements that turn the `current` default ACL rows of `role` in `schema`
 * into the `recorded` ones. Object types present in either set are handled;
 * a type absent from `recorded` ends with no per-schema row. Empty string
 * when nothing differs.
 */
export function restoreDefaultAclSql(recorded: DefaultAclRow[], current: DefaultAclRow[], role = "postgres", schema = "public"): string {
  const types = [...new Set([...recorded, ...current].map((r) => r.objtype))].sort();
  const out: string[] = [];
  const pre = `alter default privileges for role ${ident(role)} in schema ${ident(schema)}`;
  for (const ty of types) {
    const o = OBJ[ty];
    if (!o) throw new Error(`unsupported default-ACL object type '${ty}'`);
    const want = recorded.find((r) => r.objtype === ty)?.acl ?? "absent";
    const have = current.find((r) => r.objtype === ty)?.acl ?? "absent";
    if (want === have || (parseAcl(want).length === 0 && parseAcl(have).length === 0)) continue;
    const target = parseAcl(want);
    for (const i of target) {
      if (i.grantor !== role) throw new Error(`grantor ${i.grantor} in ${want}: ALTER DEFAULT PRIVILEGES FOR ROLE ${role} can only grant as ${role}`);
    }
    const grantees = [...new Set([...parseAcl(have), ...target].map((i) => i.grantee))];
    for (const g of grantees) out.push(`${pre} revoke all on ${o.kw} from ${ident(g)};`);
    for (const i of target) {
      const plain = [...i.privs].filter((c) => !i.grantable.includes(c)).join("");
      // Grant in ACL order so the restored row reads back as the same text.
      if (i.grantable) out.push(`${pre} grant ${privList(ty, i.grantable)} on ${o.kw} to ${ident(i.grantee)} with grant option;`);
      if (plain) out.push(`${pre} grant ${privList(ty, plain)} on ${o.kw} to ${ident(i.grantee)};`);
    }
  }
  return out.join("\n");
}

/**
 * Compare two readings type by type. `exact` = same text for every type;
 * `same` = same items regardless of order.
 */
export function compareDefaultAcl(recorded: DefaultAclRow[], now: DefaultAclRow[]): { exact: boolean; same: boolean; diff: string[] } {
  const types = [...new Set([...recorded, ...now].map((r) => r.objtype))].sort();
  const diff: string[] = [];
  let exact = true;
  for (const ty of types) {
    const a = recorded.find((r) => r.objtype === ty)?.acl ?? "absent";
    const b = now.find((r) => r.objtype === ty)?.acl ?? "absent";
    if (a !== b) exact = false;
    if (normaliseAcl(a) !== normaliseAcl(b)) diff.push(`${ty}: recorded ${a} now ${b}`);
  }
  return { exact, same: diff.length === 0, diff };
}

/** Rows as returned by defaultAclSql() through the query endpoint. */
export const asRows = (rows: Record<string, unknown>[]): DefaultAclRow[] =>
  rows.map((r) => ({ objtype: String(r.objtype ?? ""), acl: String(r.acl ?? "") }));

/** One-line rendering for a detail cell: "r={...}; S={...}" or "none". */
export const renderRows = (rows: DefaultAclRow[]): string => rows.map((r) => `${r.objtype}=${r.acl}`).join("; ") || "none";
