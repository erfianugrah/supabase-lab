/**
 * Return the live project to baseline-only between rehearsals, without
 * destroying it.
 *
 *   bun scripts/live-reset.ts <live-ref> <ready-ref>           list only
 *   bun scripts/live-reset.ts <live-ref> <ready-ref> --apply   drop, then
 *                                                               reapply baseline
 *
 * The ready ref is passed only so the script can refuse to run against it.
 * What is dropped: everything a coding agent could have added on top of
 * sql/00-baseline.sql - relations, functions, types and standalone sequences
 * in public and private (except the baseline helpers), extra policies,
 * columns, constraints, indexes and triggers on departments/profiles, extra
 * triggers on auth.users that call public/private functions, and the
 * migration history rows the agent's migrations wrote. Afterwards the
 * baseline file is reapplied (it is idempotent and resets grants and the
 * baseline policies) and the inventory is re-run; it must come back empty.
 *
 * Kept: auth.users and every row in departments and profiles (the seeded
 * users), extensions and anything they own. Other schemas, storage buckets
 * and Edge Functions are reported for review, never dropped.
 *
 * The PAT comes from SUPABASE_ACCESS_TOKEN in the environment.
 */
import { readFileSync } from "node:fs";

const API = "https://api.supabase.com/v1";
const TOK = process.env.SUPABASE_ACCESS_TOKEN ?? "";
if (!TOK) throw new Error("no SUPABASE_ACCESS_TOKEN in the environment");

const [live, ready, ...flags] = process.argv.slice(2);
const apply = flags.includes("--apply");
if (!live || !ready) throw new Error("usage: live-reset.ts <live-ref> <ready-ref> [--apply]");
if (live === ready) throw new Error("live and ready refs are the same - refusing");

async function sql(query: string): Promise<Record<string, unknown>[]> {
  const r = await fetch(`${API}/projects/${live}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOK}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`sql http ${r.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : [];
}

// One row per object: ord (drop order), kind, name, and the statement that
// removes it (null = report only).
const INVENTORY = `
with ext as (select objid from pg_depend where deptype = 'e'),
base_tables(t) as (values ('departments'), ('profiles')),
base_policies(t, p) as (values
  ('departments', 'departments: own'),
  ('profiles', 'profiles: same department'),
  ('profiles', 'profiles: update self')),
base_cols(t, c) as (values
  ('departments', 'id'), ('departments', 'name'),
  ('profiles', 'id'), ('profiles', 'department_id'),
  ('profiles', 'role'), ('profiles', 'display_name')),
base_cons(n) as (values
  ('departments_pkey'), ('departments_name_key'),
  ('profiles_pkey'), ('profiles_id_fkey'),
  ('profiles_department_id_fkey'), ('profiles_role_check')),
base_idx(n) as (values
  ('departments_pkey'), ('departments_name_key'),
  ('profiles_pkey'), ('profiles_department_id_idx')),
base_private_fns(n) as (values ('my_department'), ('is_manager'), ('sync_profile')),
known_schemas(n) as (values
  ('public'), ('private'), ('auth'), ('storage'), ('extensions'), ('graphql'),
  ('graphql_public'), ('realtime'), ('_realtime'), ('vault'), ('pgbouncer'),
  ('supabase_functions'), ('supabase_migrations'), ('net'), ('cron'),
  ('pgsodium'), ('pgsodium_masks'), ('_analytics'), ('information_schema'))
select * from (
  -- policies on baseline tables that the baseline did not create
  select 10 as ord, 'policy' as kind, format('%I on public.%I', policyname, tablename) as name,
         format('drop policy if exists %I on public.%I', policyname, tablename) as stmt
    from pg_policies
   where schemaname = 'public' and tablename in (select t from base_tables)
     and (tablename, policyname) not in (select t, p from base_policies)
  union all
  -- triggers on baseline tables (the baseline has none)
  select 11, 'trigger', format('%I on public.%I', tg.tgname, c.relname),
         format('drop trigger if exists %I on public.%I', tg.tgname, c.relname)
    from pg_trigger tg join pg_class c on c.oid = tg.tgrelid
   where c.relnamespace = 'public'::regnamespace and c.relname in (select t from base_tables)
     and not tg.tgisinternal
  union all
  -- constraints on baseline tables beyond the baseline's own
  select 12, 'constraint', format('%I on public.%I', con.conname, c.relname),
         format('alter table public.%I drop constraint if exists %I cascade', c.relname, con.conname)
    from pg_constraint con join pg_class c on c.oid = con.conrelid
   where c.relnamespace = 'public'::regnamespace and c.relname in (select t from base_tables)
     and con.conname not in (select n from base_cons) and con.contype <> 'n'
  union all
  -- indexes on baseline tables beyond the baseline's own
  select 13, 'index', format('public.%I', i.relname),
         format('drop index if exists public.%I', i.relname)
    from pg_index x join pg_class i on i.oid = x.indexrelid join pg_class c on c.oid = x.indrelid
   where c.relnamespace = 'public'::regnamespace and c.relname in (select t from base_tables)
     and i.relname not in (select n from base_idx)
     and not exists (select 1 from pg_constraint k where k.conindid = x.indexrelid)
  union all
  -- columns added to baseline tables
  select 14, 'column', format('public.%I.%I', c.relname, a.attname),
         format('alter table public.%I drop column if exists %I cascade', c.relname, a.attname)
    from pg_attribute a join pg_class c on c.oid = a.attrelid
   where c.relnamespace = 'public'::regnamespace and c.relname in (select t from base_tables)
     and a.attnum > 0 and not a.attisdropped
     and (c.relname, a.attname) not in (select t, c from base_cols)
  union all
  -- relations in public (other than the baseline tables) and private
  select case c.relkind when 'v' then 20 when 'm' then 21 when 'f' then 22 else 23 end,
         case c.relkind when 'v' then 'view' when 'm' then 'materialized view'
                        when 'f' then 'foreign table' else 'table' end,
         format('%I.%I', n.nspname, c.relname),
         format('drop %s if exists %I.%I cascade',
                case c.relkind when 'v' then 'view' when 'm' then 'materialized view'
                               when 'f' then 'foreign table' else 'table' end,
                n.nspname, c.relname)
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('public', 'private') and c.relkind in ('r', 'p', 'v', 'm', 'f')
     and not c.relispartition
     and not (n.nspname = 'public' and c.relname in (select t from base_tables))
     and c.oid not in (select objid from ext)
  union all
  -- standalone sequences (identity/serial sequences go with their table)
  select 24, 'sequence', format('%I.%I', n.nspname, c.relname),
         format('drop sequence if exists %I.%I cascade', n.nspname, c.relname)
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('public', 'private') and c.relkind = 'S'
     and c.oid not in (select objid from ext)
     and not exists (select 1 from pg_depend d
                      where d.objid = c.oid and d.classid = 'pg_class'::regclass
                        and d.deptype in ('a', 'i'))
  union all
  -- functions and procedures, except the baseline helpers
  select 30, case p.prokind when 'p' then 'procedure' when 'a' then 'aggregate' else 'function' end,
         format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)),
         format('drop %s if exists %I.%I(%s) cascade',
                case p.prokind when 'p' then 'procedure' when 'a' then 'aggregate' else 'function' end,
                n.nspname, p.proname, pg_get_function_identity_arguments(p.oid))
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'private')
     and p.oid not in (select objid from ext)
     and not (n.nspname = 'private' and p.proname in (select n from base_private_fns))
  union all
  -- standalone types: enums, domains, ranges, composite types
  select 40, case t.typtype when 'd' then 'domain' else 'type' end,
         format('%I.%I', n.nspname, t.typname),
         format('drop %s if exists %I.%I cascade',
                case t.typtype when 'd' then 'domain' else 'type' end, n.nspname, t.typname)
    from pg_type t join pg_namespace n on n.oid = t.typnamespace
    left join pg_class c on c.oid = t.typrelid
   where n.nspname in ('public', 'private')
     and t.oid not in (select objid from ext)
     and (t.typtype in ('e', 'd', 'r') or (t.typtype = 'c' and c.relkind = 'c'))
  union all
  -- triggers on auth.users that call kit-side functions, except the baseline's
  select 50, 'auth trigger', format('%I on auth.users', tg.tgname),
         format('drop trigger if exists %I on auth.users', tg.tgname)
    from pg_trigger tg join pg_proc p on p.oid = tg.tgfoid
   where tg.tgrelid = 'auth.users'::regclass and not tg.tgisinternal
     and tg.tgname <> 'on_auth_user_synced'
     and p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
  union all
  -- migration history written by the agent's migrations (the baseline is
  -- applied as plain SQL, so it has no rows here)
  select 60, 'migration history', format('%s row(s)', cnt), 'delete from supabase_migrations.schema_migrations'
    from (select case when to_regclass('supabase_migrations.schema_migrations') is null then 0
                      else (xpath('/row/n/text()', query_to_xml(
                              'select count(*) as n from supabase_migrations.schema_migrations',
                              false, true, '')))[1]::text::int end as cnt) m
   where cnt > 0
  union all
  -- report only: schemas nobody in the kit created
  select 90, 'schema (review, not dropped)', n.nspname, null
    from pg_namespace n
   where n.nspname not like 'pg\\_%' and n.nspname not in (select n from known_schemas)
     and n.oid not in (select objid from ext)
  union all
  select 91, 'storage bucket (review, not dropped)', b.id, null from storage.buckets b
) inv
order by ord, name`;

type Row = { ord: number; kind: string; name: string; stmt: string | null };

async function inventory(): Promise<Row[]> {
  return (await sql(INVENTORY)) as Row[];
}

async function counts(): Promise<string> {
  const [r] = await sql(
    `select (select count(*) from auth.users) as users,
            (select count(*) from public.profiles) as profiles,
            (select count(*) from public.departments) as departments`,
  );
  return `users=${r.users} profiles=${r.profiles} departments=${r.departments}`;
}

function show(rows: Row[]): void {
  if (rows.length === 0) {
    console.log("  (nothing beyond the baseline)");
    return;
  }
  for (const r of rows) console.log(`  ${r.stmt ? "drop  " : "review"} ${r.kind.padEnd(36)} ${r.name}`);
}

console.log(`live project: ${live}`);
console.log(`before: ${await counts()}`);
const plan = await inventory();
console.log("plan:");
show(plan);

const drops = plan.filter((r) => r.stmt).map((r) => r.stmt as string);
if (!apply) {
  console.log(drops.length ? `\n${drops.length} object(s) would be dropped - re-run with --apply` : "\nnothing to drop");
  process.exit(0);
}

if (drops.length > 0) {
  await sql(`begin;\n${drops.join(";\n")};\ncommit;`);
  console.log(`dropped ${drops.length} object(s)`);
}
await sql(readFileSync("sql/00-baseline.sql", "utf8"));
console.log("reapplied sql/00-baseline.sql");

const after = await inventory();
console.log(`after: ${await counts()}`);
console.log("remaining:");
show(after);
if (after.some((r) => r.stmt)) {
  console.error("reset incomplete: objects above still present");
  process.exit(1);
}
