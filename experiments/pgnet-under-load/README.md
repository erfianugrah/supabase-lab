# pgnet-under-load

What hosted `pg_net` does with a slow receiver, a busy database and an
unreliable endpoint. The platform questions: what `timeout_milliseconds`
does on the hosted version and whether there is a ceiling; whether one slow
call holds up the calls queued behind it; when calls time out while the
database CPU is saturated, whether the cause is the `pg_net` worker, a
receiver waiting on the same database, or an Edge Function cold start; and
how many of 1,000 messages arrive (lost, duplicated) through raw `pg_net`,
`pg_net` with a retry job, and Supabase Queues (`pgmq`) with a `pg_cron`
consumer.

Self-provisioning, no OpenTofu state: NL01/NL02 create a Pro-org Micro,
NL03/NL04 a Pro-org Large (dedicated CPU), both in ap-southeast-1; NL99
deletes what the process created. The external receiver is a workers.dev
Worker (`receiver/`) that records every arrival in a Durable Object ledger
before it answers, so a call the sender gave up on still leaves a record.
Sibling context: `security-lockdown` S08 (pg_net egress) and S23 (pg_net and
webhooks under restrict-all), `edge-resilience` W18 (Edge Function cold
start).

## Modules

| id | claim measured |
|---|---|
| NL01 | hosted `pg_net` version, every `pg_net%` setting, `show pg_net.max_timeout_ms`, the `http_post` signature and its `timeout_milliseconds` default; `net.http_post` to a receiver that answers after 4, 8, 30 and 90 s with `timeout_milliseconds` 5000, 30000, 120000, 600000, 600001, 0 and omitted: refused at enqueue, `timed_out`, `status_code`, `error_msg`. NL01t: temp blocks written by `count(*)` over `generate_series` in FROM vs in the target list |
| NL02 | head-of-line blocking: 400 calls in one transaction, call 1 to a fast (control), a 4.5 s, or a 60 s receiver (with timeout 30000), calls 2-400 to a fast one; per call the receiver's arrival minus the enqueue time carried in the body, `timed_out` per group |
| NL03 | attribution under load on Large: a `pg_cron` job every 10 s enqueues 17 calls each to the Worker, a trivial Edge Function and an Edge Function running one query through the Data API (timeout 5000), 600 s with the database idle and 600 s with 2 x vCPU backends spinning; per target 2xx, `timed_out`, arrival delay, `error_msg` phases, the query's time inside the function; node CPU from the metrics endpoint; the `pg_net` worker's `pg_stat_activity` row every 1 s; function_logs Boot events |
| NL04 | 1,000 messages to a receiver answering 20% 503 and holding 10% for 8 s (timeout 5000): raw `pg_net`, `pg_net` plus a `pg_cron` retry job, `pgmq` plus a `pg_cron` consumer (vt 30 s); delivered, lost and duplicated counted at the receiver, database idle and saturated |
| NL05 | on a fresh Large, four bursts of 200 calls to the receiver's `/echo` (default timeout): the project's first outbound calls, two more at once, one after 120 s idle; timed_out, calls that never arrived, arrival delay, `error_msg` shapes. Opt-in: `make large LARGE=NL05,NL99` |
| NL99 | teardown |

## Run

```bash
export PVLAB_ORG_PRO=<pro-org-slug>
sx CLOUDFLARE_API_TOKEN=CLOUDFLARE_WORKERS_TOKEN CLOUDFLARE_ACCOUNT_ID -- make receiver-up   # prints the workers.dev URL
sx SUPABASE_ACCESS_TOKEN -- make micro RECEIVER=<url>   # NL01, NL02, NL99; about 10 minutes
sx SUPABASE_ACCESS_TOKEN -- make large RECEIVER=<url>   # NL03, NL04, NL99; about 50 minutes
sx SUPABASE_ACCESS_TOKEN -- make clean                  # list leftover pvlab-nl-* projects; DELETE=1 deletes
sx CLOUDFLARE_API_TOKEN=CLOUDFLARE_WORKERS_TOKEN CLOUDFLARE_ACCOUNT_ID -- make receiver-down
make publish-evidence RUN=evidence/<ts>/run-<stamp>.json
```

`PVLAB_NL_ARM_S` (default 600) and `PVLAB_NL_MECH_S` (default 180) set the
NL03 arm and NL04 per-mechanism lengths. `PVLAB_NL_REF_MICRO` /
`PVLAB_NL_REF_LARGE` reuse a project (development only; NL99 leaves it, and
the burners then need `PVLAB_NL_DB_PASS`). Results and their limits are in
RUNLOG.md.
