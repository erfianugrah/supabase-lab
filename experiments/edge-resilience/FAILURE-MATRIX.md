# Failure matrix - every ingress point where a request can die

Path order: client -> DNS -> edge proxy -> Supabase gateway -> service ->
pooler -> Postgres -> object storage. Each point lists: what the client
sees (signature), how to detect it (probe), the workaround, and how the lab
proves it (module). Status: [green] lab-validated, [doc] doc/design only,
[gap] nothing exists.

## 0. Client side

| # | Failure point | Signature | Detection | Workaround | Test |
|---|---------------|-----------|-----------|------------|------|
| 0.1 | Client device clock wrong | supabase-js refreshes too early/late; expired tokens sent | client telemetry on 401s | server-side validation unaffected (iat is issuer-set); client SDK logic only | [doc] |
| 0.2 | Refresh-token rotation race (multi-tab) | intermittent 401s, session loss | reproduce with N parallel refreshes | single-tab refresh leader / lock | [green W08] |
| 0.3 | Token storage cleared (localStorage) | logged out | n/a | session design, not infra | [doc] |

## 1. DNS / edge ingress (customer's own front)

| # | Failure point | Signature | Detection | Workaround | Test |
|---|---------------|-----------|-----------|------------|------|
| 1.1 | Worker exception (CPU limit, bug) | 1101/1102 error page | synthetic probe through worker | keep proxy logic minimal; exceptions logged via workers tail/logs | [doc] |
| 1.2 | Worker routing data stale (D1/KV routing table points at dead project) | 5xx for some tenants only | per-tenant canary | routing health-check loop, auto-eject | [gap] W-candidate (poison routing row, watch eject) |
| 1.3 | CDN/zone issue at customer's own provider | widespread 5xx before origin | compare direct-origin vs via-proxy probes | direct-origin fallback hostname | [doc] |

## 2. Supabase gateway (shared CF front + kong)

| # | Failure point | Signature | Detection | Workaround | Test |
|---|---------------|-----------|-----------|------------|------|
| 2.1 | CF-front error (520/521/522/523) | CF error page, no pgrst code | probe reads status+body shape | retry 520-class (docs pattern); cache-first reads (W04 green) | [green W04] |
| 2.2 | Platform rate limit / WAF | 429, or __cf_bm challenge | 429-rate alert | backoff; every response carries __cf_bm Set-Cookie - breaks naive cache.put (found 2026-08-15) | [green worker] |
| 2.3 | TLS/cert at gateway | handshake failures | openssl s_client probe | none client-side | [doc] |

## 3. PostgREST (data API)

| # | Failure point | Signature | Detection | Workaround | Test |
|---|---------------|-----------|-----------|------------|------|
| 3.1 | JWT claim rejection (skewed issuer) | 401 PGRST303 | PGRST303-rate alert | TTL raise (W03), no runtime fix (W01) | [green W01/W03] |
| 3.2 | Unknown/rotated signing key | 401 PGRST301 | PGRST301-rate alert | key hygiene; TPA lag ~30s both directions (W01) | [green W01] |
| 3.3 | Schema-cache wedge | 503 PGRST002 | pgrst code probe | pg_notify reload (http-tier-lockdown) | [green L-series] |
| 3.4 | DB unreachable behind healthy tier | 503 PGRST000/002 while status ACTIVE_HEALTHY | probe a REAL table | probe design (never trust status) | [green F7] |
| 3.5 | Statement timeout / lock pileup | 57014 after timeout | slow-query watch | indexes, pooler tx mode caveats | [doc] |

## 4. GoTrue (Auth)

| # | Failure point | Signature | Detection | Workaround | Test |
|---|---------------|-----------|-----------|------------|------|
| 4.1 | Auth service down | login/refresh/signup dead; EXISTING valid tokens still pass PostgREST (local validation) | signUp probe (NOT password grant - F16) | long TTL shrinks exposure (W03); break-glass edge minting with extracted secret [W07 candidate] | [green D-series ~75s restart gap] |
| 4.2 | Email send rate limit | signup/confirm/magic-link fail with over_email_send_rate_limit | signup probe | custom SMTP; admin-create path (W03) | [green W03 collateral] |
| 4.3 | SSO/IdP outage (customer's enterprise IdP) | SSO logins fail only | per-IdP synthetic | none client-side | [doc] |

## 5. Storage API + render path

| # | Failure point | Signature | Detection | Workaround | Test |
|---|---------------|-----------|-----------|------------|------|
| 5.1 | Storage API down | uploads/downloads 5xx | real-object probe | externalize bulk objects (R2/S3) + dual-write or sync | [gap] W-candidate (dual-write drill) |
| 5.2 | imgproxy render path failure/timeout | transform URLs fail while originals serve | render-URL probe | pre-generated renditions at upload (billing fix doubles as resilience fix) | [doc] |
| 5.3 | Billing-model surprise | invoice shock, not a request failure | weekly usage-page check | per-item monitoring (no alerting exists) | [green class 6 doc] |

## 6. Realtime

| # | Failure point | Signature | Detection | Workaround | Test |
|---|---------------|-----------|-----------|------------|------|
| 6.1 | Realtime connect/subscribe failure | WS handshake fails | WS connect probe | poll fallback; retry joins under load (W12) | [green W12] |
| 6.2 | Subscription silently stale | no events, no error | heartbeat event canary | reconnect logic, canary table | [doc] |

## 7. Edge Functions

| # | Failure point | Signature | Detection | Workaround | Test |
|---|---------------|-----------|-----------|------------|------|
| 7.1 | Execution timeout | 504 IDLE_TIMEOUT at 150s (measured W13) | long-job probe | queue + cron pattern; external runner for long jobs | [green W13] |
| 7.2 | Cold start latency | p99 spikes | timing probe | keep-warm pings | [doc] |

## 8. Pooler (Supavisor)

| # | Failure point | Signature | Detection | Workaround | Test |
|---|---------------|-----------|-----------|------------|------|
| 8.1 | Session-mode auth failure | 58P01 at connect | pg connect probe | - | [green pooler-semantics] |
| 8.2 | Transaction-mode deferral | connect OK, first statement 08P01/0A000 | first-statement probe | session mode for prepared statements | [green] |
| 8.3 | max_clients / capacity | 400 (ambiguous - read SQLSTATE) | connect-storm probe | direct-conn fallback DSN | [green] |
| 8.4 | 5432 silent blackhole | accepts, never answers | probe with read timeout | always set statement/connect timeouts | [green] |

## 9. Postgres

| # | Failure point | Signature | Detection | Workaround | Test |
|---|---------------|-----------|-----------|------------|------|
| 9.1 | Compute lifecycle (restart/resize/upgrade) | per-service gaps: REST ~10s, Storage ~26s, Auth ~75s | per-service authed probes | schedule windows; read replicas keep GETs alive | [green D-series] |
| 9.2 | Connection ceiling | tooManyConnections | connect probe | pooler, PITR-drain-first (F-series) | [green] |
| 9.3 | Disk full / IO stall | writes fail, reads degrade | disk metrics (Prometheus endpoint) | storage resize ahead of curve | [doc] |
| 9.4 | No managed failover on standard tiers | DB down = everything down | - | standby (W05) / PITR (class 9) | [gap] W05 |

## 10. Control plane

| # | Failure point | Signature | Detection | Workaround | Test |
|---|---------------|-----------|-----------|------------|------|
| 10.1 | Capacity blocks create/resize/restart | mgmt API failures, stuck transitions | mgmt API probe | pre-provision pool, region selector | [doc - 2026 public pattern] |
| 10.2 | Pause (inactivity, free tier) | project asleep, cold resume | resume timing probe | keep-alive ping; paid tier | [green resume ~1-2s after pause, D-series] |

## 11. Standby/DR divergence (the W05 class of self-inflicted wounds)

| # | Failure point | Signature | Detection | Workaround | Test |
|---|---------------|-----------|-----------|------------|------|
| 11.1 | Sequence drift after logical-rep cutover | duplicate-key errors on new inserts | insert canary on standby | resync script at cutover (sbshift pattern) | [gap] W05 |
| 11.2 | DDL divergence (migrations applied to primary only) | standby missing columns/tables | schema diff probe | migration procedure: apply both sides | [gap] W05 |
| 11.3 | JWT secret mismatch on standby | all sessions 401 PGRST301 after cutover | token portability probe | copy secret (extract via GET /postgrest) | [gap] W05 |
| 11.4 | Replication lag at cutover | data loss window | lag metric | cutover only when lag < threshold | [gap] W05 |
| 11.5 | Split-brain writes during flap | divergent rows | flap drill | fail over, never dual-write; flap damping in proxy | [gap] W05 |

| 11.6 | Schema parity beyond data (RLS, grants, functions, triggers, views) | standby open/broken after cutover | schema diff probe | pg_dump --schema-only, re-applied on change (W11) | [green W11] |
| 11.7 | auth.* replication (users, identities, sessions) | fresh logins fail on standby while old tokens still read | login canary on standby | NOT viable on micro (W09); TPA + SQL hash backfill or forced re-login | [green W09] |
| 11.8 | Storage objects do not follow metadata | standby serves 400/NoSuchBucket for existing objects | object fetch probe on standby | dual-write or S3-level sync (780ms small object, W10) | [green W10] |
| 11.9 | Vault secrets / pg_cron / function secrets | jobs + integrations dead post-cutover | job heartbeat canary | recreate manually; vault ciphertext is project-keyed | [doc] |

## 12. Billing/spend

| # | Failure point | Signature | Detection | Workaround | Test |
|---|---------------|-----------|-----------|------------|------|
| 12.1 | Spend cap trips (Pro only) | usage disallowed at quota, app degrades | usage watch | intentional cap policy | [doc] |
| 12.2 | Missed payment -> suspension | project suspended | billing hygiene | billing alerts (Stripe side) | [doc] |

## Coverage summary

green (lab-validated): 3.1, 3.2, 3.3, 3.4, 4.1 (partial - restart gap
measured), 4.2, 8.x, 9.1, 9.2, 2.1/2.2 (via W04 worker), 12.1 (doc).
W-candidates (worth building): 0.2 refresh race, 1.2 routing eject,
5.1 storage dual-write, 6.1 realtime probe, 11.x ALL (the W05 standby
drill covers 11.1-11.5 in one build), 9.4 (covered BY W05).
doc/design only (no lab value or not ours to fix): 0.1, 0.3, 1.1, 1.3,
2.3, 3.5, 4.3, 5.2, 6.2, 7.x, 9.3, 10.1, 12.x.
