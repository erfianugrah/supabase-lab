# SFP Coverage Closure - Tracking & Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or implement this plan task-by-task in-session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every documentation error and measurement gap found in the 2026-08-25 SFP review across supabase-lab, erfibase, and lexicanum, so the corpus carries one consistent, fully-measured model of the `platform` plan.

**Architecture:** Three repos, five phases. Phase 1 reconciles lexicanum prose with its own evidence tables (pins-first TDD: forbid the stale strings, require the corrected ones, then edit until green). Phase 2 fixes erfibase count drift. Phase 3 brings sfp-platforms up to the lab's own hygiene bar (RUNLOG, root-README link, committed artifacts, A/B runner). Phase 4 runs the token-gated live measurements that close the unproven claims. Phase 5 is track-only (upstream doc reports, entitlement asks).

**Tech Stack:** Bun (lexicanum pins tests, pvlab harness), bash + jq (probes), OpenTofu (key-rotation), Supabase Management API.

**Credentials:** Phase 4 needs `SUPABASE_ACCESS_TOKEN` (a PAT covering the platform-plan org AND a Pro control org) exported in the shell - never committed, never written to a file. Org slugs go in `PVLAB_ORG_SLUGS`. The key-rotation task additionally needs `make secrets-decrypt` at the repo root (SOPS/age - do not print the key or the decrypted file).

---

## Tracking ledger

Every finding from the 2026-08-25 review. Status values: `open`, `in-plan` (has a task below), `track-only` (not actionable in these repos), `parked-by-design` (deliberate, labelled in the source doc).

| id | finding | where | task | status |
|---|---|---|---|---|
| L1 | platform-management-api.mdx carries pre-correction SfP framing (L105-109, footnote) | lexicanum | T2 | DONE 2026-08-25 |
| L2 | org-consolidation.mdx prose contradicts its evidence table twice (L304, L347-352) | lexicanum | T3 | DONE 2026-08-25 |
| L3 | shared-tenancy.mdx lede asserts "cannot be paused" unqualified vs measured row L371 | lexicanum | T4 | DONE 2026-08-25 |
| L4 | placement doc provenance paragraph omits 2026-08-24 ("five dates") | lexicanum | T5 | DONE 2026-08-25 |
| L5 | platform-management-api.mdx has no pins.test.ts entry | lexicanum | T1 | DONE 2026-08-25 |
| D1 | hand-rolled-sfp claim count drift: 34 (erfibase README, tenancy note) / 43 (lab README) / 51 (claims.json, actual) | erfibase | T7 | DONE 2026-08-25 |
| D2 | org-topology headline says 60 claims / 49 proven; claims.json holds 65 / 51 | erfibase | T7 | DONE 2026-08-25 |
| D3 | one private account doc carries two conflicting fleet-size figures | private corpus | - | track-only (reconcile on next touch) |
| H1 | sfp-platforms has no RUNLOG.md (only experiment without one) | supabase-lab | T8 | DONE 2026-08-25 |
| H2 | sfp-platforms not linked from root README | supabase-lab | T9 | DONE 2026-08-25 |
| H3 | no committed run artifacts (numbers live only in README prose) | supabase-lab | T10, T13 | DONE 2026-08-25 (control-arm artifacts + status diffs; platform-arm raw artifacts stay off-repo) |
| H4 | Pro-org control arm is manual; no committed A/B runner or diff | supabase-lab | T10, T13 | DONE 2026-08-25 (`run-ab.sh`, per-arm tokens + control-plane overrides) |
| M1 | S14 unproven: does `secret_jwt_template` reach the exchanged token (data-plane bearer test never implemented; `key_hash` stub) | supabase-lab | T11 | DONE 2026-08-25 - claims DO reach the exchanged token on BOTH org classes (`role_bound: 1`, `tenant_claim_present: 1`); create response redacts the key without `?reveal=true`; PostgREST schema-cache reload needed |
| M2 | S08 grow never confirmed to land (`size_gb_after` not recorded in README) | supabase-lab | T12 | DONE 2026-08-25 - grow to 8GB confirmed landed |
| M3 | read-replicas gate unidentified (400 despite `instances.read_replicas: true`) | supabase-lab | T14 | DONE 2026-08-25 - gate is the compute floor (`"minimum size of small"`, identical both org classes; nano default sits below it), then completed-physical-backup; PITR enable on the platform org is its own entitlement boundary |
| M4 | key-rotation port (R01-R03) never run live | supabase-lab | T15 | DONE 2026-08-25 - full-window live run. Two port bugs fixed (signing keys live on the Management API `/config/auth/signing-keys`, not GoTrue admin; doubled `/admin/admin/users` path). Findings: standby create NOT rate-limited (constraint is one-standby-at-a-time `422`); G30/G36 reproduced (spoke cache never re-resolved, 116 probes/20 min); STRONGER G33 - a fresh integration serves the stale kid set even with a current issuer JWKS. G31's exact scenario needs a dedicated future run (module ordering confounded it). Projects destroyed, zero leaks |
| M5 | restore points 400 on this org; undo semantics never exercised (S01c/d, S03) | supabase-lab | T16 | blocked on entitlement enablement |
| M6 | OAuth BYO-backend bridge 404 on both org classes (S05 never saw a claim/transfer) | supabase-lab | T16 | blocked on entitlement enablement |
| M7 | G37: per-tenant backup, Storage half unproven | erfibase | - | parked-by-design (objects aren't rows) |
| M8 | OAuth/SAML identity promotion untested; G7 needs custom access token hook; G34 unexplained | erfibase | - | parked-by-design |
| M9 | scale / noisy-neighbour / amortization | both | - | parked-by-design ("out of reach, not pending") |
| U1 | Nano vs Pico naming (integration doc vs launch blog) | upstream | T17 | track-only |
| U2 | "paid projects cannot be paused" mis-scoped (platform orgs pause on demand) | upstream | T17 | track-only |
| U3 | clone doc self-contradicts on extensions; clone pg_cron fires within ~6 min | upstream | T17 | track-only |
| U4 | signing-keys doc: "revocation is automatic" false for third-party consumers in cache window | upstream | T17 | track-only |
| U5 | migrations endpoint "contact us" framing overstates gating (200 on Pro) | upstream | T17 | track-only |
| U6 | region-migration guide never mentions the pgsodium root key | upstream + lexicanum | T17 | lexicanum half ALREADY COVERED (region-migration-e2e "Vault secrets: move the encryption root key, or lose them", with the /pgsodium endpoint); only the upstream supabase.com docs report remains |
| P1 | externally-blocked platform questions (backup entitlement for platform-plan nano, pause-restore latency distribution, metering idle-tail confirmation, restore-expiry override scope, cron pricing-eligibility ruling, creation rate-limit ask, per-project usage export) | private corpus | - | track-only (owned there) |

---

## Phase 1 - lexicanum reconciliation (no tokens needed)

Repo: `/home/erfi/lexicanum`. Test command: `bun test tests/pins.test.ts`. Corpus style: ASCII `-`, no em-dashes, bold for emphasis.

### Task 1: Pins first (the failing tests)

**Satisfies:** L5, and locks in L1-L4's corrections.

**Files:**
- Modify: `/home/erfi/lexicanum/tests/pins.test.ts`

- [ ] **Step 1: Add the doc constant**

After line 44 (`const MULTITENANT = ...`), add:

```ts
const PLATFORM_MGMT = "guides/supabase-platform-management-api";
```

- [ ] **Step 2: Add a new pin entry for PLATFORM_MGMT**

Insert into the pins array (alongside the CONSOLIDATION entry at ~L312), matching the existing object shape:

```ts
{
  doc: PLATFORM_MGMT,
  // The 2026-08-24 platform-plan correction: nano is the plan's create
  // default, not a gated catalogue variant. The pre-correction framing
  // ("Nano-only and gated") is forbidden so it cannot drift back in.
  mustContain: ["the platform plan's create default"],
  mustNotContain: ["Scale-to-zero pricing is Nano-only and gated"],
  linksTo: [MULTITENANT],
},
```

- [ ] **Step 3: Extend the CONSOLIDATION entry**

In the existing `{ doc: CONSOLIDATION, ... }` entry, add a `mustContain` key and extend `mustNotContain`:

```ts
mustContain: ["provisions Nano by default", "accepted and echoed"],
mustNotContain: [
  "Consolidating Supabase accounts into one organization",
  "we could not test it on this account",
  "That is untested here and is",
],
```

- [ ] **Step 4: Extend the SHARED entry**

In `{ doc: SHARED, ... }` (~L329), append to `mustContain`: `"the exception (the `platform` plan"` and add to its `mustNotContain` array: `"project on a paid plan cannot be paused."` (with the trailing period - the qualified replacement keeps the phrase but continues the sentence).

- [ ] **Step 5: Extend the MULTITENANT entry**

Append `"six dates"` to its `mustContain` array and `"They span five dates"` to its `mustNotContain` array.

- [ ] **Step 6: Run tests to verify the new pins fail**

Run: `cd /home/erfi/lexicanum && bun test tests/pins.test.ts`
Expected: FAIL - PLATFORM_MGMT mustContain missing; CONSOLIDATION/SHARED/MULTITENANT mustNotContain violations (the stale strings are still present).

### Task 2: platform-management-api.mdx - carry the correction (L1)

**Files:**
- Modify: `/home/erfi/lexicanum/src/content/docs/guides/supabase-platform-management-api.mdx:105-109` and the `[^sfp]` footnote (~L266)

- [ ] **Step 1: Replace the stale paragraph (exact current text, lines 105-109)**

Old:

```
Scale-to-zero pricing is Nano-only and gated (the Supabase for Platforms
programme[^sfp]) - on a normal paid org there is no idle discount, which is
the cost premise the
[tenant placement doc](/reference/supabase-multi-tenant-placement/) is built
on.
```

New:

```
Scale-to-zero economics are part of the Supabase for Platforms
programme[^sfp]. Measured 2026-08-24: an SfP organization is the `platform`
plan, and Nano is the platform plan's create default - the SfP-prescribed
create (no `desired_instance_size`) provisions `infra_compute_size: nano`
(224MB `shared_buffers`) and the project can pause. Nano is not a select or
resize target on any plan. On a normal paid org there is no idle discount,
which is the cost premise the
[tenant placement doc](/reference/supabase-multi-tenant-placement/) is built
on.
```

- [ ] **Step 2: Fix the footnote**

Locate it: `rg -n '\[\^sfp\]:' src/content/docs/guides/supabase-platform-management-api.mdx`. In the footnote text, replace the clause `scale-to-zero pricing is Nano-only and gated` with `scale-to-zero is the platform plan's Nano create default (measured 2026-08-24), not a gated catalogue variant`. Keep the existing URL untouched.

- [ ] **Step 3: Run the pins**

Run: `bun test tests/pins.test.ts`
Expected: PLATFORM_MGMT entry now passes both string pins (linksTo already satisfied - the doc links the placement doc in the paragraph above).

### Task 3: org-consolidation.mdx - prose vs evidence table (L2)

**Files:**
- Modify: `/home/erfi/lexicanum/src/content/docs/guides/supabase-org-consolidation.mdx:302-305,347-352`

- [ ] **Step 1: Fix the `secret_jwt_template` sentence (current lines 302-305)**

Old (tail of the paragraph):

```
is at the data plane, not here: `POST /v1/projects/{ref}/api-keys` accepts a
`secret_jwt_template` binding a secret key to a role. That is untested here and is
not a substitute for Management API scoping.
```

New:

```
is at the data plane, not here: `POST /v1/projects/{ref}/api-keys` accepts a
`secret_jwt_template` binding a secret key to a role. On a platform-plan org the
template is accepted and echoed (`201`, measured 2026-08-24), but the minted key is
opaque, so whether the claims reach the exchanged token is still unverified - and
either way it is not a substitute for Management API scoping.
```

- [ ] **Step 2: Fix the scale-to-zero paragraph (current lines 347-352)**

Old:

```
That refusal is for an explicit `desired_instance_size`. Supabase's platform guidance
is to omit the field entirely to land on Nano, and notes that scale-to-zero pricing
applies to Nano only - Micro and above cannot scale to zero. Access to scale-to-zero
is granted per account rather than being generally available. If your reason for
consolidating is the cost of idle client projects, that is worth asking about before
you optimize around it; we could not test it on this account.
```

New:

```
That refusal is for an explicit `desired_instance_size`. Supabase's platform guidance
is to omit the field entirely to land on Nano, and notes that scale-to-zero pricing
applies to Nano only - Micro and above cannot scale to zero. Access is granted per
account rather than being generally available: on a `platform`-plan org (measured
2026-08-24) the SfP-prescribed create provisions Nano by default and pause is
enforced; on Pro and Team orgs there is no idle discount. If your reason for
consolidating is the cost of idle client projects, that is the programme to ask
about before you optimize around it.
```

- [ ] **Step 3: Run the pins**

Run: `bun test tests/pins.test.ts`
Expected: CONSOLIDATION entry green (stale strings gone, new strings present).

### Task 4: shared-tenancy.mdx - qualify the lede (L3)

**Files:**
- Modify: `/home/erfi/lexicanum/src/content/docs/guides/supabase-shared-tenancy.mdx:15-19` (and the Aside if it repeats the claim - `rg -n "cannot be paused" <file>` to find every instance)

- [ ] **Step 1: Replace the lede sentence (current lines 15-19)**

Old:

```
If you give each of your end-users a backend - an app builder, a per-customer
workspace, a low-code tool - the obvious move is one Supabase project per tenant. It
isolates cleanly and the Management API provisions one in a call. It also commits you
to roughly \$10/month of compute for every tenant including the idle ones, and a
project on a paid plan cannot be paused.
```

New:

```
If you give each of your end-users a backend - an app builder, a per-customer
workspace, a low-code tool - the obvious move is one Supabase project per tenant. It
isolates cleanly and the Management API provisions one in a call. It also commits you
to roughly \$10/month of compute for every tenant including the idle ones: a
project on a paid plan cannot be paused. The exception (the `platform` plan, where
pausing is enforced and the create default is Nano - measured 2026-08-24) is gated
behind the Supabase for Platforms programme, which is exactly what makes this
architecture the self-service alternative.
```

- [ ] **Step 2: Check the Aside**

Run: `rg -n "cannot be paused" src/content/docs/guides/supabase-shared-tenancy.mdx`. If the Aside repeats the unqualified claim, append ` (platform-plan orgs are the gated exception - see the evidence table)` to that sentence.

- [ ] **Step 3: Run the pins**

Run: `bun test tests/pins.test.ts`
Expected: SHARED entry green. Note the mustNotContain pin is `"project on a paid plan cannot be paused."` WITH trailing period - the new text ends that phrase with a colon-less sentence followed by "The exception", so the exact pinned string (period-terminated) no longer occurs. Verify: `rg -c 'cannot be paused\.' src/content/docs/guides/supabase-shared-tenancy.mdx` returns nothing or only qualified instances.

### Task 5: multi-tenant-placement.mdx - provenance + superseded row (L4)

**Files:**
- Modify: `/home/erfi/lexicanum/src/content/docs/reference/supabase-multi-tenant-placement.mdx:586-595,567`

- [ ] **Step 1: Update the closing provenance paragraph (current lines 586-595)**

Change `They span five dates rather than one:` to `They span six dates rather than one:` and, after `from 2026-08-17/18 - the last four dates in `ap-southeast-1` on Micro compute` insert `, and the platform-plan (SfP) entitlement rows from 2026-08-24, measured on a `platform`-plan org via the self-provisioning sfp-platforms battery`. The full edited sentence reads:

```
_All live measurements were taken on throwaway projects, created and deleted for
the run that produced them. They span six dates rather than one: the cost
figures and Proofs 1-3 are from 2026-07-09 (Postgres 17.6), the trust,
promotion and rotation results from 2026-08-03, the discovery, ref-hiding,
MFA, retirement and provisioning results from 2026-08-04, the Nano,
legacy-pause, smart-region, rate-limit, OAuth-surface and metering results
from 2026-08-17/18 - the last four dates in `ap-southeast-1` on Micro
compute - and the platform-plan (SfP) entitlement rows from 2026-08-24,
measured on a `platform`-plan org via the self-provisioning sfp-platforms
battery. The `for all` policy behaviour noted above was
checked separately on Postgres 17.10. Where a row says documented rather than
measured, it was read from the platform docs on the date given and not executed._
```

- [ ] **Step 2: Annotate the superseded docs-only row (current line 567)**

Append to the end of the row's second cell: ` - partially superseded by the two measured rows below (2026-08-24)`. The row becomes:

```
| SfP is gated, Nano-only scale-to-zero | [supabase-for-platforms](https://supabase.com/docs/guides/integrations/supabase-for-platforms) - partially superseded by the two measured rows below (2026-08-24) |
```

- [ ] **Step 3: Run the full pins suite**

Run: `bun test tests/pins.test.ts`
Expected: ALL entries PASS (MULTITENANT's heavy pin set must survive these edits - if a `mustContain` breaks, the edit clipped a pinned string; restore it).

### Task 6: lexicanum commit

- [ ] **Step 1: Full test + build gate**

Run: `cd /home/erfi/lexicanum && bun test tests --bail`
Expected: PASS.

- [ ] **Step 2: Commit**

```bash
git add tests/pins.test.ts src/content/docs/guides/supabase-platform-management-api.mdx src/content/docs/guides/supabase-org-consolidation.mdx src/content/docs/guides/supabase-shared-tenancy.mdx src/content/docs/reference/supabase-multi-tenant-placement.mdx
git commit -m "docs: carry the 2026-08-24 platform-plan correction into every doc's prose

The nano-default / pausing-enforced finding had landed fully only in the
placement doc; the other three carried it in evidence rows while their prose
said the opposite. Pins now forbid the stale framing. Also: sixth provenance
date, pin coverage for the platform-management-api guide."
```

## Phase 2 - erfibase count drift (no tokens needed)

Repo: `/home/erfi/work/erfibase`.

### Task 7: fix the four claim-count statements (D1, D2)

**Files:**
- Modify: `/home/erfi/work/erfibase/README.md:26`
- Modify: `/home/erfi/work/erfibase/notes/supabase-tenancy-and-trust.md:138`
- Modify: `/home/erfi/work/erfibase/labs/supabase-hand-rolled-sfp/README.md:4`
- Modify: `/home/erfi/work/erfibase/labs/supabase-org-topology/PLAN.md` + `RESULTS.md` (headline counts)

- [ ] **Step 1: Verify the authoritative counts**

```bash
python3 -c "import json;d=json.load(open('/home/erfi/work/erfibase/labs/supabase-hand-rolled-sfp/claims.json'));print('hand-rolled:',len(d['claims']))"
python3 -c "import json;d=json.load(open('/home/erfi/work/erfibase/labs/supabase-org-topology/claims.json'));c=d['claims'] if isinstance(d,dict) else d;print('org-topology:',len(c))"
```

Expected: `hand-rolled: 51`, `org-topology: 65`. If either differs, use the printed number everywhere below.

- [ ] **Step 2: Fix the three hand-rolled counts**

In `README.md:26`: `34 claims in \`claims.json\`` -> `51 claims in \`claims.json\` (G1-G51, no G48)`.
In `notes/supabase-tenancy-and-trust.md:138`: `\`claims.json\` (34 claims)` -> `\`claims.json\` (51 claims)`.
In `labs/supabase-hand-rolled-sfp/README.md:4`: `43 claims` -> `51 claims`.

- [ ] **Step 3: Fix the org-topology headline**

Locate: `rg -n "60 claims|49 " labs/supabase-org-topology/PLAN.md labs/supabase-org-topology/RESULTS.md`. Update the headline counts to `65` claims / `51` empirically proven (re-derive the proven count: `python3 -c "import json;d=json.load(open('labs/supabase-org-topology/claims.json'));c=d['claims'] if isinstance(d,dict) else d;from collections import Counter;print(Counter(x['status'] if 'status' in x else x.get('label') for x in c))"` and use the actual numbers).

- [ ] **Step 4: Verify no stale counts remain, and commit**

```bash
rg -n "34 claims|43 claims|60 claims" README.md notes/ labs/supabase-hand-rolled-sfp/ labs/supabase-org-topology/ && echo "STALE COUNTS REMAIN" || true
git add -u
git commit -m "docs: reconcile claim counts with claims.json (51 hand-rolled, 65 org-topology)"
```

## Phase 3 - supabase-lab hygiene (no tokens needed)

Repo: `/home/erfi/work/supabase-lab`.

### Task 8: RUNLOG.md for sfp-platforms (H1)

**Files:**
- Create: `/home/erfi/work/supabase-lab/experiments/sfp-platforms/RUNLOG.md`

- [ ] **Step 1: Write the runlog**

```markdown
# sfp-platforms RUNLOG

Chronological record of what was actually run. The org under test is supplied
via `PVLAB_ORG_SLUGS`; org slugs are not recorded here (the org classes are).

## 2026-08-24 - initial battery (platform-plan org, ap-southeast-1)

- S01 (13:10-19:39, four revisions): SfP-path create lands on
  `infra_compute_size: nano` (224MB shared_buffers). Three corrections along
  the way: addon shape (`type`/`variants[].id`), read-only query endpoint,
  and the big one - the addon catalogue lists upgrades, not the default, so
  the earlier "nano absent" reading (instance-sizing I01) measured the wrong
  surface. Control arm on a Pro org: default create = micro (256MB).
- S03: restore point `400` - not enabled on this org; undo unreachable (skip).
- S04: migrations `200`; transactional rollback verified; recorded in
  `supabase_migrations.schema_migrations`. Also `200` on a Pro org - NOT
  SfP-gated.
- S05: OAuth project-claim / apps / transfer all `404` - BYO bridge off.
- S06: plan = `platform`; pausing ENFORCED (pause `200` -> INACTIVE,
  restore reverses; Pro org answers `400 not free-tier`); `project_cloning`
  declared but endpoint `404`; realtime 10000 / branching+functions
  unlimited / audit 366d; PITR, private_link, HA off.
- S07: read-replica setup `400` despite `instances.read_replicas: true`.
- S08: disk gp3 2GB/3000 IOPS/125 MiB/s; grow is async (`201` empty);
  gp3 floor makes 2->4GB impossible, first valid grow 6GB+.
- S09: readonly `{enabled:false, override_enabled:false}`; temporary-disable `201`.
- S10: org members: full objects (Owner), not a stub.
- S11: backup schedule `402` structured `entitlement_required`
  (`error.feature=backup.schedule`).
- S12: migration create returns `[]`; version is a `YYYYMMDDHHMMSS` timestamp
  recovered from `supabase_migrations`; GET/PATCH by version `200`.
- S13: branch create `201` (UUID id); delete is top-level
  `DELETE /v1/branches/{id}` `200` (corrected from delete-by-name `404`).
- S14: `secret_jwt_template` accepted + echoed (`201`); minted key opaque
  (`sb_secret_...`) - claim binding NOT yet verified (see 2026-08-2x entry).
- S15: JIT invite `200` (invite_id), delete `200`.

## 2026-08-25 - key-facts consolidation

AGENTS.md gains the validated key-facts section (platform plan = entitlements
tier decoupled from the form-gates and the OAuth bridge).

<!-- Append new runs below: date, org class, module ids, artifact path. -->
```

- [ ] **Step 2: Commit**

```bash
git add experiments/sfp-platforms/RUNLOG.md
git commit -m "docs(sfp-platforms): RUNLOG capturing the 2026-08-24 battery"
```

### Task 9: root README link (H2)

**Files:**
- Modify: `/home/erfi/work/supabase-lab/README.md`

- [ ] **Step 1: Add the experiment link**

Find the experiments list (`rg -n "compute-disk|residency-facts" README.md`) and add, matching the surrounding list format:

```markdown
- [sfp-platforms](experiments/sfp-platforms/) - what a `platform`-plan (SfP) org
  actually unlocks vs Pro, measured: nano is the create default, pausing is
  enforced, migrations are not gated, the OAuth BYO bridge is 404.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs(readme): link the sfp-platforms experiment"
```

### Task 10: A/B runner (H4)

**Files:**
- Create: `/home/erfi/work/supabase-lab/experiments/sfp-platforms/run-ab.sh` (executable)

- [ ] **Step 1: Write the runner**

```bash
#!/usr/bin/env bash
# A/B the sfp-platforms battery across two orgs (platform vs control) and
# emit a side-by-side status/measurement diff. Artifacts land in
# evidence/<ts>/{platform,control}/ so a run is committable.
# Usage: SUPABASE_ACCESS_TOKEN=... ./run-ab.sh <platform-org-slug> <control-org-slug> [S01,S04,...]
set -euo pipefail
PLATFORM="${1:?platform org slug}"
CONTROL="${2:?control org slug}"
IDS="${3:-S01,S03,S04,S05,S06,S07,S08,S09,S10,S11,S12,S13,S14,S15}"
TOK="${SUPABASE_ACCESS_TOKEN:?SUPABASE_ACCESS_TOKEN required}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TS="$(date +%Y%m%d-%H%M%S)"
OUT="$(dirname "$0")/evidence/$TS"
mkdir -p "$OUT/platform" "$OUT/control"

(cd "$ROOT/harness" && bun run build >/dev/null)

for arm in platform control; do
  slug=$([[ "$arm" == platform ]] && echo "$PLATFORM" || echo "$CONTROL")
  echo "== arm: $arm (org: $slug) =="
  SUPABASE_ACCESS_TOKEN="$TOK" PVLAB_ORG_SLUGS="$slug" \
    "$ROOT/harness/dist/pvlab" --where local --experiment sfp-platforms \
    --only "$IDS" --destructive --out "$OUT/$arm" 2>&1 | tail -5
done

PA=$(ls -t "$OUT"/platform/run-*.json | head -1)
CA=$(ls -t "$OUT"/control/run-*.json | head -1)
echo "== diff (id: platform-status/control-status) =="
jq -n --slurpfile p "$PA" --slurpfile c "$CA" -r '
  [$p[0].results[], $c[0].results[]] | group_by(.id)[] |
  {id: .[0].id,
   platform: (map(select(. as $r | $p[0].results | index($r))) | .[0].status // "-"),
   control:  (map(select(. as $r | $c[0].results | index($r))) | .[0].status // "-")} |
  "\(.id)\t\(.platform)\t\(.control)"'
echo "artifacts: $PA / $CA"
```

- [ ] **Step 2: Make executable, sanity-check, commit**

```bash
chmod +x experiments/sfp-platforms/run-ab.sh
bash -n experiments/sfp-platforms/run-ab.sh && echo syntax-ok
git add experiments/sfp-platforms/run-ab.sh
git commit -m "feat(sfp-platforms): A/B runner - platform vs control org, committable artifacts"
```

## Phase 4 - live measurement (TOKEN-GATED - see Credentials note)

Do NOT start this phase until `SUPABASE_ACCESS_TOKEN` and the two org slugs are confirmed. Every module here creates and deletes throwaway projects (billable minutes on the paid/platform orgs).

### Task 11: S14c data-plane claim verification (M1)

**Files:**
- Modify: `/home/erfi/work/supabase-lab/experiments/sfp-platforms/tests/s14-secret-jwt-template.ts:102-143`
- Modify: `/home/erfi/work/supabase-lab/.pi/probe-sfp-platforms.sh:63`

- [ ] **Step 1: Replace the S14c stub with the data-plane exchange probe**

Replace lines 102-143 (from `const key_status = keyRes.status;` through the end of the S14c results.push) with:

```ts
          const key_status = keyRes.status;
          const api_key = (keyRes.json as any)?.api_key;
          let key_prefix = "unknown";
          let key_hash = "unknown";

          if (api_key) {
            key_prefix = api_key.substring(0, 8);
            const buf = await crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(api_key),
            );
            key_hash = [...new Uint8Array(buf)]
              .map((b) => b.toString(16).padStart(2, "0"))
              .join("");
          }

          results.push({
            id: "S14b",
            title: "S14b: mint key",
            status: "info",
            detail: key_status >= 200 && key_status < 300 ? "KEY_CREATED" : "KEY_REJECTED",
            measurements: {
              key_create_status: key_status,
              key_prefix: key_prefix,
              key_hash: key_hash,
            },
            evidence: key_status >= 200 && key_status < 300 ? `key: ${key_prefix}...` : keyRes.text.slice(0, 300),
          });

          // --- S14c: verify binding via the data plane ---
          // The minted key is opaque; the template is applied server-side at
          // key exchange. So exchange it: expose `auth.jwt()` through a
          // SECURITY INVOKER RPC and call it with the minted key as bearer.
          // Whatever claims PostgREST sees ARE the exchanged token.
          if (!api_key) {
            results.push({
              id: "S14c",
              title: "S14c: verify binding",
              status: "skip",
              detail: "no key minted - nothing to exchange",
            });
          } else {
            const fn = await mgmt(ctx, "POST", `/projects/${ref}/database/query`, {
              query:
                "create or replace function public.jwt_probe() returns jsonb " +
                "language sql stable as $$ select coalesce(auth.jwt(), '{}'::jsonb) $$; " +
                "grant execute on function public.jwt_probe() to anon, authenticated;",
            });
            // /database/query answers successful statements with 201, not 200.
            if (fn.status < 200 || fn.status >= 300) {
              results.push({
                id: "S14c",
                title: "S14c: verify binding",
                status: "skip",
                detail: `jwt_probe install failed: HTTP ${fn.status}: ${fn.text.slice(0, 200)}`,
              });
            } else {
              const suffix = ctx.apiHostSuffix ?? "supabase.co";
              const dp = await fetch(`https://${ref}.${suffix}/rest/v1/rpc/jwt_probe`, {
                method: "POST",
                headers: {
                  apikey: api_key,
                  Authorization: `Bearer ${api_key}`,
                  "Content-Type": "application/json",
                },
                body: "{}",
                signal: AbortSignal.timeout(30_000),
              });
              const dpText = await dp.text();
              let claims: Record<string, unknown> = {};
              try { claims = JSON.parse(dpText) as Record<string, unknown>; } catch { /* non-JSON is data */ }
              const role_bound = claims["role"] === "authenticated" ? 1 : 0;
              const tenant_claim_present = claims["tenant_id"] === "probe-tenant" ? 1 : 0;
              results.push({
                id: "S14c",
                title: "S14c: verify binding",
                status: "info",
                detail:
                  dp.status >= 200 && dp.status < 300
                    ? `exchanged token claims: role=${String(claims["role"])} tenant_id=${String(claims["tenant_id"])}`
                    : `data-plane exchange refused: HTTP ${dp.status}`,
                measurements: {
                  data_plane_status: dp.status,
                  role_bound,
                  tenant_claim_present,
                },
                evidence: dpText.slice(0, 300),
              });
            }
          }
```

- [ ] **Step 2: Update the operator probe contract**

In `.pi/probe-sfp-platforms.sh` line 63, change:

```bash
  S14) REQ=( [S14b]=key_create_status [S14c]=role_bound:skip-ok ) ;;
```

to:

```bash
  S14) REQ=( [S14b]=key_create_status [S14c]=data_plane_status:skip-ok ) ;;
```

- [ ] **Step 3: Typecheck**

Run: `cd /home/erfi/work/supabase-lab/harness && bun run build`
Expected: clean build.

- [ ] **Step 4: Run live against the platform org**

```bash
cd /home/erfi/work/supabase-lab
PVLAB_ORG_SLUGS=<platform-org> .pi/probe-sfp-platforms.sh S14
```

Expected: `PROBE PASS: S14`, with S14c carrying `data_plane_status`, `role_bound`, `tenant_claim_present`. Any outcome (1/1, 1/0, 0/0, or a refused exchange) is the finding - record it, do not retry it green.

- [ ] **Step 5: Record + commit**

Update the S14 row in `experiments/sfp-platforms/README.md` (the `secret_jwt_template` line) and append a dated entry to RUNLOG.md with the measured values and the artifact path. Copy the run artifact into `experiments/sfp-platforms/evidence/`.

```bash
git add experiments/sfp-platforms/ .pi/probe-sfp-platforms.sh
git commit -m "feat(sfp-platforms): S14c exchanges the opaque key at the data plane - claim binding measured"
```

### Task 12: S08 grow confirmation (M2)

- [ ] **Step 1: Run S08 live**

```bash
PVLAB_ORG_SLUGS=<platform-org> .pi/probe-sfp-platforms.sh S08
```

- [ ] **Step 2: Record the final size**

Read `size_gb_after` (or the module's grow poll result) from the run artifact:
`jq '.results[] | select(.id=="S08c") | .measurements' <artifact>`. Add the final landed size to the S08 README row (e.g. `grow to 8GB confirmed landed (size_gb_after=8)`) and RUNLOG.md; copy the artifact into `evidence/`. Commit:

```bash
git add experiments/sfp-platforms/
git commit -m "docs(sfp-platforms): S08 grow confirmed landed - size_gb_after recorded"
```

### Task 13: full A/B run with committed artifacts (H3, H4)

- [ ] **Step 1: Run both arms**

```bash
cd /home/erfi/work/supabase-lab/experiments/sfp-platforms
SUPABASE_ACCESS_TOKEN=$SUPABASE_ACCESS_TOKEN ./run-ab.sh <platform-org> <control-org>
```

Expected: two artifacts + a printed diff table. Wall clock is dominated by per-module project provisioning (~2-3 min each, sequential): budget 60-90 min per arm.

- [ ] **Step 2: Commit the artifacts and the diff**

Save the diff table as `evidence/<ts>/AB-DIFF.md` with a one-line header (date, org classes). Commit:

```bash
git add experiments/sfp-platforms/evidence/
git commit -m "feat(sfp-platforms): committed A/B run artifacts (platform vs Pro control)"
```

- [ ] **Step 3: Reconcile the README**

Any README "Measured" row the fresh run contradicts gets corrected in the same commit style as the original corrections (state what the earlier reading measured instead).

### Task 14: read-replicas gate hunt (M3)

**Files:**
- Modify: `/home/erfi/work/supabase-lab/experiments/sfp-platforms/tests/s07-read-replicas.ts`
- Modify: `/home/erfi/work/supabase-lab/.pi/probe-sfp-platforms.sh:56`

- [ ] **Step 1: The documented prerequisites (verified 2026-08-25)**

Per `https://supabase.com/docs/guides/platform/read-replicas/getting-started`, projects must be: (1) on AWS, (2) on at least a Small compute add-on ("Read Replicas are started on the same compute instance as the Primary"), (3) on Postgres 15+, (4) using physical backups (auto-enabled with PITR; switchable during dashboard setup otherwise). So the likely gate on a nano-default platform project is the compute floor and/or logical backups - the entitlement flag is upstream of these infra prerequisites. The ladder below tests compute first (S07d), then PITR-as-physical-backups-switch (S07e). The finding is WHICH prerequisite the `400` maps to, and whether the API error names it.

- [ ] **Step 2: Extend S07 with the hypothesis ladder**

After the existing S07b/S07c rows (keep them - they are the nano-default baseline), add, inside the same try block while the project still exists:

```ts
          // --- S07d: hypothesis - compute floor. Upgrade to the documented
          // minimum size, wait healthy, retry setup. A 4xx is data.
          const up = await mgmt(ctx, "PATCH", `/projects/${ref}/billing/addons`, {
            addon_type: "compute_instance",
            addon_variant: "ci_small",
          });
          if (up.status < 200 || up.status >= 300) {
            results.push({
              id: "S07d",
              title: "S07d: setup after compute upgrade",
              status: "skip",
              detail: `compute upgrade refused: HTTP ${up.status}: ${up.text.slice(0, 200)}`,
            });
          } else {
            await waitHealthy(ctx, ref);
            const setup2 = await mgmt(ctx, "POST", `/projects/${ref}/read-replicas/setup`, {
              read_replica_region: "ap-southeast-1",
            });
            results.push({
              id: "S07d",
              title: "S07d: setup after compute upgrade",
              status: "info",
              detail: setup2.status >= 200 && setup2.status < 300 ? "REPLICA_ACCEPTED" : "STILL_REFUSED",
              measurements: { setup_small_status: setup2.status },
              evidence: setup2.text.slice(0, 300),
            });
            // --- S07e: hypothesis - PITR. Only reachable if S07d refused.
            if (setup2.status >= 400) {
              const pitr = await mgmt(ctx, "PATCH", `/projects/${ref}/billing/addons`, {
                addon_type: "pitr",
                addon_variant: "pitr_7",
              });
              if (pitr.status < 200 || pitr.status >= 300) {
                results.push({
                  id: "S07e",
                  title: "S07e: setup after PITR enable",
                  status: "skip",
                  detail: `pitr enable refused: HTTP ${pitr.status}: ${pitr.text.slice(0, 200)}`,
                });
              } else {
                await waitHealthy(ctx, ref);
                const setup3 = await mgmt(ctx, "POST", `/projects/${ref}/read-replicas/setup`, {
                  read_replica_region: "ap-southeast-1",
                });
                results.push({
                  id: "S07e",
                  title: "S07e: setup after PITR enable",
                  status: "info",
                  detail: setup3.status >= 200 && setup3.status < 300 ? "REPLICA_ACCEPTED" : "STILL_REFUSED",
                  measurements: { setup_pitr_status: setup3.status },
                  evidence: setup3.text.slice(0, 300),
                });
              }
            }
          }
```

Mirror the module's existing ensure/skip backfill for `S07d`/`S07e` in the catch/ensure block, and IMPORTANT: if a replica is accepted at any rung, remove it (`POST /read-replicas/remove` with the replica identifier from the setup/list response) before the finally-delete, so the throwaway project can be deleted.

- [ ] **Step 3: Update the probe contract**

`.pi/probe-sfp-platforms.sh` line 56:

```bash
  S07) REQ=( [S07b]=setup_status [S07c]=remove_status:skip-ok [S07d]=setup_small_status:skip-ok [S07e]=setup_pitr_status:skip-ok ) ;;
```

- [ ] **Step 4: Build, run live, record, commit**

```bash
cd harness && bun run build && cd ..
PVLAB_ORG_SLUGS=<platform-org> .pi/probe-sfp-platforms.sh S07
```

Record which rung (if any) unlocked the endpoint in README + RUNLOG (the finding is the gate's identity, or its continued absence). Commit:

```bash
git add experiments/sfp-platforms/ .pi/probe-sfp-platforms.sh
git commit -m "feat(sfp-platforms): S07 gate hunt - compute-floor and PITR hypotheses measured"
```

### Task 15: key-rotation live run (M4)

Two throwaway projects via OpenTofu, ~1 hour wall clock (the rotation windows are 20 and 15 minutes). Needs `secrets.tfvars` present (`make secrets-decrypt` at repo root - do not print it).

- [ ] **Step 1: Provision**

```bash
cd /home/erfi/work/supabase-lab/experiments/key-rotation
make init && make apply
```

Expected: `hub_ref` and `spoke_ref` outputs.

- [ ] **Step 2: Run R01-R03**

```bash
make probe
```

Expected: evidence dir `evidence/<ts>/` with a run artifact + REPORT.md. All three modules are destructive and slow by design - do not interrupt the rotation windows.

- [ ] **Step 3: ALWAYS destroy**

```bash
make destroy
```

Verify no orphaned projects: list projects on the org and confirm the two refs are gone (this experiment exists because a SIGKILL once leaked two billable projects).

- [ ] **Step 4: Record + close the parked item**

Append the run to `experiments/key-rotation/RUNLOG.md`; commit evidence. Then in `/home/erfi/work/erfibase/labs/supabase-hand-rolled-sfp/CLOSURE-PLAN.md`, mark the "key-rotation port has never run live" parked item closed with the date and artifact path; commit in erfibase.

### Task 16: restore points + OAuth bridge (M5, M6) - BLOCKED

Not token-solvable: both need account-level enablement (restore-points entitlement; OAuth bridge/app registration for the BYO flow). When granted:

- [ ] **Step 1:** Re-run `PVLAB_ORG_SLUGS=<platform-org> .pi/probe-sfp-platforms.sh S03` - S03b/S03c should flip from 400/skip to measured undo semantics (`table_after_undo`).
- [ ] **Step 2:** Re-run `.pi/probe-sfp-platforms.sh S01` (S01c/S01d same flip) and `.pi/probe-sfp-platforms.sh S05` for the claim flow.
- [ ] **Step 3:** Update README rows, RUNLOG, and the lexicanum placement-doc evidence rows that record the 400/404 (add "re-measured <date>" rather than deleting the earlier reading).

## Phase 5 - track-only (T17)

### Task 17: upstream doc reports (U1-U6)

Not fixable in these repos - file each upstream. One note per item, each citing the measured evidence:

- [ ] U1: Nano vs Pico naming - integration doc vs 2025-12-05 launch blog. Evidence: the two published pages themselves.
- [ ] U2: "paid projects cannot be paused" needs scoping to automatic pausing + dashboard; platform orgs pause on demand via `POST /v1/projects/{ref}/pause`. Evidence: S06 (enforced, measured 2026-08-24).
- [ ] U3: clone doc self-contradiction on extensions + clone pg_cron jobs firing within ~6 min. Evidence: hand-rolled G29/G46.
- [ ] U4: signing-keys doc "revocation is automatic" is false for third-party consumers inside the cache window. Evidence: G30/G31/G36 (and T15's live rerun when done).
- [ ] U5: migrations endpoint "contact us" framing overstates gating (200 + rollback on Pro). Evidence: S01b/S04.
- [ ] U6: Supabase's own region-migration/backup docs silent on the pgsodium root key (dump/restore silently loses Vault decryptability). Evidence: org-topology D6. (Lexicanum's own guide already carries the warning + the `/pgsodium` retrieval endpoint - verified 2026-08-25; only the upstream report remains.)

---

## Self-review notes

- Every ledger row maps to a task or an explicit track-only/parked/blocked disposition.
- Task 1's pinned strings match the exact replacement texts in Tasks 2-5 (checked word-for-word).
- Phase 4 code uses only surfaces that exist in the harness today (`mgmt`, `ctx.apiHostSuffix`, `/database/query` 201 semantics, probe REQ table).
- S07d/S07e addon variants (`ci_small`, `pitr_7`) are doc-derived hypotheses - Step 1 of Task 14 verifies them against current docs before the code runs; a refusal is recorded data either way.
- Commit messages carry no AI attribution, per repo policy.
