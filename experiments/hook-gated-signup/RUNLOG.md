# hook-gated-signup - RUNLOG

Vantage: one workstation (macOS), IPv4 to the project, the Management API at
api.supabase.com, one throwaway Micro project per run on the Pro org, region
ap-southeast-1 as requested in the create call (not read back), created and
deleted by the module. Harness run from source (`bun harness/src/run.ts
--where local`), lab commit 3659480 plus this experiment's files before their
first commit (run 2's measurement names match the committed module; run 1 ran
an earlier HG01a and HG01b, see below). The Auth server version was not
recorded (`GET /auth/v1/health` reports it; HG01 did not call it), so the code
reads at supabase/auth 8872586 are not tied to the deployed version.

## HG01, 2026-11-12 (UTC), n = 2

Two runs, a fresh project each. Every table cell below matched in both runs;
equating "the client's address" with the project host's `/cdn-cgi/trace` and
the `audit_rows_total` count are run 2 only (n = 1).

| label | published artifact |
|---|---|
| hg01-run1 | `out/2026-11-12/run-2026-11-12T23-34-43-910Z.json` |
| hg01-run2 | `out/2026-11-12/run-2026-11-12T23-37-00-226Z.json` |

Terms: in the artifacts, `client value` is the `X-Forwarded-For` value the
request carried (198.51.100.7) and `edge value` is the address the hook saw
for the no-header control signup. "The client's address" below is that
`edge value`, which run 2 matched to the project host's `/cdn-cgi/trace`
(`control_ip_is_client=true`).

Run 2 changed HG01a and HG01b only: HG01a compares the control IP with the
project host's `/cdn-cgi/trace` instead of 1.1.1.1's and adds `control ip
private` to its evidence, and HG01b counts `auth.audit_log_entries`. Run 1
reported `control_ip_is_egress=false`: the address 1.1.1.1's trace returned
differed from the one the hook saw (cause inferred: a different egress path to
1.1.1.1; neither address was recorded). Run 2 reported `control_ip_is_client=true`.

Each config change was first seen 4 to 5 s after its `PATCH /config/auth`
returned (`hook_live_after_s` 5/5, `forwarding_live_after_s` 4/5,
`captcha_live_after_s` 4/4, `http_hook_live_after_s` 5/5, run 1/run 2). The
probe runs right after the PATCH and then every 4 s plus its own duration, so
the change took effect within that 4 to 5 s; for CAPTCHA and the HTTP hook the
first probe still saw the old config (inferred from the timings). The harness
recorded 46204 ms (run 1) and 44486 ms (run 2) for the whole module,
provisioning included.

### HG01a: X-Forwarded-For, forwarding off (off on a fresh project per the docs; not read)

| request (publishable key unless named) | IP the before-user-created hook saw |
|---|---|
| no XFF | the client's address (= the project host's `/cdn-cgi/trace`, run 2 `control_ip_is_client=true`; run 1 not compared) |
| `X-Forwarded-For: 198.51.100.7` | 198.51.100.7 |
| `X-Forwarded-For: 198.51.100.7, 198.51.100.8` | 198.51.100.7 (leftmost) |
| secret key, `X-Forwarded-For: 198.51.100.7` | 198.51.100.7 |

So with forwarding off, any direct caller (measured: publishable and secret
key) chooses the address in the hook's `metadata.ip_address`. In the code
(supabase/auth at 8872586) the CAPTCHA `remoteip` comes from the same
function, `utilities.GetIPAddress`. The per-IP rate-limit key does not: it is
the `Sb-Forwarded-For` value when present, else the first value of the
configured rate-limit header, whose managed-platform setting was not read.
Neither leg was measured here.

### HG01b: Sb-Forwarded-For, forwarding on

| key | email signup | anonymous sign-in |
|---|---|---|
| secret | honoured | honoured |
| publishable | ignored, client's address | ignored, client's address |
| legacy anon | ignored, client's address | ignored, client's address |
| legacy service_role | ignored, client's address | ignored, client's address |

With forwarding on, a client-supplied `X-Forwarded-For` on a publishable-key
request was ignored as well, alone (`xff_only_forwarding_on`) or beside
`Sb-Forwarded-For` (`signup_publishable_with_xff`): the hook saw the client's
address. The cited code predicts the opposite (with no `Sb-Forwarded-For` in
the request context, `utilities.GetIPAddress` falls back to the leftmost
`X-Forwarded-For`), so something in front of Auth changed the request
(inferred; where was not measured). XFF with forwarding on was not sent with
the secret, legacy anon or legacy service_role key. With forwarding on, only
the secret key set the address through `Sb-Forwarded-For`; the legacy
service_role JWT, though an admin credential, did not.

The password sign-in leg (`/token?grant_type=password`, secret and
publishable key, each with `Sb-Forwarded-For`) got a 2xx both times but found
no `auth.audit_log_entries` row to read the IP from. In run 2 the table held
0 rows (`audit_rows_total`) after 13 to 15 email signups, 5 anonymous
sign-ins and the two sign-ins, so on that project the audit log was not
written to the database. Run 1 did not count rows. Sign-in routes other than
signup and anonymous sign-in (both `POST /auth/v1/signup`) are therefore not
covered.

### HG01c: CAPTCHA on, Turnstile's always-fail test secret, no token

| key | email signup | anonymous sign-in |
|---|---|---|
| secret | 200 | 200 |
| legacy service_role | 200 | 200 |
| publishable | 400 `captcha_failed` | 400 `captcha_failed` |
| legacy anon | 400 `captcha_failed` | 400 `captcha_failed` |

In code, a request with no token is refused before Turnstile is called; the
always-fail secret was exercised only by the liveness probe (dummy token,
`gate` `400:captcha_failed`).

### HG01d: HTTP before-user-created hook (Edge Function) refusing

| hook reply (publishable-key signup) | client got |
|---|---|
| 200, `{"error":{"http_code":403,"message":"..."}}` | 403, `error_code` `unknown`, the hook's message |
| 200, `{"error":{"http_code":429,"message":"..."}}` | 429, `error_code` `unknown`, the hook's message |
| 400, `{"error":{"http_code":403,"message":"..."}}` | 500 `unexpected_failure`, "Invalid payload sent to hook" |
| 200, `{}` | 200 (user row not checked) |

### HG01e, HG01f: what reaches the hook

- The email signup body's `data` (supabase-js `options.data`) arrived intact
  as `user.user_metadata` (nested object, array and boolean). `metadata`
  carried `ip_address`, `name`, `time`, `uuid`.
- An anonymous sign-in with `data` fired the hook, with
  `user.is_anonymous=true` and the data in `user_metadata`.

### HG01g: request.cf in edge logs

An `edge_logs` row of a `/auth/v1/signup` request carried 10 keys containing
`cf`: `request.cf.botManagement.ja4` (non-empty), `request.cf.asOrganization`,
`request.cf.city`, `request.cf.clientTrustScore`, `request.cf.colo`,
`request.cf.country`, `request.headers.cf_connecting_ip`,
`request.headers.cf_ray`, `response.headers.cf_cache_status`,
`response.headers.cf_ray`. No `request.cf.botManagement.score` and no
`request.cf.asn` key. The first logs query of the HG01g phase
(`logs_after_s` 1) already returned a row. The query matches any
`/auth/v1/signup` row of the last hour, and HG01g runs after every other
signup in the run, so the ingest delay for one request was not measured.
Whose fingerprint the JA4 is when a Worker sits in front was not measured
here (HG01 sent every request straight to the project).

### Not covered

- The CAPTCHA `remoteip` under client XFF (same function as the hook's IP in
  code) and the per-IP rate-limit key (configured rate-limit header in code,
  setting not read); neither measured.
- `X-Forwarded-For` with forwarding on for any key but the publishable key.
- Sign-in routes other than signup and anonymous sign-in (no audit rows).
- One region, one vantage, IPv4 only.
