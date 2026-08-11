# pdf-corpus-graph: hardening, editorial reshape, and the open scale questions

> **STATUS 2026-08-11: DESTROYED.** All tracks done and committed
> (`327301c`, `883de45`), then the throwaway project was torn down
> (`make destroy`, `supabase_project.probe` ref `<ref>`, medium,
> ap-southeast-1) - plan: 0 add, 0 change, 1 destroy; apply complete; ref now
> unreachable; tofu state gone. Rebuild is `make up` (~446s) whenever the demo
> is wanted back. The Cloudflare Worker for `pggraph.erfi.dev` was NOT touched
> by `make destroy` and remains in Cloudflare state - tearing it down is a
> separate wrangler step if the dead demo page is not wanted.
> Final measured findings: B1 561 persons/2284 orgs (precision NOISY, recorded
> honestly); G08 disk ceiling not discoverable via Management API; G09 ~270
> chars/page scanned threshold (OCR required, plpython3u absent); G10 no knee
> to c=64 on the 100k/400k graph. All in RUNLOG + demo/README.

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking. Read
> `experiments/pdf-corpus-graph/GUIDE.md` before touching anything under
> `experiments/pdf-corpus-graph/` - it is binding, and its cardinal rule (a test
> asserts that a probe RAN, never what it found) governs every task here.

**Goal:** Close the security gaps created while building the demo, reshape the
demo so it answers an editorial question rather than a technical one, and turn
three unanswered scale questions into measurements.

**Architecture:** Four independent tracks. Track A is cleanup and is urgent
(there is a live open-proxy). Track B changes what the demo extracts, not how it
works. Track C is UI polish. Track D adds probes to the existing `pvlab` harness
and follows the established `G0n` module contract.

**Tech stack:** Postgres 17.6 + pgrouting 3.4.1 + PostgREST; Astro 7 / React 19
static UI on Cloudflare Workers; the `pvlab` harness for probes; `loop` with
sensor gating for the buildable parts.

---

## Scope check, and what must NOT go in a loop

These four tracks are independent and could be four plans. They are kept
together because they share one live project and one teardown decision.

**Track A must be done by hand, first, and must not be delegated to a loop.**
It deletes live infrastructure. A loop that mis-parses a resource name and
deletes the wrong Worker is a worse outcome than doing it manually in five
minutes. It is also the only track with an active security exposure.

**Tracks B and D are loop-suitable.** They are code plus sensors, with a live
project the sensors can measure against.

**Track C is loop-suitable but low value to delegate** - it is two small files.

---

## File structure

| File | Responsibility |
|---|---|
| `experiments/pdf-corpus-graph/db/05-security.sql` | New. RLS enablement, extension relocation, grant audit. |
| `experiments/pdf-corpus-graph/demo/db/06-entities-people-orgs.sql` | New. Person/organization extraction patterns, replacing citation-only entities. |
| `experiments/pdf-corpus-graph/demo/src/components/Explorer.tsx` | Modify. Tooltips on every column and panel header. |
| `experiments/pdf-corpus-graph/demo/src/pages/index.astro` | Modify. Favicon links in `<head>`. |
| `experiments/pdf-corpus-graph/demo/public/` | New. Favicon artifact set. |
| `experiments/pdf-corpus-graph/tests/g08-disk-ceiling.ts` | New. The disk-size question G06 left open. |
| `experiments/pdf-corpus-graph/tests/g09-scanned-pdf-ocr.ts` | New. What happens to an image-only PDF. |
| `experiments/pdf-corpus-graph/tests/g10-traversal-concurrency.ts` | New. Traversal under concurrent load. |
| `experiments/pdf-corpus-graph/RUNLOG.md` | Modify. Absorb G08-G10 findings. |

---

## Track A - security cleanup (BY HAND, FIRST)

**Why first:** `pdf-extract-probe` accepts `?url=` and fetches it, on a public
`workers.dev` URL. That is an open proxy usable to reach arbitrary hosts with
Cloudflare's egress. Everything else in this plan can wait; this cannot.

### Task A1: Delete the open-proxy Worker

- [ ] **Step 1:** Confirm the exact script name before deleting anything.

```bash
curl -s "https://api.cloudflare.com/client/v4/accounts/$ACC/workers/scripts" \
  -H "X-Auth-Email: $CLOUDFLARE_EMAIL" -H "X-Auth-Key: $CLOUDFLARE_API_KEY" \
  | jq -r '.result[].id' | grep pdf-extract-probe
```

- [ ] **Step 2:** Delete it. `pggraph` must be left alone - check the name twice.
- [ ] **Step 3:** Verify the URL now 404s, and that `pggraph.erfi.dev` still 200s.
- [ ] **Step 4:** Keep `runtimes/cloudflare-worker/` in the repo. The source is
      the evidence for the ceiling measurement; only the deployment is deleted.
      Add a comment at the top of `src/index.ts` recording that it is
      deploy-on-demand and must not be left running, and why.

### Task A2: Remove the public Storage bucket

- [ ] **Step 1:** Empty and delete the `site` bucket created during the hosting
      test. It served its purpose - the `text/plain` finding is already recorded
      in RUNLOG.md and the lexicanum reference.
- [ ] **Step 2:** Verify the public object URL 404s.

### Task A3: Remove credentials from disk

- [ ] **Step 1:** `shred -u /tmp/sr-key /tmp/cf-acc-id` - the first holds a
      `service_role` key, which bypasses RLS entirely.
- [ ] **Step 2:** Confirm `demo/.env` is still gitignored at the folded-in path
      and was never committed (`git log --all -- '*/demo/.env'` must be empty).

### Task A4: Enable RLS and fix the advisor findings

**Files:** Create `experiments/pdf-corpus-graph/db/05-security.sql`

Current state: RLS is OFF on all eight tables. Access control rests entirely on
revoked grants plus `SECURITY DEFINER` functions. That works, but it is one
careless `GRANT` from being undone with no second layer.

- [ ] **Step 1:** Write the failing check first - a query asserting every table
      in `demo` and `corpus` has `rowsecurity = true`. Run it, watch it return 8
      offending rows.
- [ ] **Step 2:** Enable RLS on all eight tables. Add no policies: with grants
      already revoked and the API being definer functions, deny-by-default is
      correct and a policy would only widen it.
- [ ] **Step 3:** Re-run the check. Expect zero rows.
- [ ] **Step 4:** Verify the demo still works end to end - `SECURITY DEFINER`
      functions bypass RLS, so all seven RPCs must still answer. Curl `stats`,
      `search_entities` and `provenance`. If any breaks, the function is not
      definer and that is a finding worth recording, not patching around.
- [ ] **Step 5:** Move `pg_trgm` and `pgrouting` out of `public` into
      `extensions` (advisor WARN `extension_in_public`). Re-run the demo checks:
      `search_entities` depends on `pg_trgm` and every pgrouting RPC depends on
      the relocation not breaking the `search_path` pinned on those functions.
- [ ] **Step 6:** Re-run the security advisors. Expect `spatial_ref_sys` to
      remain as the sole ERROR - it is a PostGIS system table created by the
      pgrouting cascade and is not ours to alter. Record that rather than
      suppressing it.
- [ ] **Step 7:** Commit.

---

## Track B - reshape the demo around editorial entities

**Why:** The brief is explicit that editors, not engineers, are the gatekeepers.
The current demo extracts statute and control citations, which proves the
mechanism and persuades nobody: "AC-1 cites AC-3" is not a story. The same
machinery pointed at people and organizations produces "this name appears in a
planning document and in a filing", which is.

**Design constraint:** Do not delete the citation extractor. It is the honest,
zero-hallucination baseline and the RUNLOG numbers depend on it. Add entity
kinds alongside it.

### Task B1: Add person and organization extraction

**Files:** Create `demo/db/06-entities-people-orgs.sql`

- [ ] **Step 1:** Extend the `kind` check constraint on `demo.entities` to admit
      `person` and `org`. Write the migration so it is idempotent.
- [ ] **Step 2:** Add extraction patterns. Deterministic first, because the
      corpus supports it: honorific-prefixed names (`Mr`, `Ms`, `Senator`,
      `Representative`), and organization suffixes (`Inc.`, `LLC`, `Corporation`,
      `Authority`, `Commission`, `Department of X`). Use `\y` for word
      boundaries - `\b` is backspace in Postgres and silently matches nothing.
- [ ] **Step 3:** Run against one document, eyeball 20 random mentions against
      their source snippets. Deterministic name extraction has a much worse
      precision profile than citation extraction; if it is producing garbage,
      that is a FINDING to record, not something to tune until it looks good.
- [ ] **Step 4:** Rebuild edges with `demo.build_edges(400)` and re-run
      `demo.refresh_counters()`.
- [ ] **Step 5:** Record the precision estimate in the README honestly, next to
      the note that citations are exact and names are not.

### Task B2: Make cross-document connection the headline

- [ ] **Step 1:** Add an RPC returning entities that appear in **two or more
      distinct documents**, ordered by document count. This is the "who connects
      these papers" query and it is currently not directly askable.
- [ ] **Step 2:** Surface it as a panel above entity search, since it is the
      thing an editor would look at first.
- [ ] **Step 3:** Verify a real cross-document hit exists in the loaded corpus
      before shipping the panel. If every entity appears in exactly one document,
      the panel is empty and the demo is worse than before - in that case, say so
      and stop rather than shipping an empty box.

---

## Track C - UI polish

### Task C1: Favicon

- [ ] **Step 1:** Write an SVG mark. Geometric, two-colour, legible at 16px, in
      the existing palette (`--color-ink` on `--color-bg-cream`, accent
      `--color-accent-red`). A node-and-edge glyph suits the subject; avoid
      anything that turns to mud at favicon size.
- [ ] **Step 2:** Run `build_favicon_set` with `outDir` = `demo/public`,
      `manifestName` = "Corpus graph", theme `#1a1a1a`, background `#faf7ee`.
- [ ] **Step 3:** Paste the returned `<head>` snippet into `index.astro`.
- [ ] **Step 4:** Rebuild, redeploy, hard-refresh, confirm the tab shows it.

### Task C2: Tooltips

Every number on that page is meaningless without its definition, and the brief's
audience is non-technical.

- [ ] **Step 1:** Add a small `<Hint>` component - a `title` attribute plus a
      dotted underline. No tooltip library; a `title` is native, accessible and
      free. Respect the no-animation, no-shadow house style.
- [ ] **Step 2:** Annotate at minimum: `extract ratio` (extracted text bytes over
      source PDF bytes, and that above 1.0 is real), `mentions` vs `docs`,
      `score` (the four ranking tiers), `depth`, `weight` (co-citation count in a
      400-character window), `agg cost` (accumulated 1/weight, so lower means
      better-evidenced), `component`, and `offset` (exact character position in
      the extracted text).
- [ ] **Step 3:** Add one sentence under each panel header saying what question
      the panel answers.
- [ ] **Step 4:** Rebuild, screenshot headless, read the screenshot to confirm
      nothing overflows at 1500px and at a narrow width.

---

## Track D - the three unanswered questions

These follow the `G0n` module contract in GUIDE.md. Each records what it found;
none asserts what it should find.

### Task D1: G08 - the disk ceiling

G06 probed five endpoints and found only throughput fields
(`baseline_disk_io_mbs`, `max_disk_io_mbs`). The question "can one project hold a
corpus of this order" is the largest open commercial risk and remains unanswered.

- [ ] **Step 1:** Probe the disk **addon catalogue** rather than the project:
      `available_addons` on the billing endpoint lists variants, and the largest
      variant is the ceiling if one is published.
- [ ] **Step 2:** Probe documented pricing/limits pages via `docs_search
      source="supabase"` and record what is documented versus what the API
      exposes. Mark each as measured or documented.
- [ ] **Step 3:** Do NOT attempt a resize. Record `status: "info"`.
- [ ] **Step 4:** If no ceiling is discoverable from either surface, record that
      as the finding. An unanswered question recorded honestly beats a number
      inferred from 404s.

### Task D2: G09 - what a scanned PDF does

The corpus in the requirement spans 2000-2026 and the early end is very likely
scanned. `form-1040` already hints at this: ratio 0.048, and **zero** entities.

- [ ] **Step 1:** Add an image-only PDF fixture to `lib/fixtures.ts` with a
      verified `Content-Length` and a `genre` of `scanned`.
- [ ] **Step 2:** Run it through the same extraction path. Expect near-zero
      characters.
- [ ] **Step 3:** Record chars-per-page against the born-digital fixtures, so
      there is a measured threshold that distinguishes "scanned" from "sparse".
      That threshold is the useful deliverable - it is what a real pipeline would
      branch on to route a document to OCR.
- [ ] **Step 4:** Do NOT build an OCR pipeline. Record that OCR is required, is
      unavailable in-database (`plpython3u` absent), and note the measured
      detection threshold.

### Task D3: G10 - traversal under concurrency

Every latency measured so far is single-query and uncontended. On a 2 vCPU
instance that is the least representative case.

- [ ] **Step 1:** Run the depth-3 neighbourhood query at concurrency 1, 4, 16 and
      64 against the existing 100000/400000 graph.
- [ ] **Step 2:** Record p50 and p95 at each level, plus errors and pooler
      saturation. Carry `instance_size` on every row.
- [ ] **Step 3:** Record where it degrades. A knee is the finding; there is no
      correct value.
- [ ] **Step 4:** Update RUNLOG.md - the current text says the timings "say
      nothing about behaviour under concurrency", which this replaces.

---

## Loop configuration

Reuse `.pi/harness-pdf-corpus-graph.json` with these changes:

- [ ] `writeScope` adds `experiments/pdf-corpus-graph/demo/**` and
      `experiments/pdf-corpus-graph/db/**`.
- [ ] Add feature sensors `g08-disk-ceiling`, `g09-scanned-pdf`,
      `g10-concurrency`, each `expect: "fail"`, each asserting the module ran and
      recorded measurements - never what it recorded.
- [ ] Add a guard sensor: `demo-builds` running `bun run check && bun run build`
      in `demo/`.
- [ ] Add a guard sensor: `rls-enabled` asserting zero tables in `demo`/`corpus`
      have `rowsecurity = false`. This one CAN assert a value, because unlike a
      platform fact it is a project invariant we are choosing to hold.
- [ ] Keep the existing `hygiene`, `no-stubs`, `g-prefix-ids` and `judge` gates.
- [ ] **Run `loop verify-sensors` before `loop run`.** Last time it found five
      gates that gated nothing.
- [x] Model ladder: SUBSTITUTED 2026-08-11 - `openrouter/deepseek/deepseek-v4-pro`
      then `openrouter/deepseek/deepseek-v4-flash`, judge
      `openrouter/moonshotai/kimi-k3` (explicit `--model`). The Anthropic rungs
      were parked on the 2026-09-01 usage limit, and the search-tier loop
      proved the deepseek ladder builds to these sensors in one iteration.
      Still true: no opencode-zen rungs - that workspace was out of credit and
      the failure presents as a stalled trial rather than an auth error.

**Rules to add to the manifest:**

- [ ] Never run `find /` - it does not return on this machine and consumed a
      whole 40-minute agent budget once already.
- [ ] The database is remote. Extension files do not exist locally; query
      `pg_available_extensions`.
- [ ] Postgres word boundary is `\y`. `\b` is backspace and silently matches
      nothing.
- [ ] `row_number() over ()` beside a set-returning function in a SELECT list
      assigns 1 to every row. Use `WITH ORDINALITY` in `FROM`.

---

## Sequencing

1. **Track A by hand, now.** Open proxy first.
2. **`loop verify-sensors`**, then **Track D** - the probes are self-contained
   and the findings feed the docs.
3. **Track B**, gated on B2 Step 3 finding real cross-document entities.
4. **Track C** last; it is polish and depends on B's panels existing.
5. Update RUNLOG.md and the lexicanum reference from whatever D and B measured,
   then decide keep-versus-destroy on the project.

## Out of scope

- OCR implementation (D2 measures the need and stops).
- The pgmq + Fly ingestion architecture - that is a design question with no code
  in this repo, and it should be answered in prose before anything is built.
- Testing Containers or VMs for extraction: with gigabytes of memory the outcome
  is predictable and the measurement would not inform the decision.
- Anything at 4 TB. Nothing here is a scale test; D1 only asks whether the
  ceiling is discoverable.
