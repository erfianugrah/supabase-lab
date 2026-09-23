-- App b: one table, so a preview branch has a migration to apply.
create table public.b_items (
  id bigint generated always as identity primary key,
  label text not null
);
alter table public.b_items enable row level security;
