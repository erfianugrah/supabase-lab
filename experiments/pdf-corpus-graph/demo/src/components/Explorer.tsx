import { useCallback, useEffect, useState } from "react";
import {
  api,
  bytes,
  type BridgesAsAtRow,
  type Component,
  type CrossDocEntity,
  type DocumentRow,
  type Entity,
  type EntityRegistryIdRow,
  type EntityTimelineRow,
  type Neighbour,
  type PathHop,
  type Provenance,
  type SearchResult,
  type Subgraph,
  KIND_COLOR,
  KIND_LABEL,
  type Stats,
} from "../lib/api";
import GraphViz, { type VizNode } from "./GraphViz";

/**
 * One island, not five. The panels share a selected entity and a path endpoint,
 * and splitting them into separate islands would mean either lifting that state
 * into a store or refetching the same entity in three places.
 *
 * Voice is dry technical throughout - "DIAGNOSTIC: NO PATH" rather than "Oops,
 * nothing found!". That is a hard constraint of the house style, not a
 * preference.
 */

/**
 * A native title-attribute tooltip. No library: `title` is accessible to keyboard
 * and screen readers for free, and anything richer would fight the no-animation,
 * no-shadow house style. The dotted underline is the only affordance, matching
 * the appliance-manual register.
 */
function Hint({ children, tip }: { children: React.ReactNode; tip: string }) {
  return (
    <span
      title={tip}
      className="cursor-help underline decoration-dotted decoration-[var(--color-hairline-strong)] underline-offset-2"
    >
      {children}
    </span>
  );
}

/**
 * Render ts_headline output safely. ts_headline wraps matches in <b> markers.
 * Escape-then-re-mark: all HTML-significant characters in the source text are
 * escaped, then only the ts_headline <b> markers are re-opened. No raw
 * dangerouslySetInnerHTML on the unprocessed string.
 */
function Headline({ text }: { text: string }) {
  // Escape everything, then un-escape only <b> and </b>
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/&lt;b&gt;/g, "<b>")
    .replace(/&lt;\/b&gt;/g, "</b>");
  return <span dangerouslySetInnerHTML={{ __html: escaped }} />;
}

type RequestError = {
  heading: string;
  message: string;
  detail: string;
};

function requestError(error: unknown): RequestError {
  const detail = error instanceof Error ? error.message : String(error);
  if (/failed to fetch/i.test(detail)) {
    return {
      heading: "DIAGNOSTIC: DATA SOURCE UNAVAILABLE",
      message:
        "The interface is online, but its backing demo database is currently offline. Live document and graph queries cannot run until the project is reprovisioned.",
      detail: "The browser could not reach the Supabase API.",
    };
  }
  return {
    heading: "DIAGNOSTIC: REQUEST FAILED",
    message: "The data request was rejected by the API.",
    detail,
  };
}

function KindBadge({ kind }: { kind: string }) {
  return (
    <span
      style={{ color: KIND_COLOR[kind] ?? "var(--color-ink-muted)" }}
      className="font-semibold"
    >
      {KIND_LABEL[kind] ?? kind.toUpperCase()}
    </span>
  );
}

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border border-[var(--color-hairline-strong)] mb-3">
      <header className="flex items-baseline justify-between border-b border-[var(--color-hairline-strong)] bg-[var(--color-bg-cream-strong)] px-2 py-1">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.06em]">{title}</h2>
        {note ? <span className="text-[11px] text-[var(--color-ink-muted)]">{note}</span> : null}
      </header>
      <div className="p-2">{children}</div>
    </section>
  );
}

/**
 * Client-side pagination over an already-fetched array. 111 documents is not
 * a server-paging problem; it is a page-length problem. No library: a slice,
 * two buttons, and the honest count.
 */
function Pager({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (p: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  const from = page * pageSize + 1;
  const to = Math.min(total, (page + 1) * pageSize);
  return (
    <div className="mt-1 flex items-center gap-2 text-[11px] text-[var(--color-ink-muted)]">
      <span className="num">{from}-{to} of {total}</span>
      <button type="button" disabled={page === 0} onClick={() => onPage(page - 1)}>PREV</button>
      <button type="button" disabled={page >= pages - 1} onClick={() => onPage(page + 1)}>NEXT</button>
    </div>
  );
}

export default function Explorer() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [docs, setDocs] = useState<DocumentRow[]>([]);
  const [components, setComponents] = useState<Component[]>([]);
  const [err, setErr] = useState<RequestError | null>(null);

  const [q, setQ] = useState("AC-1");
  const [hits, setHits] = useState<Entity[]>([]);
  const [selected, setSelected] = useState<Entity | null>(null);

  const [depth, setDepth] = useState(2);
  const [neighbours, setNeighbours] = useState<Neighbour[]>([]);
  const [prov, setProv] = useState<Provenance[]>([]);

  // Only id + label are needed to be a path endpoint, so the state is typed to
  // exactly that. Typing it as Entity forced a cast from Neighbour (which has no
  // mentions_count/docs_count) and the cast was a lie tsc correctly rejected.
  const [crossDoc, setCrossDoc] = useState<CrossDocEntity[]>([]);
  const [docQ, setDocQ] = useState("");
  const [docResults, setDocResults] = useState<SearchResult[]>([]);

  // The as-at filter on the bridging panel: empty means all time (the plain
  // cross_document_entities read), a date means bridges_as_at recomputed
  // within the window. BridgesAsAtRow and CrossDocEntity share a row shape,
  // so one table renders both.
  const [asAt, setAsAt] = useState("");
  const [bridgesAsAt, setBridgesAsAt] = useState<BridgesAsAtRow[]>([]);
  const [timeline, setTimeline] = useState<EntityTimelineRow[]>([]);
  const [registryIds, setRegistryIds] = useState<EntityRegistryIdRow[]>([]);
  const [graph, setGraph] = useState<Subgraph | null>(null);

  const [docsPage, setDocsPage] = useState(0);
  const [bridgesPage, setBridgesPage] = useState(0);
  const [neighboursPage, setNeighboursPage] = useState(0);
  const [timelinePage, setTimelinePage] = useState(0);

  const [pathTo, setPathTo] = useState<{ id: number; label: string } | null>(null);
  const [path, setPath] = useState<PathHop[] | null>(null);
  const [pathMsg, setPathMsg] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.stats(), api.documents(), api.components(2), api.crossDocumentEntities(50)])
      .then(([s, d, c, x]) => {
        setStats(s);
        setDocs(d);
        setComponents(c);
        setCrossDoc(x);
      })
      .catch((e) => setErr(requestError(e)));
  }, []);

  // Deep link: ?entity=<id> hydrates the selection directly, so a recording
  // or a shared URL lands on the graph, not on the search box. Runs after the
  // corpus load above because select() refetches everything it needs anyway.
  useEffect(() => {
    const raw = new URLSearchParams(window.location.search).get("entity");
    const id = raw ? Number(raw) : NaN;
    if (!Number.isInteger(id) || id <= 0) return;
    api.entityGet(id)
      .then((rows) => {
        const e = rows[0];
        if (e) select({ ...e, score: 0 });
      })
      .catch((x) => setErr(requestError(x)));
    // select is stable enough for this mount-only intent; re-running on its
    // identity change would reselect on every depth change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!asAt) return;
    setBridgesPage(0);
    api.bridgesAsAt(asAt, 50)
      .then(setBridgesAsAt)
      .catch((e) => setErr(requestError(e)));
  }, [asAt]);

  const runSearch = useCallback(async (term: string) => {
    if (!term.trim()) return;
    try {
      setHits(await api.search(term, 20));
    } catch (e) {
      setErr(requestError(e));
    }
  }, []);

  useEffect(() => {
    runSearch(q);
    // Intentionally only on mount: subsequent searches are explicit (Enter or
    // the button). Debounced search-as-you-type would triple the request count
    // for no benefit on a corpus this size.
  }, [runSearch]);

  const select = useCallback(async (e: Entity) => {
    setSelected(e);
    setPath(null);
    setPathMsg(null);
    setTimeline([]);
    setRegistryIds([]);
    setGraph(null);
    setNeighboursPage(0);
    setTimelinePage(0);
    try {
      const [n, p, t, r, g] = await Promise.all([
        api.neighbourhood(e.id, depth, 200),
        api.provenance(e.id, 12),
        api.entityTimeline(e.id),
        api.entityRegistryIds(e.id),
        api.subgraph(e.id, 2, 120),
      ]);
      setNeighbours(n);
      setProv(p);
      setTimeline(t);
      setRegistryIds(r);
      setGraph(g);
    } catch (x) {
      setErr(requestError(x));
    }
  }, [depth]);

  useEffect(() => {
    if (selected) {
      api.neighbourhood(selected.id, depth, 200).then(setNeighbours).catch((e) => setErr(requestError(e)));
      api.subgraph(selected.id, depth, 120).then(setGraph).catch((e) => setErr(requestError(e)));
      setNeighboursPage(0);
    }
  }, [depth, selected]);

  const runDocSearch = useCallback(async (term: string) => {
    if (!term.trim()) {
      setDocResults([]);
      return;
    }
    try {
      setDocResults(await api.searchDocuments(term, 10));
    } catch (e) {
      setErr(requestError(e));
    }
  }, []);

  const findPath = useCallback(async () => {
    if (!selected || !pathTo) return;
    setPathMsg(null);
    try {
      const hops = await api.shortestPath(selected.id, pathTo.id);
      setPath(hops);
      if (hops.length === 0) {
        // An empty result here is a real answer, not an error: the graph has
        // several disconnected components, so two nodes can genuinely have no
        // route between them.
        setPathMsg(
          "DIAGNOSTIC: NO PATH - endpoints lie in different connected components",
        );
      }
    } catch (e) {
      setErr(requestError(e));
    }
  }, [selected, pathTo]);

  if (err) {
    return (
      <div className="border border-[var(--color-accent-red)] p-2">
        <div className="font-semibold text-[var(--color-accent-red)]">{err.heading}</div>
        <p className="mt-1 text-[12px]">{err.message}</p>
        <p className="mt-2 border-t border-[var(--color-hairline-strong)] pt-1 text-[11px] text-[var(--color-ink-muted)]">
          {err.detail}
        </p>
      </div>
    );
  }

  return (
    <div>
      {/* Counters strip. Numbers, not prose. */}
      <div className="mb-3 flex flex-wrap gap-x-6 gap-y-1 border-b border-[var(--color-hairline-strong)] pb-2 text-[12px]">
        {stats ? (
          <>
            <span>DOCUMENTS <b>{stats.documents}</b></span>
            <span>ENTITIES <b>{stats.entities.toLocaleString()}</b></span>
            <span>MENTIONS <b>{stats.mentions.toLocaleString()}</b></span>
            <span>EDGES <b>{stats.edges.toLocaleString()}</b></span>
            {Object.entries(stats.by_kind).map(([k, n]) => (
              <span key={k}>
                <KindBadge kind={k} /> <b>{n}</b>
              </span>
            ))}
          </>
        ) : (
          <span className="text-[var(--color-ink-muted)]">LOADING</span>
        )}
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <div>
          <Section
            title="Source corpus"
            note="what got extracted from each document"
          >
            <table>
              <thead>
                <tr>
                  <th>slug</th>
                  <th>genre</th>
                  <th className="num"><Hint tip="Size of the source PDF in bytes.">source</Hint></th>
                  <th className="num"><Hint tip="Size of the text extracted from it.">text</Hint></th>
                  <th className="num"><Hint tip="extracted text / source PDF bytes. Above 1.0 is real: a PDF already compresses its content streams, so dense regulation yields more text than its own file.">ratio</Hint></th>
                  <th className="num"><Hint tip="Distinct cited entities found in this document.">entities</Hint></th>
                  <th className="num"><Hint tip="Every individual occurrence of a citation in this document.">mentions</Hint></th>
                </tr>
              </thead>
              <tbody>
                {docs.slice(docsPage * 25, (docsPage + 1) * 25).map((d) => (
                  <tr key={d.slug}>
                    <td>{d.slug}</td>
                    <td className="text-[var(--color-ink-muted)]">{d.genre}</td>
                    <td className="num">{bytes(d.source_bytes)}</td>
                    <td className="num">{bytes(d.extracted_bytes)}</td>
                    <td className="num">{d.extract_ratio?.toFixed(3) ?? "-"}</td>
                    <td className="num">{d.entities}</td>
                    <td className="num">{d.mentions}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pager page={docsPage} pageSize={25} total={docs.length} onPage={setDocsPage} />
            <p className="mt-2 text-[11px] text-[var(--color-ink-muted)]">
              The ratio is not a constant. A positioned form yields 0.048; dense
              regulation yields 1.089, because a PDF already compresses its own
              content streams. Source size does not predict database size.
            </p>
          </Section>

          <Section
            title="Cross-document entities"
            note={asAt
              ? `${bridgesAsAt.length} bridging entities as at ${asAt}`
              : `${crossDoc.length} entities appear in 2+ documents`}
          >
            <div className="mb-2 flex items-center gap-2">
              <label htmlFor="as-at" className="text-[11px] uppercase text-[var(--color-ink-muted)]">
                as at
              </label>
              <input
                id="as-at"
                type="date"
                value={asAt}
                min="2015-08-06"
                max="2026-12-31"
                onChange={(e) => setAsAt(e.target.value)}
              />
              {asAt ? (
                <button type="button" onClick={() => setAsAt("")}>CLEAR</button>
              ) : (
                <span className="text-[11px] text-[var(--color-ink-muted)]">
                  only edges whose document existed by the date count
                </span>
              )}
            </div>
            <table>
              <thead>
                <tr>
                  <th><Hint tip="Entity type: CTRL = NIST control, U.S.C. = statute, CFR = regulation, PUB.L = Public Law.">kind</Hint></th>
                  <th>label</th>
                  <th className="num"><Hint tip="How many documents this entity appears in.">docs</Hint></th>
                  <th className="num"><Hint tip="Total mentions across all documents.">mentions</Hint></th>
                  <th><Hint tip="The documents containing this entity.">found in</Hint></th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(asAt ? bridgesAsAt : crossDoc).slice(bridgesPage * 20, (bridgesPage + 1) * 20).map((e) => (
                  <tr key={e.id}>
                    <td><KindBadge kind={e.kind} /></td>
                    <td>{e.label}</td>
                    <td className="num">{e.docs_count}</td>
                    <td className="num">{e.mentions_count}</td>
                    <td className="text-[var(--color-ink-muted)]">
                      <details>
                        <summary>{e.docs.length} documents</summary>
                        {e.docs.join(", ")}
                      </details>
                    </td>
                    <td>
                      <button type="button" onClick={() => {
                        const ent: Entity = { id: e.id, kind: e.kind, label: e.label, mentions_count: e.mentions_count, docs_count: e.docs_count, score: 0 };
                        select(ent);
                      }}>OPEN</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pager
              page={bridgesPage}
              pageSize={20}
              total={(asAt ? bridgesAsAt : crossDoc).length}
              onPage={setBridgesPage}
            />
            <p className="mt-2 text-[11px] text-[var(--color-ink-muted)]">
              The discovery surface for a first-time user: entities that bridge
              documents are the natural entry point. Bridging is corpus-shaped:
              20 of the 1521 US citation entities span documents, against
              sitting councillors who span 86-93 of the 103 council documents.
            </p>
          </Section>

          <Section title="Document search" note="keyword search over extracted text">
            <form
              className="mb-2 flex gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                runDocSearch(docQ);
              }}
            >
              <input
                aria-label="search document text"
                className="flex-1"
                value={docQ}
                onChange={(e) => setDocQ(e.target.value)}
                placeholder="search document text"
              />
              <button type="submit">SEARCH</button>
            </form>
            {docResults.length > 0 ? (
              <table>
                <thead>
                  <tr>
                    <th>slug</th>
                    <th>genre</th>
                    <th className="num"><Hint tip="ts_rank over the tsvector: how well the document matches the query.">rank</Hint></th>
                    <th><Hint tip="ts_headline snippet with match markers in bold.">snippet</Hint></th>
                  </tr>
                </thead>
                <tbody>
                  {docResults.map((r) => (
                    <tr key={r.slug}>
                      <td>{r.slug}</td>
                      <td className="text-[var(--color-ink-muted)]">{r.genre}</td>
                      <td className="num">{r.rank.toFixed(4)}</td>
                      <td><Headline text={r.headline} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : docQ.trim() ? (
              <p className="text-[var(--color-ink-muted)]">NO MATCH</p>
            ) : (
              <p className="text-[var(--color-ink-muted)]">Enter a search term above.</p>
            )}
          </Section>

          <Section title="Entity search" note="find a control, person or organisation by name">
            <form
              className="mb-2 flex gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                runSearch(q);
              }}
            >
              <input
                aria-label="search entities"
                className="flex-1"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="entity name - a control, a councillor, a company"
              />
              <button type="submit">SEARCH</button>
            </form>
            <table>
              <thead>
                <tr>
                  <th><Hint tip="Entity type: CTRL = NIST control, U.S.C. = statute, CFR = regulation, PUB.L = Public Law.">kind</Hint></th>
                  <th>label</th>
                  <th className="num">mentions</th>
                  <th className="num">docs</th>
                  <th className="num"><Hint tip="Search rank: 4.0 exact, 3.9 punctuation-insensitive, 2.x prefix, 1.x trigram similarity.">score</Hint></th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {hits.map((h) => (
                  <tr key={h.id}>
                    <td><KindBadge kind={h.kind} /></td>
                    <td>{h.label}</td>
                    <td className="num">{h.mentions_count}</td>
                    <td className="num">{h.docs_count}</td>
                    <td className="num">{h.score.toFixed(2)}</td>
                    <td className="whitespace-nowrap">
                      <button type="button" onClick={() => select(h)}>OPEN</button>{" "}
                      <button type="button" onClick={() => setPathTo(h)}>SET TARGET</button>
                    </td>
                  </tr>
                ))}
                {hits.length === 0 ? (
                  <tr><td colSpan={6} className="text-[var(--color-ink-muted)]">NO MATCH</td></tr>
                ) : null}
              </tbody>
            </table>
          </Section>

          <Section title="Connected components" note="whether the corpus separates into topics on its own">
            <table>
              <thead>
                <tr><th className="num"><Hint tip="Number of entities in this cluster - mutually reachable via pgr_connectedComponents.">size</Hint></th><th><Hint tip="The most-mentioned entities in the cluster - its topic.">largest members</Hint></th></tr>
              </thead>
              <tbody>
                {components.slice(0, 8).map((c) => (
                  <tr key={c.component}>
                    <td className="num">{c.size}</td>
                    <td className="text-[var(--color-ink-muted)]">
                      {(c.sample_labels ?? "").slice(0, 90)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-[11px] text-[var(--color-ink-muted)]">
              The corpus separates into topical clusters on its own: security
              controls in one component, statutes and public laws in another,
              securities regulation in a third.
            </p>
          </Section>
        </div>

        <div>
          <Section
            title="Selected entity"
            note={selected ? `id ${selected.id}` : "none"}
          >
            {selected ? (
              <div className="mb-2 flex items-baseline gap-3">
                <span className="text-[16px] font-semibold">{selected.label}</span>
                <KindBadge kind={selected.kind} />
                <span className="text-[11px] text-[var(--color-ink-muted)]">
                  {selected.mentions_count} mentions in {selected.docs_count} document(s)
                </span>
              </div>
            ) : (
              <p className="text-[var(--color-ink-muted)]">
                Select a result with OPEN.
              </p>
            )}

            {selected ? (
              <div className="flex items-center gap-2 border-t border-[var(--color-hairline)] pt-2">
                <label htmlFor="depth" className="text-[11px] uppercase text-[var(--color-ink-muted)]">
                  traversal depth
                </label>
                <select
                  id="depth"
                  value={depth}
                  onChange={(e) => setDepth(Number(e.target.value))}
                >
                  <option value={1}>1</option>
                  <option value={2}>2</option>
                  <option value={3}>3</option>
                </select>
                <span className="text-[11px] text-[var(--color-ink-muted)]">
                  recursive CTE, capped at 4
                </span>
              </div>
            ) : null}
          </Section>

          {selected ? (
            <>
              <Section
                title="Graph"
                note={graph
                  ? `${graph.nodes.length} nodes, ${graph.edges.length} edges (top 40 nodes, top 3 edges each drawn)`
                  : "loading"}
              >
                {graph ? (
                  <GraphViz
                    nodes={graph.nodes}
                    edges={graph.edges}
                    onOpen={(n: VizNode) => {
                      // Viz nodes carry edge weight, not entity counters, so a
                      // graph click re-fetches the real entity row by exact
                      // label rather than fabricate counts.
                      api.search(n.label, 5)
                        .then((hits) => {
                          const exact = hits.find((h) => h.id === n.id) ?? hits[0];
                          if (exact) select(exact);
                        })
                        .catch((x) => setErr(requestError(x)));
                    }}
                  />
                ) : (
                  <p className="text-[var(--color-ink-muted)]">LOADING</p>
                )}
              </Section>

              <Section title="Shortest path" note="the strongest chain of references between two entities">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className="text-[11px] uppercase text-[var(--color-ink-muted)]">target</span>
                  <span>{pathTo ? pathTo.label : "unset - use SET TARGET"}</span>
                  <button type="button" onClick={findPath} disabled={!pathTo}>
                    FIND PATH
                  </button>
                </div>
                {pathMsg ? (
                  <div className="text-[var(--color-accent-red)]">{pathMsg}</div>
                ) : null}
                {path && path.length > 0 ? (
                  <table>
                    <thead>
                      <tr><th className="num"><Hint tip="Position in the path, 1 = start.">seq</Hint></th><th>kind</th><th>label</th><th className="num"><Hint tip="Accumulated cost from the start. Cost is 1/co-citation-weight, so a lower number means a more strongly evidenced chain, not just fewer hops.">agg cost</Hint></th></tr>
                    </thead>
                    <tbody>
                      {path.map((h) => (
                        <tr key={h.seq}>
                          <td className="num">{h.seq}</td>
                          <td><KindBadge kind={h.kind} /></td>
                          <td>{h.label}</td>
                          <td className="num">{h.agg_cost.toFixed(4)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : null}
              </Section>

              <Section title="Neighbourhood" note={`${neighbours.length} nodes within depth ${depth}`}>
                <table>
                  <thead>
                    <tr>
                      <th className="num"><Hint tip="How many citation hops from the selected entity. 0 is the entity itself.">depth</Hint></th>
                      <th>kind</th>
                      <th>label</th>
                      <th><Hint tip="The document where this connection was found.">via document</Hint></th>
                      <th className="num"><Hint tip="Co-citation count: how often the two entities appear within 400 characters. Higher = more strongly linked.">weight</Hint></th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {neighbours.slice(neighboursPage * 25, (neighboursPage + 1) * 25).map((n) => (
                      <tr key={n.id}>
                        <td className="num">{n.depth}</td>
                        <td><KindBadge kind={n.kind} /></td>
                        <td>{n.label}</td>
                        <td className="text-[var(--color-ink-muted)]">{n.via_doc ?? "-"}</td>
                        <td className="num">{n.weight}</td>
                        <td>
                          <button type="button" onClick={() => setPathTo({ id: n.id, label: n.label })}>
                            SET TARGET
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <Pager
                  page={neighboursPage}
                  pageSize={25}
                  total={neighbours.length}
                  onPage={setNeighboursPage}
                />
              </Section>

              <Section
                title="Timeline"
                note="every mention of this entity, in document-date order"
              >
                {timeline.length > 0 ? (
                  <table>
                    <thead>
                      <tr>
                        <th><Hint tip="The document's own date (meeting date, register snapshot). Nulls - the US federal documents - sort last.">date</Hint></th>
                        <th>document</th>
                        <th className="num"><Hint tip="Exact character position of this mention in the extracted text.">offset</Hint></th>
                        <th>source text</th>
                      </tr>
                    </thead>
                    <tbody>
                      {timeline.slice(timelinePage * 25, (timelinePage + 1) * 25).map((t) => (
                        <tr key={`${t.doc_slug}-${t.char_offset}`}>
                          <td className="whitespace-nowrap">{t.doc_date ?? "-"}</td>
                          <td className="text-[var(--color-ink-muted)]">{t.doc_slug}</td>
                          <td className="num">{t.char_offset.toLocaleString()}</td>
                          <td>{t.snippet}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="text-[var(--color-ink-muted)]">NO MENTIONS</p>
                )}
                <Pager
                  page={timelinePage}
                  pageSize={25}
                  total={timeline.length}
                  onPage={setTimelinePage}
                />
              </Section>

              {registryIds.length > 0 ? (
                <Section title="Registry identifiers" note="deterministic identity pins co-located with this entity">
                  <table>
                    <thead>
                      <tr><th>identifier</th><th className="num">canonical</th><th>printed in</th></tr>
                    </thead>
                    <tbody>
                      {registryIds.map((r) => (
                        <tr key={r.id}>
                          <td>{r.label}</td>
                          <td className="num">{r.norm}</td>
                          <td className="text-[var(--color-ink-muted)]">
                            <details>
                              <summary>{r.docs.length} documents</summary>
                              {r.docs.join(", ")}
                            </details>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="mt-2 text-[11px] text-[var(--color-ink-muted)]">
                    Each identifier passed the ABN checksum at extraction -
                    shape proposes, arithmetic disposes. Co-location is the
                    existing 400-character proximity edge; no fuzzy matching is
                    involved.
                  </p>
                </Section>
              ) : null}

              <Section title="Provenance" note="the exact documents and character offsets this node came from">
                <table>
                  <thead>
                    <tr><th><Hint tip="The source document this mention came from.">document</Hint></th><th className="num"><Hint tip="Exact character position of this mention in the extracted text. Verified against the bytes, not asserted.">offset</Hint></th><th><Hint tip="The 150-character window of source text around the mention - the evidence.">source text</Hint></th></tr>
                  </thead>
                  <tbody>
                    {prov.map((p) => (
                      <tr key={`${p.doc_slug}-${p.char_offset}`}>
                        <td className="whitespace-nowrap">{p.doc_slug}</td>
                        <td className="num">{p.char_offset.toLocaleString()}</td>
                        <td>{p.snippet}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-2 text-[11px] text-[var(--color-ink-muted)]">
                  Offsets are exact character positions in the extracted text,
                  reconstructed from the match and split arrays and verified with
                  substr() rather than asserted. Every edge is traceable to the
                  bytes that produced it.
                </p>
              </Section>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
