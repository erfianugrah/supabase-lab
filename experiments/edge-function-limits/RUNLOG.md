# edge-function-limits - RUNLOG

One project, no AWS. Several separate ceilings get reported as a single "Edge
Functions limit", and most of them have different fixes. This experiment
measures each one on its own so a report says WHICH ceiling bit, on which
deploy path, with the platform's error verbatim - and, for the failures that
are not limits at all, whether the functions actually landed.

The documented figures are pinned in `lib/docs.ts` with the date they were
read (2026-09-02). Every module compares the runtime against those constants,
so `pvlab --diff` shows which side moved when they disagree.

Full write-up: https://erfi.dev/reference/supabase-edge-function-limits/

## Modules

| id   | mode        | question |
| ---- | ----------- | -------- |
| EF01 | read-only   | Do the four secrets limits declared in the published OpenAPI request schema match the docs? Is 413 a declared response of the deploy endpoint? Is `static_patterns` in the API contract? |
| EF02 | read-only   | Per org plan: does `function.max_count` match the docs table (Free 100 / Pro 1000 / Team 2000)? An override is `info`, not a fail - it is the lever. `function.size_limit_mb` recorded per plan. |
| EF03 | destructive | Secrets: reserved prefix, name length 256/257, value 24,576/24,577 chars, the same count in three-byte characters, and the 101st user secret. |
| EF04 | destructive | Function size by deploy path: API 2 MB / 8 MB, CLI `--use-api` 8 MB, CLI default 8 MB / 24 MB, then `--use-docker` at 8 MB only if the 8 MB default did not land. Every acceptance proven by GET + invoke. |
| EF05 | destructive | 24 API deploys 8-wide, 8 concurrent CLI processes, a same-slug race, a delete during a deploy: reported success vs landed, 409 vs 413 vs 429 kept apart, version regressions. |
| EF06 | destructive | Restrictions: HTML rewritten to text/plain, ports 25/587 blocked (443 control), Worker and node:vm unavailable, static files via API vs via CLI, `npm:sharp`. |
| EF07 | destructive | Runtime ceilings: CPU 500 ms vs 3 s, memory 64 MB vs 400 MB. Wall clock / idle timeout referenced to edge-resilience W13, not re-run. |

Pure logic (docs table, spec readers, the triage classifier) is unit tested:
`make unit` (or `bun test experiments/edge-function-limits` at the root). The
classifier's tests include the strings the platform actually returned below.

## Triage order the classifier encodes (`lib/triage.ts`)

1. The error string. A limit names itself and reproduces on retry.
2. How many deploys ran in parallel. A 413 under parallelism is labelled
   `misleading-413`; a 429 is `throttled`; a 409 is `conflict` and is never
   merged with 429.
3. Whether anyone checked the functions landed rather than trusting the exit
   code. Exit 0 or 2xx with the function absent afterwards is `silent-loss`.

## Validated 2026-09-02 (micro, ap-southeast-1, Pro org; CLI 2.116.0, Docker present)

Full battery EF03-EF07 in one pass (evidence/20260902-135131, 21 pass / 4
fail: three findings, EF05a, EF05b and EF06b, plus one harness error, the
EF06d2 static_files glob). EF03 and EF06 were then re-run together twice:
evidence/20260902-135529 after the glob fix and the EF03c2 three-byte change
(this run exposed the secrets-count error), and evidence/20260902-135726
after the secrets-count fix; 135726 is the clean evidence for EF03 and
135529 for EF06. EF01/EF02 ran earlier the same day without a project. Fails
below are findings, not harness errors, unless marked as a correction.

### Functions per project (EF02) - plan-gated, an entitlement

- free 100, pro 1000, team 2000 on the three lab orgs, matching the docs; no
  override on any of them. The public changelog entry of 2024-07-18 set 25 /
  500 / 1000, so a report quoting 500 is reading an older figure. On the
  current table a cap of exactly 1000 identifies Pro; a report built on the
  2024 figures would call 1000 Team, so check the date of the figure before
  mapping it to a plan.
- `function.size_limit_mb` is 20 on ALL THREE plans. Size is not a plan lever.

### Function size (EF04) - set by where bundling happens, all rows pass

- API deploy 2 MB: 201, landed, invoke reports 2,097,004 bytes.
- API deploy 8 MB: **413 `request entity too large`**. The genuine size
  rejection is a 413 with that body - not the "exceeds the maximum
  deployment size" string. Nothing was created (GET 404 afterwards).
- CLI `--use-api` 8 MB: exit 1, `unexpected deploy status 413:
  {"message":"request entity too large"}` - same ceiling by construction.
- CLI default 8 MB: exit 0 after 32 s (local bundle plus upload), landed,
  invoke reports 8,388,460 bytes. The default bundled locally (Docker
  present).
- CLI default 24 MB: exit 1, `unexpected create function status 413:
  {"message":"request entity too large"}`. The local ceiling is ALSO a 413
  with the same body, on a different CLI call ("create function" rather than
  "deploy"). So a 413 by itself does not say which path was over, and a
  serial reproduction is needed before the flaky-parallel-413 is ruled in or
  out (see EF05).

### Secrets (EF03) - four limits, all at the documented boundary

- Reserved prefix: 400 `0.name: Secret name must not start with the
  SUPABASE_ prefix.`
- Name: 256 accepted, 257 refused 400 `0.name: Too big: expected string to
  have <=256 characters`.
- Value: 24,576 accepted, 24,577 refused 400 `0.value: Too big: expected
  string to have <=24576 characters`.
- The value ceiling counts CHARACTERS: 24,576 three-byte characters (73,728
  bytes) accepted. "48 KiB" is 24,576 at two bytes each, not a byte limit.
- Count: 100 user secrets stored, the 101st refused 400 `You can only store
  100 secrets per project at maximum.`
- CORRECTION recorded: once a project has had any function deployed,
  `GET /secrets` lists seven platform-managed `SUPABASE_*` entries (the project
  URL, the anon and service-role JWTs, the publishable-key and secret-key
  lists, the database URL, the JWKS). They do
  NOT count toward the 100 - a run that counted them stopped at 100 listed
  entries (93 user + 7 platform) and then had its next user secret, the 94th,
  accepted (evidence/20260902-135529). Count user secrets.

### When it is not a limit (EF05) - on a project created minutes earlier with no other functions

- **24 API deploys, 8 in flight: 24/24 answered 201, 10/24 present
  afterwards, 14 silent losses. No 429, 409 or 413 surfaced on any of the 24
  deploy responses.** Whether the verification GETs and cleanup DELETEs that
  followed were throttled is not recorded: the helpers retry through 429
  silently (see Operational notes). Not a read-timing artifact: the cleanup
  listing minutes later found exactly the functions the immediate GETs had
  found, 21 across the whole module (10 here + 9 in the CLI row + 1 same-slug
  + 1 delete-race), and none of the 14 missing ones.
- **8 concurrent CLI processes x 3 functions (`--use-api`): 8/8 exited 0,
  9/24 present, 15 exit-0-but-missing. No 429 text in any process output.**
  The public CLI issue's shape reproduces without the throttle being visible,
  so the throttle explains none of the loss here rather than "only part".
- Same-slug race: one seed deploy (version 1), then 3 rounds of 2 concurrent
  deploys: statuses 201:3 | 409:3, versions 1 -> 2 -> 3 -> 4 (one bump per
  201, none per 409), no regression, invoke 200 afterwards. **409 is the
  concurrent-same-slug signature** and stays distinct from 429.
- Delete during a deploy of the same slug: deploy 201, delete 200, function
  present and ACTIVE afterwards, invoke 200 (n=1).

### Restrictions (EF06)

- HTML: GET returning text/html arrives as `text/plain`; a POST keeps
  `text/html; charset=utf-8`. The rewrite is GET-only, as documented.
- Ports: 25 blocked (`pvlab-timeout-8000ms` - a hang, not a refusal). **587
  OPEN** on two runs (TCP connect to a public SMTP host succeeded), 465 open,
  443 control ok. The docs' "25 and 587 are not allowed" did not hold for 587
  at the TCP layer on this project; whether SMTP submission completes was not
  probed.
- Worker: `typeof Worker` undefined, construction `ReferenceError`. node:vm:
  import fails `NotCapable: Requires run access`. Both unavailable.
- Static files via the API deploy with `static_patterns`: **201, and the
  asset is missing at runtime** (`NotFound ... /source/static/hello.txt`).
  The deploy reports success and the function 500s. The restriction holds in
  its worst shape.
- Static files via CLI local bundling with `static_files` in config.toml:
  exit 0, file readable at runtime. CORRECTION recorded: `static_files`
  paths are relative to the `supabase/` directory (`./functions/<name>/...`);
  a `./supabase/functions/...` glob matched nothing and shipped a 654 B
  bundle with no error (evidence/20260902-135131).
- `npm:sharp`: bundles and deploys (201), invocation 500 with an empty body.
  Fails at run time, not at bundle time.

### Runtime ceilings (EF07)

- CPU: 500 ms busy loop -> HTTP 200; 3 s -> **546
  `{"code":"WORKER_RESOURCE_LIMIT","message":"Function failed due to not
  having enough compute resources (please check logs)"}`**.
- Memory: 64 MB -> HTTP 200; 400 MB -> the same 546 WORKER_RESOURCE_LIMIT.
  CPU and memory exhaustion are indistinguishable from the response.
- Wall clock / idle timeout: edge-resilience W13 (504 IDLE_TIMEOUT at 150 s).

## Operational notes

- The lab project was created with `make apply` (4 s to ref, ~1 min to
  ACTIVE_HEALTHY) and destroyed with `make destroy` the same hour.
- Run the destructive battery detached (`setsid nohup make probe-destructive`)
  or in a shell without a command timeout: EF04's Docker rows plus EF05 take
  ~3 minutes on this machine, and a killed run leaves functions deployed.
- EF05 is built to provoke the control-plane rate limit; the deploy responses
  themselves never returned 429 on this run, and whether the follow-up GET and
  DELETE calls did is not recorded, because `landedPatiently` and
  `deleteFunction` retry through 429 silently so the verification and cleanup
  survive it. Cleanup left nothing behind on any run.
