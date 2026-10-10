# jit-db-access RUNLOG

Chronological record of what was run. Org slugs, project refs, the caller's
user id and email are not recorded here (the org class is). Artifacts are in
`evidence/` (gitignored); no `out/` copy was published for these runs, so the
rows below are quoted from the `evidence/<ts>/run-*.json` files named in the
table.

Public sources for the docs claims (not measurements):
https://supabase.com/changelog/46346-feature-preview-temporary-token-based-database-access
and https://supabase.com/docs/guides/platform/temporary-access (both read
2026-10-10).

## 2026-10-10 - JA01 on a Pro-org project (Postgres 17, ap-southeast-1)

Vantage: a laptop on an IPv4 network with an IPv6 route through a tunnel
interface; psql 18.6. The key under test in every row is the Management API
PAT of the caller, which is both the bearer for the control-plane calls and the
Postgres password. One project per run, created by the module and deleted in
`finally` (n = 1 project per run, 5 runs; each row says which runs it holds
for). Plan: Pro, smallest compute. Postgres `17.11.0.003` on every run
(docs floor `17.6.1.081`).

| run | artifact stamp | what it was | use |
|---|---|---|---|
| exploratory | `01-28-01-903Z` (reused project) | first module draft against a project set up by hand | not cited except where named |
| 1 | `01-42-19-583Z` | first self-provisioning run | JA01a-e, JA01g unit, JA01k; JA01g/h/i/j pooler rows polluted by the pooler circuit breaker (below) |
| 2 | `01-51-06-255Z` | module classifies refusals by error code | clean |
| 3 | `01-57-55-066Z` | same module | JA01g discarded (host stall, below); other rows clean |
| 4 | `02-10-36-037Z` | JA01g holds three sessions for 300 s after expiry, stall detector added | clean |
| 5 | `02-41-17-188Z` | JA01i reads the mapping before restoring it; JA01j repeats the pooler trials | headline run for JA01i, JA01j |

All statuses in run 5: JA01a, c, d, e, f, g, h, i, j pass; JA01b and JA01k info;
JA01l skip. `pass` here means the platform did what the docs say at the
boundary probed, not that a retyped figure was confirmed.

### The 500 recorded for JIT on Pro did not reproduce on the grant route

`AGENTS.md` records "JIT database access: 200 on platform, 500 on Pro". That
line comes from sfp-platforms S15, which calls `POST /database/jit/invite`
(inviting an external email), not the grant route. This experiment never calls
the invite route. On the Pro project, in all five runs:

- `PUT /v1/projects/{ref}/jit-access` -> 200 (JA01c, `state` reads back
  `enabled`).
- `PUT /v1/projects/{ref}/database/jit` -> 200 (JA01d).
- `GET /v1/projects/{ref}/database/jit/list` -> 200.

So the premise that the grant route is blocked where the invite route answers 500 is not met, and the invite route's
500 on Pro is not re-tested here (not run).

### JA01a-JA01c: gates and enabling

- JA01a: `POST /projects` returned the project `ACTIVE_HEALTHY` in 2 s (runs
  1, 2, 4, 5) and 5 s (run 3). The log history of the instance starts about 9 minutes before the create
  call (run 5: `terminating connection due to administrator command` rows at
  02:32:08 UTC, create at 02:41:17 UTC; run 4 shows the same shape). Reading:
  the project is assigned a pre-warmed instance. That is an inference from
  timestamps, not a documented behaviour.
- JA01b, fresh project, SSL enforcement off: `GET /jit-access` -> 200
  `{"state":"unavailable","unavailableReason":"ssl_enforcement_required"}`.
  `PUT /jit-access {"state":"enabled"}` in that state -> 200 and the body is
  still `{"state":"unavailable",...}`: a 200 that did not enable anything.
  `PUT /ssl-enforcement {"requestedConfig":{"database":true}}` -> 200 in 1-2 s;
  `GET /jit-access` then reads `disabled`. The docs say SSL enforcement must be
  on before temporary access can be used; the reason code is measured here.
- JA01b/JA01k: a `received fast shutdown request` row is logged 1 s after the
  SSL enforcement PUT in each of runs 1-5 (run 1 also shows one 620 s before,
  the instance warm-up). Reading: the SSL enforcement change restarts Postgres.
  Downtime was not measured.
- JA01c: `PUT /jit-access {"state":"enabled"}` -> 200, read-back `enabled`.

### JA01d: grant API shape (docs claim vs measured)

- The docs example body for `PUT /database/jit` uses the key `user_roles` with
  `expires_at` in milliseconds. Measured: that body -> `400 {"message":"roles:
  Invalid input: expected array, received undefined"}`. The OpenAPI document
  (read 2026-10-10 from the public Management API spec) names the request key
  `roles`; that body -> 200, and the response uses the key `user_roles`.
- `PUT` replaces the user's whole role set: after `PUT [postgres]` then
  `PUT [ja_reader]`, the list shows only `ja_reader`.
- `GET /database/jit/list` item keys: `expires_at, invite_id, primary_email,
  user_id, user_roles`. The list carries the member's email; do not paste raw
  responses.
- `POST /database/jit {role, rhost}` (the authorise check in the spec) -> 403
  `{"message":"Unauthorized to assume role"}` for this PAT.

### JA01e: connection matrix (runs 2-5; run 1 agrees except where noted)

Grant: `postgres` and a custom `ja_reader` role (LOGIN, no password, `select`
only), 30 minutes. The first pooler login worked 1.7 s (run 2), 0.4 s (run 3),
0.5 s (run 4) and 0.5 s (run 5) after the PUT returned.

| path (PAT as password) | result, runs 2-5 |
|---|---|
| shared pooler `:6543`, user `postgres.<ref>`, `options=-c jit=true` | login works |
| shared pooler `:5432`, same | login works |
| shared pooler, no `jit=true` option | refused: `password authentication failed for user "postgres"` |
| shared pooler, `jit=true`, role with no mapping (`supabase_admin`) | refused: `password authentication failed` |
| direct `db.<ref>.supabase.co:5432`, user `postgres` | login works (over IPv6) |
| dedicated pooler `db.<ref>.supabase.co:6543`, user `postgres` | refused: `SASL authentication failed` |
| pooler host from the docs example (`aws-1-...`) | refused: `(ENOTFOUND) tenant/user postgres.<ref> not found` |

- The pooler config endpoint returned an `aws-0-` host for this project; the
  docs example uses `aws-1-`. The tenant is not found on the `aws-1-` host
  (4 of 4 runs where it was tried). Use the host from
  `GET /config/database/pooler`, not the docs string.
- The direct hostname has an AAAA record and no A record (A count 0, AAAA
  count 1; no IPv4 add-on bought). This vantage reached it over IPv6. macOS
  `getaddrinfo` refused the name (`could not translate host name`) until the
  module resolved the AAAA record itself and passed it as `hostaddr`; a vantage
  without any IPv6 route will not reach the direct path at all (not tested).
- The dedicated pooler refusal matches the changelog ("not available through
  the dedicated pooler (port 6543 on the database host)"). The wrong-credential
  text (`SASL authentication failed`) does not say why.

### JA01f: what the session is

PAT-authenticated sessions (runs 2-5): `current_user = session_user =
postgres`, `pg_stat_activity.usename = postgres`, `rolsuper = false`. Through
the pooler `application_name` reads `Supavisor` whatever the client sent;
direct, it is the client's. The custom role connects as `ja_reader` and
`CREATE TABLE public.x` fails with `permission denied for schema public`. The
role keeps its own privileges (as the docs say); the session carries no
Supabase user identity of its own.

### JA01g: expiry

Grants written in one PUT at the same instant: `postgres` with `expires_at` =
now + 75 in epoch SECONDS, `ja_reader` with the same instant in epoch
MILLISECONDS (the docs example is milliseconds). Both PUTs -> 200 and both
values read back verbatim (`1791600168` and `1791600168000` in run 5).

- Seconds is the unit the platform enforces. Fresh logins on `postgres`
  worked until the expiry and were refused at +0 s to +1 s (probe resolution:
  one pass of the loop took about 1.5-2.5 s) on both paths in runs 2, 4, 5
  (pooler `+1, +0, +0`; direct `+0` in all three). Run 3 is discarded for this
  row (below); its offsets (pooler `+0`, direct `+0`) agree but are not
  counted. Refusal text: pooler
  `password authentication failed for user "postgres"`, direct `PAM
  authentication failed for user "postgres"`.
- The millisecond value was NOT refused within 70 s after the instant it
  names, on the direct path (runs 2, 4, 5; the exploratory run saw the same on
  the pooler). Read as seconds it is a year far past 90 days. The platform
  accepted it with 200. Reading: following the docs example body literally
  produces a grant with no practical expiry. That is a reading from one
  observation window of 70 s per run; the expiry of a value that large was not
  waited out and no cap was found.
- Open sessions are not closed by expiry. Three sessions opened before the
  instant (pooler `postgres`, direct `postgres`, direct `ja_reader`) all
  answered a ping every 5 s until 300 s after the instant in runs 4 and 5
  (largest gap between loop iterations 6 s and 5 s). In run 2 the two
  `postgres` sessions answered at +70 s.
- Run 3 contradicts this and is discarded: its loop overran by about 225 s (the
  `ja_reader` probe returned 295 s after the instant with `server closed the
  connection unexpectedly`, both held sessions found closed). The run took 11
  min; run 2 took 5 min 41 s (artifact start and finish stamps). A timer on the
  same machine also did not fire inside its window, so the orchestrator itself
  stalled. The cause was not established, and no stall detector existed in that
  run. Run 4 added the detector and `caffeinate -i`; runs 4 and 5 show no gap
  above 6 s.

Not settled: whether the platform ever closes sessions of an expired grant later
than 300 s.

### JA01h: extending

`PUT` a later `expires_at` after expiry: a fresh direct login worked 0.3-0.4 s
later and a fresh pooler login 0.3-0.5 s later (runs 2-5).

### JA01i: revocation

Each step starts with a valid grant, one held pooler session and one held
direct session, then waits 15 s after the first refusal and pings the held
sessions.

| step | new pooler login | new direct login | held sessions after |
|---|---|---|---|
| `DELETE /database/jit/{user_id}` | refused after 0.2-0.5 s (runs 2-5, plus the exploratory run), text `(EJITREQUESTFAILED) failed to reach JIT provider for user "postgres"` | refused after 0.5-2.9 s, text `PAM authentication failed` | both alive (4 of 4 clean runs) |
| `PUT /jit-access {"state":"disabled"}` | refused after 0.7-4.6 s, text `password authentication failed` | refused after 0.9-1.9 s | pooler session CLOSED, direct session alive (4 of 4 clean runs) |

- After `DELETE`, the list read before any restore step shows no mapping for
  the caller (run 5: `none`). After `disabled` it still shows `postgres`
  (run 5), and `PUT enabled` alone restored login in 0.8-4.7 s (runs 2-5): the
  changelog's "users regain access when re-enabled" holds for the pooler and
  direct logins tried.
- Deleting the mapping stops new logins within a second but does not end an
  open session. Disabling temporary access closed pooler sessions and not the
  direct one. Neither was waited past 15 s here.
- Not run: removing the project member, and revoking the PAT (JA01l, below).

### JA01j: allowed_networks

Same grant with `allowed_networks`. `allowed_cidrs` is IPv4; IPv6 is
`allowed_cidrs_v6` (OpenAPI). Results, run 5 unless stated:

- Documentation-range `192.0.2.0/24`: direct refused; pooler refused in three
  of three trials (`password, password, password`) and in every single probe of
  runs 2-5.
- Vantage IPv4 `/32` only: direct refused (the database sees an IPv6 client
  address on direct sessions). Pooler verdicts for the SAME grant varied:
  refused in runs 2 and 4 at +3 s, allowed in runs 3 and 5 at +3 s, and in
  run 5's four trials 8 s apart `password, password, ok-v6, ok-v6`. Reading:
  the pooler's view of a changed grant converges over 10-20 s and differs
  between connections (several pooler nodes answered during the runs); not
  confirmed.
- Vantage IPv4 `/32` plus `allowed_cidrs_v6` set to the address the database
  saw for the direct session (`/128`): direct ok in runs 2, 4 and 5, refused in
  run 3 (`095754`). Direct scoping with the `/128` is variable across runs; the
  cause was not established (the address the database sees on a direct session
  may differ between connections, not checked).
- `allowed_cidrs_v6: ["::/0"]`: direct ok in runs 2-5. Pooler ok in runs 3, 4
  and 5, refused in run 2 (`095106`). On a pooler session `inet_client_addr()`
  is an IPv6 address (the pooler's), not the client's (runs 3, 4, 5; run 2 had
  no pooler login to read it from). So "the pooler works with `::/0`" held in
  three of four runs.

Not settled: whether the pooler judges the client IPv4, the pooler's own IPv6
address, or both. A manual probe before the module existed (not in an
artifact) saw `PAM authentication failed` from Postgres on the pooler path with
`allowed_cidrs: ["0.0.0.0/0"]`, then success once `::/0` was in
`allowed_cidrs_v6`; that points at the pooler's IPv6 address being checked by
Postgres. Treat per-client-IP scoping through the shared pooler as unproven.

### JA01k: log attribution (log_connections on, markers in application_name)

Logs read through `GET /analytics/endpoints/logs`, unified `logs` table.
Marker rows appeared 34-38 s after the logins (runs 2-5).

- Direct JIT login, `postgres_logs`: `connection authenticated:
  identity="postgres" method=pam (<pg_hba PAM rule, public SSL>:4)` then
  `connection authorized: user=postgres database=postgres
  application_name=<client value> SSL enabled (...)`. The authentication
  method is `pam`; the identity is the Postgres role.
- Pooler JIT login, `supavisor_logs`: rows with `user` attribute `postgres`,
  `peer_ip` (the client's address) and `app_name` (the client's value). No
  `postgres_logs` row carries the client's marker for the pooler login.
- No `postgres_logs` or `supavisor_logs` row from the logins contains the
  caller's user id or email, and no row anywhere in the last hour contains the
  string `sbp_` (0 rows, runs 1-5). The one row containing the user id was the
  Management API's own statement tag on `POST /database/query`
  (`-- user: scoped_pat:<id>`), written when the module created the
  `ja_reader` role.
- The changelog says "it will be possible to see who accessed the database".
  Not seen in these two log sources for a JIT login. The project audit trail
  was not read: AGENTS.md records that a Pro project has no platform audit log
  (audit-integrity); the dashboard view of JIT activity was not examined
  (dashboard-only, not run).
- Counts of marker rows (runs 2-5): `postgres_logs` 1 each time (the direct
  login); `supavisor_logs` 1, 1, 2, 2. Which of the four marked attempts the
  `supavisor_logs` rows belong to was not broken out, so what a refused attempt
  leaves in the logs is not measured here.

### JA01l: not run

- Removing the project member: needs a second human user whose PAT is the
  Postgres password and an owner to remove them. The changelog says revoking
  project access "immediately revokes their ability to log into the database";
  `doc-cited-not-tested` here.
- Revoking the PAT itself: token creation is not on the `/v1` API (the
  `GET /profile` route answers 403 `This endpoint requires a user-scoped access
  token` to this token), and revoking it would end the run. Not run.

## Pooler circuit breaker (observed in run 1, not designed)

Run 1 retried a refused pooler login every 2 s for 60 s (JA01h), and the pooler
then answered `FATAL: (ECIRCUITBREAKER) too many authentication failures` to
logins that had a valid grant; `POST /network-bans/retrieve` listed one banned
IPv4 address and `DELETE /network-bans` lifted it. Run 1's pooler rows after
that point (JA01g `ja_reader` refusal at +45 s, JA01h, the JA01i held pooler
session, JA01j) are not interpretable and are not cited. Consequence for a
CI job holding an expired PAT grant: a retry loop on the shared pooler can lock
out other users of the same address with valid grants for as long as the
breaker stays open (clearing time not measured). From run 2 the module reads
the error code of every refusal (`ECIRCUITBREAKER`, `EJITREQUESTFAILED`,
`password`, `PAM`, `SASL`, `ENOTFOUND`), waits instead of retrying on a
breaker answer, and checks the ban list after each phase (0 bans in runs 2-5).

## Created and deleted

Projects (all named `ja-...`, Pro org, ap-southeast-1, smallest compute):
one exploratory (reused project), five module runs, and one extra project for a
logs-scope check. Recorded in the artifacts: each module run's `delete project:
HTTP <status>` log line (the module's `finally` block). Not recorded in any
artifact: the extra logs-scope project, a post-run `GET /v1/projects` listing
showing no `ja-` project left, and any spend figure. Those three were
observed in the session and are unrecorded here; treat them as unverified and
re-list the org's projects before relying on a clean state. No AWS or
Cloudflare resources were created.

## Unmeasured, with what would measure it

- Membership removal and PAT revocation (JA01l): a second human member.
- Sessions of an expired or deleted grant beyond 300 s / 15 s.
- `branches_only` scoping, the invite route on Pro, a Team or Free org.
- Direct path from an IPv4-only vantage (no A record without the IPv4 add-on).
- Per-client-IP scoping through the shared pooler (JA01j, not settled).
