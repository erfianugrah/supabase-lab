# static-hosting - RUNLOG

Can a Supabase project stand in for a static host (Cloudflare Pages,
Netlify)? One Micro project, ap-southeast-1. Modules HS01-HS03 and HS05; HS05
deploys a real Astro 7 build (`site/`: Tailwind, a self-hosted font, an SVG
asset, one React island) and loads it in headless Chromium.

## 2026-10-06 - first run

Artifact: `out/2026-10-06/run-2026-10-06T08-02-24-640Z.json` (+ `.facts.md`).
One run, n=1 per row. Every probe was browser-shaped (no apikey).

- **The Astro build does not render on either surface.** The control (same
  build, plain Bun static server on localhost) rendered, hydrated the island,
  applied the font-family from its CSS and followed the About link (HS05-control). On Storage
  (`.../object/public/astro/index.html`) and through an Edge Function (mount
  root) Chromium got `text/plain` and showed the page source (HS05-storage,
  HS05-fn). The function deploy itself was fine: 201, 538978 B of source with
  the build inlined.
- **Storage has no index document.** The bucket root answered HTTP `400` with
  an 87 B body, `{"statusCode":"400","error":"InvalidKey","message":"Invalid
  key: ","code":"InvalidKey"}` (the artifact holds the first 60 characters and
  the byte count; the full text is from the HS05-storage-root screenshot); a directory path (`about/`), an
  extensionless path (`about`) and a missing path all answered HTTP `400`
  with a JSON body carrying `"statusCode":"404"` (HS02a-d). No SPA fallback
  and no custom 404 page; a missing object is a 400 to the client.
- **The rewrite covers more than `text/html`.** On Storage, `text/html`,
  `application/xhtml+xml` and `application/xml` were all served `text/plain`;
  `image/svg+xml` kept its type but came with `Content-Disposition:
  attachment` (HS01). The Edge Function path did the same for the same four
  types (HS03). Every GET of those four types on both paths carried
  `Content-Security-Policy: default-src 'none'; sandbox` and
  `X-Content-Type-Options: nosniff`. CSS, JS, JSON, WASM, web manifest, PNG and
  plain text kept their declared types and carried neither header.
- The rewrite held for `TEXT/HTML` and `text/html;charset=utf-8` set by the
  handler (HS03-ct-upper, HS03-ct-nosp), on `<ref>.functions.supabase.co`
  (HS03-fnhost), on `<ref>.storage.supabase.co` (HS01-host) and through a
  signed URL (HS01-signed). POST to the function kept `text/html` (HS03-post, as EF06a
  found); HEAD to the function kept `text/html` without the CSP and nosniff
  headers (HS03-head, no body). Neither was sent to Storage.
- Caching: an object uploaded with `max-age=3600` was served `public,
  max-age=3600`, `cf-cache-status` HIT on both GETs (HS02e). After an
  overwrite, the public URL served the new bytes after 47085 ms (24 polls at
  2 s, HS02f) - a redeploy is visible per object, not atomically.
- Not run in this pass: HS05-domain (custom domain; see the next section).
  The first run scored HS03-head `fail` against a GET-only expectation; the
  module now records it as info.

## 2026-10-06 - custom domain, Worker front, teardown

Same project, same day. Artifacts in `out/2026-10-06/`:
`run-2026-10-06T08-38-35-610Z` (HS04, HS05), `run-2026-10-06T08-44-25-913Z`
(HS06), `run-2026-10-06T08-47-51-699Z` (HS07). DNS for every hostname went
through the Cloudflare v4 API (lib/cfdns.ts) in zones on the operator's own
account; the hostnames are deleted.

- **Custom domain on the project (HS04).** A first attempt on a second zone was
  torn down unused (an earlier HS07 pass, no artifact, 3 records removed; the
  published HS07 artifact is the final teardown below). On the domain kept, from
  the run log (gitignored; that run was stopped before writing an artifact): initialize `201` `2_initiated`, the ownership TXT
  written at 2 s and the `_acme-challenge` TXT at 4 s, verified 175 s into the DNS-and-reverify loop with
  reverify already reading `4_origin_setup_completed`. `activate` then answered
  HTTP `400` (body not recorded); the same call by hand about ten minutes later
  answered `201` with `5_services_reconfigured`. HS04 now retries activate for
  up to 10 minutes and logs the first refusal's body; that version has not run.
  The re-run (artifact above) found the hostname active and serving at once.
- **The custom domain lifts the rewrite for the function and not for Storage
  (HS05).** The same Astro build loaded through the custom domain at
  `/functions/v1/pvlab-hs-astro/` rendered, hydrated, applied the font-family
  from its CSS, called
  Auth (`api HTTP 200`) and followed About (HS05-domain-fn). The bucket through
  the same domain was still `text/plain` (HS05-domain-storage). The docs name
  the exception for Edge Functions only.
- **There is no root path on a custom domain** (ad hoc curl, no artifact):
  `/` and `/about/` answered `404 {"error":"requested path is invalid"}`,
  `/pvlab-hs-astro/` `404`, `/functions/pvlab-hs-astro/` `401`; only
  `/functions/v1/<slug>/` reached the function. A build made with
  `SITE_BASE=/functions/v1/site` and deployed as function `site` served `200
  text/html` at `/functions/v1/site/` and `/functions/v1/site/about/`, and its
  404 page with a `404` for a missing path. That is the shortest URL a
  Supabase-only site gets.
- **A Worker on an own hostname gives the production shape, with or without the
  custom domain (HS06).** The same Worker script (site/worker/worker.js) in
  front of Storage, and in front of the function via the custom domain, both
  rendered at `/` in Chromium with the island hydrated, and both answered
  `/about` with `308` (Location not recorded) and a missing path with `404 "text/html; charset=utf-8"`.
  The Worker sets the content-type itself, so in front of Storage it needs no
  custom domain. This leaves Supabase holding files only; recorded as the
  contrast case.
- **Teardown (HS07 + `make destroy`).** Workers (already deleted by hand,
  `wrangler delete` exit 1 each), custom hostname `DELETE` `200`, 3 DNS records
  removed with 0 left, add-on `DELETE` `200`; project destroyed (GET `404`). An
  ad hoc check afterwards (no artifact) found 0 `pvlab` records in either zone, 0 `pvlab` Workers
  and 0 Worker custom domains.
- Harness fix: `make publish-evidence` filtered on `ONLY`, which defaults to
  the battery list, so the first publishes of HS06 and HS07 came out empty and
  dropped HS04's rows; it now has its own `PUBLISH_ONLY`.

## 2026-10-06 - re-run after the HS04/HS06 changes (work-supabase-lab#24)

A second project, provisioned, run and destroyed 17:11-17:15 local time.
Artifacts in `out/2026-10-06/`: `run-2026-10-06T09-12-38-952Z` (HS04, HS05),
`run-2026-10-06T09-14-57-937Z` (HS06), `run-2026-10-06T09-15-29-285Z` (HS07).
Same custom hostname as the earlier pass.

- **The activate 400 did not reproduce (HS04).** initialize `201`
  `2_initiated`; only the ownership TXT was asked for this time (no
  `_acme-challenge` record), verified after 67 s; the first `activate` answered
  `201` and the status read `5_services_reconfigured` at once. The retry branch
  added after the first pass was not exercised. One success after one failure
  does not settle the cause. The hostname had been active on another project
  earlier the same day, which may explain the missing ACME record (not checked).
- **HS06 now records the redirect target:** `/about` -> `308` to
  `https://<host>/about/` on both Worker hostnames; a missing path -> `404`
  `text/html; charset=utf-8`.
- HS05 repeated the first pass on the new project: control, custom-domain
  function rendered; Storage, function on the project hostname and Storage on
  the custom domain `text/plain`; bucket root `400`. Function source 539014 B
  (the build carries the new project's URL and anon key).
- Teardown: Workers deleted (`wrangler delete` exit 0 each), custom hostname
  `DELETE` `200`, 2 DNS records removed with 0 left, add-on `DELETE` `200`,
  `make destroy`. Re-read afterwards (ad hoc, no artifact): project GET `404`,
  0 `pvlab` records, Workers and Worker domains.

## 2026-10-06 - third and fourth cycles: path probes as a row, harness fixes

Two more fresh projects, 17:30-17:40 and 17:41-17:45 local time, same custom
hostname. Artifacts in `out/2026-10-06/`: third cycle
`run-2026-10-06T09-31-42-515Z` (HS04, HS05), `run-2026-10-06T09-39-26-623Z`
(HS06), `run-2026-10-06T09-39-58-061Z` (HS07); fourth cycle
`run-2026-10-06T09-42-19-998Z`, `run-2026-10-06T09-44-41-585Z`,
`run-2026-10-06T09-45-25-682Z`.

- **The custom-domain path claims are now a module row (HS05-domain-paths),**
  in both cycles: `/` `404`, `/about/` `404`, `/<slug>/` `404`,
  `/functions/<slug>/` `401`, `/functions/v1/<slug>/` `200`. The first pass had
  these from ad hoc curl only.
- **activate answered `201` on the first call in both cycles** (verified after
  24 s and 66 s, one TXT asked for each time). Across the day: one `400`
  (first pass, body not recorded), then three first-call `201`s. The retry
  branch is covered by unit tests (`lib/activate.test.ts`, `make unit`); it has
  not fired live. HS04c now records `first_activate` and `activate_attempts`.
- **HS04c failed in the third cycle on a harness bug:** its serving probe reads
  `robots.txt` from the `site` bucket, which only HS01 created, and `make
  domain-up` runs HS04 and HS05 on a fresh project - `400` after 369 s. HS04
  now creates the fixture first; the fourth cycle answered `200` after 1 s with
  `cf-cache-status` `MISS`. The second cycle's HS04c `200` (fresh project, no
  `site` bucket) is therefore unexplained: an edge-cached copy of the first
  cycle's object through the same hostname fits, and cache status was not
  recorded then.
- **`font_loaded` is now informative:** a loaded `IBM Plex Mono` FontFace, `1`
  on the rendered pages (HS05-control, HS05-domain-fn) and `0` on the
  `text/plain` ones. Before the fix it read `1` everywhere
  (`document.fonts.check()` is true when no face is declared).
- Teardown after each cycle: Workers deleted (exit 0), custom hostname `DELETE`
  `200`, 2 DNS records removed with 0 left, add-on `DELETE` `200`,
  `make destroy`. Ad hoc re-read after the fourth: no lab project on the
  account, no `pvlab` hostname resolving.
