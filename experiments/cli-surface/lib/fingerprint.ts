/**
 * A catalog fingerprint: one text line per schema object property, sorted, so
 * two databases can be compared with a set difference. This is how CL01-CL03
 * decide whether a generated diff or a declarative round trip is faithful -
 * by reading the catalogs, not by reading the SQL the tool printed.
 *
 * Coverage is deliberate and finite: relations (kind, owner, RLS enabled and
 * forced, reloptions, comment), columns, constraints, indexes, policies,
 * triggers, functions (full definition, ACL, owner), enum labels, sequences,
 * ACLs on relations, columns, functions and schemas, default privileges and
 * extensions. Anything not on that list is NOT checked, and a clean fingerprint
 * says nothing about it.
 *
 * ACLs are resolved through acldefault() so a NULL ACL (the owner holds
 * everything) and an explicit owner-only ACL compare equal; they are the same
 * privileges.
 */
import { Client } from "pg";

export const FP_SCHEMAS = ["app", "public"];

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

export function fingerprintSql(schemas: string[] = FP_SCHEMAS): string {
  const inList = schemas.map(q).join(",");
  return `
with ns as (select oid, nspname from pg_namespace where nspname in (${inList})),
rel as (
  select c.oid, n.nspname, c.relname, c.relkind, c.relowner, c.relacl, c.relrowsecurity, c.relforcerowsecurity, c.reloptions
  from pg_class c join ns n on n.oid = c.relnamespace
  where c.relkind in ('r','p','v','m','S','f')
),
lines as (
  select 'rel ' || nspname || '.' || relname || ' kind=' || relkind::text || ' owner=' || pg_get_userbyid(relowner)
         || ' rls=' || relrowsecurity || ' force=' || relforcerowsecurity
         || ' opts=' || coalesce(array_to_string(reloptions, ','), '') as l from rel
  union all
  select 'comment rel ' || nspname || '.' || relname || ' ' || obj_description(oid, 'pg_class') from rel where obj_description(oid, 'pg_class') is not null
  union all
  select 'col ' || r.nspname || '.' || r.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
         || ' notnull=' || a.attnotnull || ' default=' || coalesce(pg_get_expr(d.adbin, d.adrelid), '')
         || ' gen=' || a.attgenerated::text || ' identity=' || a.attidentity::text
  from rel r join pg_attribute a on a.attrelid = r.oid and a.attnum > 0 and not a.attisdropped
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  where r.relkind in ('r','p','v','m','f')
  union all
  select 'comment col ' || r.nspname || '.' || r.relname || '.' || a.attname || ' ' || col_description(r.oid, a.attnum)
  from rel r join pg_attribute a on a.attrelid = r.oid and a.attnum > 0 and not a.attisdropped
  where col_description(r.oid, a.attnum) is not null
  union all
  select 'con ' || r.nspname || '.' || r.relname || ' ' || c.conname || ' ' || pg_get_constraintdef(c.oid) || ' validated=' || c.convalidated
  from rel r join pg_constraint c on c.conrelid = r.oid
  union all
  select 'idx ' || pg_get_indexdef(i.indexrelid) from rel r join pg_index i on i.indrelid = r.oid
  union all
  select 'policy ' || schemaname || '.' || tablename || ' ' || policyname || ' permissive=' || permissive
         || ' roles=' || array_to_string(roles, ',') || ' cmd=' || cmd
         || ' using=' || coalesce(qual, '') || ' check=' || coalesce(with_check, '')
  from pg_policies where schemaname in (${inList})
  union all
  select 'trigger ' || r.nspname || '.' || r.relname || ' ' || pg_get_triggerdef(t.oid)
  from rel r join pg_trigger t on t.tgrelid = r.oid and not t.tgisinternal
  union all
  select 'func ' || n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') owner=' || pg_get_userbyid(p.proowner)
         || ' acl=' || coalesce(array_to_string(coalesce(p.proacl, acldefault('f'::"char", p.proowner)), ','), '')
         || ' def=' || replace(pg_get_functiondef(p.oid), E'\\n', ' ')
  from pg_proc p join ns n on n.oid = p.pronamespace where p.prokind in ('f','p') and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
  union all
  select 'enum ' || n.nspname || '.' || t.typname || ' ' || string_agg(e.enumlabel, ',' order by e.enumsortorder)
  from pg_type t join ns n on n.oid = t.typnamespace join pg_enum e on e.enumtypid = t.oid group by n.nspname, t.typname
  union all
  select 'seq ' || r.nspname || '.' || r.relname || ' start=' || s.seqstart || ' inc=' || s.seqincrement || ' min=' || s.seqmin || ' max=' || s.seqmax || ' cache=' || s.seqcache || ' cycle=' || s.seqcycle
  from rel r join pg_sequence s on s.seqrelid = r.oid
  union all
  select 'acl rel ' || r.nspname || '.' || r.relname || ' ' || pg_get_userbyid(x.grantor) || '->' || coalesce(nullif(pg_get_userbyid(x.grantee), '-'), 'PUBLIC') || ' ' || x.privilege_type || ' grant=' || x.is_grantable
  from rel r cross join lateral aclexplode(coalesce(r.relacl, acldefault((case r.relkind when 'S' then 's' else 'r' end)::"char", r.relowner))) x
  union all
  select 'acl col ' || r.nspname || '.' || r.relname || '.' || a.attname || ' ' || coalesce(nullif(pg_get_userbyid(x.grantee), '-'), 'PUBLIC') || ' ' || x.privilege_type
  from rel r join pg_attribute a on a.attrelid = r.oid and a.attacl is not null and not a.attisdropped
  cross join lateral aclexplode(a.attacl) x
  union all
  select 'acl schema ' || n.nspname || ' ' || coalesce(nullif(pg_get_userbyid(x.grantee), '-'), 'PUBLIC') || ' ' || x.privilege_type
  from pg_namespace n cross join lateral aclexplode(coalesce(n.nspacl, acldefault('n'::"char", n.nspowner))) x where n.nspname in (${inList})
  union all
  select 'defacl ' || pg_get_userbyid(d.defaclrole) || ' in ' || coalesce(n.nspname, '*') || ' type=' || d.defaclobjtype::text || ' '
         || coalesce(nullif(pg_get_userbyid(x.grantee), '-'), 'PUBLIC') || ' ' || x.privilege_type
  from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace
  cross join lateral aclexplode(d.defaclacl) x
  where n.nspname is null or n.nspname in (${inList})
  union all
  select 'ext ' || e.extname || ' schema=' || n.nspname from pg_extension e join pg_namespace n on n.oid = e.extnamespace
)
select l from lines order by l`;
}

export async function fingerprint(url: string, schemas: string[] = FP_SCHEMAS): Promise<string[]> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    const r = await c.query(fingerprintSql(schemas));
    return r.rows.map((x: { l: string }) => x.l);
  } finally {
    await c.end();
  }
}

export interface FpDiff {
  onlyA: string[];
  onlyB: string[];
  same: number;
}

export function diffFingerprints(a: string[], b: string[]): FpDiff {
  const A = new Set(a);
  const B = new Set(b);
  return { onlyA: a.filter((x) => !B.has(x)), onlyB: b.filter((x) => !A.has(x)), same: a.filter((x) => B.has(x)).length };
}

/** `kind` of a fingerprint line: its first word, plus `rel`/`col` for ACL and comment lines. */
export function lineKind(l: string): string {
  const w = l.split(" ");
  return w[0] === "acl" || w[0] === "comment" ? `${w[0]} ${w[1]}` : (w[0] ?? "");
}

export function countByKind(lines: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const l of lines) out[lineKind(l)] = (out[lineKind(l)] ?? 0) + 1;
  return out;
}
