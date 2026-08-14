# pdf-corpus-graph: demo-readiness gaps and the next iteration

> **STATUS 2026-08-14: SUBSTANTIALLY LANDED.** Tracks E (headline), F
> (corpus, time, resolution) and most of G (fusion run, region, OCR, per-PDF
> arithmetic) shipped the same day; details in the RUNLOG. G12's write-up is
> recorded; G15's headroom check rides along on the rebuild. Track H remains
> conversation preparation. The throwaway project stays destroyed
> (teardown 2026-08-11; rebuild is `make up`, ~446s). This plan folds a
> demo-readiness review of the current artifacts into work items. Per the
> experiment's hygiene rule it names no customer, account, deal or
> individual: the use case is stated generically, and every number quoted
> here is already in `experiments/pdf-corpus-graph/RUNLOG.md`.

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking.
> Read `experiments/pdf-corpus-graph/GUIDE.md` before touching anything under
> `experiments/pdf-corpus-graph/` - it is binding, and its cardinal rule (a
> test asserts that a probe RAN, never what it found) governs every task here.

**Goal:** reshape the demo so the graph it headlines is the graph the use case
asks about - people and organisations connected across documents and over
time - and fuse the two claims the current artifacts make separately into one
measured run.

## Where the demo stands

Measured facts, all already in the RUNLOG:

- The headline graph is **citations**: 1521 citation entities, regex-exact,
  with byte-exact provenance. Precision comes nearly free because citations
  are structurally regular.
- The use case's graph is **people and organisations** ("did organisation X
  deal with officeholder Y, when, and where else"). That extractor exists
  (Track B1: 561 persons, 2284 organisations) and is honestly graded NOISY:
  candidate generation, not a production recogniser. As it stands, the clean
  half of the demo is the half the use case does not ask about, and the half
  it asks about is the half labelled noisy.
- **Cross-document bridging is 1.3%.** 20 of the 1521 citation entities appear
  in 2+ documents (18 in two, 2 in three). Hidden connections across documents
  are the entire product thesis, and the corpus evidences it twenty times.
  With seven documents across five genres that is arithmetic, not a flaw -
  but a recording gets judged on the payoff.
- **There is no time axis.** The canonical question is temporal ("dealt with
  five years ago, and also in twenty other places"). Nothing in the model
  carries a date, so no "as at" query is possible.
- **Entity resolution is barely exercised.** `pg_trgm` and `fuzzystrmatch`
  are installed, but at 1.3% bridging they do almost nothing. At real scale,
  "J. Smith" against "John Smith" against "Cr Smith" is the problem that
  decides whether a reader trusts the output.
- **Scanned documents extract to nothing, silently.** Detection is solved
  (~270 chars/page routes a document to OCR, G09); OCR itself is not built.
  Meeting minutes from the early 2000s are scans. A demo corpus that is all
  born-digital looks broken the first time someone tries a scan.
- **The read surface is tables and lists.** The queries and data for a graph
  view exist; what is missing is a renderer over the bridging-entity query.
  Cheap, and worth not gold-plating.
- **"It works" and "it is fast" are two separate claims.** The real pipeline
  is seven documents and 1521 entities; the performance numbers come from a
  synthetic 100000/400000 graph. Nobody has run the real pipeline at even 100
  documents, so the two claims are held together by assumption.

## Track E - the editorial graph as the headline

Demo-grade precision on the documents actually shown, not production NER.

- [x] **E1: Curate the recording corpus for person/org precision.** One to
  five documents, hand-reviewed extraction output. A viewer will find a
  mangled name in the first minute of an unreviewed recording, and trust does
  not survive it.
- [x] **E2: Person/org graph becomes the headline panel.** Citations demoted
  to what they are genuinely good at: the verifiability story (regex-exact,
  byte-exact provenance).
- [ ] **E3: Record the precision statement on the curated documents.** Same
  honesty standard as B1: measured on those documents, stated as demo-grade,
  no production-recogniser claim.

## Track F - corpus engineering: bridging, time, resolution

The corpus is chosen, so choose it to demonstrate the thesis.

- [x] **F1: Pick an overlap-engineered public corpus.** One issuing body's
  minutes across consecutive years, plus a listed company's filing that those
  minutes name. The bridging count becomes the demo instead of a footnote.
- [x] **F2: Put dates on edges.** Minutes and filings are dated, so the
  metadata is free at ingestion. Carry the document date onto mentions and
  edges, and add an "as at" query RPC: a date filter over the same tables,
  not a new structure.
- [x] **F3: Registry-identifier resolution.** Jurisdictions whose corporate
  documents carry a registry identifier (an ACN or ABN in Australian filings,
  a company number in UK ones) hand you a deterministic join key that US
  federal documents do not have. Extract the identifier as its own entity
  kind and resolve on it first; trigram similarity becomes the fallback, not
  the primary mechanism. Exact resolution is a stronger story than fuzzy
  matching, and the dedicated graph stores do not give it to you either.
- [x] **F4: Jurisdiction honesty.** The measured corpus is US federal. Genre
  match is not jurisdiction match: citation formats, registry identifiers and
  scan rates are all jurisdictional. The recording corpus should be drawn
  from the target jurisdiction's public documents.

## Track G - the fusion run (the highest-leverage hour)

One run of the real pipeline over ~100 documents, reporting entity count,
edge count, extraction wall clock and one traversal latency. It fuses "it
works" and "it is fast" into a single artifact, and it produces the
extraction-ratio measurement that turns the cost projection from a band into
a number.

- [x] **G11: Real-pipeline scale probe.** Follows the established `G0n`
  module contract in the `pvlab` harness. Asserts that the run completed and
  recorded; never what it recorded.
- [ ] **G12: Cost per document.** The per-genre extraction ratios from G11
  convert the infrastructure figure into a per-document cost. Quote both
  units: a per-month infrastructure number cannot be compared against
  anything priced per document, and the comparison gets made in whatever
  units are quoted.
- [x] **G13: Region re-verification.** Everything was measured in
  `ap-southeast-1`. Re-run the G01 catalogue probe in the deployment-target
  region before quoting `pgrouting` availability there.
- [x] **G14: OCR path, or a stated boundary.** Either a minimal external OCR
  stage for below-threshold documents, or the boundary stated explicitly in
  GUIDE.md and the demo copy - before a viewer discovers it. Detection is
  already measured (G09).
- [ ] **G15: Disk headroom before loading.** The experiment project measured
  88% disk full at the 2026-08-11 audit, and the single-project disk ceiling
  is not discoverable via the Management API (G06/G08). Size headroom
  explicitly before a larger corpus goes in.

## Track H - engagement hygiene (pre-empt list)

Cheap to settle now, expensive to discover mid-demo.

- [ ] **H1: Demo logistics.** The demo runs on disposable infrastructure on a
  personal domain and can drop mid-call; the rebuild is one command and 446s.
  Supabase Storage cannot host the UI (serves HTML as `text/plain`,
  measured) - have the "why is the demo not hosted on the platform" answer
  ready, because it is a measured finding, not an oversight.
- [ ] **H2: Apache AGE expectations.** AGE is absent from the extension
  catalogue and its availability is a packaging request to the provider, not
  a design option. If it was ever described as available, that gets unwound
  before an artifact is promised.
- [ ] **H3: Vector recall.** The vectors in this build are synthetic, so no
  recall claim exists. If hybrid search becomes the ask, the agent-memory
  store work has real filtered-vector numbers (index cost, CPU embedding
  throughput) to draw on - the starting point is not zero.
- [ ] **H4: Residency scoping.** Public data only at evaluation stage, stated
  explicitly and in writing. Residency is not a blocker for public documents;
  it becomes one the moment internal archives are in scope, and that line
  should be drawn before anyone crosses it accidentally.

## Sequencing

G11 (the fusion run) is first: it is the highest-leverage hour available and
it produces the numbers E and F get quoted with. E1/F1 (the curated,
overlap-engineered corpus) gate any recording. Track H is conversation
preparation and costs nothing but writing time.
