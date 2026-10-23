# RUNLOG - cross-project-auth

Two Supabase projects, no AWS. Answers the question a tiered-tenancy design
rests on: can one project's identity be trusted by another, so a tenant moved
between projects keeps the token it already holds?

`hub` plays the identity provider - its GoTrue issues the tokens. `spoke`
plays the tenant's own project, configured to trust the hub. The names avoid
"shared"/"dedicated" because the trust question is independent of whichever
tenancy model sits on top of it.

Two things were being asserted rather than measured before this run:

1. The third-party-auth endpoint takes three config shapes
   (`oidc_issuer_url`, `jwks_url`, `custom_jwks`). A prior lab measured that
   `custom_jwks` is accepted and never works, and that `jwks_url` works. It
   never tested `oidc_issuer_url`, which was nonetheless written up as
   "likely the better choice" - a recommendation with no evidence under it.
2. Portability had a control - a token signed with a key the target does not
   trust was refused - but not the strongest available one. That control varies
   the TOKEN, so it leaves open whether the accepted token was accepted for the
   reason claimed. Varying the target's CONFIGURATION instead, with the token
   held byte-identical, closes that. (The guide's other control, "an anon key
   gets nothing", proves less than it looks: an anon bearer is signed by a key
   the target DOES trust and is stopped by grants and RLS, so it says nothing
   about signature validation at all.)

## 2026-08-03 - run 1 (Micro x2, ap-southeast-1)

Harness: `make probe` -> `pvlab --where local --destructive --only X01,X02`.
Both tests are `local` because the question is what the auth tier accepts over
the public API - no VPC, no runner; the PAT and two project refs are the whole
input. Run twice end to end, plus three X02-only repeats after tightening the
poll interval. Numbers below are the spread.

### X01 - which config shapes resolve

Resolution is the observable: `resolved_at` populated and `resolved_jwks`
non-null. A shape that never resolves is a shape whose tokens fail at request
time with `PGRST301`, long after the configuration looked correct.

| Shape | Create | Resolved | Time |
|---|---|---|---|
| `oidc_issuer_url` | 201 | yes | 59ms, 249ms |
| `jwks_url` | 201 | yes | 81ms, 79ms |
| `custom_jwks` | 201 | **no** | still null at 92.9s / 92.1s |

- `oidc_issuer_url` resolves, and it resolves ON the create response - the
  gap in the tenancy guide is closed, and the recommendation it carried
  without evidence turns out to be right. Both working shapes resolve to the
  same key material (identical `kid`, ES256), so the choice between them is
  about which URL you would rather hard-code, not about capability.
- `custom_jwks` reproduces the prior lab's finding on a fresh project pair:
  accepted with 201, key material echoed back intact on a later GET,
  `resolved_at` still null after 92s. It is not a slow path, it is a dead one.
- `type` comes back as `custom` for all three shapes, so the response field
  does NOT tell you which shape a given integration was created with. Read
  `oidc_issuer_url` / `jwks_url` / `custom_jwks` themselves.
- The hub's own OIDC discovery document is served and advertises `jwks_uri`,
  which is what makes the issuer form work at all. Its
  `grant_types_supported` is `authorization_code,refresh_token`.

### X02 - portability under three trust states

Design: ONE token, three trust states, in order, so acceptance is
attributable to the trust configuration and nothing else. The bytes of the
bearer are identical throughout.

| State | Expectation | Measured |
|---|---|---|
| No trust configured on the spoke | refused | `401 PGRST301` "No suitable key was found to decode the JWT" |
| Hub registered via `oidc_issuer_url` | accepted | accepted, `[]` (spoke empty) - 1038 / 1155 / 1169ms after the create |
| Slice copied to the spoke | reads it | 2 rows with the ORIGINAL token, no re-login |
| Trust deleted | refused again | `401 PGRST301` - 652 / 587 / 654ms after the delete |

Plus the isolation baseline on the issuing project: tenant A sees its 2 rows,
tenant B sees only its own 1 row, so RLS on `app_metadata->>tenant_id` is
doing the scoping rather than the token being all-powerful.

Reading the timings: the poll interval IS the error bar (`stepMs` in
`tests/x02-token-portability.ts`). The first probe fires immediately after the
API call and still sees the OLD state in both directions, so neither change is
synchronous with the write; a later poll sees the new one. Trust propagates in
well under two seconds each way, and that is as precise as this method gets.
Do not quote these as a latency figure - quote the shape: sub-second-ish, not
instant.

The revocation direction is the operationally interesting half and it had
never been measured: deleting a third-party-auth integration stops the tokens
it was verifying, promptly. De-provisioning a tenant's trust is a real
control, not an eventually-consistent hope.

## Why the negative control matters here

"The token worked on both projects" and "the API is not checking signatures"
produce identical observations. A foreign-key token distinguishes them, and the
earlier lab ran that one. The pre-trust state is the stronger version of the
same control: it holds the token constant and varies only the target's
configuration, so it also rules out the possibility that the accepted token
differed from the refused one in some way nobody was tracking. Two controls
that fail in the same direction for different reasons is the point.

## What this does NOT answer

- Whether enabling the OAuth 2.1 Server on the hub changes the token shape
  (`client_id` / audience handling) and therefore whether the spoke still
  accepts it. The discovery document already advertises
  `authorization_code`, so the surface exists; untested. (Run 2026-10-23
  by X09, below.)
- Whether an `aud` mismatch is enforced. Both projects accepted the token
  with GoTrue's default `authenticated` audience; nothing here varies it.
  (Run 2026-10-23 by X08, below.)
- Refresh. The spoke trusts the hub's signing key, so it can VERIFY a token,
  but a refresh goes to the hub's `/token` endpoint. A promoted tenant still
  depends on the hub being alive at refresh time - which is the thing a
  "fully independent project" claim would need to address, and it is not
  tested here.
- Anything about Storage or Realtime accepting a foreign-issuer token. Only
  PostgREST was probed. (Run 2026-10-23 by X08/X09, below, with the hub
  project as the issuer.)

## Cost / teardown

Two Micro projects, ~20 minutes, destroyed same session. `make destroy`.

## 2026-08-17 - X03 green: refresh goes to the ISSUING project, measured

The "Refresh" gap in *What this does NOT answer* is now closed. X03 creates a
user at the hub, takes two independent password-grant sessions, then presents
session A's refresh token to the SPOKE's `/auth/v1/token?grant_type=refresh_token`
while session B's goes to the HUB as the control.

| Probe | Result | Evidence (verbatim) |
|---|---|---|
| X03a: hub refresh token at the SPOKE | HTTP 400 | `{"code":400,"error_code":"refresh_token_not_found","msg":"Invalid Refresh Token: Refresh Token Not Found"}` |
| X03-control: same token kind at the HUB | 200 | (success bodies are never recorded - they carry rotated tokens) |

Read: the spoke can VERIFY a hub-issued access token (X02) but cannot refresh
one - refresh tokens live in the issuing project's auth store, so a promoted
tenant depends on the hub being alive at refresh time, exactly as the gap
suspected. Success-body evidence is deliberately absent: GoTrue rotates on
refresh, so a recorded 200 body would carry live rotated tokens.

## 2026-10-23 - fan-out read across two projects (X04-X07, X99; two runs plus an X07 hang re-run)

The question: in a tenant-per-project layout, one tenant's rows live in more
than one project and a client (or an Edge Function) reads each project's Data
API and merges the results. Does one token reach both, what does the merge
cost against a single-project read of the same rows, does keyset pagination
stay correct across the merge, and what does the merged read do when one
project is unavailable?

Setup (`lib/fanout.ts`, self-provisioned, no OpenTofu state): two projects,
A and B, created through `POST /v1/projects` in a Pro-plan org, ap-southeast-1,
no compute size requested; read back from `/billing/addons` as `ci_micro` on
both, PostgreSQL 17.11 (X04a). A's Auth issues the token; B registers A as a
third-party issuer with `oidc_issuer_url` = A's `/auth/v1`, the shape X01
measured resolving on create. Both users are created on A with
`app_metadata.tenant_id`; the policy on both projects is `for select to
authenticated using (tenant_id = (select auth.jwt() -> 'app_metadata' ->>
'tenant_id'))`. Each Data API request carries that project's legacy anon JWT
as `apikey` and the user's A-issued access token as the bearer.

Data, identical in both runs: tenant-a has 576 rows on A and 664 on B (1240
in all); each project also holds 300 tenant-b rows. A's `fan_all` holds the
union of both projects' rows under the same policy: it is the single-project
baseline. Timestamps are microsecond-precision; the seed has 40 exact
cross-project ties on `created_at` and 100 clusters of three rows inside one
millisecond spread over both projects. Ground truth for X06 is every tenant-a
row in `fan_all`, ordered by `(created_at desc, id desc)` in Postgres.

Merge code: `lib/merge.ts`, the same file in both vantages. The Edge Function
source is that file's text plus a `Deno.serve` handler, deployed to A with
`verify_jwt` false (each Data API verifies the forwarded token itself).
Policy "all" fails the merged read on the first leg failure
(`Promise.all`); policy "settled" waits for both legs and returns what
answered, flagged partial.

Vantage: this lab's Mac over the public internet (the "client"); the Edge
Function was served in ap-southeast-1 (`SB_REGION` and `x-sb-edge-region`
both `ap-southeast-1`, X04f). Harness: `make fanout`, `--destructive`, from
source with bun; all three artifacts carry lab commit 661afdf with the
uncommitted tree that adds these modules (between runs 1 and 2, X07 gained the
dead_ref DNS row and the restart timeline evidence, and leg errors lost the
request URL; before run 3, the "never answers" target changed, below).
Published (redacted) under `out/2026-10-23/`:

- run 1 `run-2026-10-23T07-57-57-742Z.json`, 07:57:57 to 08:06:31 UTC:
  9 pass, 29 info.
- run 2 `run-2026-10-23T08-07-16-031Z.json`, 08:07:16 to 08:15:45 UTC:
  9 pass, 30 info.
- run 3 `run-2026-10-23T08-21-02-092Z.json`, 08:21:02 to 08:25:24 UTC: X04,
  X07 with `PVLAB_XF_MODES=hang` (the hang cells only), X99. 6 pass, 5 info.

Each run used its own fresh pair; X99 deleted both (DELETE 200 and 200, absent
from `GET /projects` at the first check, all three runs). Run 3's X04 matched
runs 1-2 (same counts, refusal and isolation); its trust was accepted after
1697 ms.

### X04 - one token, both projects

| Check | Run 1 | Run 2 |
|---|---|---|
| Before trust: tenant-a token at B | `401 PGRST301` | `401 PGRST301` |
| Trust create on B (`oidc_issuer_url`) | 201 | 201 |
| Same token accepted at B after | 1226 ms | 635 ms |
| tenant-a token: rows on A / on B, tenants seen | 576 / 664, tenant-a only | 576 / 664, tenant-a only |
| tenant-b token (also A-issued) at B | 200, 300 rows, tenant-b only | 200, 300 rows, tenant-b only |
| Edge Function on A, fan-out page of 50 | 200, both legs 200, page equals truth | the same |

The poll interval is 500 ms, so the acceptance times carry that error bar.
RLS on B reads the claim from a token B did not issue and scopes it the same
way A does.

### X05 - latency, merged two-project read vs single-project read

200 rounds per run, each round one sample of each of the four cells in turn
(5 warm-up rounds discarded first), page size 50, connections warm. Every
sample's page was compared with the ground truth's first 50 ids: 0 wrong
pages and 0 errors in all 8 cells x 200 samples. "single" = one leg, A's
`fan_all`; "fan-out" = A's and B's `fan_items` in parallel, merged. Edge
cells: the client round trip to the function on A; `inner` is the
function's own time from request to response. Milliseconds, nearest-rank
percentiles; at n = 200 the p99 is the third-largest sample.

| Cell | Run | p50 | p95 | p99 | max | inner p50 / p95 / p99 |
|---|---|---|---|---|---|---|
| client_single | 1 | 35.9 | 59.7 | 112.2 | 258.7 | - |
| client_single | 2 | 34.7 | 84 | 451.2 | 614.5 | - |
| client_fanout | 1 | 43.6 | 179.2 | 487 | 566.4 | - |
| client_fanout | 2 | 43 | 233.3 | 427.6 | 700.2 | - |
| edge_single | 1 | 157.9 | 262.6 | 630.6 | 693.5 | 57.4 / 132.4 / 272.3 |
| edge_single | 2 | 154 | 396.6 | 481.7 | 884.5 | 55.6 / 137.2 / 364.5 |
| edge_fanout | 1 | 174.1 | 343.9 | 571.5 | 2531.7 | 75.4 / 202.3 / 338.2 |
| edge_fanout | 2 | 176 | 379.4 | 645.8 | 812.7 | 75 / 225.3 / 302.2 |

Per leg inside the fan-out cells (p50 / p95 / p99):

| Cell | Run | leg A | leg B |
|---|---|---|---|
| client_fanout | 1 | 36.4 / 58.9 / 109.1 | 38.8 / 98.7 / 486.3 |
| client_fanout | 2 | 35.3 / 81.6 / 233.1 | 40 / 165.8 / 371.9 |
| edge_fanout | 1 | 58 / 127.1 / 251.5 | 59.8 / 169.8 / 256.9 |
| edge_fanout | 2 | 53.7 / 167 / 297.8 | 57.6 / 125.9 / 246.3 |

Reading (measured, two runs, one vantage):

- From the client, the median merged read cost 7.7 ms (run 1) and 8.3 ms
  (run 2) more than the single-project read. The p95 is where the fan-out
  shows: 179.2 and 233.3 ms against 59.7 and 84 ms. The merged read waits for
  the slower of two legs, so it takes the worse tail of the two every round;
  in the client cells of both runs leg B's p95 was above leg A's.
- The Edge Function added 119 to 133 ms at the median over the same read
  from the client (round trip 157.9 / 154 ms single, 174.1 / 176 ms
  fan-out, against 35.9 / 34.7 and 43.6 / 43), for one vantage. Inside
  the function, one leg to A's own Data API took 56.4 / 54.3 ms at p50,
  slower than the same read from the client (35.8 / 34.5 ms); the function
  reaches its project's Data API over the project's public URL. Why that
  hop is slower was not measured.
- Fan-out inside the function cost 18 and 19.4 ms at the median over the
  single read (inner p50 75.4 / 75 against 57.4 / 55.6).
- Not separated: how much of each tail is the network path from this vantage
  against the Data API itself. One run 1 edge_fanout sample took 2531.7 ms;
  its inner time was at most 422.6 ms (the inner max), so most of it was
  outside the function.

### X06 - keyset pagination across the merge

Page size 20, walked from the first page to exhaustion. Identical counts in
both runs except `positions differing` for keyset_ms_compare (1202 run 1,
1206 run 2; ids are random per run).

| Strategy | Pages | Rows returned | Missing | Duplicates | Equals truth |
|---|---|---|---|---|---|
| keyset_exact (cursor = last row's `created_at` text verbatim, microsecond-exact merge) | 63 | 1240 | 0 | 0 | yes |
| keyset_ms_cursor (same, cursor passed through a JS `Date`) | 61 | 1201 | 39 | 0 | no |
| keyset_ms_compare (`Date` comparator and `Date` cursor) | 61 | 1201 | 39 | 0 | no |
| offset (each project `offset = page x 20`, merge, keep 20) | 34 | 664 | 576 | 0 | no |
| single_keyset (A's `fan_all` alone, control) | 63 | 1240 | 0 | 0 | yes |
| edge_keyset_exact (keyset_exact, each page fetched by the function) | 63 | 1240 | 0 | 0 | yes |

- Keyset by `(created_at, id)` merges correctly across two projects when
  each leg gets the same cursor filter
  (`created_at < c OR (created_at = c AND id < i)`) and the cursor keeps the
  microseconds PostgREST returned. The exact ties broke by id across projects
  with no row lost or repeated.
- A cursor that goes through a JS `Date` truncates to milliseconds, so the
  rows older than the cursor row but inside the same millisecond fall outside
  `created_at < c` and are skipped. No error and no duplicate shows it; the
  walk ends 39 rows short. The count belongs to this seed layout
  (clusters and ties inside one millisecond): the offline replay of the same
  layout with the same merge code, no network, also loses 39
  (`lib/merge.test.ts`, "X06 replay over the seed layout"). Data with no two
  rows in one millisecond would lose none (reasoned, not measured).
- Per-project OFFSET does not compose with a merge: each page drops the
  rows the merge did not keep. The walk ended after 34 pages, when the
  longer project (664 rows) ran out; 664 of 1240 rows came back and 576
  never did (which project they came from was not recorded).

### X07 - one project unavailable

Per-leg timeout 3000 ms in every cell; n = 20 per cell per run, the four cells
interleaved. A was healthy throughout and every partial result carried A's
50 rows. Edge cells: the function answered HTTP 200 in all 160 edge calls
of runs 1 and 2 and all 40 of run 3, with the failure reported in the body.

| B broken by | Cell | Time to return, p50 / p95 ms (run 1; run 2) | Merged read | B leg |
|---|---|---|---|---|
| ref-shaped hostname of no project (DNS `ENOTFOUND` from the client, run 2) | client_all | 2.1 / 7.6; 1.9 / 3.7 | failed 20/20 | no response, `Error` |
| | client_settled | 48 / 80.6; 34.5 / 53.5 | partial 20/20 | the same |
| | edge_all | 114.8 / 168.3; 102.9 / 130.7 | failed 20/20 | `TypeError` ... `dns error` (run 2 text; run 1 truncated before it) |
| | edge_settled | 165.3 / 221.9; 140.6 / 217.7 | partial 20/20 | the same |
| hostname under `.invalid` | client_all | 2.1 / 4.6; 2.1 / 4 | failed 20/20 | no response, `Error` |
| | client_settled | 40.6 / 84.5; 33.4 / 41.8 | partial 20/20 | the same |
| | edge_all | 98.5 / 125.9; 103.3 / 118.7 | failed 20/20 | `TypeError` ... `dns error` (run 2 text) |
| | edge_settled | 164.3 / 512; 145.5 / 216.7 | partial 20/20 | the same |
| blackhole: an address where nothing answers the TCP connect (runs 1-2 only; target since removed, see below) | client_all | 3001.8 / 3002.8; 3001.7 / 3002.5 | failed 20/20 | `TimeoutError` |
| | client_settled | 3002.2 / 3002.8; 3001.7 / 3002.9 | partial 20/20 | the same |
| | edge_all | 3099.8 / 3136.6; 3104.4 / 3136.8 | failed 20/20 | the same |
| | edge_settled | 3102 / 3129; 3104.5 / 3140.6 | partial 20/20 | the same |
| hang: a path on A's Edge Function that accepts the request and answers after 20 s (run 3 only) | client_all | 3002.4 / 3003.1 | failed 20/20 | `TimeoutError` |
| | client_settled | 3002.7 / 3003.3 | partial 20/20 | the same |
| | edge_all | 3111 / 3135.7 | failed 20/20 | the same |
| | edge_settled | 3112.7 / 3148.8 | partial 20/20 | the same |
| B's trust in A deleted | client_all | 29.8 / 56.8; 30.7 / 44.8 | failed 20/20 | `401 PGRST301` |
| | client_settled | 43.1 / 73.1; 36.6 / 55.9 | partial 20/20 | the same |
| | edge_all | 154.8 / 396.7; 144.5 / 355.3 | failed 20/20 | the same |
| | edge_settled | 176.1 / 600.1; 178.2 / 280 | partial 20/20 | the same |

- Time to error is set by how B fails, and the merge policy decides whether
  the user sees anything. A DNS failure or a 401 arrives before A's rows,
  so from the client "all" errored at a p50 of about 2 ms (DNS) or about
  30 ms (401), and "settled" returned A's half at a p50 of 33.4 to 48 ms,
  close to a normal single read. A leg that never answers holds both
  policies to the timeout, whether nothing answers the connect (blackhole,
  runs 1-2) or the server accepts the request and stays silent (hang, run
  3): every such cell's p50 was 3001.7 ms or more, from either vantage,
  because neither policy returns until the slow leg gives up. The per-leg
  timeout is the latency of a partial result.
- Method change: runs 1-2 pointed B's leg at a documentation-range address
  for the blackhole cells. The lab keeps no address literals in committed
  files, so that target was removed from `tests/x07-fanout-one-down.ts` after
  run 2 and replaced by the hang path, which run 3 measured. The two are
  different failures (no TCP answer against an accepted request with no
  response) and gave the same timing at this timeout; the blackhole numbers
  stay above as measured, with no code in the repo that reproduces them.
- Revoking the trust is a fast, clean failure: `401 PGRST301` "No suitable
  key was found to decode the JWT", the same body as before trust existed.
  B refused 1741 ms (run 1) and 812 ms (run 2) after the DELETE, and the
  re-created integration was accepted again after 685 ms and 608 ms.

Restart of B (`POST /v1/projects/{ref}/restart`, HTTP 200), policy
"settled", one client sample and one edge sample per second until B had
failed and then answered for 30 s:

| | Run 1 | Run 2 |
|---|---|---|
| Samples / span | 82 / 89 s | 86 / 92 s |
| Samples with B's leg failed | 22 | 19 |
| First / last B failure after the call | 1.8 s / 58.1 s | 2.8 s / 61.0 s |
| Partial results / whole-read failures | 22 / 0 | 19 / 0 |
| B leg failures by kind | edge 521: 6, client 521: 4, client timeout: 6, edge timeout: 5, client `503 PGRST002`: 1 | client 521: 3, edge 521: 3, client timeout: 6, edge timeout: 6, client `503 PGRST002`: 1 |

Run 2's timeline (artifact evidence): 521 at 2.8 to 2.9 s, then every sample
from 6.9 s to 45.9 s timed out at the 3000 ms budget, then 521 at 47.0 to
47.4 s, `503 PGRST002` at 49.2 s, 521 again at 60.9 to 61.0 s, then 30 s
clean. During the timeout stretch each partial result took the full 3000 ms,
and consecutive samples were 3.1 to 4.0 s apart instead of 1 s. 521 is an
HTML error page, not a PostgREST body, so a client that parses every error
as JSON breaks on it.

Pause: `POST /v1/projects/{ref}/pause` on B answered `400 {"message":"Project
is not free-tier. Please downgrade it to free-tier first and try again."}` in
both runs, so on a Pro-plan org a paused project was not available as a
failure mode; restart was used as the real outage.

### What this does not answer

- Other vantages and regions: one client location, one region, both projects
  side by side. A tenant's projects in two regions would put a cross-region
  leg in every fan-out.
- Load: samples were sequential; no concurrency, no rate-limit behaviour.
- Cold paths: warm connections only; no cold Edge Function start, no
  first-request TLS or DNS cost.
- Larger fan-outs: two projects only; the tail effect with N legs was not
  measured.
- Writes, Realtime and Storage across projects: only Data API reads.
- Why the function's leg to its own project is slower than the same read from
  the client.
- Token refresh still goes to A (X03); A down was not tested here, only B.

## 2026-10-23 - audience mismatch and the hub's OAuth 2.1 server at the spoke (X08, X09, X99; three runs)

The questions, from *What this does NOT answer* above: does any verifier on
the spoke check `aud`, and does a token issued by the hub's OAuth 2.1 server
(which adds `client_id` and `scope`) still get accepted by the spoke? And,
since only PostgREST had been probed: do the spoke's Storage and Realtime
accept the hub's tokens at all?

Setup: the `lib/fanout.ts` pair (two projects created through `POST
/v1/projects` in a Pro-plan org, ap-southeast-1, no compute size requested;
not read back in these runs). A is the hub and issues every token; B
registers A as a third-party issuer with `oidc_issuer_url` = A's `/auth/v1`
(X08 creates the integration, HTTP 201 in all three runs). Users are created
on A through the admin API with `app_metadata.tenant_id = "tenant-a"`.
`lib/audprobe.ts` adds, on both projects: a private bucket `xaud` with one
object `tenant-a/probe.txt` written with the service_role key, a
`storage.objects` select policy on the tenant claim, and a `realtime.messages`
select policy that admits topic `tenant:<tenant claim>`. The data table and
its policy are X04's (`fan_items`, tenant-a has 576 rows on A and 664 on B).

The probe matrix presents one token to seven cells. Every request carries
that project's legacy anon JWT as `apikey`; the token under test is the
bearer, or the `access_token` of the Realtime join.

| Cell | Request | Accepted means |
|---|---|---|
| `a_rest`, `b_rest` | `GET /rest/v1/fan_items` | 200 with only tenant-a rows (576 on A, 664 on B) |
| `a_storage`, `b_storage` | `GET /storage/v1/object/authenticated/xaud/tenant-a/probe.txt` | 200 and the body written at setup |
| `a_realtime`, `b_realtime` | `phx_join` of private topic `tenant:tenant-a` | `phx_reply` status `ok` |
| `a_auth_user` | `GET /auth/v1/user` on A (A's own GoTrue) | 200 |

To vary `aud`, A gets a custom access token hook (`public.xaud_hook`,
enabled with `PATCH /v1/projects/{ref}/config/auth`
`hook_custom_access_token_enabled` / `hook_custom_access_token_uri`): it sets
`aud` to the user's `app_metadata.aud_override` (any JSON value, or removes
the claim for `"__drop__"`), and for a token carrying `client_id` with no
override it uses the single row of `public.xaud_oauth_aud` when one exists.
The custom access token hook docs (as read 2026-10-23) list `aud` as a
required claim, typed `string` in the hook's JSON schema.

Harness: `make fanout XF_ONLY=X08,X09,X99`, lab commit 77cdea0 plus the
uncommitted tree that adds these modules. Published (redacted) under
`out/2026-10-23/`:

- run 2 `run-2026-10-23T10-38-25-783Z.json`, 10:38:25 to 10:39:20 UTC:
  5 pass, 8 info. X09e here hit a flow defect (below), fixed before run 3.
- run 3 `run-2026-10-23T10-39-59-520Z.json`, 10:39:59 to 10:40:57 UTC:
  5 pass, 8 info.
- run 4 `run-2026-10-23T10-41-16-105Z.json`, 10:41:16 to 10:42:11 UTC:
  5 pass, 8 info.

Run 1 (10:36:42 UTC) is not published: A's fixture SQL answered 400, and its
error text was not kept, so A's Storage and Realtime cells refused every
token for a reason unrelated to the token. X09 then registered its OAuth
client right after the config PATCH, before Auth applied it, and stopped at
`404 feature_disabled`. Both were harness defects. The fixture SQL now runs
after the warm-up, retries and records its first error. X09 now polls
discovery before it registers a client. In run 1, B's X08 cells accepted
every token, as in runs 2-4 (console output, not published).
Each run's X99 deleted its pair (DELETE 200 and 200, absent from `GET
/projects` at the first check).

Runs 3 and 4 produced identical measurement cells for X08b-X08g and
X09b-X09e. Run 2 matched them except X09e. Quoted from run 4 unless a run
is named.

### X08 - aud other than "authenticated"

| Row | Token `aud` (as issued by A) | All seven cells |
|---|---|---|
| X08b control (hook in the path, no override) | `"authenticated"` | accepted |
| X08d | `"spoke-api"` | accepted |
| X08e | `["spoke-api"]` | accepted |
| X08f | `["authenticated","spoke-api"]` | accepted |
| X08g hook removes `aud` | no token issued | - |

- Every token in X08b and X08d-X08f read 576 tenant-a rows on A and 664 on
  B (`200 rows=576 tenants=tenant-a`, `200 rows=664 tenants=tenant-a`),
  downloaded the object on both projects (`200 body matches`), joined the
  private topic on both (`join ok`), and got `200` from A's
  `/auth/v1/user` (whose body reports the USER record's `aud`,
  `authenticated`, not the token's). Three runs, n = 1 token per row per run.
- No verifier on either project refused a token for its `aud`: PostgREST,
  Storage and Realtime on the spoke (B, verifying A's token through the
  third-party integration), the same three on the issuer (A), and A's GoTrue
  on `/auth/v1/user`. That includes an array `aud` that does not contain
  `authenticated`, which the hook docs' schema does not describe.
- Apart from `aud`, the claim set was the same in every row: `alg=ES256`,
  `kid` present, `iss=https://<ref-a>.supabase.co/auth/v1`,
  `role=authenticated`, no `client_id`, `amr=password`, `aal1`, 3600 s
  (`exp - iat`); claim names `aal, amr, app_metadata, aud, email, exp, iat,
  is_anonymous, iss, phone, role, session_id, sub, user_metadata`.
- X08g: with the hook removing `aud`, A refused to issue a token. The
  password grant answered `500 {"code":500,"error_code":"unexpected_failure",
  "msg":"output claims do not conform to the expected schema: \n- (root):
  aud is required\n", ...}` on both attempts, in all three runs. A token with
  no `aud` cannot come out of the hub; how the spoke treats one (a foreign
  signer would have to mint it) was not tested.
- X08c, the admin API's own `aud` field: `POST /auth/v1/admin/users` with
  `aud: "spoke-api"` answered 200 and the returned user's `aud` was
  `spoke-api`; the password grant for that user (anon key, right password)
  then answered `400 {"code":400,"error_code":"invalid_credentials",
  "msg":"Invalid login credentials"}` in all three runs. So the admin field
  sets the user's audience and that user cannot sign in through the default
  password grant; it does not produce a token with another `aud`. Why the
  grant refuses (an audience-scoped user lookup is the likely reading) was
  not probed.
- The hook took effect between the first and second password grant after the
  config PATCH (HTTP 200): the first fresh token still carried
  `"authenticated"`; the override showed at 3376, 3288 and 3311 ms (runs 2,
  3, 4), on a 3 s poll.
- Storage and Realtime on B accepted the hub's default token on the first
  probe in every run: the acceptance poll recorded no refusal on any surface.
  It started after fixture setup, seconds after the trust was created, so
  its times (REST 98 / 164 / 113 ms, Storage 682 / 1002 / 440 ms, Realtime
  971 / 1912 / 645 ms, runs 2 / 3 / 4, each from the poll's start with the
  surfaces probed in turn) are probe round trips, not propagation delays.

Reading: on these projects the audience is not part of acceptance on any of
the surfaces probed. A hub cannot narrow where its tokens are accepted by
choosing an `aud`; a spoke that wants to tell tokens apart can do it
in RLS (`auth.jwt() ->> 'aud'` or `client_id`, the pattern the OAuth server
docs show). That last step was not run here.

### X09 - the hub's OAuth 2.1 server

| Step | Runs 2, 3, 4 |
|---|---|
| Before: `oauth_server_enabled` read back | `false` |
| Before: `GET /.well-known/oauth-authorization-server/auth/v1` | `404 {"code":404,"error_code":"feature_disabled","msg":"OAuth server is disabled"}` |
| `PATCH /v1/projects/{ref}/config/auth` `{oauth_server_enabled: true, oauth_server_authorization_path: "/oauth/consent"}` | 200; read back `oauth_server_enabled=true`, `oauth_server_allow_dynamic_registration=false` |
| Discovery right after the PATCH | the same `404 feature_disabled` |
| First discovery 200 | 5149 / 5263 / 5119 ms after the PATCH returned (second poll, 5 s apart) |
| Discovery after | issuer `https://<ref-a>.supabase.co/auth/v1`; grants `authorization_code, refresh_token`; scopes `openid, profile, email, phone, offline_access` |

The getting-started guide's Cloud instructions (as read 2026-10-23) name
only the dashboard (Authentication > OAuth Server); the Management API auth config PATCH
enabled it with no dashboard step, as byo-oauth O03 and governed-starter-kit
K06 had already used it. The 2026-08-03 run 1 above read A's OIDC document
at `/auth/v1/.well-known/openid-configuration`, a different URL from the one
probed here; it is not the 404 above.

X09b: a confidential client registered through `POST
/auth/v1/admin/oauth/clients` (201). The code flow ran headless as tenant-a's
user on A: authorize with PKCE (302), `GET /oauth/authorizations/{id}` (200,
the pending request), consent approve (200), token with client_secret_basic
(200, `token_type` bearer, a refresh token, no non-empty `scope` field in the
token response). The access token's claims:

`alg=ES256; kid=present; iss=https://<ref-a>.supabase.co/auth/v1;
aud="authenticated"; role=authenticated; client_id=present; scope=openid
email; tenant_id=tenant-a; amr=oauth_provider/authorization_code; aal=aal1;
ttl_s=3600; claim_names=aal,amr,app_metadata,aud,client_id,email,exp,iat,
is_anonymous,iss,phone,role,scope,session_id,sub,user_metadata`

The issuer, key and `aud` are those of a password-grant token; the
additions are `client_id` and `scope`, and `amr` names the OAuth grant.

| Row | Token | All seven cells |
|---|---|---|
| X09c | OAuth access token as issued (`aud "authenticated"`) | accepted (3 runs) |
| X09e | second flow, same user and client, with the hook setting `aud` to `"spoke-api"` for tokens that carry `client_id` | accepted (runs 3, 4); claims as X09b except `aud="spoke-api"` |

- The spoke accepted the OAuth server's token on PostgREST (664 tenant-a
  rows), Storage and Realtime exactly as it accepts a password-grant token.
  Neither `client_id`, `scope` nor (X09e) a non-default `aud` changed any
  cell. The `scope` did not limit the Data API either, as governed-starter-kit
  K06 measured on one project.
- X09d, refresh: the OAuth refresh token presented to B's
  `/auth/v1/oauth/token` answered `404 {"code":404,"error_code":
  "feature_disabled","msg":"OAuth server is disabled"}`. That 404 is B's
  OAuth server being off. It says nothing about B refusing A's refresh token
  on its merits. The same refresh token at A answered 200 with a new access
  token (`aud "authenticated"`, `client_id` present). In this setup refresh
  went to the issuing project, as X03 measured for a password session.
- X09e's second flow: the `GET /oauth/authorizations/{id}` for a user who
  had already approved this client answered 200 with the redirect and code
  directly, with no pending request to approve (runs 3 and 4). Run 2's harness
  still POSTed consent and got `400 {"code":400,"error_code":
  "validation_failed","msg":"authorization request is no longer pending"}`,
  so run 2 has no X09e token.

### What this does not answer

- RLS keyed on `aud` or `client_id` on the spoke: the obvious way to make the
  spoke tell tokens apart, not run here (K06 measured `client_id` RLS on one
  project).
- A token with no `aud`, or an `iss` other than the registered issuer, at the
  spoke: A will not mint the first (X08g) and the second needs a foreign
  signer (third-party-auth's in-process issuer could).
- `sb_publishable_` keys as `apikey`: every request used the legacy anon JWT.
- Dynamic client registration, public clients, and consent through a real
  page: the client was confidential and registered through the admin API.
- B with its own OAuth server enabled, so whether B's `/oauth/token` would
  refuse A's refresh token on its own terms was not separated from the
  `feature_disabled` answer.
