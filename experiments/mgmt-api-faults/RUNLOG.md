# mgmt-api-faults RUNLOG

Chronological record of what was actually run. Org slugs and project refs are
not recorded; the org class is.

## 2026-10-10 - first runs (Pro org, ap-southeast-1)

Vantage: a Mac (darwin arm64) running the tool under test, with a
fault-injecting proxy in a local container (`oven/bun:1`) between it and
`https://api.supabase.com`. Tools: supabase CLI 2.120.0, OpenTofu 1.13.1 with
the `supabase/supabase` provider 1.11.0, the lab harness at its working-tree
state (client `harness/src/mgmt.ts`, helper `harness/src/platform.ts`).

Every fault is injected. No real 5xx from `api.supabase.com` was observed in
these runs, and the injected body is a short JSON message naming the status and
the rule, so how each tool reacts to a real 5xx body (for example an HTML
interstitial) is not measured here, apart from the harness classifier's
existing unit test. `error-before` means the proxy answered without contacting
upstream (the operation did not happen). `error-after` means the proxy
forwarded the request, upstream completed it, and the proxy replaced the answer
with the error. The attempt counts below are proxy-log rows, counted at the
wire.

Final run (MF01-MF04): `out/2026-10-10/run-2026-10-10T07-44-43-736Z.json`, 10
min 19 s. MF05 ran separately: `out/2026-10-10/run-2026-10-10T07-55-39-410Z.json`.
Both are redacted copies of the raw artifacts (the raw `evidence/` is ignored by
version control) with a `.facts.md` beside each. The development runs are unpublished. n is one trial per cell unless stated. MF01, MF02 and
MF03 were each run twice (a development run and the final run) and MF04 three
times; every count and exit code below was the same in each run that measured
it. MF03e is the exception: its development run was cut at 130 s after 3 attempts (offsets not recorded in that run). The other exception is the MF04 settings rows (d0c, d1, d2): the first MF04 run
read the upstream value from a wrong path (it returned -1), so those rows rest
on two runs.

### MF01 - the harness client (`mgmt()` and `functionPresent()`)

| cell | measured |
|---|---|
| `mgmt()` GET `/organizations`, answered 500 / 502 / 503 / 504 on every attempt | 1 attempt each; the status is returned (no throw) |
| `mgmt()` GET, one 500 then upstream healthy | 1 attempt; the caller gets 500 (MF01b) |
| `functionPresent()` GET, 429 (Retry-After: 1) twice then upstream | 3 attempts in 30144 ms; final status 404 (the probe ref does not exist) |
| `functionPresent()` GET, one 500 then upstream | 1 attempt, 0 ms; `status` 500, `present` false |
| `mgmt()` GET held 35 s, default timeout | throws `TimeoutError` at 30001 ms; 1 attempt; the proxy still forwarded the request and upstream answered 200 |

Reading: `mgmt()` does not retry anything. `functionPresent()` is the one
retrying helper and it retries 429 only, with a fixed 15 s sleep (its source
sleeps 15000 ms; the 30144 ms for two retries matches 2 x 15 s. Whether the
`Retry-After: 1` header is ignored or honoured was not separated: the run used
only that header value, so the timing is the sleep constant read from source,
not a measured effect of the header). A 500 on its read comes back as `present: false`,
which a caller cannot tell from "the function does not exist" without checking
`status`. Not measured: `mgmt()` or `functionPresent()` against a connection
reset.

### MF02 - the harness create, answer lost (creates 2 projects per run)

| cell | measured |
|---|---|
| POST `/projects`, proxy holds the answer 8 s, client timeout 4 s | client throws `TimeoutError` at 4003 ms; 1 POST; upstream answered 201; 1 project with that name afterwards |
| POST `/projects` answered 500 after upstream created it | client got 500; upstream 201; 1 POST; 1 project with that name |
| same POST repeated with the same name and org | 400; still 1 project with that name |

The body of the 400 says a project with that name already exists in the
organization. Only the same-name repeat was tried; a retry that generates a new
name each time (a timestamp suffix, as the lab's own modules do) is not covered
by this protection, and no run created two projects that way. Not measured:
whether the name check also holds across two concurrent POSTs.

### MF03 - the supabase CLI

`--profile` file with `api_url` set to the proxy; no CLI patching.

| cell | measured |
|---|---|
| `projects list` (GET `/v1/projects`) answered 500, 502, 503 or 504 on every attempt | 6 attempts, exit 1; first to last attempt 3-4 ms apart (no back-off at that resolution); whole command 127-255 ms |
| same, answered 429 (with Retry-After: 1; and without the header) | 1 attempt each, exit 1 |
| GET answered 500 five times then upstream | 6 attempts, exit 0 |
| GET answered 500 six times then upstream | 6 attempts, exit 1 (the budget is 6 attempts per call) |
| POST `projects create`, POST `secrets set` answered 500 | 1 attempt each, exit 1 |
| POST `secrets set` answered 502 / 503 / 504 / 429 | 1 attempt each |
| PUT `ssl-enforcement update` (needs `--experimental`), DELETE `projects delete`, DELETE `domains delete` answered 500 | 6 attempts each, exit 1 |
| POST `projects create` answered 500 AFTER upstream created the project | 1 attempt, exit 1; 1 project with the requested name afterwards (an orphan) |
| GET held 100 s | attempts started at 0, 60, 120, 180, 240, 300 s; exit 1 after 360220 ms with "request timed out" (6 attempts, 60 s each) |

Reading: the CLI retries GET, PUT and DELETE five times with no pause on a 500
(GET only was run for 502/503/504), and does not retry POST on any of
500/502/503/504/429. It does not retry 429 on GET either. Its per-attempt
timeout is 60 s, which also applies to the retries (reasoned from the offsets
0, 60, ..., 300). Not measured: PATCH (no CLI command reached a PATCH;
`branches update` issues a GET first and stopped on its failure), the other
commands of the CLI, and DELETE or PUT answered 500 AFTER upstream applied
them.

### MF04 - the OpenTofu provider (one config: project, optionally settings)

Local state in a scratch directory; `endpoint` set to the proxy. The settings
resource used only the `api` block (PATCH `/postgrest`). The project create
returned in 3-4 s without waiting for the project to become healthy.

| step | measured |
|---|---|
| a: POST create answered 500 before upstream, once | apply exit 1; 1 POST (not retried); state 0 resources; 0 projects upstream |
| b: POST create answered 500 AFTER upstream created it, once | apply exit 1; 1 POST; state 0 resources; 1 project upstream (orphan) |
| c: plain re-apply with the orphan present | exit 1; 1 POST, upstream answered 400; state 0; still 1 project upstream |
| c: re-apply after deleting the orphan through the API | exit 0 in 3468 ms; state 1; upstream 1 |
| d0: settings create answered 500 before upstream, once | apply exit 1; 1 write; state keeps the project and has no settings; a later plan exits 2 (settings still to create) |
| d0c: the same apply, no fault (control) | exit 0; one write, `PATCH /v1/projects/{ref}/postgrest`; upstream `max_rows` 1000 |
| d1: settings update (1000 to 500) answered 500 before upstream, once | apply exit 1; 1 write attempt; upstream still 1000; later plan exits 2 |
| d2: settings update (500 to 250) answered 500 AFTER upstream applied it, once | apply exit 1; 1 write; upstream 250; later plan (no fault) exits 0, no pending change |
| e: plan refresh, GET `/projects/{ref}` answered 500 once / 429 (Retry-After: 1) once | 2 GET attempts each; plan exit 0 (1614 ms / 1544 ms) |
| e: same GET answered 503 on every attempt | 4 GET attempts; plan exit 1 after 6240 ms |
| e: same GET held 100 s, once | 1 attempt; plan exit 0 after 103298 ms (no client timeout reached) |
| f1: destroy, DELETE answered 500 before upstream, once | exit 1; 1 DELETE (not retried); state 1 resource; 1 project upstream |
| f2: destroy, DELETE answered 500 AFTER upstream accepted it (200) | exit 1; 1 DELETE; state 1 resource; 0 projects upstream |
| f3: destroy again, no fault, against the state f2 left | exit 0; the two requests were GET and DELETE, both answered 404; state 0 resources |

Reading: the provider retried the project GET (up to 4 attempts, spread over
about 6 s, on 500, 429 and 503) and did not retry POST, PATCH or DELETE on 500.
A failed create leaves no state entry: with `error-after` that is an orphan the
config cannot recover from by re-apply, because the platform refuses the repeat
name with 400 (the provider printed only "Client Error" in the first lines of
its error). A failed settings write after the project exists is a partial
apply: the project is tracked, settings are not (d0). When the write did land
upstream (d2), the next plan reads it back and converges without an apply. When
the delete did land (f2), the stale state entry destroys cleanly later because
a 404 on GET and DELETE is accepted (f3).

Not measured: a 5xx on any provider GET other than the project read; any write
answered with 502, 503, 504 or 429 (only 500 was injected on writes); `tofu
import` of the orphan from step b (not run; deleting it was the recovery used);
other resources (`supabase_branch`, edge functions, api keys); a provider
timeout beyond 103 s on a GET.

### MF05 - answer arrives after the client's own timeout

| cell | measured |
|---|---|
| CLI `projects create`, proxy forwards then holds the answer 75 s | exit 1 after 60448 ms; 1 POST (upstream 201); 1 project with the name |
| provider create, proxy forwards then holds the answer 130 s, once | apply exit 0 after 132978 ms; 1 POST; 1 project with the name |

Reading: the CLI gives up on a held POST at 60 s and does not resend it, so the
create happened and the CLI reports failure. The provider waited the full 130 s
and succeeded. Neither tool duplicated a POST in any trial; the only duplicate
protection observed is the platform's same-name 400 (MF02c).

## What was not run

- Docs claims: no documented retry or idempotency behaviour of the CLI, the
  provider or the Management API was read or compared. Every statement above is
  a measurement on the versions named at the top.
- Real incident behaviour: none of the cells reproduce an actual outage; the
  injected 5xx are a model of one.
- Connection-level faults (reset, refused, TLS failure, DNS failure): run
  2026-10-23 (MF06-MF08, below).
- A tool that retries a POST and generates a fresh name each time: run
  2026-10-23 (MF07c).
- The orphan-detection side: orphans were found here by listing the org with
  the PAT and matching the name; a reconciler was built and run on 2026-10-23
  (MF07e, MF08).

## Cleanup and cost

Projects created over the runs (all named with the experiment prefix, each
alive for seconds to about 4 minutes): at least 14 accounted for
(MF02 2 per run over 2 runs, MF03d 1 per run over 2 runs, MF04 2 per run over
3 runs, MF05 2). One further invocation produced an empty result and is not
counted in that figure. All counted projects were deleted by the modules'
`finally` sweep; a `GET /v1/projects` after the last run listed 0 projects
with the prefix and no proxy container remained. Project-hours are
small (well under 1 h in total); no add-ons were enabled.

## 2026-10-23 - connection-level faults and orphan reconciliation (Pro org, ap-southeast-1)

Vantage: the same Mac (darwin arm64). Tools: supabase CLI 2.121.0 (Homebrew;
the 2026-10-10 runs used 2.120.0, and MF01-MF05 were not re-run on 2.121.0),
Bun 1.3.14 for the harness and the Bun `fetch()` client, Node v26.12.1 for the
Node `fetch()` client. The lab harness ran from its working tree on top of
661afdf with the new modules (MF06-MF08, `lib/connfault.ts`,
`lib/clients.ts`, `lib/reconcile.ts`) not yet committed; the artifacts name
661afdf.

Method. The container proxy of MF01-MF05 answers HTTP; here the fault is the
connection, so the proxy is a raw TCP listener in the test process
(`lib/connfault.ts`) that reads an HTTP/1.1 request and forwards it to
`https://api.supabase.com` with `fetch()`. `reset-before` reads the whole
request and aborts the connection with an RST (`socket.terminate()`; curl
reports exit 56 "Connection reset by peer", checked in
`lib/connfault.test.ts`); `close-before` closes it with a FIN (curl exit 52,
"Empty reply from server"); `reset-after` forwards, waits for upstream's
answer, then sends the RST. Connection refused is a loopback port with nothing
listening; the TLS failure is a loopback listener with a fresh self-signed
certificate; the DNS failure is a host under the reserved `.invalid` TLD. The
CLI is pointed at each target with a `--profile` file, as in MF03. Clients:
the CLI (`projects list`, `projects create`), Bun `fetch()` and Node
`fetch()` (each one call, 30 s timeout, no retry code of its own;
`lib/clients.ts`). Attempts are proxy-log rows, or TCP connections accepted by
the TLS listener; for refused and DNS there is no listener to count at, and
the CLI's `--debug` log prints one "HTTP GET:" line per command while the
proxy counted 6 attempts, so it is not an attempt count either.

Artifacts (redacted, with facts): MF06 three runs,
`out/2026-10-23/run-2026-10-23T08-26-58-210Z.json`,
`out/2026-10-23/run-2026-10-23T08-28-46-346Z.json`,
`out/2026-10-23/run-2026-10-23T08-29-08-425Z.json`; MF07 one run,
`out/2026-10-23/run-2026-10-23T08-29-47-990Z.json` (43 s, 08:29:47.990 to
08:30:31.279 UTC); MF08 one run,
`out/2026-10-23/run-2026-10-23T08-32-56-569Z.json`. Each MF06 cell below is
n=3 (the three runs agreed on every count and outcome; times are the three
values); MF07 and MF08 cells are n=1.

### MF06 - faults before upstream (no project can be created)

| fault | CLI `projects list` (GET) | CLI `projects create` (POST) | Bun `fetch()` GET / POST | Node `fetch()` GET / POST |
|---|---|---|---|---|
| reset-before (RST) | 6 attempts over 6 connections, first to last 2 / 7 / 5 ms; exit 1 in 455 / 520 / 633 ms | 1 attempt; exit 1 | 1 attempt each; `ECONNRESET` "The socket connection was closed unexpectedly" | 1 attempt each; `ECONNRESET` "read ECONNRESET" |
| close-before (FIN) | 6 attempts over 6 connections, first to last 6 / 2 / 11 ms; exit 1 | 1 attempt; exit 1 | 1 attempt each; `ECONNRESET`, same message as the RST | 1 attempt each; `UND_ERR_SOCKET` "other side closed" |
| refused | exit 1 (attempts not countable) | exit 1 | `ConnectionRefused` "Unable to connect" | `ECONNREFUSED` |
| TLS, self-signed certificate | 6 TCP connections to the listener; exit 1 | 1 TCP connection; exit 1 | 1 TCP connection each; `DEPTH_ZERO_SELF_SIGNED_CERT` | 1 TCP connection each; `DEPTH_ZERO_SELF_SIGNED_CERT` |
| DNS, `.invalid` host | exit 1 (attempts not countable) | exit 1 | GET `ConnectionRefused` "Unable to connect"; POST `FailedToOpenSocket` "Was there a typo in the url or port?" | `ENOTFOUND` (getaddrinfo) |

- The CLI printed the same message for all five faults: `failed to list
  projects: HttpClientError: Transport error (GET <url>)`, and for the create
  `{"_tag":"Error","error":{"code":"ProjectsCreateNetworkError","message":"failed
  to create project: HttpClientError: Transport error (POST <url>)"}}`. Every
  CLI cell exited 1 within 116-633 ms of process start.
- No request byte reached the TLS listener in any of its 18 cells (6 cells x
  3 runs). The listener's own handshake callback reported a completed
  handshake for the two Bun cells in two of the three runs and in none of the
  others; that callback is not used as evidence here.
- MF06f, a Bun or Node POST reset before upstream after a GET answered 200 on
  the same client: Bun sent the POST on the GET's connection and made 1
  attempt (3 of 3 runs). Node opened a second connection for the POST (3 of
  3), so a reset on a reused connection was not exercised for Node.
- MF06g: 0 projects carried the run's name tag after each run (17 create
  names used per run).

Reading: the CLI 2.121.0 retries a GET 5 times on a reset, a clean close and a
TLS failure (6 attempts, 2-11 ms first to last for the reset and the close;
MF03 measured the same budget for a 500 on 2.120.0), and does not retry a
create POST on any of them. Neither `fetch()` made a second attempt in any
cell where attempts were countable. A client sees the same error for
"nothing was sent" and "the answer was lost": Bun reports `ECONNRESET` for
both an RST and a FIN, and the CLI's message names no cause at all. Bun's
error name for an unresolvable host is `ConnectionRefused` on the GET, so the
name is not a reliable cause either.

### MF07 - the create landed, the connection was reset (creates 5 projects)

| cell | measured |
|---|---|
| a: CLI `projects create`, RST after upstream answered | upstream 201; 1 POST; CLI exit 1 after 1859 ms with the same `ProjectsCreateNetworkError` "Transport error" message as MF06; 1 project with the name |
| b: Bun `fetch()` POST, RST after upstream answered | upstream 201; 1 POST; threw `ECONNRESET` after 1633 ms; 1 project with the name |
| c: client that retries with a fresh name (timestamp suffix), first attempt reset after upstream answered | 2 attempts, upstream 201 on both, the second heard; 2 projects; its ledger holds 1 |
| d: client that, on a transport error, lists the org for the name it sent before retrying | 1 POST; the name was in the listing at the first look, 79 ms after the error; adopted, 1 project, in the ledger |
| e: reconciler, first version (kept projects with `created_at` at or after the module start) | 5 projects listed with the tag, 2 ledger lines; it classified 0 as orphan and 0 as tracked; the five `created_at` values were 486-564 s old when read, inside a 43 s run |
| f: after deleting the five | 5 DELETEs accepted; 0 tagged projects listed; the 2 ledger lines report as having no project |

The first reconciler filtered on `created_at` and so dropped every project the
run had just created; the module now records that count as
`created_at_after_start` and the reconciler no longer reads `created_at`.

### MF08 - the reconciler on one induced orphan (creates 1 project)

| cell | measured |
|---|---|
| a: Bun `fetch()` POST, RST after upstream answered | upstream 201; 1 project with the name; the time the POST reached the proxy minus `created_at`: 219 s from upstream's answer, 219 s from the listing |
| b: `lib/reconcile.ts` as a command, empty ledger, state file, 30 s grace from first sighting | pass 1: exit 0, 1 young, 0 orphan; pass 2 after 35 s: exit 3, 1 orphan, the induced name; a `created_at >= start` filter keeps 0 of 1 |
| c: after the delete | 1 DELETE accepted; listing empty for the tag; reconciler exit 0, 0 orphan |

Reading: the reconciler (prefix and org scope, ledger match by ref or name,
grace measured from the reconciler's own first sighting) found the induced
orphan and only it. `created_at` on a fresh project preceded the create
request by 219 s (MF08a) and the five MF07 projects read 486-564 s old within
43 s of the run starting, so `created_at` is not the time of the request on
this platform (n=6 projects, one day, one region). Why it precedes the request
was not investigated; a grace window or a "created since" filter keyed on it
misclassifies fresh projects.

Not measured: a reset partway through the request body or the response body;
a TLS failure after the handshake; DNS failures other than NXDOMAIN (timeout,
SERVFAIL); the CLI's attempt count on refused and DNS failures; Node `fetch()`
on a reused connection; the OpenTofu provider under connection faults; the
MF07c-d retry policies with any client other than Bun `fetch()`; MF07a-d with
n above 1; a reconciler that deletes.

Cleanup: 6 projects created on 2026-10-23 (MF07 5, MF08 1), each alive for
under 1 minute, all deleted by the modules; a `GET /v1/projects` at
2026-10-23T08:33:42Z listed 0 projects with the `mf-` prefix. MF06 created
none (MF06g). No container was used.
