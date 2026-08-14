# loop plan: build the editorial layer with the local model, judged by kimi-k3

Companion to `2026-08-14-editorial-graph-layer.md` (the work itself). This
document is the loop plan: which models, which sensors, and why.

## Models

- **Agent: `llama-server/loop`** - the local rung: Gemma 4 26B-A4B MoE on the
  5090 via the llm-compose proxy, 196608 ctx (the wide window is load-bearing;
  at 131072 the auto-compact threshold killed loop iterations). Preset locked
  before the run: `llmc lock loop --owner <session>`. Fallback rung:
  `openrouter/deepseek/deepseek-v4-pro` (proven in this repo on the
  search-tier slice) if the local rung stalls. Anthropic is out (usage limit
  until 2026-09-01, fails as a stalled trial).
- **Judge: `openrouter/moonshotai/kimi-k3`** - different model from the
  writer, strongest available. Local writes, frontier judges.

## Scope

The agent may write:

- `experiments/pdf-corpus-graph/demo/db/**` (the new 08-editorial.sql)
- `experiments/pdf-corpus-graph/scripts/seed.sh` (rebuild coverage, Task 1.6)
- `experiments/pdf-corpus-graph/RUNLOG.md` (Task 3 measurements)

Everything else is fenced: the harness, live-suite.sh, the probes, lib/,
tests/, sql/, the loader, the manifest, the demo UI (a separate slice),
the plan docs.

## Sensors

Carried over: premises, typecheck, unit, registry, default-exports, hygiene,
no-stubs, demo-builds, rls-enabled, raw-tables-denied, live-suite pinned to
G01..G07, g02/g07 preserve.

New, specific to this work (all expect-fail at baseline; structural assertions
about OUR corpus and OUR schema, never platform facts):

- **abn-live** - extract_abn exists, at least 2 abn entities exist, EVERY abn
  entity norm passes demo.valid_abn, and norm '45153592173' (the WRWF pin)
  is among them.
- **au-persons-live** - person entities with mentions in inv-* docs exist
  (>= 5), and the org norm 'HINES CONSTRUCTIONS PTY LTD' exists.
- **time-axis-live** - entity_timeline exists and returns only non-null
  doc_date rows for the WRWF org; neighbourhood_as_at returns 0 rows for the
  HINES org at '2020-01-01' (before the corpus window opens) and > 0 at
  '2026-12-31' (after it closes); zero mentions and zero edges on inv-* docs
  have null doc_date.
- **judge** - kimi-k3 against .pi/judge-spec-editorial.md.

No canary on the live sensors (they mutate the live DB; verify-sensors
reverts the tree, not the database). Expect-fail-at-baseline proven by the
baseline run.

## Failure modes this loop is pre-armed against

All previously measured in this repo:

- No `find /`.
- The database is remote; extension questions go to pg_available_extensions.
- `\y` not `\b`; all regex groups non-capturing (the [1] trap).
- SRFs in FROM with WITH ORDINALITY, never beside a window function.
- RLS deny-by-default, zero policies; new RPCs security definer + pinned path.
- Postgres never inlines SECURITY DEFINER functions - do not EXPLAIN a
  function call and expect to see the inner plan.
- The transaction pooler hands back dirty backends: a crashed run's temp
  table (_hits/_hits_po/_hits_abn) can still exist on the next session.
  `drop table if exists pg_temp.<name>` before create, or drop and retry.
- extract_* are NOT idempotent: extraction for inv-* docs runs ONCE. Do not
  re-run over US docs at all.

## Go / no-go

1. `loop verify-sensors --manifest .pi/harness-editorial.json` - every guard
   discriminating.
2. Baseline: exactly abn-live, au-persons-live, time-axis-live + judge red;
   everything else green. A red preserve sensor at baseline means the project
   drifted - stop.
3. `loop run --manifest .pi/harness-editorial.json` with
   PI_COMPACT_FRACTION=0.95.
