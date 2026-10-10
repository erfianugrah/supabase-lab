# jit-db-access

Temporary token-based database access ("JIT"): grant a project member a
Postgres role with an expiry through the Management API, log in with the
member's PAT as the Postgres password, and measure expiry, revocation, network
scoping and what the logs record. Public sources for the claims under test:
https://supabase.com/changelog/46346-feature-preview-temporary-token-based-database-access
and https://supabase.com/docs/guides/platform/temporary-access.

Self-provisioning, no OpenTofu state: the module creates one Pro-org project
(Postgres 17, ap-southeast-1), runs every row on it and deletes it in
`finally`. Sibling context: `sfp-platforms` S15 (the invite route, which is the
call that answered 500 on Pro), `audit-integrity` (CLI login roles, no platform
audit log on Pro), `pooler-semantics`.

## Modules

| id | claim |
|---|---|
| JA01a | create a Pro project on Postgres 17; version against the docs floor `17.6.1.081` |
| JA01b | gates before enabling: `GET /jit-access` reason code, `PUT enabled` without SSL enforcement, `PUT /ssl-enforcement` |
| JA01c | `PUT /jit-access {state: enabled}` and the read-back |
| JA01d | `PUT /database/jit` body (`roles` vs the docs key `user_roles`), replace vs merge, read routes, the authorise check |
| JA01e | connection matrix with the PAT as password: shared pooler 6543 and 5432 with `options=-c jit=true`, docs host vs configured host, no option, direct over IPv6, dedicated pooler, unmapped role |
| JA01f | what a PAT session is: `current_user`, `pg_stat_activity`, a least-privilege custom role |
| JA01g | expiry: seconds vs milliseconds `expires_at`, fresh-login refusal time, three open sessions watched for 300 s |
| JA01h | extending an expired grant |
| JA01i | revocation by `DELETE /database/jit/{user_id}` and by `PUT /jit-access disabled`: new logins, held sessions, mapping retained |
| JA01j | `allowed_networks` (IPv4 and IPv6 lists) on the direct and pooler paths, repeated pooler trials |
| JA01k | `postgres_logs` / `supavisor_logs` with `log_connections` on: what a JIT login records, whether the user id, email or a token appears |
| JA01l | membership removal and PAT revocation: not run (needs a second human; the PAT is the run's only token) |

## Run

```bash
SUPABASE_ACCESS_TOKEN=... PVLAB_ORG_PRO=<pro-org-slug> make run
```

Needs `psql` on PATH and an IPv6 route for the direct-path rows (the direct
hostname has no A record without the IPv4 add-on). The module checks both
before creating the project and skips every row with a reason if either is
missing. The PAT is passed to psql
through `PGPASSWORD` and every psql error is scrubbed before it reaches a
result. `PVLAB_PEER_JIT=<ref>` reuses a project instead of creating one (it is
then not deleted). Wall time about 10 minutes (the 300 s open-session watch in
JA01g, the log ingest wait in JA01k).

Failed logins through the shared pooler trip a circuit breaker
(`ECIRCUITBREAKER`) that refuses valid credentials too; the module classifies
every refusal, never retries a breaker answer every few seconds, and reads
`POST /network-bans/retrieve` after each phase. Keep that in mind before adding
a polling loop.

## Measured (Pro org, 2026-10-10; five runs, one project each)

| finding | value | row |
|---|---|---|
| Grant route on Pro | `PUT /jit-access` and `PUT /database/jit` answer 200; the 500 in `AGENTS.md` was the invite route | JA01c, JA01d |
| Prerequisite | SSL enforcement on; before it `GET /jit-access` reads `unavailable` / `ssl_enforcement_required` and `PUT enabled` answers 200 without enabling; the SSL change logs a fast shutdown request 1 s after the call | JA01b |
| Grant body | `roles` (200); the docs' `user_roles` key answers 400; `PUT` replaces the user's role set | JA01d |
| Pooler login | works on 6543 and 5432 with `jit=true`, refused without it; host from `/config/database/pooler` (`aws-0-`), the docs' `aws-1-` host answers `ENOTFOUND` | JA01e |
| Direct login | works over IPv6 (AAAA only, no A record); dedicated pooler (`db` host :6543) refused `SASL authentication failed` | JA01e |
| Session identity | `current_user = session_user = postgres`; no Supabase user identity inside the session; custom role keeps its own privileges | JA01f |
| Expiry unit | epoch SECONDS: refused at +0 to +1 s; a MILLISECOND value (the docs example) is accepted and was not refused within 70 s | JA01g |
| Open sessions at expiry | not closed; alive 300 s after expiry (runs 4, 5) | JA01g |
| Extension | later `expires_at` restores login in 0.3-0.5 s | JA01h |
| `DELETE` mapping | new logins refused in 0.2-2.9 s; open sessions survive | JA01i |
| `PUT disabled` | new logins refused in 0.7-4.6 s; open pooler session closed, direct kept; `PUT enabled` restores login without a re-grant | JA01i |
| `allowed_networks` | documentation-range CIDR refused; direct with the `/128` the database saw was ok in runs 2, 4, 5 and refused in run 3; the pooler path is judged on an IPv6 address (the pooler's), `::/0` let it in in runs 3-5 but not run 2, and the IPv4-only verdict varied between runs; per-client scoping is unproven | JA01j |
| Logs | direct login: `method=pam`, identity = the Postgres role; pooler login: `supavisor_logs` `user`/`peer_ip`; no row from the logins carries the user id, email or a token (one `postgres_logs` row, the Management API statement tag from creating the `ja_reader` role, carries the user id) | JA01k |

Not measured: membership removal and PAT revocation (the changelog's "revoking
project access immediately revokes login" is `doc-cited-not-tested`), sessions
beyond 300 s, `branches_only`, other plans. Details and the discarded runs:
`RUNLOG.md`.
