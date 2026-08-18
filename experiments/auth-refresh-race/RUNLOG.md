# RUNLOG - auth-refresh-race

2026-08-19. Reproduce the supabase_flutter concurrent/stale refresh-token
defect (public tracker: supabase-flutter issues 895, 930, 1158; fixed by
PR 1351) and pin the exact client version boundary, against both a live
hosted project and a local gotrue.

## TL;DR

- **Defect reproduced** on gotrue-dart **2.21.0** (what supabase_flutter
  2.14.0 pins): a `refresh_token_already_used` rejection aimed at a stale
  token destroys the client's CURRENT, still-valid session - local
  `_removeSession()` + `signedOut` event. This is the "user gets logged out /
  requests start 401ing" symptom.
- **Fixed in gotrue-dart 2.22.0** (PR 1351, shipped 2026-06-11; first
  supabase_flutter release carrying it: **2.15.0**). On a fixed client the
  same rejection is absorbed: the call returns the existing valid session,
  no error thrown, no `signedOut` event.
- Differential verified identically on a hosted project (ap-southeast-1,
  micro) and on the local stack (gotrue v2.195.0).

## The repro scenario (`dart/bin/repro.dart`, scenario `stale-reuse`)

1. Admin-create a user, password sign-in -> S0 (rt0).
2. Rotate twice via the client: rt0 -> rt1 -> rt2. Client now holds valid S2
   (access token good for another hour).
3. Wait out the reuse interval (10s default; 12s used).
4. Present the stale GRANDPARENT rt0 via `refreshSession(rt0)` - the shape a
   racing resume / resurrected persisted session takes in the wild.

Pre-fix: server 400 `refresh_token_already_used` -> client removes the valid
session and emits `signedOut`. Post-fix: client returns the existing session,
no error, no event. (`concurrent-same` scenario - 5 concurrent refreshes of
one token - dedupes to a single network call and succeeds on BOTH versions;
that arm already worked pre-fix, matching PR 1351's own test table.)

## Server-side semantics measured (gotrue v2.195.0 source + live probes)

From `internal/tokens/service.go` (v2.195.0) and confirmed by curl probes:

- A revoked token that is the DIRECT PARENT of the currently active token is
  tolerated WITHOUT any time limit ("client could not store the result"
  branch) and returns the active token. Single-rotation stale use never
  errors - measured at 3s, 15s, 45s, 130s after rotation.
- Reuse of an OLDER generation (grandparent+) is rejected with
  `refresh_token_already_used` only once past `reuse_interval` from the
  token's `UpdatedAt` - and the token family is revoked server-side. Measured
  locally AND hosted: grandparent at 12-15s -> HTTP 400
  `refresh_token_already_used`.
- Notable: after family revocation the just-current token (rt2) still
  refreshed fine in both environments. Family revocation did not immediately
  kill the active chain - worth its own probe if that matters.
- Hosted platform: PATCHing `security_refresh_token_reuse_interval` to 0 was
  accepted by the Management API (GET reads back 0) but the running auth
  service kept the ~10s behavior (2s tolerated, 15s rejected). Config changes
  do not propagate to the auth runtime immediately (or are clamped).

## Version boundary (from the monorepo's own tags)

- `supabase_flutter` 2.14.0 -> gotrue 2.21.0 (defect present)
- `supabase_flutter` 2.15.0 -> gotrue 2.22.0 (fixed; PR 1351 also added the
  per-token `_pendingRefreshes` dedup, the `_sessionVersion` guard against
  stale-response overwrite, and dispose safety)

## Evidence

`evidence/<ts>/` - full client logs per run:

- 20260819-055140 local gotrue=2.21.0: defect reproduced
- 20260819-055154 local gotrue=2.27.2: fixed
- 20260819-055304 local gotrue=2.22.0: fixed (boundary confirmed)
- 20260819-055513 hosted gotrue=2.21.0: defect reproduced
- 20260819-055544 hosted gotrue=2.27.2: fixed

## Pre-empt: "still seeing sign-outs on supabase_flutter >= 2.15.0"

Paths that STILL sign out, by design, after the fix - each maps to one
diagnostic question to ask:

1. **The session was already fully expired when the stale token hit.** The
   fix only absorbs `refresh_token_already_used` when the current session is
   still valid; an expired session + a rejected stale token = deliberate
   sign-out. Reproduced here as scenario T1 (jwt_expiry=30s on the local
   stack): `VERDICT=correct-signout`. Diagnostic: if the app sits backgrounded
   past JWT expiry and the resume path races an old token, this is expected,
   not the bug. The app-side mitigation is a single session check gate on
   resume, plus not resurrecting old tokens from storage.

2. **Cross-instance refresh.** `_pendingRefreshes` dedups within ONE
   AuthClient instance; two instances (separate Flutter isolates, e.g. a
   background isolate + UI isolate each holding a SupabaseClient) each run
   their own refresh. On non-web targets there is no BroadcastChannel sync, so
   instance B may reject with already_used while instance A holds the new
   session - if B's session is expired, B signs out. Diagnostic: one
   SupabaseClient per process; UI isolate owns auth; background work goes
   through it.

3. **App code calling signOut() on any 401.** Deliberate call, generates a
   signedOut event, looks like the bug in onAuthStateChange telemetry.
   Diagnostic: grep the codebase for signOut in 401/refresh error handlers.

4. **Residual tracker cracks (not the 1351 race):**
   - supabase-flutter #1372: AuthRetryableFetchException during backend
     downtime can break session recovery even with a valid stored session.
   - supabase-flutter #1687: session deserialization across tabs/isolates on
     WASM (double vs int) - can drop or misread the session.

5. **recoverSession entry point.** The Flutter layer
   (packages/supabase_flutter/lib/src/supabase_auth.dart) recovers through
   `hasAccessToken()`/`accessToken()` on the configured LocalStorage. A custom
   storage that falsely reports an old or missing token reroutes into a
   stale-token refresh - then either path 1 or the old 2.21.0 defect.
   Diagnostic: custom LocalStorage in play?

Version/symptom triage for support:

- < 2.15.0 + already_used sign-outs -> the PR-1351 defect; upgrade first.
- >= 2.15.0 + sign-outs -> read the signedOut evidence: it means one of the
  paths above, and the answer is app-side, not another SDK bump.

## Actionable conclusion

An app hitting "Invalid Refresh Token: Already Used" sign-outs /
post-resume 401s on supabase_flutter < 2.15.0 is hitting this defect, and
**upgrading to supabase_flutter >= 2.15.0 is the fix** - the SDK does then
absorb the race instead of signing the user out. Custom-LocalStorage and
resume-burst hygiene still reduce how often the stale token gets presented,
but they are no longer load-bearing for session survival.
