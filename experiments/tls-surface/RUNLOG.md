# tls-surface - RUNLOG

One micro project in ap-southeast-1 on the Team organisation, probed from an
IPv4-only vantage in Singapore (OpenSSL 3.6.5, psql 18.6, Bun 1.3.14 per the
artifacts' `toolVersions`; curl 8.22.0 on the vantage, not recorded in the
artifacts). Every TLS surface the project exposes is the subject: the HTTP
edge names, the shared pooler (Supavisor), direct 5432 and the dedicated
PgBouncer on 6543 (both over IPv4 via the add-on), a custom domain, SSL
enforcement, and outbound TLS from pg_net and an Edge Function. Redacted
artifacts under `out/2026-10-02/`, each with a `.facts.md` beside it; numbers
below are pasted from those. Infrastructure addresses are redacted to
`<addr>` and the vantage's own address to `<vantage-ip>`.

The read-only modules are built to be re-run and compared with `make diff`:
TL02 has one column per tracked suite and TL05 one per route.

## 2026-10-02 - first spin

Order: read-only pass (TL01-TL06, TL10-TL12), the same pass again inside
`make full`, TL14, TL10-TL12 on all four Postgres paths, TL16, TL20, TL21,
TL17, TL18; then TL14, TL16 (fixed, see below), TL18 again; then TL17 and
the read-only pass twice more after module wording and the TLS 1.2 OCSP
parser changed. The earlier read-only passes agree with the last one on
every row except the OCSP column, and are not published.

### TL01-TL06 - the HTTP edge (run-2026-10-02T06-11-12; custom-domain rows from TL17, run-2026-10-02T06-00-15)

### TL01 - protocol versions

- `<ref>.supabase.co`, `<ref>.storage.supabase.co`,
  `<ref>.functions.supabase.co`, `api.supabase.com`, and the custom domain:
  TLS 1.0 and 1.1 refused with alert 70 (protocol version), TLS 1.2 and 1.3
  accepted. Client at @SECLEVEL=0 for the 1.0/1.1 legs, so the refusal is the
  server's.
- Suite chosen for the client's default list: TLS 1.3
  `TLS_AES_256_GCM_SHA384` on every name; TLS 1.2
  `ECDHE-ECDSA-AES128-GCM-SHA256`, except the Storage host, which picks
  `ECDHE-ECDSA-CHACHA20-POLY1305`.

### TL02 - cipher suites (155 TLS 1.2 suites offered one by one)

- `<ref>.supabase.co`, `<ref>.functions.supabase.co`, `api.supabase.com` and
  the custom domain accept the same 10 TLS 1.2 suites: six AEAD
  (ECDHE-{ECDSA,RSA}-{AES128-GCM-SHA256, AES256-GCM-SHA384, CHACHA20-POLY1305})
  and four ECDHE CBC suites with SHA-2 MACs
  (ECDHE-{ECDSA,RSA}-AES128-SHA256, ECDHE-{ECDSA,RSA}-AES256-SHA384). These
  four are the per-suite TL02 columns; a "CBC suites enabled" scanner finding
  on these names would list them.
- `<ref>.storage.supabase.co` has a different suite list: 20 TLS 1.2 suites,
  12 CBC. On top of the ten above it accepts
  ECDHE-{ECDSA,RSA}-AES{128,256}-SHA (SHA-1 CBC) and six static-RSA
  key-exchange suites with no forward secrecy: AES128-SHA, AES256-SHA,
  AES128-SHA256, AES256-SHA256, AES128-GCM-SHA256, AES256-GCM-SHA384. Spot
  checked by hand with `openssl s_client -tls1_2 -cipher AES128-SHA` against
  the Storage host (negotiated). A CBC or "no forward secrecy" scanner finding
  on the Storage host - where the S3 endpoint lives - lists more than the
  four suites the other names share.
- TLS 1.3 on every name: AES-128-GCM, AES-256-GCM and CHACHA20 accepted;
  TLS_AES_128_CCM_SHA256 refused (alert 40); CCM_8 not offerable by this
  client.

### TL03 - certificates

- Every edge name serves both an ECDSA P-256 leaf (issuer CN=WE1) and an
  RSA-2048 leaf (issuer CN=WR1), chosen by what the client offers; the TLS
  1.3 default is the ECDSA one. 90-day lifetime on every leaf, so rotation is
  automated and a pinned leaf breaks within 90 days. The system store
  verifies all of them with hostname checking.
- SANs: `supabase.co *.supabase.co` (api), `storage.supabase.co
  *.storage.supabase.co`, `supabase.co *.functions.supabase.co`,
  `supabase.com *.supabase.com` (mgmt), and the custom domain's own name only.
- No OCSP response stapled on any name, on any of the three legs (TLS 1.2
  ECDSA, TLS 1.2 RSA, TLS 1.3).
- TLS 1.3 group this OpenSSL 3.6.5 client negotiated on the edge:
  `X25519MLKEM768` (hybrid post-quantum).

### TL04 - SNI, ALPN, HTTP versions, HSTS, port 80

- No SNI: refused with alert 40 on every edge name, so a client that sends
  no SNI fails today whatever its suites. An unknown SNI (`.invalid`) is
  refused the same way. (An earlier version of this row sent `example.com`,
  which the same edge served; replaced.)
- ALPN: h2 when offered, http/1.1 when it is the only offer. Default HTTP/2.
- HTTP/3 (`alt-svc: h3=":443"`) on `<ref>.supabase.co`,
  `<ref>.functions.supabase.co` and the custom domain; not on the Storage host
  or `api.supabase.com`. The vantage control (cloudflare.com over HTTP/3)
  worked, so the misses are not this vantage.
- HSTS on every name: `max-age=31536000; includeSubDomains; preload`.
- Port 80: `<ref>.supabase.co`, `<ref>.functions.supabase.co`, the custom
  domain and `api.supabase.com` answer 301 to https. `<ref>.storage.supabase.co`
  does not redirect: `/auth/v1/health` gets a 404 from the project gateway in
  cleartext (`sb-gateway-version` header present), and `/storage/v1/version`
  gets no answer in 8 s - after the client has sent its `apikey` header in
  cleartext. A by-hand check the same day saw `/storage/v1/bucket` and the
  S3 path hang the same way (15 s, 0 bytes); that check is not in an
  artifact. HSTS preload covers browsers; a non-browser client given an
  `http://` Storage URL sends its key in the clear and then hangs.

### TL05 - a client offering only the four ECDHE SHA-2 CBC suites

- curl restricted to TLS <= 1.2 and those four suites, against an
  unrestricted control, on `<ref>.supabase.co` (the S3 leg on
  `<ref>.storage.supabase.co`): auth 200, rest 401, storage 400, functions
  404, realtime WebSocket 101, Storage S3 403 - identical to the control on
  every route, negotiated `ECDHE-ECDSA-AES128-SHA256`. The same on the custom
  domain (TL17) for the five routes other than S3, which TL17 does not call.
- A suite the edge does not accept is refused with alert 40 (`handshake
  failure`) in the one refusal whose alert is stored (TLS 1.3 CCM); TL02
  stores per-suite outcomes only for the tracked columns.

### TL06 - Management API spec

- TLS-adjacent paths: custom-hostname (4), ssl-enforcement, vanity-subdomain
  (3). No schema field controls ciphers or TLS versions; the only match is
  the `ssl` status object in the custom-hostname response.

### TL10 - Postgres paths: protocols, suites, chain (run-2026-10-02T05-25-28)

| path | TLS 1.2 suites | of them CBC | leaf | direct TLS (PG17) |
|---|---|---|---|---|
| Supavisor 5432 / 6543 | 6 | 0 | `*.pooler.supabase.com *.pooler.supabase.co`, to 2030-03-11 | refused: plaintext reply (`wrong version number`) |
| direct 5432 | 40 | 22 | `db.<ref>.supabase.co`, to 2031-10-01 | ok, TLS 1.3, ALPN `postgresql` |
| dedicated PgBouncer 6543 | 20 | 12 | `db.<ref>.supabase.co`, to 2031-10-01 | ok, TLS 1.3, ALPN `postgresql` |

- TLS 1.0/1.1 refused, 1.2/1.3 accepted on all four.
- Direct 5432's CBC set: ECDHE-RSA and DHE-RSA AES and CAMELLIA in SHA-1,
  SHA-256 and SHA-384 variants, plus static-RSA AES/CAMELLIA (no forward
  secrecy). The dedicated PgBouncer: the same minus CAMELLIA. 3DES NOT
  TESTED: this OpenSSL 3.6.5 build offers no DES/3DES suite (none of the 155),
  so the `+3DES` in `ssl_ciphers` is unverified either way. A scanner pointed
  at `db.<ref>.supabase.co` port 5432 (22 CBC) or 6543 (12 CBC) would list
  these suites, whatever changes on the HTTP edge.
- One CA on all four paths: leaf <- Supabase Intermediate 2021 CA <- Supabase
  Root 2021 CA (self-signed, to 2031-04-26), with the root sent in the chain.
  Same root fingerprint on all four. The system store does not verify it
  (code 19); it is a private CA.
- The direct/dedicated leaf (5-year lifetime, to 2031-10-01) outlives its
  root (2031-04-26). Inferred, not measured: once the root expires,
  `verify-full` against it would fail while this leaf is still in date,
  unless the root is replaced first.
- Groups: dedicated PgBouncer negotiates `X25519MLKEM768`, Supavisor X25519,
  Postgres itself ECDH P-256 (`ssl_ecdh_curve = prime256v1`).

### TL11 - server settings and per-hop TLS (run-2026-10-02T05-25-28)

- Postgres: `ssl=on`, `ssl_min_protocol_version=TLSv1.2`, max unset,
  `ssl_ciphers='HIGH:MEDIUM:+3DES:!aNULL'`, `ssl_ecdh_curve=prime256v1`.
- `pg_stat_ssl` for the session's own backend (SSL enforcement off, the
  default):
  - via Supavisor (5432 and 6543): `ssl=false` - the Supavisor -> Postgres hop
    is plaintext Postgres protocol even though the client leg is TLS 1.3;
  - via the dedicated PgBouncer: `ssl=true TLSv1.3 TLS_AES_256_GCM_SHA384`,
    backend sees `::1` (so PgBouncer presumably runs on the database
    instance);
  - direct: the client's own TLS, `TLSv1.3 TLS_AES_256_GCM_SHA384`.
- `pg_hba_file_rules`: permission denied for the `postgres` role.

### TL12 - libpq sslmode matrix (run-2026-10-02T05-25-28)

- With enforcement off, `sslmode=disable` connects on all four paths.
  Through Supavisor every mode, verify-full included, ends with a plaintext
  backend hop (`ssl=false`); through the dedicated PgBouncer even `disable`
  ends with a TLS 1.3 backend hop.
- `verify-full` with the chain's root passes on all four paths; the
  wrong-name negative control fails on all four ("does not match host
  name"). `sslrootcert=system` fails (private CA); `verify-ca` with `system`
  is refused by libpq itself ("weak sslmode").
- `sslnegotiation=direct` works on direct 5432 and the dedicated PgBouncer
  6543, and fails on Supavisor (`wrong version number`).

### TL14 - IPv4 add-on (plumbing; run-2026-10-02T05-13-26, run-2026-10-02T05-31-52)

- PATCH 200 both times. Both TL14 runs then reported "A record never" - the
  first after its 12-minute budget, the second after 20 minutes - while
  `dig` (local resolver, 1.1.1.1, 8.8.8.8) returned the A record and the very
  next process (TL10-TL12, TL16) connected to direct 5432 over IPv4. So the
  in-process lookup (`node:dns` resolve4 in the long-running harness process)
  was what never saw it; why is not established. TL14 now polls with a fresh
  `dig` each time; not run since that change.

### TL16 - SSL enforcement (run-2026-10-02T05-26-30 and, fixed, run-2026-10-02T05-51-58)

The first version counted the restart's `Connection refused` on direct 5432
and dedicated 6543 as the enforcement refusal; fixed to wait for an hba/SSL
rejection and re-run with all four paths reachable. The artifacts'
`probe_interval_ms` 500 is a constant from the shared `flatten()` helper;
both runs sampled at the module's `intervalMs: 1000` (column fixed for later
runs). Both runs:

- `PUT /ssl-enforcement` HTTP 200 (on: 3288 ms, 2537 ms; off: 1362 ms,
  1455 ms), `appliedSuccessfully=true` every time.
- Every switch, on AND off, restarted Postgres: `pg_postmaster_start_time()`,
  read through Supavisor 5432, moved on each of the four switches (05:26:34,
  05:26:56, 05:52:01, 05:52:27 UTC). Schedule the switch as a restart.
- A TLS client on Supavisor 5432, sampled every 1 s, failed during every
  switch. Switching on: 1/15 samples in the first run, from first failure to
  sustained recovery 4 s, failure text `no pg_hba.conf entry for host
  "<addr>" ... no encryption` - Postgres refusing Supavisor's still-plaintext
  hop, so a TLS client is refused while that hop catches up; 3/17 in the
  rerun, 13 s, `Failed to connect to database: {:error, :econnrefused}` (the
  restart). Switching off: 1/13 both times, 1 s, `the database system is
  shutting down`. The REST probe never failed.
- Plaintext (`sslmode=disable`), rerun: refused on all four paths at the
  first poll after the PUT returned - 3 s after the PUT was sent, with the PUT
  taking 2537 ms and a 3 s poll interval. The refusal text per path:
  - Supavisor 5432 and 6543: `FATAL: (ESSLREQUIRED) SSL connection is
    required for user: postgres`. In the first run (6 s after the PUT was
    sent) the refusal came from Postgres, relayed: `no pg_hba.conf entry for
    host "<addr>" ... no encryption`. Which check takes effect first is not
    established.
  - direct 5432: `FATAL: no pg_hba.conf entry for host "<vantage-ip>", user
    "postgres", database "postgres", no encryption`.
  - dedicated PgBouncer 6543: `FATAL: SSL required`.
- With enforcement on, the backend hop is TLS 1.3 `TLS_AES_256_GCM_SHA384` on
  all four paths, including Supavisor -> Postgres (plaintext with
  enforcement off - TL11).
- Off again: plaintext accepted on all four at 4 s (first run) and 5 s
  (rerun) after the PUT was sent. The module restores the setting it found
  (off).

### TL17 - custom domain (run-2026-10-02T05-27-40 setup, protocol, certificate and extras rows; run-2026-10-02T06-00-15 all rows)

- First bring-up, seconds from the add-on request: add-on 200, initialize
  201, ownership TXT asked at once and the `_acme-challenge` TXT on a later
  poll (24 s), verified (`4_origin_setup_completed`) at 196 s, activate 201,
  serving at 207 s.
- Second bring-up of the same hostname about 30 minutes after the first was
  torn down: only the CNAME and the ownership TXT were written (2 DNS
  records), verified at 47 s, serving at 48 s. Presumably the certificate
  for the name was still issued; this run cannot confirm it.
- TL01-TL05 on the custom host: same protocols, the same 10 suites with the
  four CBC, ECDSA + RSA leaves for the custom name only (90 days), unknown
  SNI refused, HTTP/3, HSTS preload, port 80 redirects on both routes probed,
  CBC-only client identical to the control on its five routes. The suite and
  CBC-client rows are from the second run; the first run's raw evidence has
  the same rows and they are withheld from its published artifact. Teardown
  clean both times (DELETE 200, DNS records removed, add-on removed 200).

### TL20 - outbound from pg_net 0.20.4 (run-2026-10-02T05-26-30)

- howsmyssl echo: TLS 1.3, offers 30 suites, 16 of them CBC (presumably the
  database host's libcurl/OpenSSL defaults; not inspected).
- Refuses TLS 1.0-only and 1.1-only servers, RC4 and 3DES servers; refuses
  expired, self-signed, untrusted-root and wrong-host certificates ("SSL peer
  certificate ... was not OK"). Connects to a CBC-only server. Refused the
  revoked-certificate host with "SSL connect error", which the local curl
  control accepts; the cause (revocation checking or something else in the
  handshake) is not established.

### TL21 - outbound from an Edge Function (run-2026-10-02T05-26-30)

- howsmyssl echo: TLS 1.3, offers 10 suites, 0 CBC (rating "Improvable").
- Refuses TLS 1.0-only and 1.1-only servers, RC4, 3DES, expired,
  self-signed, untrusted-root and wrong-host certificates; also refuses a
  CBC-only server (`client error`), so an Edge Function cannot call an
  upstream that only offers CBC suites. Connects to the revoked-certificate
  host: revocation is not enforced (one host tested).

### Not measured

- IPv6 to direct 5432 / dedicated 6543: this vantage has no IPv6 (asserted
  from the setup, not probed by a module). Read replicas, vanity subdomains,
  other regions' edges and poolers, and Realtime's own Postgres connection.

## Module changes after the first spin (not yet run against the platform)

- TL12 records both legs per cell: the client's own TLS from libpq
  `\conninfo` and the backend `pg_stat_ssl` row (the pooler -> Postgres hop
  through a pooler). The first spin recorded only the second. The
  `\conninfo` parser was checked against psql 18.6 and a local ssl=on
  cluster, not against the platform.
- TL16 counts a plaintext attempt as the enforcement refusal only on the
  three texts seen per path (`ESSLREQUIRED`, hba `no encryption`, PgBouncer
  `SSL required`); a restart-time `SSL SYSCALL error` no longer qualifies.
- TL20/TL21: the revoked-certificate target is informational and no longer
  counts as a mismatch (clients legitimately differ on revocation). The
  first spin's TL21 fail had two mismatches, one of them this row.
- Postgres path discovery and TL14 resolve with `dig`; TL17 skips before
  anything billable when `~/bin/knotctl` is absent.
