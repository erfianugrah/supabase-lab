/**
 * The statements under test, verbatim. Each runs against the fixture from
 * rig.ts: `t (id bigint primary key, a int, b text)` holding N rows and a
 * batch `src` with the same N ids, identical or with 1% of rows changed.
 */
import type { Variant } from "./rig";

export interface Case {
  /** Result-id suffix and report label. */
  key: string;
  variant: Variant;
  /** Run on the measuring connection before the checkpoint (not measured). */
  pre?: string[];
  stmt: string;
  /** Needs a server function; the module checks it exists and skips the case otherwise. */
  needsFunction?: string;
}

/** Plain upsert: every conflicting row is updated, changed or not. */
export const UPSERT_PLAIN = `insert into public.t as t (id, a, b)
  select id, a, b from public.src
  on conflict (id) do update set a = excluded.a, b = excluded.b`;

/** Guard on the DO UPDATE: only rows whose values differ are updated. */
export const UPSERT_GUARDED = `insert into public.t as t (id, a, b)
  select id, a, b from public.src
  on conflict (id) do update set a = excluded.a, b = excluded.b
  where (t.a, t.b) is distinct from (excluded.a, excluded.b)`;

/**
 * Filter the batch against the table first, so unchanged rows never reach ON
 * CONFLICT at all; the DO UPDATE guard stays for rows a concurrent writer
 * changes between the read and the insert.
 */
export const UPSERT_PREFILTERED = `insert into public.t as t (id, a, b)
  select s.id, s.a, s.b
    from public.src s
    left join public.t cur on cur.id = s.id
   where cur.id is null or (cur.a, cur.b) is distinct from (s.a, s.b)
  on conflict (id) do update set a = excluded.a, b = excluded.b
  where (t.a, t.b) is distinct from (excluded.a, excluded.b)`;

/** MERGE (PG 15+) with the same guard on WHEN MATCHED. */
export const MERGE_GUARDED = `merge into public.t as t
  using public.src as s on t.id = s.id
  when matched and (t.a, t.b) is distinct from (s.a, s.b) then
    update set a = s.a, b = s.b
  when not matched then
    insert (id, a, b) values (s.id, s.a, s.b)`;

export const UPDATE_PLAIN = `update public.t as t set a = s.a, b = s.b
  from public.src s where t.id = s.id`;

export const UPDATE_GUARDED = `update public.t as t set a = s.a, b = s.b
  from public.src s where t.id = s.id
   and (t.a, t.b) is distinct from (s.a, s.b)`;

/**
 * The built-in trigger function. The docs advise naming the trigger so it
 * fires last among BEFORE UPDATE triggers (they fire in name order); this is
 * the only trigger on the table, so the name is for copy-paste safety.
 */
export const SUPPRESS_TRIGGER = `create trigger zzz_suppress_redundant_updates
  before update on public.t
  for each row execute function suppress_redundant_updates_trigger()`;

export const UPSERT_CASES: Case[] = [
  { key: "upsert_plain_identical", variant: "identical", stmt: UPSERT_PLAIN },
  { key: "upsert_guarded_identical", variant: "identical", stmt: UPSERT_GUARDED },
  { key: "upsert_guarded_1pct", variant: "one_pct_differ", stmt: UPSERT_GUARDED },
  { key: "upsert_prefiltered_identical", variant: "identical", stmt: UPSERT_PREFILTERED },
  { key: "upsert_prefiltered_1pct", variant: "one_pct_differ", stmt: UPSERT_PREFILTERED },
  { key: "merge_guarded_identical", variant: "identical", stmt: MERGE_GUARDED },
  { key: "merge_guarded_1pct", variant: "one_pct_differ", stmt: MERGE_GUARDED },
];

export const UPDATE_CASES: Case[] = [
  { key: "update_plain_identical", variant: "identical", stmt: UPDATE_PLAIN },
  { key: "update_guarded_identical", variant: "identical", stmt: UPDATE_GUARDED },
  {
    key: "update_trigger_identical",
    variant: "identical",
    pre: [SUPPRESS_TRIGGER],
    stmt: UPDATE_PLAIN,
    needsFunction: "suppress_redundant_updates_trigger",
  },
  {
    key: "upsert_plain_trigger_identical",
    variant: "identical",
    pre: [SUPPRESS_TRIGGER],
    stmt: UPSERT_PLAIN,
    needsFunction: "suppress_redundant_updates_trigger",
  },
];
