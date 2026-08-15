# edge-resilience - RUNLOG

What a client can do about Supabase platform incidents that are not theirs to
fix. Four modules, all green against the live drill project
(ap-southeast-2, micro, tofu-managed) on 2026-08-15. Consolidated artifact:
`evidence/final/run-2026-08-15T07-41-58-013Z.{json,md}` (4 pass, 0 fail).

## W01 - JWT issued-at skew map (the PGRST303 incident class)

Setup: lab-controlled ES256 issuer (keypair in `jwks/`, public half served by
the edge worker at `/jwks.json`) registered via third-party-auth `jwks_url`.
Tokens minted with arbitrary `iat` offsets probe the real claim-validation
path - first-party secrets are not readable, TPA is the mintable path.

Measured (two full runs, final artifact values):

| iat offset | result |
| --- | --- |
| -3600s | 200 |
| 0 | 200 |
| +15s | 200 |
| +30s | 200 |
| +31s | 401 PGRST303 (run 1: 200; boundary sits at 30-31s) |
| +60s / +300s / +3600s | 401 PGRST303 |

- The documented 30-second skew tolerance (PostgREST v11 docs) is REAL:
  final run boundary max_200=30s, min_401=31s. First run measured 31/60 -
  sub-second mint-to-validate timing explains the 1s wobble.
- Expired token => 401 PGRST303 (same code, `exp` side).
- Wrong/unknown key => 401 PGRST301. After TPA deletion => 401 PGRST301.
- **JWKS trust lags the Management API by ~30s**: integration shows
  `resolved_jwks` set while PostgREST still answers PGRST301 (kid unknown).
  After deletion, tokens keep validating for seconds until config is
  re-read. Config APIs are not request-path truth - always poll the request
  path (warm-up loop / eviction loop in the module).
- Collateral (2026-08-14, pre-lab): `PATCH /config/auth {jwt_secret:...}`
  returns 200 and changes nothing. New projects bootstrap with ES256
  `in_use` + HS256 `previously_used` signing keys.

## W02 - supabase-js retry behaviour (v2.112.3)

- Case A (401 PGRST303): exactly **1 attempt**, 9ms elapsed. The default
  client does NOT retry claim rejections - it does not amplify the incident
  class.
- Case B (503 PGRST002 x3 then 200): **4 attempts, success in ~7.0s** -
  transient 5xx is ridden out with backoff.
- Case C (connection refused): "Unable to connect" surfaced after ~7.0s.
- Docs cross-ref (guides/api/automatic-retries-in-supabase-js.md): built-in
  retries for 408/409/503/504 + network failures, default on since 2.102.0.

## W03 - jwt_exp lever (exposure-window reduction)

- `PATCH /config/auth {jwt_exp: 43200}` readable-back immediately.
- Effect lag: first token after acceptance still minted at 3600s; second
  attempt (~6.5s later) minted 43200s. Config acceptance != instant effect.
- Restored to 3600 in finally.
- Probe-path lesson: hosted `/auth/v1/signup` sends email and the default
  sender is rate limited - scripted signups die with
  `over_email_send_rate_limit`. The rate-limit-proof path is
  `POST /auth/v1/admin/users` (service key, `email_confirm: true`) +
  `POST /auth/v1/token?grant_type=password`.

## W04 - edge cache through an origin outage

Worker (`worker/worker.ts`, wrangler-as-code) caches GETs of the probe table
and serves the cache before touching the origin.

- Prime: 1 attempt to HIT. Outage toggle (redeploy with `OUTAGE:true`,
  ~10.5s) repoints origin fetches at 192.0.2.1 (TEST-NET-1).
- **Warm read under outage: 200 HIT, body byte-identical to pre-outage.**
  A warm edge cache makes an origin outage invisible to reads.
- Cold URL under outage: 403/PASS - Cloudflare wraps the TCP failure to a
  TEST-NET address as a 403 response rather than a JS exception, so the
  worker's catch->503/EMPTY path never fires; the error passes through.
  Finding stands: cold reads fail during an outage.
- Restore (OUTAGE:false, ~10.6s): 200 HIT again.
- **Cache gotcha (found while building)**: the Supabase gateway's Cloudflare
  front sets `Set-Cookie: __cf_bm` on EVERY response. `caches.default.put`
  refuses Set-Cookie responses and `waitUntil` swallows the rejection - a
  naive cache proxy silently never caches. Strip `set-cookie` before `put`.

## Process notes (loop-driven build)

- Modules were built by the sensor-gated loop (`.pi/harness-w*.json`,
  operator probe `.pi/probe-edge-resilience.sh` outside writeScope).
- The local rung (Gemma 4 26B via llama-server/loop) failed to produce a
  compilable W01 in 5 iterations across two runs (pseudocode placeholders,
  syntax garbage, tree thrash: literal-\n filenames, junk symlinks, build
  artifacts at repo root) and produced one W02 that passed plus one that
  leaked `Bun.serve` handles (probe hang). claude-sonnet-4.6 converged W01
  in 3 iterations, W02/W03 in 1, W04 in 1. For this harness, keep the local
  rung for single-file mechanical modules only.
- Operator edits and the loop fence do not mix: commit harness/spec changes
  BEFORE launching a run, or the writeScope fence reverts them as
  out-of-scope agent edits.

## Reproduce

```
make secrets-decrypt      # repo root, once
cd experiments/edge-resilience
make init apply keygen worker-deploy seed
make probe ONLY=W01,W02,W03
make probe-destructive    # W04 (redeploys the worker twice)
make destroy              # when done
```
