# edge-burst

The Edge Functions error-codes page attributes `RATE_LIMIT_EXCEEDED` to
recursive or nested function calls. Does a sustained, non-recursive burst
against ONE function draw it, and at what request rate? Self-provisioning:
EB01 creates one Micro in ap-northeast-1 through the Management API, in the org passed as `PVLAB_ORG_PRO`,
and deploys two functions, EB99 deletes it. No OpenTofu state.

Measured results and their limits: `RUNLOG.md`.

| Module | Question |
|---|---|
| EB01 | Setup and control: project ready, both functions answer 200 to 20 sequential invocations with `x-region: ap-northeast-1`; region and colo headers |
| EB02 | No-op function: open loop at 25 to 800 req/s (120 s per step) and one 1,000-request burst; status and error-code classes per step |
| EB03 | The same for a function that makes one supabase-js `rpc()` per request |
| EB99 | Teardown and confirm the project left `GET /projects` |

The generator (`lib/load.ts`) is open loop: requests leave on schedule
whether or not earlier ones answered, a request due while 450 are in flight is
counted as skipped rather than queued, and a step is flagged `client_limited`
when it skipped a request, missed its send schedule, or left a request
without an HTTP answer; the flag marks a step as not a clean platform
measurement and does not say which side caused it. Bun's fetch queues above
256 requests in flight by default, so the Makefile raises
`BUN_CONFIG_MAX_HTTP_REQUESTS` above the generator's cap.

## Run

```sh
export SUPABASE_ACCESS_TOKEN=...   # environment only, never argv
export PVLAB_ORG_PRO=...           # org slug; EB01a records its plan
make test                          # pure logic, no network
make run                           # about 30 minutes (run 1)
make sweep                         # list leftovers by name prefix; DELETE=1 deletes
make publish-evidence RUN=evidence/<ts>/run-<stamp>.json
```

Knobs: `PVLAB_EB_RATES` (25,50,100,200,400,800), `PVLAB_EB_STEP_S` (120),
`PVLAB_EB_REST_S` (20), `PVLAB_EB_BURST` (1000), `PVLAB_EB_CAP` (450),
`PVLAB_EB_BURST_LANES` (`PVLAB_EB_CAP`), `PVLAB_EB_BURST_REST_S` (60),
`PVLAB_EB_STOP_PCT` (20), `PVLAB_EB_REGION` (ap-northeast-1).
