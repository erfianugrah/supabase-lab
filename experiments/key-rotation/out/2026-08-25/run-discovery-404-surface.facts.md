# Facts from key-rotation - 2026-08-25 04:52:05 UTC

Source artifact: run started 2026-08-25T04:52:05.014Z, finished 2026-08-25T04:52:08.917Z, vantage local, region ap-southeast-1, lab commit 3b5a109. Project ref omitted on purpose.

## R01a - Initial signing keys (fail)

| key | value |
|---|---|
| initial_count | 0 |

detail: 0 key(s):

## R01b - First create attempt - rate limited (fail)

| key | value |
|---|---|
| http_status | 404 |
| has_deadline | false |

detail: unexpected: HTTP 404 ""

## R01c - Standby key after first attempt (fail)

| key | value |
|---|---|
| standby_exists | false |
| key_count | 0 |

detail: no standby key and no rate-limit message

## R02a - Spoke trusts the hub issuer (pass)

| key | value |
|---|---|
| status | 201 |

detail: create HTTP 201, id=b5f1c0c6-dac

## R02z - hub login (fail)

_no measurements_

detail: pre-rotation login failed: HTTP 400

## R03z - active key (fail)

_no measurements_

detail: no active signing key found. Keys:
