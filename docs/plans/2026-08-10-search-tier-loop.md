# loop plan: build the search tier with deepseek-v4-pro, judged by kimi-k3

Companion to `2026-08-10-search-tier.md` (the work itself). This document is the
loop plan: which models, which sensors, and why.

## Models

- **Agent: `openrouter/deepseek/deepseek-v4-pro`**, fallback rung
  `openrouter/deepseek/deepseek-v4-flash`. Both ids verified present in the
  local model store under the `openrouter` provider. Anthropic is out: its API
  reported a usage limit with a 2026-09-01 reset, and the failure mode presents
  as a stalled trial rather than an auth error, so it is excluded from the
  ladder rather than left to burn iterations.
- **Judge: `openrouter/moonshotai/kimi-k3`** - this session's own model, passed
  explicitly with `judge --model`. Two reasons: the judge should be a different
  model from the writer (self-review is weak review), and the strongest model
  currently available is the one running this session.

## Scope

The agent may write:

- `experiments/pdf-corpus-graph/demo/db/**` (the new 07-search.sql)
- `experiments/pdf-corpus-graph/demo/src/**` (client + panel)
- `experiments/pdf-corpus-graph/demo/README.md` (endpoint table)
- `experiments/pdf-corpus-graph/scripts/seed.sh` (rebuild coverage - plan Task 4)
- `experiments/pdf-corpus-graph/RUNLOG.md` (measured costs)

Everything else is fenced: the harness, live-suite.sh (the instrument), the
existing tests, and the plan docs.

## Sensors

Carried over from the working manifest: premises, typecheck, unit, registry,
default-exports, g-prefix-ids, measurements-typed, no-stubs, hygiene,
demo-builds, rls-enabled, live-suite (pinned to `PVLAB_ONLY=G01..G07` - the
preserve set; G08/G09/G10 stay parked and out of this loop), the six G02-G07
preserve sensors.

New, specific to this work:

- **search-documents-live** (expect: fail at baseline) - the function exists,
  returns rows for a known term, returns zero rows (not an error) for
  gibberish, and the GIN index appears in the plan. Structural assertions about
  OUR corpus, same class as rls-enabled - not a platform fact.
- **cross-document-live** (expect: fail at baseline) - the function exists and
  every returned row satisfies `docs_count >= 2`. No count assertion: 20 is
  today's corpus fact, not an invariant.
- **raw-tables-denied** - anon direct read of `demo.entities` must still return
  42501. A regression here means the agent widened the surface.
- **judge** - `judge --base HEAD --spec .pi/judge-spec-search-tier.md --model
  openrouter/moonshotai/kimi-k3`.

No canary on the two live sensors: a canary would have to drop a function from
a live database and verify-sensors reverts the git tree, not the database. They
get expect-fail-at-baseline instead, proven by going green when the work lands.

## Failure modes this loop is pre-armed against

From the manifest rules, all previously measured:

- No `find /` (burned a 40-minute budget once).
- The database is remote; extension questions go to `pg_available_extensions`.
- `\y` not `\b` for word boundaries.
- `row_number() over ()` beside an SRF assigns 1 to every row.
- RLS is deny-by-default with zero policies; do not add policies, do not
  disable.
- Plus this loop's own: `ts_headline` output carries `<b>` markers - escape and
  re-mark, never raw `dangerouslySetInnerHTML`.

## Go / no-go

1. `loop verify-sensors --manifest .pi/harness-search-tier.json` must show every
   guard discriminating.
2. Baseline must show exactly the two new feature sensors + judge red and
   everything else green. If rls-enabled or a preserve sensor is red at
   baseline, stop - the project drifted.
3. Run: `loop run --manifest .pi/harness-search-tier.json`.

## Outcome (2026-08-11)

Done in one agent iteration. Two instrument bugs surfaced and were fixed before
the loop could run to completion - both were bugs in the harness/seed, not in
the agent's work, and both were exactly the failure classes the baseline check
exists to catch:

1. **Baseline drift (g07-preserve red).** `scripts/seed.sh` created the corpus
   shell tables with a made-up shape (`label`/`norm`, plain `bigint` ids,
   `source`/`target`) instead of the canonical `sql/corpus-*.sql` contract the
   probes insert against. On the rebuilt project G04/G05 measured-failed and
   G07 skipped, which g07-preserve correctly read as drift. Fix: seed applies
   the sql/ files (commit "fix(seed)"), live tables dropped and recreated
   canonical, full G01-G07 re-run 24 info / 0 fail / 0 skip.
2. **Unsatisfiable sensor (search-documents-live).** Its index clause ran
   `EXPLAIN select ... from demo.search_documents(...)` and grepped for the GIN
   index - but Postgres never inlines SECURITY DEFINER functions (verified
   live), and the RLS architecture requires definer, so the clause could never
   pass. Replaced with EXPLAIN of the underlying `search_tsv @@ tsquery` query
   on `corpus.documents` with `enable_seqscan=off` (7 rows seq-scan otherwise).
   Discrimination re-proven: passes with the index, seq-scans without it.

Iteration 1 then landed the whole tier: `demo/db/07-search.sql`
(search_documents + cross_document_entities, definer, pinned path, anon
EXECUTE, no table grants), client + Explorer panel (escape-then-re-mark for
ts_headline), seed.sh coverage, README/RUNLOG. Sensors after the iteration:
everything green except the then-broken search-documents-live; judge (kimi-k3)
passed on the real diff. Committed as "feat(demo): search tier". A third loop
run aborted at baseline on the non-discriminating-sensor check - which is the
loop correctly observing the feature sensors are green on the unchanged tree,
i.e. done. UI deployed to pggraph.erfi.dev; anon RPC path verified end-to-end.

Note for future loops: OpenRouter credits hit zero mid-run on the first
attempt (402 presents as instant agent exit, not a stall) - check
`/api/v1/credits` before firing, not after two burned iterations.
