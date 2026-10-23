# Console excerpts (sampler log lines; project refs and hosts removed). Times are sampler offsets (Date.now() - t0).

## Medium C, D03 (artifact run-2026-10-23T01-55-35-451Z): last lines before the gap, then the first after
  rest_read down at +37860ms: HTTP 521
  auth down at +38035ms: HTTP 521
  realtime_join down at +38174ms: pg_changes: {:error, "Too many database timeouts"}
  storage down at +38354ms: HTTP 500
  rest_read down at +38406ms: HTTP 521
  auth down at +38557ms: HTTP 521
  realtime_join down at +38756ms: pg_changes: {:error, "Too many database timeouts"}
  storage down at +38883ms: HTTP 500
  rest_read down at +38923ms: HTTP 521
  pooler down at +34069ms: timeout expired
  auth down at +39078ms: HTTP 521
  rest_http down at +39153ms: The operation timed out.
  auth recovered at +300805ms
  rest_read recovered at +300805ms
  pooler recovered at +300805ms
  realtime_join recovered at +300804ms
  storage recovered at +300805ms
  rest_http recovered at +301307ms
  -> pass: outage on rest_http 262s, auth 299s, storage 299s, rest_read 299s, realtime_join 298s, pooler 298s

## Medium C, D04: first lines
[D04] Resize down (-> ci_medium): outage per connection path (destructive)
  data-path probes ready after 4s; pooler <pooler>
  compute -> ci_medium: HTTP 200
  storage down at +40447ms: HTTP 500
  rest_read down at +40447ms: HTTP 521
  auth down at +40447ms: HTTP 521
  storage down at +42236ms: HTTP 500

## Extra Micro pass (no artifact), D03: 100 s to the end of the log
  pooler down at +101280ms: (EAUTHQUERY) auth_query secret check timed out
  pooler down at +102827ms: (ECIRCUITBREAKER) failed to retrieve database credentials after multiple attempt
  storage down at +100066ms: The operation timed out.
  pooler down at +103369ms: Failed to connect to database: {:error, :timeout}
  rest_read down at +105096ms: timeout
  auth down at +105381ms: The operation timed out.
  storage down at +105571ms: The operation timed out.
  rest_read down at +110599ms: timeout
  pooler down at +108781ms: Failed to connect to database: {:error, :timeout}
  auth down at +110884ms: The operation timed out.
  storage down at +111076ms: The operation timed out.
  realtime_join down at +107566ms: timeout at pg_changes
  rest_read down at +116102ms: timeout
  auth down at +116387ms: The operation timed out.
  storage down at +116578ms: The operation timed out.
  realtime_join down at +118072ms: timeout at pg_changes
  rest_read down at +121609ms: timeout
  auth down at +121892ms: The operation timed out.
  rest_http down at +121895ms: The operation timed out.
  storage down at +122081ms: The operation timed out.
  rest_read down at +187250ms: timeout
  storage down at +187250ms: The operation timed out.
  auth down at +187250ms: The operation timed out.
  rest_http recovered at +187250ms
  realtime_join down at +187248ms: timeout at pg_changes
  auth down at +192755ms: The operation timed out.
  storage down at +192755ms: The operation timed out.
  rest_read down at +192754ms: timeout
  rest_read down at +198259ms: timeout
  storage down at +198259ms: The operation timed out.
  auth down at +198259ms: The operation timed out.
  realtime_join down at +197752ms: timeout at pg_changes
  rest_read down at +203760ms: timeout
  auth down at +203760ms: The operation timed out.
  storage down at +203760ms: The operation timed out.
  storage down at +209264ms: The operation timed out.
  rest_read down at +209263ms: timeout
  auth down at +209263ms: The operation timed out.
  realtime_join down at +208254ms: timeout at pg_changes
  rest_read down at +214767ms: timeout
  auth down at +214767ms: The operation timed out.
  storage down at +214766ms: The operation timed out.
  storage down at +220270ms: The operation timed out.
  rest_read down at +220270ms: timeout
  auth down at +220270ms: The operation timed out.
  realtime_join down at +218754ms: timeout at pg_changes
  storage down at +225774ms: The operation timed out.
  auth down at +225774ms: The operation timed out.
  rest_read down at +225774ms: timeout
  storage down at +231278ms: The operation timed out.
  rest_read down at +231278ms: timeout
  auth down at +231278ms: The operation timed out.
  realtime_join down at +229258ms: timeout at pg_changes
  auth down at +236782ms: The operation timed out.
  rest_read down at +236782ms: timeout
  storage down at +236782ms: The operation timed out.
  rest_read down at +242286ms: timeout
  storage down at +242287ms: The operation timed out.
  auth down at +242286ms: The operation timed out.
  rest_read down at +247791ms: HTTP 521
  auth down at +247791ms: HTTP 521
  rest_read down at +248324ms: HTTP 521
  auth down at +248353ms: HTTP 521
  rest_read down at +248850ms: HTTP 521
  auth down at +248896ms: HTTP 521
  realtime_join down at +239762ms: timeout at pg_changes
  rest_read down at +249400ms: HTTP 503 PGRST002
  storage down at +247791ms: The operation timed out.
  auth recovered at +249424ms
  rest_read recovered at +250712ms
  realtime_join recovered at +250266ms
  storage recovered at +253296ms
  rest_read down at +263111ms: HTTP 521
  auth down at +263280ms: HTTP 521
  rest_read down at +263667ms: HTTP 521
  auth down at +263901ms: HTTP 521
  rest_read down at +264190ms: HTTP 521
  auth down at +264425ms: HTTP 521
  rest_read down at +264730ms: HTTP 521

## Extra Micro pass: last line per path
  rest_http recovered at +187250ms
  auth down at +264425ms: HTTP 521
  storage recovered at +253296ms
  rest_read down at +264730ms: HTTP 521
  realtime_join recovered at +250266ms
  pooler down at +108781ms: Failed to connect to database: {:error, :timeout}
