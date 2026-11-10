# RR10 manual reads, 2026-11-10 (Management API query endpoint and logs endpoint, refs and the password redacted)

Read by hand while RR10e waited (about 10:13-10:20 UTC, plus one backups read at 10:48 UTC), before teardown; each probe was run once. Not part of the run artifact. Probe 0 and the probe 2 excerpt were transcribed from the session's tool output (their full outputs were not saved); everything else is saved output with refs and the password redacted.

## A: pg_stat_subscription and pg_subscription_rel at 10:13:36 UTC (probe 0, transcribed)

```
[{"subname":"rr10_sub_a","pid":7438,"rel":null,"received_lsn":"1/1F000000","latest_end_lsn":"1/1F000000","last_msg_receipt_time":"2026-11-10 10:13:36.023215+00"}]
[{"rel":"rr10_t","srsubstate":"f","srsublsn":null}]
```

## A: the create subscription statement in A's Postgres log (probe 2 excerpt, transcribed, password replaced)

```
2026-11-10T09:33:03.096000 LOG statement: create subscription rr10_sub_a connection 'host=db.<ref-S>.supabase.co port=5432 dbname=postgres user=postgres password=<password> options=''-c statement_timeout=0''' publication rr10_pub
```

The logged line carried the generated password in plain text; it is replaced here. `log_statement` was not read.

## A: subscription workers, settings; S: replication slots; A: replication log lines (probe 1)

```
== A activity
[{"pid":5368,"backend_type":"logical replication launcher","state":null,"wait_event_type":"Activity","wait_event":"LogicalLauncherMain","age":"01:07:34.681742"},{"pid":7438,"backend_type":"logical replication apply worker","state":"idle","wait_event_type":"Activity","wait_event":"LogicalApplyMain","age":"00:45:27.027373"},{"pid":12516,"backend_type":"walsender","state":"active","wait_event_type":"Activity","wait_event":"WalSenderMain","age":"00:23:08.875826"}]
== A settings
[{"name":"hot_standby_feedback","setting":"off"},{"name":"max_logical_replication_workers","setting":"4"},{"name":"max_replication_slots","setting":"10"},{"name":"max_sync_workers_per_subscription","setting":"2"},{"name":"max_wal_senders","setting":"10"},{"name":"max_worker_processes","setting":"6"},{"name":"synchronous_commit","setting":"on"},{"name":"synchronous_standby_names","setting":""}]
== S slots
[{"slot_name":"rr10_sub_b","active":true,"slot_type":"logical","confirmed_flush_lsn":"1/1F000000","wal_status":"reserved"},{"slot_name":"rr10_sub_a","active":true,"slot_type":"logical","confirmed_flush_lsn":"1/1F000000","wal_status":"reserved"}]
== A logs
2026-11-10T10:18:19.648000 background worker "logical replication tablesync worker" (PID 14428) exited with exit code 1
2026-11-10T10:18:19.613000 logical replication table synchronization worker for subscription "rr10_sub_a", table "rr10_t" has started
2026-11-10T10:18:14.602000 background worker "logical replication tablesync worker" (PID 14427) exited with exit code 1
2026-11-10T10:18:14.568000 logical replication table synchronization worker for subscription "rr10_sub_a", table "rr10_t" has started
2026-11-10T10:18:09.557000 background worker "logical replication tablesync worker" (PID 14425) exited with exit code 1
2026-11-10T10:18:09.521000 logical replication table synchronization worker for subscription "rr10_sub_a", table "rr10_t" has started
2026-11-10T10:18:04.509000 background worker "logical replication tablesync worker" (PID 14424) exited with exit code 1
2026-11-10T10:18:04.476000 logical replication table synchronization worker for subscription "rr10_sub_a", table "rr10_t" has started
2026-11-10T10:17:59.465000 background worker "logical replication tablesync worker" (PID 14423) exited with exit code 1
2026-11-10T10:17:59.428000 logical replication table synchronization worker for subscription "rr10_sub_a", table "rr10_t" has started
2026-11-10T10:17:54.417000 background worker "logical replication tablesync worker" (PID 14420) exited with exit code 1
2026-11-10T10:17:54.386000 logical replication table synchronization worker for subscription "rr10_sub_a", table "rr10_t" has started
2026-11-10T10:17:49.376000 background worker "logical replication tablesync worker" (PID 14418) exited with exit code 1
2026-11-10T10:17:49.339000 logical replication table synchronization worker for subscription "rr10_sub_a", table "rr10_t" has started
2026-11-10T10:17:44.328000 background worker "logical replication tablesync worker" (PID 14417) exited with exit code 1
2026-11-10T10:17:44.299000 logical replication table synchronization worker for subscription "rr10_sub_a", table "rr10_t" has started
2026-11-10T10:17:39.288000 background worker "logical replication tablesync worker" (PID 14415) exited with exit code 1
2026-11-10T10:17:39.258000 logical replication table synchronization worker for subscription "rr10_sub_a", table "rr10_t" has started
2026-11-10T10:17:34.247000 background worker "logical replication tablesync worker" (PID 14414) exited with exit code 1
2026-11-10T10:17:34.217000 logical replication table synchronization worker for subscription "rr10_sub_a", table "rr10_t" has started
2026-11-10T10:17:29.206000 background worker "logical replication tablesync worker" (PID 14413) exited with exit code 1
2026-11-10T10:17:29.168000 logical replication table synchronization worker for subscription "rr10_sub_a", table "rr10_t" has started
2026-11-10T10:17:24.156000 background worker "logical replication tablesync worker" (PID 14410) exited with exit code 1
2026-11-10T10:17:24.125000 logical replication table synchronization worker for subscription "rr10_sub_a", table "rr10_t" has started
2026-11-10T10:17:19.114000 background worker "logical replication tablesync worker" (PID 14409) exited with exit code 1
2026-11-10T10:17:19.078000 logical replication table synchronization worker for subscription "rr10_sub_a", table "rr10_t" has started
2026-11-10T10:17:14.067000 background worker "logical replication tablesync worker" (PID 14408) exited with exit code 1
2026-11-10T10:17:14.021000 logical replication table synchronization worker for subscription "rr10_sub_a", table "rr10_t" has started
2026-11-10T10:17:09.012000 background worker "logical replication tablesync worker" (PID 14406) exited with exit code 1
2026-11-10T10:17:08.978000 logical replication table synchronization worker for subscription "rr10_sub_a", table "rr10_t" has started
```

## S and A error timeline by node, 09:20-09:40 UTC (probe 4; `<replica-S>` and `<replica-A>` are the read replicas, `<ref-S>` and `<ref-A>` the primaries)

```
== S 09:20-09:40
2026-11-10T09:26:59.775000 | <replica-S> | client backend | ERROR | relation "realtime.subscription" does not exist
2026-11-10T09:27:14.501000 | <replica-S> | postmaster | LOG | received fast shutdown request
2026-11-10T09:27:14.507000 | <replica-S> | client backend | FATAL | terminating connection due to administrator command
2026-11-10T09:27:14.509000 | <replica-S> | client backend | FATAL | terminating connection due to administrator command
2026-11-10T09:27:14.519000 | <replica-S> | client backend | FATAL | terminating connection due to administrator command
2026-11-10T09:27:46.690000 | <replica-S> | postmaster | LOG | received fast shutdown request
2026-11-10T09:27:46.699000 | <replica-S> | client backend | FATAL | terminating connection due to administrator command
2026-11-10T09:27:46.701000 | <replica-S> | client backend | FATAL | terminating connection due to administrator command
2026-11-10T09:29:54.271000 | <replica-S> | startup | FATAL | could not extend file "base/5/17617.3": No space left on device
2026-11-10T09:29:54.326000 | <replica-S> | postmaster | LOG | terminating any other active server processes
2026-11-10T09:33:03.208000 | <ref-S> | walsender | LOG | starting logical decoding for slot "rr10_sub_b"
2026-11-10T09:33:03.255000 | <ref-S> | walsender | LOG | starting logical decoding for slot "rr10_sub_a"
2026-11-10T09:33:03.298000 | <ref-S> | walsender | ERROR | replication slot "pg_17650_sync_17643_7703759698107299042" already exists
2026-11-10T09:34:44.602000 | <ref-S> | walsender | LOG | starting logical decoding for slot "pg_17650_sync_17643_7703759698107299042"
2026-11-10T09:34:54.015000 | <ref-S> | walsender | ERROR | replication slot "pg_17650_sync_17643_7703759698107299042" does not exist
2026-11-10T09:34:55.094000 | <ref-S> | walsender | ERROR | replication slot "pg_17650_sync_17643_7703759698107299042" does not exist
2026-11-10T09:35:00.146000 | <ref-S> | walsender | ERROR | replication slot "pg_17650_sync_17643_7703759698107299042" does not exist
2026-11-10T09:35:05.187000 | <ref-S> | walsender | ERROR | replication slot "pg_17650_sync_17643_7703759698107299042" does not exist
2026-11-10T09:35:10.230000 | <ref-S> | walsender | ERROR | replication slot "pg_17650_sync_17643_7703759698107299042" does not exist
2026-11-10T09:35:15.276000 | <ref-S> | walsender | ERROR | replication slot "pg_17650_sync_17643_7703759698107299042" does not exist
2026-11-10T09:35:20.317000 | <ref-S> | walsender | ERROR | replication slot "pg_17650_sync_17643_7703759698107299042" does not exist
2026-11-10T09:35:25.721000 | <ref-S> | walsender | ERROR | replication slot "pg_17650_sync_17643_7703759698107299042" does not exist
2026-11-10T09:35:30.769000 | <ref-S> | walsender | ERROR | replication slot "pg_17650_sync_17643_7703759698107299042" does not exist
2026-11-10T09:35:35.810000 | <ref-S> | walsender | ERROR | replication slot "pg_17650_sync_17643_7703759698107299042" does not exist
2026-11-10T09:35:40.853000 | <ref-S> | walsender | ERROR | replication slot "pg_17650_sync_17643_7703759698107299042" does not exist
2026-11-10T09:35:45.895000 | <ref-S> | walsender | ERROR | replication slot "pg_17650_sync_17643_7703759698107299042" does not exist
2026-11-10T09:35:50.938000 | <ref-S> | walsender | ERROR | replication slot "pg_17650_sync_17643_7703759698107299042" does not exist
2026-11-10T09:35:55.985000 | <ref-S> | walsender | ERROR | replication slot "pg_17650_sync_17643_7703759698107299042" does not exist
2026-11-10T09:36:01.033000 | <ref-S> | walsender | ERROR | replication slot "pg_17650_sync_17643_7703759698107299042" does not exist
2026-11-10T09:36:06.080000 | <ref-S> | walsender | ERROR | replication slot "pg_17650_sync_17643_7703759698107299042" does not exist
2026-11-10T09:36:11.124000 | <ref-S> | walsender | ERROR | replication slot "pg_17650_sync_17643_7703759698107299042" does not exist
2026-11-10T09:36:16.182000 | <ref-S> | walsender | ERROR | replication slot "pg_17650_sync_17643_7703759698107299042" does not exist
2026-11-10T09:36:21.227000 | <ref-S> | walsender | ERROR | replication slot "pg_17650_sync_17643_7703759698107299042" does not exist
2026-11-10T09:36:26.272000 | <ref-S> | walsender | ERROR | replication slot "pg_17650_sync_17643_7703759698107299042" does not exist
2026-11-10T09:36:31.314000 | <ref-S> | walsender | ERROR | replication slot "pg_17650_sync_17643_7703759698107299042" does not exist
2026-11-10T09:36:36.363000 | <ref-S> | walsender | ERROR | replication slot "pg_17650_sync_17643_7703759698107299042" does not exist
2026-11-10T09:36:41.408000 | <ref-S> | walsender | ERROR | replication slot "pg_17650_sync_17643_7703759698107299042" does not exist
2026-11-10T09:36:46.518000 | <ref-S> | walsender | ERROR | replication slot "pg_17650_sync_17643_7703759698107299042" does not exist
2026-11-10T09:36:51.560000 | <ref-S> | walsender | ERROR | replication slot "pg_17650_sync_17643_7703759698107299042" does not exist
2026-11-10T09:36:56.605000 | <ref-S> | walsender | ERROR | replication slot "pg_17650_sync_17643_7703759698107299042" does not exist
2026-11-10T09:37:01.651000 | <ref-S> | walsender | ERROR | replication slot "pg_17650_sync_17643_7703759698107299042" does not exist
2026-11-10T09:37:06.699000 | <ref-S> | walsender | ERROR | replication slot "pg_17650_sync_17643_7703759698107299042" does not exist
2026-11-10T09:37:11.745000 | <ref-S> | walsender | ERROR | replication slot "pg_17650_sync_17643_7703759698107299042" does not exist
2026-11-10T09:37:16.796000 | <ref-S> | walsender | ERROR | replication slot "pg_17650_sync_17643_7703759698107299042" does not exist
2026-11-10T09:37:21.852000 | <ref-S> | walsender | ERROR | replication slot "pg_17650_sync_17643_7703759698107299042" does not exist
2026-11-10T09:37:26.896000 | <ref-S> | walsender | ERROR | replication slot "pg_17650_sync_17643_7703759698107299042" does not exist
2026-11-10T09:37:31.940000 | <ref-S> | walsender | ERROR | replication slot "pg_17650_sync_17643_7703759698107299042" does not exist
2026-11-10T09:37:36.984000 | <ref-S> | walsender | ERROR | replication slot "pg_17650_sync_17643_7703759698107299042" does not exist
2026-11-10T09:37:42.028000 | <ref-S> | walsender | ERROR | replication slot "pg_17650_sync_17643_7703759698107299042" does not exist
2026-11-10T09:37:47.074000 | <ref-S> | walsender | ERROR | replication slot "pg_17650_sync_17643_7703759698107299042" does not exist
2026-11-10T09:37:52.116000 | <ref-S> | walsender | ERROR | replication slot "pg_17650_sync_17643_7703759698107299042" does not exist
2026-11-10T09:37:57.161000 | <ref-S> | walsender | ERROR | replication slot "pg_17650_sync_17643_7703759698107299042" does not exist
2026-11-10T09:38:02.204000 | <ref-S> | walsender | ERROR | replication slot "pg_17650_sync_17643_7703759698107299042" does not exist
2026-11-10T09:38:07.244000 | <ref-S> | walsender | ERROR | replication slot "pg_17650_sync_17643_7703759698107299042" does not exist
2026-11-10T09:38:12.282000 | <ref-S> | walsender | ERROR | replication slot "pg_17650_sync_17643_7703759698107299042" does not exist
2026-11-10T09:38:17.329000 | <ref-S> | walsender | ERROR | replication slot "pg_17650_sync_17643_7703759698107299042" does not exist
2026-11-10T09:38:22.372000 | <ref-S> | walsender | ERROR | replication slot "pg_17650_sync_17643_7703759698107299042" does not exist
2026-11-10T09:38:27.422000 | <ref-S> | walsender | ERROR | replication slot "pg_17650_sync_17643_7703759698107299042" does not exist
2026-11-10T09:38:32.471000 | <ref-S> | walsender | ERROR | replication slot "pg_17650_sync_17643_7703759698107299042" does not exist
2026-11-10T09:38:37.514000 | <ref-S> | walsender | ERROR | replication slot "pg_17650_sync_17643_7703759698107299042" does not exist
== A 09:28-09:37 (crash and first slot error)
2026-11-10T09:31:20.794000 | <replica-A> | client backend | ERROR | relation "realtime.subscription" does not exist
2026-11-10T09:32:16.398000 | <replica-A> | postmaster | LOG | received fast shutdown request
2026-11-10T09:32:16.403000 | <replica-A> | client backend | FATAL | terminating connection due to administrator command
2026-11-10T09:32:16.404000 | <replica-A> | client backend | FATAL | terminating connection due to administrator command
2026-11-10T09:32:48.745000 | <replica-A> | postmaster | LOG | received fast shutdown request
2026-11-10T09:32:48.751000 | <replica-A> | client backend | FATAL | terminating connection due to administrator command
2026-11-10T09:35:09.355000 | <replica-A> | startup | FATAL | could not extend file "base/5/17643.3": No space left on device
2026-11-10T09:35:09.356000 | <replica-A> | walreceiver | FATAL | could not write to file "pg_wal/xlogtemp.5430": No space left on device
2026-11-10T09:35:09.404000 | <replica-A> | postmaster | LOG | terminating any other active server processes
```

## system_identifier, subscription and table OIDs (probe 5)

```
s: [{"sysid":"7703759990361338896","subs":null,"rel":"17617","n":4000000}]
a: [{"sysid":"7703759698107299042","subs":"17650:rr10_sub_a","rel":"17643","n":4000000}]
b: [{"sysid":"7703759698107299042","subs":"17650:rr10_sub_b","rel":"17643","n":4000000}]
```

## A separate Postgres 17 project, created about 10:15 UTC and deleted at once

```
[{"sysid":"7703759698107299042","v":"17.11","maxoid":"17634"}]
```

## B: backups endpoint, read by hand at 10:48 UTC (35 minutes after the replica setup)

```
{"pitr_enabled":true,"walg_enabled":true,"n":0,"latest":{"earliest_physical_backup_date_unix":1794301788,"latest_physical_backup_date_unix":1794305682}}
(jq projection: n = length of `backups`; latest = the response field `physical_backup_data`)
pooler entries: PRIMARY only
```
