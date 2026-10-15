# logs-volume

How much log content a project produces per client action, by log source, and
what the customer-settable Postgres logging knobs add. Logs ingest is a metered
dimension (https://supabase.com/docs/guides/platform/manage-your-usage/logs-ingest).
The levers measured here are Postgres settings, Edge Function console output,
the Auth call used (`getUser` vs `getClaims`) and request count.

Self-provisioning: every module creates its own `lv-` project on a Pro
organization (`PVLAB_ORG_PRO`) and deletes it in `finally`. No OpenTofu state.
Measured values, their vantage and the size caveat are in `RUNLOG.md`.

Size is a proxy. Metered ingest bytes are not readable with a PAT
(observability-surface OB03c), so modules report rows and the length of each
row's `event_message` plus its `log_attributes` keys and values, as returned by
the logs endpoint. Compare actions with it; do not read it as billed GB.

## Modules

| id | question | runtime |
|---|---|---|
| LV01 | rows and size per action, per source: idle background, REST GET, single vs bulk insert, Edge Function with 0 / 1 / 10 console lines, `getUser` vs `getClaims`, repeated public Storage GET (cache hits), Realtime broadcast messages and an idle subscription | ~25-28 min, one project |
| LV02 | `postgres_logs` added per REST request and per SQL statement (pooler and direct sessions) by `log_statement` (on `postgres`, `authenticator`, `anon`), `log_min_duration_statement` (on `postgres`, `authenticator`) and `pgaudit.log` (on `postgres`); `RAISE NOTICE` vs `RAISE LOG` in an RPC at defaults; whether `reset all` clears a role setting | ~14-17 min, one project |

## Run

```bash
# secrets injected per command, never exported: SUPABASE_ACCESS_TOKEN, PVLAB_ORG_PRO
make -C experiments/logs-volume probe IDS=LV01      # LV01_N, LV01_IDLE_S
make -C experiments/logs-volume probe IDS=LV02      # LV02_WORK; the direct path needs IPv6
make -C experiments/logs-volume cleanup             # deletes any project named lv-*
```

Raw run artifacts go to `evidence/<stamp>/` (gitignored: they carry project
refs).

## Layout

- `tests/lv0*.ts` - the modules; each header names the claim, the vantage and
  what it does not settle.
- `lib/lv.ts` - phase windows, the per-source footprint query and size proxy,
  a `postgres`-role pooler session and a direct session. Provisioning is
  observability-surface's `makeProject` with the `lv-` prefix.
