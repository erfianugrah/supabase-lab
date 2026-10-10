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
  refresh output was not kept).

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

## Not measured, and scope

- One provider version (1.11.0) and one tofu version (1.13.1); not
  1.9.0, 1.10.x, or Terraform. One region (ap-southeast-1), one instance size
  (micro), one project age (created minutes before each run), sources of a
  few lines. No project with other functions already present.
- Whether unlisted functions ever appear in the listing, and for how long a
  destroyed function keeps answering, were not tracked beyond about three
  minutes after an apply and one read after a destroy.
- The mechanisms (the endpoint's handling of concurrent deploys, the
  provider's refresh dropping 404 slugs, the listing lagging the data plane)
  are reasoned from the counts, not observed. Separating probes: per-slug
  listing reads over time and a `TF_LOG` trace of one apply.
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
