# terraform-edge-functions - RUNLOG

What the OpenTofu `supabase` provider's `supabase_edge_function` and
`supabase_edge_function_secrets` resources do with 24 functions in one apply:
whether "Apply complete" means the functions are there, how an update and a
destroy behave, and whether the loss measured through the Management API in
`edge-function-limits` (EF05a: 24 x 201, 10 of 24 present afterwards) shows up
through the provider.

Evidence: `out/2026-10-10/` holds four redacted run artifacts with their facts
renderings. Everything below was measured on 2026-10-10 and is cited by run
and module id. Times in run names are UTC.

| run | start (UTC) | what it was |
|---|---|---|
| dev1 | 08:28 | first module version, on one pre-existing throwaway project, rows TF01-TF04 only |
| run2 | 09:01 | full module on a fresh project, deleted at the end |
| run3 | 09:44 | fresh project; the module threw "The operation timed out." after TF02d (TF02e onward have no row) and the cleanup row threw too, see TF01z |
| run4 | 10:05 (finished 10:54, 49 min) | full module on a fresh project, deleted at the end |

Setup common to the runs: tofu 1.13.1 and the `supabase/supabase` provider
1.11.0 (both read from the runs' `tofu_version` and `provider_version`
measurements; `tf/providers.tf` allows `~> 1.10` and the lock file pins
1.11.0), a Pro-org project on the micro instance in ap-southeast-1, one macOS
workstation as vantage, function sources of a few lines each. "Listed" always
means `GET /v1/projects/{ref}/functions` shows the slug. "Serves" means an
invocation of the function URL returned HTTP 200 (status only; the body was
checked only where a row says so). The module text was edited between runs
(row titles and detail fields differ between dev1, run2, run3 and run4), so a
figure is compared across runs only where those runs recorded it.

Source for the resources: the public May 2026 developer update
(https://supabase.com/changelog/45702-developer-update-may-2026), fetched on
2026-10-10: "Terraform Provider v1.9.0 adds Edge Functions resource, Edge
Function secrets resource, and a network bans data source."

## Findings, 2026-10-10

### TF01a - 24 functions + secrets resource, one apply at -parallelism=24

- **tofu reported success every time; the API listed 3 to 5 of the 24.**
  `Apply complete! Resources: 25 added, 0 changed, 0 destroyed.` with 0 error
  blocks in all four runs (24 functions + the secrets resource). Listed 10 s
  after the apply and again 70 s after it: dev1 3/24 and 3/24, run2 5/24 and
  5/24, run3 3/24 and 3/24, run4 4/24 and 4/24. The listing did not grow
  between +10 s and +70 s in any run. The apply itself took 2.7 to 5.9 s
  (`apply_ms` 2652 to 5859).
- **The listed ones all answer 200** (run2 5/5, run3 3/3, run4 4/4).
- **The unlisted ones are not absent from the data plane.** run3: for the 21
  unlisted slugs `GET /functions/{slug}` returned 404 on 21 and an invocation
  returned 200 on 21. run4: 404 on 20, invocation 200 on 20. (Two runs; dev1
  and run2 predate the probe.) So "lost" is the wrong word for these: they
  serve, and the control plane neither lists them nor returns them by slug.
  Whether they appear in the listing later was not tried; the reads were
  within about three minutes of the apply.
- Baseline at `-parallelism=1` (TF02a, same 24 functions + secrets): 24/24
  listed at +10 s and +70 s, 24/24 serve 200, 3/3 secrets listed, in 37 s
  (run2), 41 s (run3), 31 s (run4). dev1's TF04a, 24 functions without the
  secrets resource at width 1: 24/24 in 32 s.

### TF01b - re-plan, then re-apply at -parallelism=24

- A re-plan right after the first apply was not clean: exit 2, 21 add / 1
  change (dev1), 19 add / 1 change (run2), 21 / 1 (run3), 20 / 1 (run4). The
  "add" count equals 24 minus the listed count in each run. Which resource the
  "1 change" is was not recorded; the secrets resource is the likely one (it
  was 0/3 listed in run3 and run4) and that was not checked.
- Four re-apply rounds at 24, each exit 0 with 0 errors, each reporting a
  number of creations. Listed after rounds 1 to 4: dev1 5, 8, 10, 13; run2 5,
  8, 11, 14; run3 6, 8, 11, 14; run4 5, 7, 9, 10. Final listed after four
  rounds: 13, 14, 14, 10 of 24. No run converged in four rounds.
- In all 16 rounds (4 runs x 4) the number tofu reported creating equals 24
  minus the number listed before the round (run4: 20, 19, 17, 15 reported,
  against 4, 5, 7, 9 listed before). So each round re-creates the unlisted
  slugs and a few more become listed. A provider read that drops 404 slugs
  from state and re-creates them fits this; it was not separated here (the
  refresh output was not kept). TF06 observed it on 2026-10-23 (below).

### TF01c, TF04g - the secrets resource at -parallelism=24

- First apply alone: 0/3 declared secrets listed (run3, run4; dev1 0/3 with
  the read point not recorded). After the four rounds: 3/3 in run4 and in run2
  (run2's module version did not record the first-apply count), 0/3 in run3.
- A fresh apply of 24 functions + the secrets resource at 24 (TF04g): 0/3
  secrets listed in run2 and in run4. The same resource at `-parallelism=1`
  (TF02a): 3/3 in run2, run3 and run4.

### TF02 - update in place

- **Every changed source is planned as an in-place update, never a
  replacement**: plan 0 add / 24 change / 0 destroy, 0 must-be-replaced, in
  TF02c and TF02d (run2, run3, run4), and 0 add / 1 change / 0 destroy in
  TF02e (run2, run4).
- **Every update apply exits 1 with `Provider produced inconsistent result
  after apply`, three errors per function** (72 for 24 functions) on
  `.checksum`, `.updated_at` and `.version`; tofu's own text says "This is a
  bug in the provider". The update itself lands: at `-parallelism=1` (TF02c)
  24/24 listed versions increased and 24/24 serve the new body in run2, run3
  and run4; the plan afterwards is clean (exit 0, run3 and run4; run2's detail
  line has no plan field). A pipeline that fails on a non-zero apply exit
  fails on every update with this provider version, and the function is
  updated anyway. TF02e's single-function apply also exited 1 (run2, run4).
- **At -parallelism=24 (TF02d) the listing shows 2/24 versions increased in
  run3 and run4 and 6/24 in run2, while 24/24 serve the new body in all
  three.** Two readings fit: the listing lags the deploy, or the update path
  does not produce a new version per slug under concurrency. The separating
  read, the listing minutes later, was not run. Applies took 2 to 5 s at
  width 24 against 36 to 42 s at width 1.
- Change one source (TF02e, apply at 24, run2 and run4): the other 23
  functions' listed versions did not move, 1 version increased.
- Secrets (TF02f, run2 and run4): change one value, add one, remove one. The
  changed secret's returned value differs, the untouched one's does not, the
  added one is listed, the removed one is gone; plan 0 add / 1 change, apply
  exit 0.
- Out of band (TF02g, `info`, run4): an undeclared secret created with `POST
  /secrets` (HTTP 201) is not seen by tofu (re-plan exit 0) and survives the
  next apply; a declared secret changed out of band gives re-plan exit 2 with
  1 change, and the apply sets it back to the declared value. In run2 the
  first re-plan of this step was exit 2 and run2's TF02b (re-plan with nothing
  changed) was also exit 2; no error text was recorded, so run2's value is
  unexplained and "tofu does not see an undeclared secret" rests on run4
  alone.

### TF03 - destroy

- **At -parallelism=24 (TF03a), after the TF01 rows, destroy exits 0, state is
  emptied, and the functions stay.** State held 24 function addresses before
  the destroy in run2, run3 and run4; destroy reported 15, 15 and 11
  destroyed with 0 errors, and 0 addresses were left in state. The API listed
  14 (run3) and 10 (run4) functions before the destroy and 13 and 10 ten
  seconds after it; every function still listed had been listed before. run2
  did not record the count before, 14 were listed after the TF01b rounds and 14
  after the destroy; dev1 reported 20 destroyed and 18 still listed. The
  reported count equals the listed functions plus the secrets resource (14 + 1,
  10 + 1), by arithmetic; the other addresses were gone from state before the
  destroy finished and were not destroyed.
- **run4 only (the invocation was added to the module after run3): invoking
  all 24 slugs after the destroy returned 200 on 23 and 404 on 1**, so after a
  destroy that reported success, 23 of 24 functions still answered. One trial;
  the data plane was read once, within a few minutes of the destroy, and
  whether it empties later was not tried.
- A clean destroy exists: from a converged state at `-parallelism=1` (TF03b,
  run4) exit 0, 25 reported destroyed, 0 functions listed, 0 declared secrets
  left. run2's TF03b failed (exit 1, 1 error, 24 functions listed and 3
  secrets left); its error text was not recorded.
- Width sweep on fresh state, apply then destroy at the same width, no secrets
  resource (TF04a-f). Each cell is the number listed at +70 s after the apply,
  then the number still listed 10 s after the destroy:

  | width | dev1 | run2 | run4 |
  |---|---|---|---|
  | 1 | 24, left 0 | 24, left 0 | 24, left 0 |
  | 2 | - | 17, left 7 | 17, left 7 |
  | 4 | - | 9, left 4 | 13, left 7 |
  | 10 | 4, left 3 | 6, left 5 | 5, left 4 |
  | 24 | 4, left 3 | 3, left 2 and 3, left 2 | 3, left 2 and 2, left 1 |

  With the secrets resource at 24 (TF04g): run2 4 listed, 3 left; run4 3
  listed, 1 left. In run4 each leftover had been listed before the destroy
  (`left_were_listed_before` equals the left count in every row); run2 and
  dev1 did not record that. Apply time fell with width (run4: 33, 15, 13, 4,
  3, 2 s at widths 1, 2, 4, 10, 24, 24). Direction at both ends: more
  concurrency, fewer functions listed after the apply, fewer of the listed
  ones removed by the destroy. Which listed ones were removed was not tracked
  per slug.
- The leftovers were removed afterwards by the module's own serial API
  deletes (the "removed through the API" count in each detail line equals the
  left count); the statuses of those deletes were not recorded.

### TF05 - the same 24 functions through the Management API, no provider

- 24 deploys with 24 in flight: 201 on 24, 3/24 listed at +10 s and +70 s
  (run2 in 81 s, run4 in 77 s). 24 deploys one at a time: 201 on 24, 24/24
  listed (75 s, 76 s). Two runs; run3 did not reach it.
- The provider is therefore not what makes functions unlisted: the endpoint
  produces 3 of 24 with no provider involved, the same shape as EF05a (24
  deploys, 8 in flight, 10 of 24 present). What the provider adds is that it
  reports 25 created and exits 0 without checking the listing. The EF05
  section of the `edge-function-limits` RUNLOG does not record an invocation
  of its missing 14, so whether those served is open.

### TF01z - cleanup

- run2, run4: project delete HTTP 200, gone from `GET /projects`. run3: the
  module threw "The operation timed out." (client side; which call is not
  recorded) and the cleanup row also threw. Checked on 2026-10-10 after run4:
  `GET /v1/projects` lists 3 projects, none created by this experiment (no
  name starting `tf-` or the earlier labels, none with dev1's project
  reference).

## Findings, 2026-10-23 - TF06, the loss observed

The 2026-10-10 sections infer the loss mechanism from counts. TF06
(`tests/tf06-parallel-loss-trace.ts`) watches it happen. Two runs on two
fresh Pro-org micro projects in ap-southeast-1, each deleted at the end;
tofu 1.13.2 (one patch release after the 2026-10-10 runs), provider 1.11.0.

| run | start (UTC) | artifact | rounds |
|---|---|---|---|
| t1 | 08:28 | `out/2026-10-23/run-2026-10-23T08-28-55-230Z.json` | two provider rounds (TF06a/b, TF06c/d) |
| t2 | 08:41 | `out/2026-10-23/run-2026-10-23T08-41-12-874Z.json` | two provider rounds (TF06a/b, TF06c/d), one direct-API round (TF06e/f) |

What one round does: 24 fresh slugs and fresh state, one apply at
`-parallelism=24` (or, in TF06e, the same 24 multipart deploys sent by the
module, all in flight). The provider talks to the Management API through a
recording reverse proxy on 127.0.0.1 (`SUPABASE_API_ENDPOINT`), which keeps
method, path, status, timing and, for function responses, the body's slug,
version and id (ids are replaced by their order of arrival, `#1` to `#24`).
A side poller reads `GET /v1/projects/{ref}/functions` and, round robin,
`GET /functions/{slug}`, each loop once per 250 ms (median gap 250 to 251 ms
in every round), from 1 s before the apply to 20 s after it, pausing when
the token's `x-ratelimit-remaining` reached 30 (2 to 8 paused ticks per
round). `TF_LOG=DEBUG` with provider `TRACE` goes to a file outside the repo;
only line counts and Create-call timing are in the artifact. After the
apply: a re-plan through the proxy, a per-slug GET and an invocation of all
24, and a listing at +299 s. The module text changed between t1 and t2: t2
checks that each invocation body carries its own slug's tag, adds the
direct-API round, and runs the re-plan before the per-slug sweep on a fresh
rate-limit window.

### What the provider sent (TF06a, TF06c in t1 and t2)

- **24 `POST /v1/projects/{ref}/functions/deploy?slug=...`, one per slug, all
  24 in flight at once, 24 x 201, and no other request during the apply** in
  all four provider rounds (`deploy_posts` 24, `deploy_posts_max_per_slug` 1,
  `deploy_max_in_flight` 24, `deploy_status_histogram` 201:24,
  `other_provider_calls_in_apply` 0). Median deploy 1335 to 1425 ms; apply
  2172 to 2574 ms. The TF_LOG agrees on the overlap: 24 Create calls, 24 open
  at once (`tflog_create_max_overlap` 24), medians 1333 to 1427 ms.
- **Every 201 body named the slug that was sent and carried its own id**:
  `distinct_ids_in_201` 24 and `body_slug_mismatch` 0 in every round, version
  1 on all of them. The provider has nothing to drop: it builds state from
  this body (provider v1.11.0 `deployEdgeFunction` reads `JSON201`; read from
  the source at the v1.11.0 tag, 2026-10-23) and makes no read-back.
- No retry of a write, measured (0 slugs with a second POST) and by source
  (`getOnlyRetryPolicy` retries GETs only, up to 3 times).
- TF_LOG at DEBUG/TRACE holds no HTTP line: 0 method-and-path lines and 0
  retry lines in every apply and re-plan log (`tflog_http_method_lines`,
  `tflog_retry_lines`). The provider's retrying client has its logger set to
  nil (source), so a `TF_LOG` trace alone cannot show the wire; the proxy is
  what this section's request counts come from.

### What the listing did, per slug, at 250 ms

- **Slugs were listed and then unlisted while nobody sent a delete**: 3 and
  5 slugs (t1), 3, 3 and 3 (t2) (`listed_then_unlisted_slugs`), 17 across
  five rounds. The provider sent only the 24 POSTs and the poller sends only
  GETs. The listed set during the second after the 201s, at each change
  (t2 TF06a): `2.55:{07} 2.80:{06} 3.05:{02} 3.30:{05,07}`; TF06c
  `2.51:{16} 2.76:{19} 3.00:{08,16} 3.26:{03,20}`; the direct round TF06e
  `2.01:{12} 2.51:{01,05} 2.76:{07,12}`. Each read shows one to three slugs,
  and a later read replaces them; slug 07 in t2 TF06a was listed, unlisted,
  then listed again.
- Peak listed 2 or 3 of 24 (`list_peak`); 4 to 6 ever listed (`ever_listed`);
  2 or 3 at the last poll, about 19 s after the apply
  (`listed_at_last_read`), and the same count at +299 s with nothing gained
  (`late_listed`, `late_gained` 0, all five rounds). The first slug was
  listed 2.01 to 2.77 s after the poller started, about 1 s after the first
  POST went out. The listed set stopped changing within 0.15 s of the last
  201 arriving (last change 3.53, 3.51, 3.30, 3.26, 2.76 s against last 201
  at 3.57, 3.36, 3.15, 3.17, 2.71 s, `deploy_last_end_s`; t1's rounds from
  the per-slug ranges, t2's from the recorded set) and held for the rest of
  the 20 s poll.
- The per-slug read agrees with the listing: no slug the listing never
  showed ever answered 200 by slug (`never_listed_but_get_200` 0, every
  round), and in t1 TF06a slug 12 answered `200@3.02` then
  `404@9.59,404@15.61,404@21.63` after the listing dropped it. That is the
  only by-slug capture of a drop: the round robin visits each slug every
  ~6 s and the drops happen within about a second, so 1 of the 17 was caught.
- The slug whose 201 arrived last (`#24`) was among the survivors in 4 of 5
  rounds (t1 TF06a `r1-20`, t1 TF06c `r2-19`, t2 TF06a `r1-05`, t2 TF06c
  `r2-20`; not in t2 TF06e, where `#24` was never listed). Read off the
  per-slug timelines in the artifacts' evidence fields; five rounds.
- The same happens without the provider: t2 TF06e, 24 deploys sent by the
  module through the same proxy, 201:24, 24 distinct ids, 4 ever listed, 3
  listed then unlisted, 2 at the end and at +299 s.

### The data plane, and the provider's refresh

- **All 24 slugs answered 200 in every round, and in t2 every body carried
  its own slug's tag** (`invoke_hist` 200:24 in all five rounds;
  `invoke_own_body` 24 in TF06b, TF06d, TF06f of t2). 18 to 20 of them per
  round were never listed (`never_listed_invoke_200`). The deployed code is
  per slug and intact; what goes missing is the control plane's record.
- **The re-plan reads each slug by GET and plans the 404s as new**: t2, both
  provider rounds, the refresh sent 24 `GET /functions/{slug}`, 200:2 and
  404:22, the plan said 22 to add, exit 2, the 404 set equals the unlisted
  set (`refresh_404_equals_unlisted` 1), and TF_LOG holds 22 "edge function
  not found" lines. This is the TF01b inference ("a provider read that drops
  404 slugs from state and re-creates them"), now observed.
- t1's re-plans exited 1 instead: the token's rate-limit window was spent
  (the module's own after-apply reads, and possibly other runs on the same
  token; not recorded). In each t1 re-plan 7 of 30 refresh GETs answered 429
  (24 slugs plus 6 retries; `refresh_hist` 200:2|404:21|429:7 and
  200:3|404:20|429:7): one slug got 429 on its first try and on all 3
  retries, about 10 s apart, and a second slug got 429 three times before
  its fourth try passed (re-plan wire in the TF06b and TF06d evidence). The
  provider then stopped with `Unable to read edge function, got status 429:
  {"message":"ThrottlerException: Too Many Requests"}` (local TF_LOG of t1
  round 1, extracted by hand). The provider caps each wait at 10 s (source) against
  a 60 s window. t2's per-slug sweep after the re-plan was throttled the same
  way (`get_by_slug_hist` 200:1|404:5|429:18 and 200:1|404:6|429:17); the
  poller's reads and the +299 s listing cover those rounds.

### Which mechanism the evidence supports

| reading (RUNLOG 2026-10-10) | TF06 evidence | verdict |
|---|---|---|
| the provider sends fewer deploys than it reports, or retries | 24 POSTs, 1 per slug, 0 other calls, 4 rounds | not this |
| 409, or a 201 whose body the provider drops | 201:24 with the requested slug and a distinct id in every round | not this |
| several slugs share one bundle, last writer wins | 24/24 invocations serve their own slug's code (t2, 3 rounds) | not this |
| the listing lags the deploys | 0 of 24 gained between +19 s and +299 s (5 rounds); never-listed slugs 404 by slug too | not this |
| concurrent deploys replace each other's control-plane record | 17 slugs listed then unlisted with no delete sent; the listed set flips between sets of 1 to 3 and settles at 2 or 3; same with no provider | supported |

The last row is what the endpoint does as seen from outside. Which store
holds the record and how a concurrent write removes another slug's entry
(a read-modify-write of a per-project set is one design that produces this
shape) is not visible from the Management API and was not probed. Scope:
provider 1.11.0, tofu 1.13.2, ap-southeast-1, micro, fresh projects with no
other functions, 24 sources of a few lines, five rounds in two runs on
2026-10-23, one vantage. The proxy adds a local hop to every provider
request; the end counts (2 or 3 of 24) sit in the range the unproxied
2026-10-10 runs gave at width 24 (TF04e/f: 2 to 4 listed at +70 s, dev1,
run2, run4).

## Not measured, and scope

- One provider version (1.11.0); tofu 1.13.1 (2026-10-10) and 1.13.2 (TF06); not
  1.9.0, 1.10.x, or Terraform. One region (ap-southeast-1), one instance size
  (micro), one project age (created minutes before each run), sources of a
  few lines. No project with other functions already present.
- Whether unlisted functions ever appear in the listing was tracked to
  +299 s after an apply in TF06 (none did, five rounds), not beyond. How long
  a destroyed function keeps answering was not tracked beyond one read
  after a destroy.
- The mechanisms were reasoned from the counts on 2026-10-10. TF06
  (2026-10-23, above) observed the listing flip between sets of 1 to 3 slugs
  with no delete sent (read: concurrent deploys replace each other's
  control-plane records), no slug gained between +19 s and +299 s, and the
  provider's refresh plan the 404 slugs as adds. Not observed: which store
  holds the record and how one write removes another slug's entry.
- "Update lands" is read from invoking the function (the body carries the new
  tag) and from the listed version; neither is a read of the stored source.
- The provider's public issue tracker was searched by title only, twice, on
  2026-10-10 ("edge function", "inconsistent result"); no issue about these
  resources' apply or update behaviour turned up. A report would give the
  versions above, the TF01a and TF02c rows and `out/2026-10-10/`.

## What to do about it

Design choices read off the measurements; the set was not tested together.

| row | lever | rests on |
|---|---|---|
| Apply edge functions with `-parallelism=1` | `tofu apply -parallelism=1` (31 to 41 s for 24 functions + 3 secrets) | TF02a, TF04a |
| After any wider apply, list the functions and compare with the declared set before trusting the exit code | `GET /v1/projects/{ref}/functions` | TF01a, TF04b-g |
| Do not destroy at width above 1 and then discard state | `tofu destroy -parallelism=1`; check the listing is empty before deleting the project or the state | TF03a, TF04b-g, TF03b (run4) |
| Expect exit 1 on every in-place update with this provider version and decide how the pipeline treats it | read the three `inconsistent result` attributes; re-plan and confirm exit 0 | TF02c, TF02d |
| Keep the secrets resource out of a wide apply | a separate apply of that resource at width 1 | TF01c, TF04g, TF02a |
| Keep deploys to one project one at a time across every client (pipelines, scripts, the CLI), not only inside one apply | a per-project lock or CI concurrency group around any deploy step | TF06e, TF05a, TF05b; design choice: two separate clients deploying at once was not run |
| Leave rate-limit headroom for the refresh | do not run a plan in the same minute as other bulk Management API reads on that token; the provider gives a throttled GET 3 retries at most 10 s apart against a 60 s window, then the plan exits 1 | TF06b, TF06d (t1) |
