# image-transformations - RUNLOG

One project, no AWS. How Supabase bills and serves Storage image
transformations: which URL surfaces transform, where the documented limits
disagree with the runtime, edge-cache behavior, signed-render-URL security,
RLS on the authenticated render path, the rate ceiling, and (with a dashboard
JWT) the billing counter itself.

Complements edge-resilience W19 (render path on the drill pair) and W21
(spend cap is not a request-path circuit breaker); does not duplicate them.

## Validated 2026-08-18 (micro, ap-southeast-1; evidence/20260818-102900,
evidence/20260818-103221, evidence/i06-*)

Full battery 23-24 pass, plus I09 destructive. Fails below are findings, not
harness errors. Prior ad-hoc probe same day (two hand-created scratch
projects, Pro and Free orgs) found the surface/bounds facts; these modules
reproduced them.

### Surfaces (I02)

- Only the four `/render/image/*` surfaces transform. Params appended to
  `/object/public` or `/object/sign` URLs are silently ignored - 200 and the
  full original bytes, no error. The silent-ignore is the integration trap:
  you find out from egress, not logs.
- `createSignedUrl(path, exp, { transform })` embeds the transform in the
  token and returns a `/render/image/sign/...` URL.
- Private bucket via the public render surface: 400.

### Docs vs runtime (I03/I04)

- Docs say width/height must be 1-2500. Runtime accepts `width=2501` (200)
  and silently clamps above 3000 and above the source dimensions - never an
  error. The documented bound is wrong in both directions.
- `width=0` and no-params renders are accepted (processed near-identity).
  `width=abc` is the one that 400s. Junk params are ignored.
- >25MB and >50MP sources are 400 at render time, exactly as documented -
  and both upload to Storage without complaint first.

### Signed render URLs (I07)

- Tampering fails CLOSED: editing width/height in the signed URL's query
  string is ignored - the server renders the transform embedded in the
  token (200, same bytes as untampered). A leaked signed render URL does
  not yield arbitrary variants.
- Expiry is enforced: expired token render is rejected.

### RLS on the render path (I08)

- Enforced. A user JWT with no `storage.objects` select policy is denied on
  `/render/image/authenticated/` (400/403); the same user with a select
  policy on the bucket renders (200). The negative control matters: without
  it a 200 would prove nothing.

### Formats (I05)

- SVG passes through unchanged (content-type preserved, body untouched) -
  matches W19.
- BMP input transforms and comes out as `image/jpeg`.
- GIF (1x1) renders 200, stays `image/gif`.
- Accept negotiation works (`Accept: image/webp` -> webp; `image/jpeg` on a
  PNG source -> PNG fallback) but responses carry NO `Vary: Accept`. Two
  clients negotiating different formats at the same URL can be served each
  other's format from the edge cache - whoever warms the URL first fixes
  the format until TTL.

### Edge cache (I06)

- Cold ~113ms, warm ~30ms, `cf-cache-status: HIT` on the repeat despite
  `cache-control: no-cache` on the response.
- Junk query params do not bust the cache (normalized out of the key).
- HEAD works.
- **Overwrite invalidation is unreliable.** 5 valid trials (confirmed
  x-upsert 200 overwrite, then re-render the same variant): 1 invalidated
  within 60s, 4 served the stale variant past the poll window (3 x 60s
  polls, 1 x 15s poll). A sixth trial with a failed overwrite (400, no
  x-upsert) was excluded. The docs say the Smart CDN purges on update;
  runtime does not reliably match within a minute. If your flow overwrites
  images in place, version the object path instead of relying on
  invalidation.

### Rate ceiling (I09, destructive)

- There IS a ceiling; the ad-hoc 200-parallel probe was just under it.
  500 parallel fresh renders: 11 x 429. 1000 parallel: 88 x 429. Refusals
  are ~2% at 500 and ~9% at 1000, not a hard cutoff.

### Counter sensor (I10)

- Skipped: needs PVLAB_PLATFORM_JWT (dashboard user token; /platform 401s
  PATs). The increment-event question stays doc-cited-not-tested.

### Harness notes

- Storage POST without `x-upsert: true` 400s on an existing path - the
  first version of I06 "proved" stale cache with an overwrite that had
  itself failed. A measured fail was a harness bug; check the mutation
  landed before reading the effect.
- Duplicate bucket creation returns 400 (not 409); ensureBucket GETs first.
- Free-plan rendering (docs say Pro and above; runtime renders) is not yet
  a module - needs a peer project in a Free org.
