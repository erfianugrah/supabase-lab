# client-retries

What the supabase-js PostgREST retry policy does on the wire, and whether two
client policies the built-in retries do not provide hold up: a deadline plus one
hedged GET, and refresh-then-retry on a 401.

Public sources for the documented policy:
https://supabase.com/changelog/45071-automatic-postgrest-retries-for-transient-errors
and https://supabase.com/docs/guides/api/automatic-retries-in-supabase-js

Self-provisioning: CR01 and CR02 create one throwaway Pro-org project each
(`PVLAB_ORG_PRO`, ap-southeast-1, Micro requested) and delete it in `finally`. CR03 and
CR04 need no project. No OpenTofu state. The fault injector is a local process
(`lib/faultproxy.ts`) because a Cloudflare Worker needs a token that can deploy
Workers.

## Modules

| id | claim |
|---|---|
| CR01 | Retry matrix through the proxy: which statuses and methods are retried, `X-Retry-Count` and spacing, `Retry-After`, the opt-outs, timeouts, the real Data-API-off 503 PGRST002, and what the gateway's edge_logs record |
| CR02 | Client policy: `AbortSignal.timeout` + one hedged GET (slow first, 525, hang, stacking with built-in retries), why hedging is GET-only, refresh-then-retry on 401 (injected, revoked session, real 401, parallel) |
| CR03 | The same retry probes per supabase-js version (14 versions) and per runtime (Bun, Node), local mock, no project |
| CR04 | Opt-in (`PVLAB_CR_LONG=1`, 330 s): does a default client ever fail when a request is never answered, under Bun and Node |

`lib/policy.ts` holds the two policy functions; `lib/faultproxy.ts` the proxy
(`pass`, synthetic status, delay before or after forwarding, TCP reset, hang;
logs `X-Retry-Count` per request); `lib/faultproxy.test.ts` its loopback tests.

## Run

```bash
SUPABASE_ACCESS_TOKEN=... PVLAB_ORG_PRO=<pro-org-slug> make probe ONLY=CR01,CR02,CR03
PVLAB_CR_LONG=1 SUPABASE_ACCESS_TOKEN=unused make probe ONLY=CR04   # 5.5 minutes
make unit                                                            # proxy tests
make publish-evidence RUN=evidence/<ts>/run-<stamp>.json
```

`PVLAB_CR_PREFIX` renames the throwaway projects (default `cr-retries-`).
`PVLAB_CR_VERSIONS` overrides the CR03 version list. The runner is started from
source: the compiled `dist/pvlab` targets linux-x64.

Results, with the docs' claims separated from the measured values:
`RUNLOG.md`.
