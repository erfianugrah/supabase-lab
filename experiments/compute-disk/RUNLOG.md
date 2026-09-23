# RUNLOG - experiments/compute-disk

One project per module, self-provisioning (no tofu), Pro/Team/Free orgs.
Reference: COMPUTE-DISK.md at repo root. Probes: `.pi/probe-compute-disk.sh D01[,...]`.

## Findings, by module

- D01 (pg_limits micro vs small): resize settled 107 s. micro/max_connections
  60, small 90; slots 10/10, senders 10/10; shared_buffers 256/512 MB.
- D02 (disk semantics): decrease rejected HTTP 400; increase accepted 201.
- D03 (quota): 429 "Database disk can only be modified once per four hours.
  Last modified at ..." - the doc's "4 per rolling 24h" and runtime disagree;
  enforcement appeared nondeterministic across runs (a first 5-mod burst was
  accepted, before and after).
- D04 (autoscale surface, Pro): GET returns an empty shape; PUT/POST/PATCH
  404 - no public mutation surface.
- D05 (free-org disk): baseline 2GB (docs claim 1GB); disk did not grow
  during a 726MB db fill.
- D06 (free read-only): kicked at ~726MB (docs claim 500MB) with
  `ERROR: 25006: cannot execute INSERT in a read-only transaction`. SELECT
  still answers on the management query endpoint (201).
- D06b (recovery): TRUNCATE rejected in read-only; DELETE+vacuum needed.
- D07 (autoscale surface, Team): identical gap to D04.
- D08 (IOPS/throughput gate): POST config/disk accepted AND verified applied
  on Micro (the dashboard's "LARGE required" text is a UI gate only).
- D09 (resize/downgrade timing with 250ms sampling, local vantage):
  upgrade micro->small 105s (max contiguous REST outage 1.0s), upgrade
  small->large 61s (17.0s), downgrade large->small 61s (0s), downgrade
  small->micro 73s (0s); Auth /auth/v1/health showed no contiguous outage in
  any op. Adjacent resize PATCHes are rate-limited: 429
  `We are still processing addon changes, please try again in N minute(s)`.

## Operational notes

- The free-org module borders on the util endpoint: selects return 200, so
  `/config/disk/util` is available on free (check D05 measurements).
- Probe mapping: result ids D01..D09 live in modules D01, D02, D04, D05, D08
  - the probe maps result->module before passing --only.
- The first fill round ran a 5-mod disk increase burst without triggering
  the quota; the second round caught the cooldown on the second attempt.
  Recorded as nondeterministic, not a clean pass/fail.

## 2026-09-23 - the disk write accepts autoscale fields and silently discards them

Prompted by a customer asking whether the Advanced Disk Settings cap can be set
programmatically, so that automatic growth cannot bill them without approval.
Curl replay against a throwaway nano project on a platform-plan org, STAGING
control plane, created and deleted for the run.

- **No write verb exists on the autoscale route.** `PATCH`, `PUT`, `POST` and
  `DELETE` on `/config/disk/autoscale` all answer
  `404 {"message":"Cannot <VERB> /v1/projects/<ref>/config/disk/autoscale"}` -
  the same shape an entirely unknown path returns, checked as a control
  (`PATCH /config/disk/nonesuch`). `GET` answers `200` with
  `{"growth_percent":null,"min_increment_gb":null,"max_size_gb":null}`.
  This replicates the D04/D07 reading on Pro and Team, now on a third org
  class and a second control plane.
- **The documented disk write accepts autoscale fields and ignores them.**
  `POST /config/disk` with a full valid `attributes` object plus autoscale keys
  answers `201` in every shape tried - keys inside `attributes`, keys at the
  top level, and a nested `autoscale` object. `GET /config/disk/autoscale` still
  reads all-null after a 60 s settle. So a caller who reaches for the obvious
  workaround gets a success code and no effect, which is a worse failure than
  the 404: nothing tells them the cap was not applied.
- Getting there needs the full attribute set. A partial body is rejected on the
  missing field rather than on the autoscale keys (`attributes.type: Invalid
  discriminator value. Expected 'gp3' | 'io2'`, then `attributes.iops: Invalid
  input: expected number, received undefined`), so a probe that stops at the
  first 400 concludes "rejected" when the real answer is "accepted and
  discarded".

Consequence for anyone billing on provisioned capacity: there is no API lever
to cap growth, and no error to detect a failed attempt. The readable half is
the mitigation - `GET /config/disk/autoscale` and `GET /config/disk/util` are
both per-project reads, so utilisation can be polled and capacity raised
deliberately with `POST /config/disk` after approval. That does not stop
autoscale firing between polls.
