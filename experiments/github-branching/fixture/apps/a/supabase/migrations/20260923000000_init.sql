-- App a: one table, so a preview branch has a migration to apply.
create table public.a_items (
  id bigint generated always as identity primary key,
  label text not null
);
alter table public.a_items enable row level security;
