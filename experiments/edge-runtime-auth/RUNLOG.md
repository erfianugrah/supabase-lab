# RUNLOG - edge-runtime-auth

Two questions about code that runs on Edge Functions and on the Workers runtime,
each measured on self-provisioned throwaway projects (Pro organisation, region
ap-southeast-1, deleted by the module that created them; no OpenTofu state).

- ER01: which credentials the five `@supabase/server` auth modes let through to
  the handler body, on an Edge Function and on the Workers runtime.
- ER02: an Edge Function canary - how long old and new builds are served after a
  redeploy, whether `supabase-js` `functions.invoke` retries a 503, and p50/p95
  over a sampling window.

Package source for the docs claims quoted below: the files under `docs/` in the
published `@supabase/server` 1.9.1 package (https://github.com/supabase/server).

## 2026-10-10 - versions and vantage

| item | value | source |
|---|---|---|
| `@supabase/server` | 1.9.1 | the run (`ER01-setup`, `server_version`) |
| `@supabase/supabase-js` / `@supabase/functions-js` | 2.117.3 / 2.117.3 | the run (`ER02-setup`) |
| wrangler in the container | 4.149.0 | `wrangler --version` in the image |
| workerd build | not recorded | bundled inside wrangler; no version query was run |
| vantage | this machine, Singapore; Cloudflare trace `colo=SIN loc=SG` | `ER02-setup` |
| lab commit | 70e4244 plus the uncommitted experiment directory | artifact header |

## What the workerd runs are, and are not

The runs `er01-a` to `er01-e` (00:54 to 01:00 UTC) deployed nothing to Cloudflare;
a Cloudflare token without Workers Scripts access was the only one available when
they ran, so the Workers matrices in the "ER01" section below are the same Worker
bundle running on workerd (the Workers runtime) inside a container on this
machine, with bindings supplied from a `.dev.vars` file. That leg shares the
runtime with Cloudflare's deployment; it does not exercise Cloudflare's edge, its
secrets store, or its network. The later run in "Cloudflare edge run" deployed
the bundle to Cloudflare with a Workers-scoped token and supersedes this
limitation.

## ER01 - auth modes x credentials

Run: `ER01`, started 2026-10-10 00:54:40 UTC, finished 01:00:55 UTC, n = 1
project, 30 results (23 pass, 7 info; artifact `out/2026-10-10/run-2026-10-10T00-54-40-928Z.json`). Fourteen credential
presentations at each of five modes, on five targets, 70 cells per target: Edge
Function with `verify_jwt` false, Edge Function with `verify_jwt` true, and three
Worker configurations on workerd (`wkauto`, `wkovr`, `wkjwks`). The Cloudflare
deployment of the same Worker, three more targets, is a separate run in the
"Cloudflare edge run" section below.

Fixtures (all real, none generated with the library under test):

- user token: password sign-in on the project's own Auth. Header `alg` ES256,
  `kid` present. Lifetime 3600 s.
- expired token: a real sign-in token issued with `jwt_exp` set to 300 s, then
  probed after its `exp`.
- third-party token: ES256, signed by an in-process key whose JWKS is served by
  an Edge Function on the project and registered through the Management API
  third-party-auth endpoint (HTTP 201).
- foreign token: ES256, signed by a key no project trusts.
- legacy HS256 token: signed with the project's shared JWT secret, no `kid`,
  `sub` set to the real user.
- keys: the project's legacy `anon` and `service_role` JWTs, and its `default`
  publishable and secret keys.

### Setup facts (measured)

| fact | value |
|---|---|
| keys on a new project | legacy anon + service_role, one publishable, one secret |
| user token header | ES256 with `kid` |
| variables the Edge Function runtime injected | `SUPABASE_PUBLISHABLE_KEYS` with name `default`; `SUPABASE_SECRET_KEYS` with name `default`; `SUPABASE_JWKS` set, one key of type EC/ES256; `SB_EXECUTION_ID` set; `SUPABASE_FUNCTION_SLUG` set; singular `SUPABASE_PUBLISHABLE_KEY` and `SUPABASE_SECRET_KEY` not set; `SUPABASE_JWKS_URL` not set |
| `jwt_exp` readback 300, then first sign-in | the first sign-in after the Management API read back 300 still carried the default lifetime; a second sign-in 10 s later carried 300 s (`short_lifetime_effective_after_s` = 10, resolution is the 10 s retry step). The same 10 s lag appeared restoring 3600 |
| JWKS endpoint without an apikey | HTTP 200 from this host, and from inside workerd (240 bytes, one key) |
| third-party token at the data API | PostgREST answered 200 |
| third-party token at the Edge Function gateway (`verify_jwt` true) | refused ("Invalid JWT") for 120 s of polling after registration (`gateway_accepted_after_s` = never), and refused again in the `verify_jwt` true matrix cell for that token; the time between registration and that matrix cell was not recorded |

### Expiry boundary (measured, user mode, Edge Function)

The short token was probed every ~4.2 s around its `exp`, offsets in seconds on
this machine's clock: accepted at -20, -15.5, -11.3, -7.1 and -2.9; refused with
`INVALID_JWT` from +1.4 onward (12 probes). The library accepted up to 2.9 s
before `exp` and refused by 1.4 s after it. The 4.3 s between those two probes
is not resolved, and this machine's clock against the platform's was not
measured, so a leeway under about 2 s is neither shown nor excluded.

### Matrix: Edge Function, `verify_jwt` false

Cell = HTTP status, then `ran:<authMode>` if the handler body executed, `lib:<code>`
if the library refused (its `x-supabase-server-error` header), `gw:<message>` if the
platform gateway refused before the function.

| credential | none | user | secret | publishable | user_secret |
|---|---|---|---|---|---|
| legacy_anon | 200 ran:none | 401 lib:INVALID_JWT | 401 lib:INVALID_API_KEY | 401 lib:INVALID_API_KEY | 401 lib:INVALID_JWT |
| legacy_service_role | 200 ran:none | 401 lib:INVALID_JWT | 401 lib:INVALID_API_KEY | 401 lib:INVALID_API_KEY | 401 lib:INVALID_JWT |
| publishable | 200 ran:none | 401 lib:UNUSABLE_CREDENTIAL | 401 lib:INVALID_API_KEY | 200 ran:publishable | 401 lib:INVALID_API_KEY |
| publishable_bearer | 200 ran:none | 401 lib:UNUSABLE_CREDENTIAL | 401 lib:INVALID_API_KEY | 200 ran:publishable | 401 lib:INVALID_API_KEY |
| secret | 200 ran:none | 401 lib:UNUSABLE_CREDENTIAL | 200 ran:secret | 401 lib:INVALID_API_KEY | 200 ran:secret |
| unknown_secret | 401 gw:Invalid API key | 401 gw:Invalid API key | 401 gw:Invalid API key | 401 gw:Invalid API key | 401 gw:Invalid API key |
| user_jwt | 200 ran:none | 200 ran:user | 401 lib:INVALID_CREDENTIALS | 401 lib:INVALID_CREDENTIALS | 200 ran:user |
| user_jwt_pub | 200 ran:none | 200 ran:user | 401 lib:INVALID_API_KEY | 200 ran:publishable | 200 ran:user |
| user_jwt_secret | 200 ran:none | 200 ran:user | 200 ran:secret | 401 lib:INVALID_API_KEY | 200 ran:user |
| expired_jwt_pub | 200 ran:none | 401 lib:INVALID_JWT | 401 lib:INVALID_API_KEY | 200 ran:publishable | 401 lib:INVALID_JWT |
| tpa_jwt_pub | 200 ran:none | 401 lib:INVALID_JWT | 401 lib:INVALID_API_KEY | 200 ran:publishable | 401 lib:INVALID_JWT |
| foreign_jwt_pub | 200 ran:none | 401 lib:INVALID_JWT | 401 lib:INVALID_API_KEY | 200 ran:publishable | 401 lib:INVALID_JWT |
| legacy_hs256_jwt_pub | 200 ran:none | 401 lib:INVALID_JWT | 401 lib:INVALID_API_KEY | 200 ran:publishable | 401 lib:INVALID_JWT |
| no_credentials | 200 ran:none | 401 lib:MISSING_CREDENTIALS | 401 lib:MISSING_CREDENTIALS | 401 lib:MISSING_CREDENTIALS | 401 lib:MISSING_CREDENTIALS |

Credential names: `_pub` = the request also carried the publishable key in
`apikey` (the shape a `supabase-js` client sends); `_secret` = the secret key in
`apikey`; `publishable_bearer` = the publishable key in both `apikey` and
`Authorization`; `unknown_secret` = a well-formed `sb_secret_` string that is not
a key of the project.

### Matrix: Edge Function, `verify_jwt` true (same code, gateway in front)

Differs from the table above in 20 of 70 cells. Every one is a request the
gateway refused before the function (`gw:`), and every one involves a bad or
absent `Authorization` bearer:

| credential | all five modes |
|---|---|
| expired_jwt_pub, tpa_jwt_pub, foreign_jwt_pub | 401 gw:Invalid JWT |
| no_credentials | 401 gw:Missing authorization header |

Not changed by `verify_jwt` true: a bare publishable key (200 ran:publishable in
`publishable` mode), a bare secret key (200 ran:secret in `secret` mode), the
publishable key in both headers, the legacy HS256 token (the gateway passed it:
200 ran:none in `none` mode and 200 ran:publishable in `publishable` mode; the
library still refused it in `user` mode with `INVALID_JWT`), and the legacy anon
and service_role JWTs (200 ran:none). The gateway therefore refused the
third-party token that PostgREST accepted, and accepted the HS256 token that the
library refuses.

### Matrix: Workers runtime (workerd in a container)

Three Worker configurations were run: env read from `process.env` under
`nodejs_compat` (`wkauto`), env passed as explicit `env` overrides (`wkovr`), and
overrides plus the project's JWKS inline (`wkjwks`). All three gave the same
70 cells. They differ from the Edge Function (`verify_jwt` false) table above in
5 cells, all in the `unknown_secret` row, which the Edge Function gateway refuses
(401 gw:Invalid API key) before the function and the Worker has no gateway to
refuse:

| mode | Edge Function | Worker |
|---|---|---|
| none | 401 gw:Invalid API key | 200 ran:none |
| user | 401 gw:Invalid API key | 401 lib:UNUSABLE_CREDENTIAL |
| secret, publishable, user_secret | 401 gw:Invalid API key | 401 lib:INVALID_API_KEY |

Every other cell of the Worker matrix is identical to the Edge Function table.
With the JWKS fetched at run time, `user` mode verified real user tokens on
workerd (200 ran:user) once the container had a CA bundle.

### Docs claims against cells

The expectation table is in `lib/matrix.ts`; a cell the package docs do not
state is counted as "docs-silent" rather than as a pass.

| target | cells | docs-stated cells that match | docs-stated cells that differ | docs-silent cells |
|---|---|---|---|---|
| Edge Function, `verify_jwt` false | 70 | 44 | 0 | 26 |
| Edge Function, `verify_jwt` true | 70 | 43 | 1 | 26 |
| Workers runtime, each of the three configurations | 70 | 44 | 0 | 26 |

- The one differing cell with `verify_jwt` true is `none` mode with no
  credentials: the docs say `none` needs no credentials, the gateway refused it
  with "Missing authorization header". That is the gateway, not the library.
- docs (`auth-modes.md`): "if your function uses `publishable`, `secret` or
  `none`, disable the platform-level JWT check". Measured with `verify_jwt` true:
  a bare publishable key, a bare secret key and the publishable key in both
  headers all reached the handler (200). The platform check refused a missing
  credential and a bad bearer (expired, third-party, foreign). So the setting
  mattered for `none` mode with no credentials and for any request carrying a
  bearer that is not a valid project JWT; the docs' blanket instruction is
  stricter than these cells. Scope: three valid-key shapes and three bad-bearer
  shapes, one project, one date.
- docs: "legacy HS256 tokens and old-format keys are rejected, not silently
  downgraded". Measured: refused by the library in `user` and `['user','secret']`
  modes (`INVALID_JWT`), and the legacy anon and service_role keys refused with
  `INVALID_API_KEY` in `secret` and `publishable` modes. Held on both runtimes.
- docs: "a JWT that is present and fails verification rejects immediately, it
  will not fall through to a later mode". Measured in `['user','secret']`: the
  expired, third-party, foreign and HS256 tokens, each with a publishable key
  in `apikey`, were refused with `INVALID_JWT`; the secret-key-only request still
  matched `secret` (200 ran:secret).
- docs: "the specific codes cover essentially every real failure;
  `INVALID_CREDENTIALS` is a fallback". Measured: a valid user JWT sent with no
  `apikey` to a `secret` or `publishable` mode got `INVALID_CREDENTIALS` (the
  `user_jwt` row, two cells per target). A fallback code on a plausible request,
  which the docs describe as rare.
- Cells the docs do not state, measured (selection): a valid user JWT plus the
  secret key in `secret` mode ran the handler (`ran:secret`); a bare publishable
  key in `none` mode ran; `publishable` mode ignores the bearer when a valid
  publishable key is in `apikey` (200 ran:publishable for the expired,
  third-party, foreign and HS256 tokens).

### Not settled by ER01

- A Cloudflare deployment in the runs above (see "Cloudflare edge run").
- Whether the third-party token's refusal at the Edge Function gateway is a
  propagation delay longer than the 120 s polled (the later matrix cell was not
  timestamped relative to registration), or a gateway rule. The data API accepted the same token. One issuer type (custom JWKS URL)
  was used; Auth0, Clerk or other registered providers were not.
- Edge Function cells were measured in a second project: the artifact diff
  between an earlier run (`er01-c`) and `er01-e` lists no change in any Edge
  Function matrix cell (it lists the Worker cells that the CA fix changed, the
  expiry offset, and the added data-API control). Worker cells are one
  container run after the CA fix.
- Handler bodies did not use `ctx.supabase` or `ctx.supabaseAdmin`; client
  construction, RLS and `supabaseAdmin` were not exercised.
- Other runtimes the package names (Vercel, Bun, Deno outside Supabase) were not run.
- Unknown `sb_publishable_` strings (only an unknown `sb_secret_` string was
  sent) and the named-key syntax (`publishable:<name>`, `secret:*`).
- The platform clock against this machine's clock (expiry offsets are on this
  machine's clock).

### Superseded ER01 runs (kept so the numbers above are not read as the first attempt)

- A first run was stopped after about 24 minutes: the module read the Management
  API's `jwt_exp` back as 300 and signed in once, got a 3600 s token, and waited
  for its expiry. The module now signs in until a token carries the wanted
  lifetime (`signInWithLifetime`).
- Two runs (`er01-c`, `er01-d`) showed Worker `user`-family cells failing with
  `JWKS_FETCH_FAILED` ("internal error") in the configurations that fetch the
  JWKS at run time. Cause: the container image (`node:22-slim`) has no CA bundle,
  so workerd's outbound https failed for every host. The inline-JWKS
  configuration passed in `er01-d`, which isolated it. The image now installs
  `ca-certificates`; `er01-e` is the first run with it. Those failures are a
  harness defect, not library behaviour.

## ER02 - canary: redeploy drift, `functions.invoke` retry, latency

Run: `ER02`, started 2026-10-10 00:54:40 UTC, finished 01:07:50 UTC, n = 1
project (artifact `out/2026-10-10/run-2026-10-10T00-54-40-928Z-er02.json`; the file name carries a suffix because both runs started in the same millisecond). One function, `er-canary`,
deployed through the Management API multipart endpoint (not the CLI), `verify_jwt`
false. It returns a build hash that the module substitutes into the source on
each deploy.

### Redeploy drift (5 cycles, 4 concurrent pollers)

Each cycle: 3 s of baseline polling of the old build, redeploy to a new build,
poll until the new build was the only answer for 20 s. Pollers were sequential
loops with a 100 ms pause. Each cycle was observed for about 30 s (30.0 to 30.1 s)
and collected 618 to 639 samples across the four pollers, about 21 samples/s
averaged over the cycle (deploy call included); the 3 s baselines held 74 to 105
samples each. Times are ms after the deploy API call returned.

| cycle | deploy API ms | last old-build answer | first new-build answer | old-build answers after the first new one | non-200 |
|---|---|---|---|---|---|
| 1 | 1391 | 8 | 975 | 0 | 0 |
| 2 | 1703 | none after the deploy returned | 781 | 0 | 0 |
| 3 | 1441 | none after the deploy returned | 976 | 0 | 0 |
| 4 | 1324 | 2 | 987 | 0 | 0 |
| 5 | 1558 | 36 | 974 | 0 | 0 |

Across the five cycles: no old-build answer after a new-build answer, 0 non-200
responses, and no answer of either build between 36 ms and 781 ms after the
deploy call returned. Latency of successful answers in the first 10 s after a
deploy: p95 240 ms, max 1035 ms, against a pre-deploy p95 of 109 ms over the 3 s
baselines. Reading: requests issued around the deploy boundary took up to about
1 s and then returned the new build. The module does not record when each
request was sent, so "held until the new version was ready" and "booted slowly"
are not separated.

An earlier ER02 run (`er02-full`, 2026-10-10) reported a 3 to 6 s mixed window
with 68 to 143 old-build answers after the first new one. That was a defect in
the module's time origin (pre-deploy samples were counted as post-deploy). The
module was corrected and `er02-full2` is the cited run; the earlier figures are
withdrawn.

### `functions.invoke` against an injected failure

`supabase-js` 2.117.3, `createClient` with a counting `global.fetch`, one
`functions.invoke` per trial, 3 trials per status. The function returned the
status itself and wrote one row to a table per request it received, keyed by a
request id header (an in-memory counter was not used: most latency-window answers
reported a module-load age under 2 s, see the latency note).

| injected status | client attempts per invoke (3 trials) | rows the function recorded (3 trials) | error class | `Retry-After` set |
|---|---|---|---|---|
| 503 | 1 / 1 / 1 | 1 / 1 / 1 | FunctionsHttpError | no |
| 503 | 1 / 1 / 1 | 1 / 1 / 1 | FunctionsHttpError | 1 s |
| 502 | 1 / 1 / 1 | 1 / 1 / 1 | FunctionsHttpError | no |
| 500 | 1 / 1 / 1 | 1 / 1 / 1 | FunctionsHttpError | no |
| 429 | 1 / 1 / 1 | 1 / 1 / 1 | FunctionsHttpError | no |
| 200 (control) | 1 / 1 / 1 | not recorded | none | no |

Neither the client nor the platform path to the function retried: each invoke
produced one outbound request and one function-side request, and returned an
error object with the status. `Retry-After` made no difference. This is 3
trials per status, one project, one client version. A relay-level 503 produced by
the platform itself (not by the function), a network failure (`FunctionsFetchError`)
and other client versions were not measured.

### Latency over a 600 s window (1 request/s to the function, 1 request/s to an RPC twin)

The function and a SQL function behind PostgREST (`/rest/v1/rpc/`, same
publishable key header) were called alternately, 600 of each, from this machine.
All 1200 answered 200.

| path | n | p50 ms | p95 ms | p99 ms | max ms |
|---|---|---|---|---|---|
| Edge Function | 600 | 88 | 112 | 146 | 242 |
| RPC twin | 600 | 27 | 44 | 68 | 147 |

Per 30 s bucket (20 buckets of 30 function requests each), the function's p95
had median 110 ms and max 151 ms; 0 buckets exceeded twice the median. Over the
whole window 466 of 600 function answers came from an instance whose `age_ms`
was under 2 s (the canary records `age_ms` since its own module load). Those
young-instance answers had p50 91 ms and p95 115 ms; the 134 answers with a
served count above 1 had p50 61 ms and p95 86 ms. `age_ms` is the time since
the canary's module was loaded, so a young `age_ms` shows a recent module load,
which the run does not separate from an instance start or from a reload inside
a longer-lived instance. The answers with an older `age_ms` were still slower
than the RPC twin (p50 in ms: 61 against 27). The module also
counted 543 distinct instance ids over 600 answers, which does not agree with 134
answers carrying a served count above 1 (about 466 distinct ids if every reuse
kept the same id); the disagreement is unresolved, so the instance id is not
relied on here.

Not measured: a sampling window at a request rate where instances stay warm, any
window longer than 600 s, more than one function or region, concurrency above 1
during the window, the platform's own logs (the Logs API was not queried), and a
p95 alert evaluated on a live incident. The "2x the median bucket p95" rule is a
threshold chosen here; it fired 0 times in steady state. The post-deploy 10 s
p95 (240 ms) was 2.2x the pre-deploy p95 (109 ms) but over a different window
length, so it is not a like-for-like firing.

## Cloudflare edge run (2026-10-10)

Run: `ER01`, started 2026-10-10 09:28:52 UTC, finished 09:35:15 UTC (6 m 22 s),
n = 1 new project (not one of the projects of the runs above), 46
results (38 pass, 8 info; artifact `out/2026-10-10/run-2026-10-10T09-28-52-860Z.json`). The module is the one
described above plus a Cloudflare leg: the same Worker bundle, built with
`bun build`, deployed with `wrangler` 4.147.0 (host) to `workers.dev` on one
account, `compatibility_date` 2026-09-01 with `nodejs_compat`, the project URL,
publishable key, secret key and the project's JWKS document as Worker secrets
(`wrangler secret bulk`). One Worker script serves the three env configurations,
which the Worker selects by the `env` query parameter (`auto`, `override`,
`jwks`), the same selector the workerd runs used. The workerd container ran in
the same module run, against the same project, so each Cloudflare cell has a
workerd cell from the same fixtures. Name prefix `er-` (the Makefile default).
The Cloudflare token (Workers Scripts edit) was supplied through the
environment and never written to a file.

### Cells, per target against workerd

Each target is 70 cells (14 credentials x 5 modes). Comparison is the cell text
(status, `ran:`/`lib:`/`gw:` and code), taken from the measurement tables of the
artifact.

| Cloudflare target | cells that differ from the workerd cell of the same configuration and run |
|---|---|
| `cfauto` (env from `process.env`) vs `wkauto` | 0 of 70 |
| `cfovr` (explicit overrides) vs `wkovr` | 0 of 70 |
| `cfjwks` (overrides plus inline JWKS) vs `wkjwks` | 0 of 70 |

Also in this run: the three Cloudflare configurations are identical to each other
in all 70 cells; the Cloudflare and workerd cells differ from the Edge Function
(`verify_jwt` false) cells in the same 5 cells as the earlier workerd run, all in
the `unknown_secret` row (the Edge Function gateway answers `401 gw:Invalid API
key`; the Workers answer `200 ran:none` in `none` mode, `401 lib:UNUSABLE_CREDENTIAL`
in `user`, `401 lib:INVALID_API_KEY` in the other three). The Edge Function
`verify_jwt` true matrix again differs from `verify_jwt` false in 20 cells, all
`gw:`. The `user_jwt` cell (a real user token, no `apikey`) in `user` mode was
`200 ran:user` on all six Worker targets, so the library verified the user token
on Cloudflare in the three configurations, including the two that fetch the
JWKS at run time and the one that gets it inline. The JWKS endpoint answered
200 with and without an `apikey` (240 bytes) from the deployed Worker, as it did
from workerd and from this host.

Docs-stated cells against the expectation table: 0 differ on each Cloudflare
target; the docs-silent cell counts per mode (8, 2, 7, 7, 2) equal those of the
workerd targets.

### What else this run measured

| item | value |
|---|---|
| deploy to first answer | 18 s from the start of `wrangler deploy` to the first 200 from the `workers.dev` URL that reported the secret bindings present (`ready_after_s`; the module polls every 3 s) |
| Edge Function expiry boundary (same module) | last accepted -2.9 s, first refused +1.3 s from `exp` (the earlier run: -2.9 and +1.4) |
| third-party token at the Edge Function gateway, `verify_jwt` true | still refused after the 120 s polled (`gateway_accepted_after_s` "not within 120 s"), data API answered 200: the same result as the earlier project |
| project readiness | `ER01-setup`: healthy 3 s after the create call returned (create call 1481 ms) |
| teardown | Worker delete HTTP 200; project delete 200; issuer delete 200; the module's re-read of the account's Worker scripts found 0 with the `er-` prefix |

Edge-run limits, stated so the table is not over-read:

- Vantage: this machine in Singapore for every request. The Worker's runtime
  probe was meant to record `cf_colo`; in this artifact the `_runtime` response
  that `ER01-cfsetup` stored was an HTML page from Cloudflare (the HTTP status
  was not recorded) rather than the JSON, so the colo for this run is not in the
  artifact and the HTML page is unexplained. The matrices that followed all
  answered from the Worker. In a smoke deploy of the same bundle earlier that
  day (console output only, not published, placeholder bindings) the probe
  returned `user_agent` "Cloudflare-Workers", `cf_colo` "SIN",
  `process_env_has_url` true and `has_deno` false; on that smoke's first deploy
  the first 200 reported `process_env_has_url` false, which is why the module now
  waits for the bindings to show before it starts the matrices. The cause (a
  window between the script and its secrets) is inferred from that one
  observation, not separated.
- One Worker script, one account, one `compatibility_date`; Durable Objects,
  Workers for Platforms, a custom domain, a Worker in front of another
  Cloudflare zone, and other colos were not run.
- The cells are one sequential pass (14 requests per mode per target). A
  request rate, cold-start latency, or the time for the Worker to see a changed
  secret were not measured.
- The workerd image's `wrangler` and this host's `wrangler` differ in version
  (4.149.0 in the container, 4.147.0 on the host); the Worker bundle is the same
  file.

## Cleanup (2026-10-10)

Projects created by the runs above carried the Makefile's default name prefix,
`er-`; the last cleanup recorded in each artifact is `project delete 200` (the
`ER01z` / `ER02z` rows). For the Cloudflare edge run a check was made after the
module finished: `GET /v1/projects` listed 4 projects, none with the `er-`
prefix, and the Cloudflare Workers list had 17 scripts, none with the `er-`
prefix (the same count as before the run). That listing is a console check made
by the operator and is not published; the module's own re-read of the
Worker list is. Docker containers from ER01's workerd leg were removed by the
module. No AWS resource was created.
