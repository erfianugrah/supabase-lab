-- Rows an MCP tool reads, scoped by the OAuth client that made the call.
--
-- Tokens issued through the project's OAuth 2.1 server carry a `client_id`
-- claim; a password-session token does not. The policy treats the two paths
-- explicitly: `client_id is not distinct from <claim>` matches a NULL row to a
-- token without the claim, and a client row to that client only.
-- OAuth scopes identify the caller; they do not limit database access, so the
-- policy, not a scope, is the control.

create table if not exists public.mcp_notes (
  id        bigint generated always as identity primary key,
  client_id text,
  note      text not null
);

alter table public.mcp_notes enable row level security;
revoke all on public.mcp_notes from anon, authenticated;
grant select on public.mcp_notes to authenticated;

drop policy if exists "mcp_notes: own client" on public.mcp_notes;
create policy "mcp_notes: own client" on public.mcp_notes
  for select to authenticated
  using (client_id is not distinct from nullif((select auth.jwt() ->> 'client_id'), ''));
