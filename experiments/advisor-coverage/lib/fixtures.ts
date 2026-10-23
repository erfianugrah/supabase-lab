/**
 * Seeded fixtures: one deliberate issue per row, each on an object whose name
 * is a unique marker. `auditChecks` are the audit.sql check names that cover
 * the category, `advisorLints` the advisor lint names that cover it, and
 * `predicted` is the cell expected from reading both sources before the run
 * (audit.sql at f8d15fa, supabase/splinter lints at fccca4b). The run records
 * the observed cell next to it; a mismatch is a finding, not a test failure.
 *
 * Grants are explicit wherever exposure matters, so a fixture does not depend
 * on the project's default privileges (data-api-defaults DD01 measured the
 * legacy default ACL on API-created projects; the platform default is moving).
 * The two exceptions read the default on purpose: F09 (the audit's own fix,
 * REVOKE ... FROM PUBLIC, on a function that also got the platform's default
 * grants) and F08.
 */

export type Predicted = "both" | "tool only" | "advisors only" | "neither";

export interface Fixture {
  id: string;
  marker: string;
  category: string;
  /** audit.sql check number(s) this row exercises, or "-" for none. */
  auditNo: string;
  auditChecks: string[];
  advisorLints: string[];
  predicted: Predicted;
  why: string;
  sql: string;
}

const SECDEF_ANON = ["anon_security_definer_function_executable", "authenticated_security_definer_function_executable"];

export const FIXTURES: Fixture[] = [
  {
    id: "F01",
    marker: "av_f01_rls_off",
    category: "table in public, RLS off, granted to anon",
    auditNo: "1",
    auditChecks: ["RLS disabled"],
    advisorLints: ["rls_disabled_in_public"],
    predicted: "both",
    why: "the textbook case",
    sql: `create table public.av_f01_rls_off (id int primary key, note text);
grant select on public.av_f01_rls_off to anon, authenticated;
insert into public.av_f01_rls_off values (1, 'seeded');`,
  },
  {
    id: "F02",
    marker: "av_f02_rls_off_public_grant",
    category: "table in public, RLS off, readable by anon only through a grant to PUBLIC",
    auditNo: "1",
    auditChecks: ["RLS disabled"],
    advisorLints: ["rls_disabled_in_public"],
    predicted: "advisors only",
    why: "audit #1 reads information_schema.role_table_grants for grantee anon/authenticated; the lint uses has_table_privilege, which counts PUBLIC",
    sql: `create table public.av_f02_rls_off_public_grant (id int primary key, note text);
revoke all on public.av_f02_rls_off_public_grant from anon, authenticated;
grant select on public.av_f02_rls_off_public_grant to public;
insert into public.av_f02_rls_off_public_grant values (1, 'seeded');`,
  },
  {
    id: "F03",
    marker: "av_f03_rls_off_api",
    category: "table in a second exposed schema (av_api), RLS off",
    auditNo: "1",
    auditChecks: ["RLS disabled"],
    advisorLints: ["rls_disabled_in_public"],
    predicted: "advisors only",
    why: "audit #1 looks at schema public only; the lint reads pgrst.db_schemas",
    sql: `create schema if not exists av_api;
grant usage on schema av_api to anon, authenticated;
create table av_api.av_f03_rls_off_api (id int primary key, note text);
grant select on av_api.av_f03_rls_off_api to anon, authenticated;
insert into av_api.av_f03_rls_off_api values (1, 'seeded');`,
  },
  {
    id: "F04",
    marker: "av_f04_rls_no_policy",
    category: "RLS on, zero policies",
    auditNo: "2",
    auditChecks: ["RLS on, zero policies"],
    advisorLints: ["rls_enabled_no_policy"],
    predicted: "both",
    why: "same predicate on both sides",
    sql: `create table public.av_f04_rls_no_policy (id int primary key);
alter table public.av_f04_rls_no_policy enable row level security;
grant select on public.av_f04_rls_no_policy to anon, authenticated;`,
  },
  {
    id: "F05",
    marker: "av_f05_anon_select_true",
    category: "SELECT policy USING (true) for anon",
    auditNo: "3",
    auditChecks: ["Policy open to anon"],
    advisorLints: ["rls_policy_always_true"],
    predicted: "tool only",
    why: "lint 0024 excludes SELECT on purpose (deliberate public read); audit #3 flags any command",
    sql: `create table public.av_f05_anon_select_true (id int primary key);
alter table public.av_f05_anon_select_true enable row level security;
grant select on public.av_f05_anon_select_true to anon, authenticated;
create policy av_f05_p on public.av_f05_anon_select_true for select to anon using (true);`,
  },
  {
    id: "F06",
    marker: "av_f06_auth_update_true",
    category: "UPDATE policy USING (true) WITH CHECK (true) for authenticated",
    auditNo: "3",
    auditChecks: ["Policy open to anon"],
    advisorLints: ["rls_policy_always_true"],
    predicted: "advisors only",
    why: "audit #3 matches roles anon/public only; any signed-up user can rewrite every row",
    sql: `create table public.av_f06_auth_update_true (id int primary key, note text);
alter table public.av_f06_auth_update_true enable row level security;
grant select, update on public.av_f06_auth_update_true to authenticated;
create policy av_f06_p on public.av_f06_auth_update_true for update to authenticated using (true) with check (true);`,
  },
  {
    id: "F07",
    marker: "av_f07_anon_delete_true",
    category: "DELETE policy USING (true) for anon",
    auditNo: "3",
    auditChecks: ["Policy open to anon"],
    advisorLints: ["rls_policy_always_true"],
    predicted: "both",
    why: "inside both predicates",
    sql: `create table public.av_f07_anon_delete_true (id int primary key);
alter table public.av_f07_anon_delete_true enable row level security;
grant select, delete on public.av_f07_anon_delete_true to anon;
create policy av_f07_p on public.av_f07_anon_delete_true for delete to anon using (true);`,
  },
  {
    id: "F08",
    marker: "av_f08_definer_default",
    category: "SECURITY DEFINER function in public, default privileges, search_path pinned",
    auditNo: "4",
    auditChecks: ["SECURITY DEFINER open to PUBLIC"],
    advisorLints: SECDEF_ANON,
    predicted: "both",
    why: "PUBLIC holds EXECUTE by default, so anon can call it",
    sql: `create function public.av_f08_definer_default() returns int language sql security definer set search_path = '' as 'select 1';`,
  },
  {
    id: "F09",
    marker: "av_f09_definer_revoked_public",
    category: "SECURITY DEFINER in public after the audit's own fix (REVOKE EXECUTE ... FROM PUBLIC) and nothing else",
    auditNo: "4",
    auditChecks: ["SECURITY DEFINER open to PUBLIC"],
    advisorLints: SECDEF_ANON,
    predicted: "advisors only",
    why: "if the schema's default privileges grant EXECUTE to anon by name, revoking PUBLIC leaves anon able to call it; audit #4 checks PUBLIC only",
    sql: `create function public.av_f09_definer_revoked_public() returns int language sql security definer set search_path = '' as 'select 9';
revoke execute on function public.av_f09_definer_revoked_public() from public;`,
  },
  {
    id: "F10",
    marker: "av_f10_definer_private",
    category: "SECURITY DEFINER open to PUBLIC in a schema the API does not expose (av_private)",
    auditNo: "4",
    auditChecks: ["SECURITY DEFINER open to PUBLIC"],
    advisorLints: SECDEF_ANON,
    predicted: "tool only",
    why: "audit #4 has no exposed-schema filter; the lints only look at pgrst.db_schemas",
    sql: `create schema if not exists av_private;
create function av_private.av_f10_definer_private() returns int language sql security definer set search_path = '' as 'select 10';`,
  },
  {
    id: "F11",
    marker: "av_f11_definer_no_path",
    category: "SECURITY DEFINER without a pinned search_path (EXECUTE revoked from everyone)",
    auditNo: "5",
    auditChecks: ["SECURITY DEFINER without search_path"],
    advisorLints: ["function_search_path_mutable"],
    predicted: "both",
    why: "same proconfig test on both sides",
    sql: `create function public.av_f11_definer_no_path() returns int language sql security definer as 'select 11';
revoke execute on function public.av_f11_definer_no_path() from public, anon, authenticated;`,
  },
  {
    id: "F12",
    marker: "av_f12_invoker_no_path",
    category: "SECURITY INVOKER function without a pinned search_path",
    auditNo: "5",
    auditChecks: ["SECURITY DEFINER without search_path"],
    advisorLints: ["function_search_path_mutable"],
    predicted: "advisors only",
    why: "audit #5 is definer-only; lint 0011 covers every function",
    sql: `create function public.av_f12_invoker_no_path() returns int language sql as 'select 12';`,
  },
  {
    id: "F13",
    marker: "av_f13_view_owner",
    category: "view without security_invoker, granted to anon",
    auditNo: "6",
    auditChecks: ["View runs as owner"],
    advisorLints: ["security_definer_view"],
    predicted: "both",
    why: "same reloptions test",
    sql: `create view public.av_f13_view_owner as select id from public.av_f04_rls_no_policy;
grant select on public.av_f13_view_owner to anon, authenticated;`,
  },
  {
    id: "F14",
    marker: "av_f14_auth_users_view",
    category: "view over auth.users granted to anon",
    auditNo: "6",
    auditChecks: [],
    advisorLints: ["auth_users_exposed"],
    predicted: "advisors only",
    why: "audit #6 flags it as a generic owner-rights view (REVIEW), with no check for auth.users",
    sql: `create view public.av_f14_auth_users_view as select id, email from auth.users;
grant select on public.av_f14_auth_users_view to anon, authenticated;`,
  },
  {
    id: "F15",
    marker: "av_f15_secret_exact",
    category: "column named password on a table with RLS off",
    auditNo: "7",
    auditChecks: ["Secret-shaped column exposed"],
    advisorLints: ["sensitive_columns_exposed"],
    predicted: "both",
    why: "exact name on both lists",
    sql: `create table public.av_f15_secret_exact (id int primary key, password text);
grant select on public.av_f15_secret_exact to anon, authenticated;`,
  },
  {
    id: "F16",
    marker: "av_f16_secret_substring",
    category: "column named stripe_api_key on a table with RLS off",
    auditNo: "7",
    auditChecks: ["Secret-shaped column exposed"],
    advisorLints: ["sensitive_columns_exposed"],
    predicted: "tool only",
    why: "audit #7 is a substring regex; lint 0023 compares the whole column name",
    sql: `create table public.av_f16_secret_substring (id int primary key, stripe_api_key text);
grant select on public.av_f16_secret_substring to anon, authenticated;`,
  },
  {
    id: "F17",
    marker: "av_f17_secret_rls_on",
    category: "column named api_key on a table with RLS on and an owner policy",
    auditNo: "7",
    auditChecks: ["Secret-shaped column exposed"],
    advisorLints: ["sensitive_columns_exposed"],
    predicted: "tool only",
    why: "lint 0023 only looks at tables with RLS off",
    sql: `create table public.av_f17_secret_rls_on (id int primary key, owner uuid, api_key text);
alter table public.av_f17_secret_rls_on enable row level security;
grant select on public.av_f17_secret_rls_on to authenticated;
create policy av_f17_p on public.av_f17_secret_rls_on for select to authenticated using ((select auth.uid()) = owner);`,
  },
  {
    id: "F18",
    marker: "av_f18_pii_ssn",
    category: "column named ssn on a table with RLS off",
    auditNo: "7",
    auditChecks: ["Secret-shaped column exposed"],
    advisorLints: ["sensitive_columns_exposed"],
    predicted: "advisors only",
    why: "audit #7 matches credentials only; lint 0023 also lists PII and financial names",
    sql: `create table public.av_f18_pii_ssn (id int primary key, ssn text);
grant select on public.av_f18_pii_ssn to anon, authenticated;`,
  },
  {
    id: "F19",
    marker: "av_f19_initplan_uid",
    category: "policy calls auth.uid() unwrapped",
    auditNo: "8",
    auditChecks: ["auth.uid() re-evaluated per row"],
    advisorLints: ["auth_rls_initplan"],
    predicted: "both",
    why: "textbook case",
    sql: `create table public.av_f19_initplan_uid (id int primary key, owner uuid);
alter table public.av_f19_initplan_uid enable row level security;
grant select on public.av_f19_initplan_uid to authenticated;
create policy av_f19_p on public.av_f19_initplan_uid for select to authenticated using (auth.uid() = owner);`,
  },
  {
    id: "F20",
    marker: "av_f20_initplan_setting",
    category: "policy calls current_setting() unwrapped",
    auditNo: "8",
    auditChecks: ["auth.uid() re-evaluated per row"],
    advisorLints: ["auth_rls_initplan"],
    predicted: "advisors only",
    why: "audit #8 matches auth.uid/jwt/role; lint 0003 also matches auth.email() and current_setting()",
    sql: `create table public.av_f20_initplan_setting (id int primary key, owner text);
alter table public.av_f20_initplan_setting enable row level security;
grant select on public.av_f20_initplan_setting to authenticated;
create policy av_f20_p on public.av_f20_initplan_setting for select to authenticated using (owner = current_setting('request.jwt.claim.sub', true));`,
  },
  {
    id: "F21",
    marker: "av_f21_initplan_mixed",
    category: "policy with one wrapped and one unwrapped auth.uid()",
    auditNo: "8",
    auditChecks: ["auth.uid() re-evaluated per row"],
    advisorLints: ["auth_rls_initplan"],
    predicted: "neither",
    why: "both sides skip a policy whose text contains any 'select auth.uid()'",
    sql: `create table public.av_f21_initplan_mixed (id int primary key, owner uuid, editor uuid);
alter table public.av_f21_initplan_mixed enable row level security;
grant select on public.av_f21_initplan_mixed to authenticated;
create policy av_f21_p on public.av_f21_initplan_mixed for select to authenticated using ((select auth.uid()) = owner or auth.uid() = editor);`,
  },
  {
    id: "F22",
    marker: "av_f22_initplan_wrapped",
    category: "control: policy with auth.uid() wrapped",
    auditNo: "8",
    auditChecks: ["auth.uid() re-evaluated per row"],
    advisorLints: ["auth_rls_initplan"],
    predicted: "neither",
    why: "negative control, nothing to find",
    sql: `create table public.av_f22_initplan_wrapped (id int primary key, owner uuid);
alter table public.av_f22_initplan_wrapped enable row level security;
grant select on public.av_f22_initplan_wrapped to authenticated;
create policy av_f22_p on public.av_f22_initplan_wrapped for select to authenticated using ((select auth.uid()) = owner);`,
  },
  {
    id: "F23",
    marker: "av_f23_members",
    category: "policy that queries its own table (recursion)",
    auditNo: "9",
    auditChecks: ["Possible policy recursion"],
    advisorLints: [],
    predicted: "tool only",
    why: "no splinter lint for policy recursion",
    sql: `create table public.av_f23_members (team_id int, user_id uuid, primary key (team_id, user_id));
alter table public.av_f23_members enable row level security;
grant select on public.av_f23_members to authenticated;
create policy av_f23_p on public.av_f23_members for select to authenticated
  using (team_id in (select m.team_id from public.av_f23_members m where m.user_id = (select auth.uid())));`,
  },
  {
    id: "F24",
    marker: "av_f24_child",
    category: "single-column foreign key with no index",
    auditNo: "10",
    auditChecks: ["Foreign key without index"],
    advisorLints: ["unindexed_foreign_keys"],
    predicted: "both",
    why: "textbook case",
    sql: `create table public.av_f24_parent (id int primary key);
alter table public.av_f24_parent enable row level security;
create table public.av_f24_child (id int primary key, parent_id int references public.av_f24_parent (id));
alter table public.av_f24_child enable row level security;`,
  },
  {
    id: "F25",
    marker: "av_f25_child",
    category: "two-column foreign key (a, b) with an index on (a) only",
    auditNo: "10",
    auditChecks: ["Foreign key without index"],
    advisorLints: ["unindexed_foreign_keys"],
    predicted: "advisors only",
    why: "audit #10 compares the leading column only; lint 0001 wants an index whose leading columns are the whole key",
    sql: `create table public.av_f25_parent (a int, b int, primary key (a, b));
alter table public.av_f25_parent enable row level security;
create table public.av_f25_child (id int primary key, a int, b int, foreign key (a, b) references public.av_f25_parent (a, b));
alter table public.av_f25_child enable row level security;
create index av_f25_child_a on public.av_f25_child (a);`,
  },
  {
    id: "F26",
    marker: "pg_trgm",
    category: "extension installed in public",
    auditNo: "11",
    auditChecks: ["Extension installed in public"],
    advisorLints: ["extension_in_public"],
    predicted: "both",
    why: "same predicate",
    sql: `create extension if not exists pg_trgm with schema public;`,
  },
  {
    id: "F27",
    marker: "av_f27_insert_only",
    category: "INSERT policy with no SELECT policy",
    auditNo: "12",
    auditChecks: ["INSERT policy with no SELECT policy"],
    advisorLints: [],
    predicted: "tool only",
    why: "no splinter lint for it",
    sql: `create table public.av_f27_insert_only (id uuid primary key default gen_random_uuid(), body text);
alter table public.av_f27_insert_only enable row level security;
grant select, insert on public.av_f27_insert_only to anon;
create policy av_f27_p on public.av_f27_insert_only for insert to anon with check (body is not null);`,
  },
  {
    id: "F28",
    marker: "av_f28_no_pk",
    category: "table without a primary key",
    auditNo: "-",
    auditChecks: [],
    advisorLints: ["no_primary_key"],
    predicted: "advisors only",
    why: "no audit check",
    sql: `create table public.av_f28_no_pk (x int);
alter table public.av_f28_no_pk enable row level security;`,
  },
  {
    id: "F29",
    marker: "av_f29_dup_index",
    category: "duplicate index",
    auditNo: "-",
    auditChecks: [],
    advisorLints: ["duplicate_index"],
    predicted: "advisors only",
    why: "no audit check",
    sql: `create table public.av_f29_dup_index (id int primary key, v int);
alter table public.av_f29_dup_index enable row level security;
create index av_f29_dup_index_v1 on public.av_f29_dup_index (v);
create index av_f29_dup_index_v2 on public.av_f29_dup_index (v);`,
  },
  {
    id: "F30",
    marker: "av_f30_unused_index",
    category: "unused index",
    auditNo: "-",
    auditChecks: [],
    advisorLints: ["unused_index"],
    predicted: "advisors only",
    why: "no audit check (and a fresh index is unused by definition)",
    sql: `create table public.av_f30_unused_index (id int primary key, v int);
alter table public.av_f30_unused_index enable row level security;
create index av_f30_unused_index_v on public.av_f30_unused_index (v);`,
  },
  {
    id: "F31",
    marker: "av_f31_multi_permissive",
    category: "two permissive SELECT policies for the same role",
    auditNo: "-",
    auditChecks: [],
    advisorLints: ["multiple_permissive_policies"],
    predicted: "advisors only",
    why: "no audit check",
    sql: `create table public.av_f31_multi_permissive (id int primary key, owner uuid, shared boolean);
alter table public.av_f31_multi_permissive enable row level security;
grant select on public.av_f31_multi_permissive to authenticated;
create policy av_f31_own on public.av_f31_multi_permissive for select to authenticated using ((select auth.uid()) = owner);
create policy av_f31_shared on public.av_f31_multi_permissive for select to authenticated using (shared);`,
  },
  {
    id: "F32",
    marker: "av_f32_policy_rls_off",
    category: "policy exists but RLS is disabled",
    auditNo: "-",
    auditChecks: [],
    advisorLints: ["policy_exists_rls_disabled"],
    predicted: "advisors only",
    why: "audit #1 flags the table as RLS disabled (incidental) but says nothing about the dormant policy",
    sql: `create table public.av_f32_policy_rls_off (id int primary key, owner uuid);
grant select on public.av_f32_policy_rls_off to anon, authenticated;
create policy av_f32_p on public.av_f32_policy_rls_off for select to authenticated using ((select auth.uid()) = owner);`,
  },
  {
    id: "F33",
    marker: "av_f33_user_metadata",
    category: "policy trusts user_metadata from the JWT",
    auditNo: "-",
    auditChecks: [],
    advisorLints: ["rls_references_user_metadata"],
    predicted: "advisors only",
    why: "no audit check; user_metadata is editable by the user",
    sql: `create table public.av_f33_user_metadata (id int primary key);
alter table public.av_f33_user_metadata enable row level security;
grant select on public.av_f33_user_metadata to authenticated;
create policy av_f33_p on public.av_f33_user_metadata for select to authenticated
  using (((select auth.jwt()) -> 'user_metadata' ->> 'role') = 'admin');`,
  },
  {
    id: "F34",
    marker: "av_f34_matview",
    category: "materialized view in public granted to anon",
    auditNo: "-",
    auditChecks: [],
    advisorLints: ["materialized_view_in_api"],
    predicted: "advisors only",
    why: "audit only looks at relkind r and v; RLS does not apply to materialized views",
    sql: `create materialized view public.av_f34_matview as select 1 as x;
grant select on public.av_f34_matview to anon, authenticated;`,
  },
  {
    id: "F35",
    marker: "av_f35_no_autovacuum",
    category: "table with autovacuum disabled",
    auditNo: "-",
    auditChecks: [],
    advisorLints: ["autovacuum_disabled"],
    predicted: "advisors only",
    why: "no audit check",
    sql: `create table public.av_f35_no_autovacuum (id int primary key) with (autovacuum_enabled = false);
alter table public.av_f35_no_autovacuum enable row level security;`,
  },
  {
    id: "F36",
    marker: "av_f36_bucket",
    category: "public Storage bucket with a listing policy for anon",
    auditNo: "-",
    auditChecks: [],
    advisorLints: ["public_bucket_allows_listing"],
    predicted: "advisors only",
    why: "audit reads schema public only; Storage policies live on storage.objects",
    sql: `insert into storage.buckets (id, name, public) values ('av_f36_bucket', 'av_f36_bucket', true) on conflict do nothing;
create policy av_f36_list on storage.objects for select to anon using (bucket_id = 'av_f36_bucket');`,
  },
];

/** Schemas the run adds to the Data API's exposed list (F03). */
export const EXTRA_EXPOSED_SCHEMA = "av_api";
