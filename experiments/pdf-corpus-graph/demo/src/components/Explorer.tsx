import { useCallback, useEffect, useState } from "react";
import {
  api,
  bytes,
  type Component,
  type DocumentRow,
  type Entity,
  type Neighbour,
  type PathHop,
  type Provenance,
  KIND_COLOR,
  KIND_LABEL,
  type Stats,
} from "../lib/api";

/**
 * One island, not five. The panels share a selected entity and a path endpoint,
 * and splitting them into separate islands would mean either lifting that state
 * into a store or refetching the same entity in three places.
 *
 * Voice is dry technical throughout - "DIAGNOSTIC: NO PATH" rather than "Oops,
 * nothing found!". That is a hard constraint of the house style, not a
 * preference.
 */

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

export default function Explorer() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [docs, setDocs] = useState<DocumentRow[]>([]);
  const [components, setComponents] = useState<Component[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const [q, setQ] = useState("AC-1");
  const [hits, setHits] = useState<Entity[]>([]);
  const [selected, setSelected] = useState<Entity | null>(null);

  const [depth, setDepth] = useState(2);
  const [neighbours, setNeighbours] = useState<Neighbour[]>([]);
  const [prov, setProv] = useState<Provenance[]>([]);

  // Only id + label are needed to be a path endpoint, so the state is typed to
  // exactly that. Typing it as Entity forced a cast from Neighbour (which has no
  // mentions_count/docs_count) and the cast was a lie tsc correctly rejected.
  const [pathTo, setPathTo] = useState<{ id: number; label: string } | null>(null);
  const [path, setPath] = useState<PathHop[] | null>(null);
  const [pathMsg, setPathMsg] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.stats(), api.documents(), api.components(2)])
      .then(([s, d, c]) => {
        setStats(s);
        setDocs(d);
        setComponents(c);
      })
      .catch((e) => setErr(String(e)));
  }, []);

  const runSearch = useCallback(async (term: string) => {
    if (!term.trim()) return;
    try {
      setHits(await api.search(term, 20));
    } catch (e) {
      setErr(String(e));
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
    try {
      const [n, p] = await Promise.all([api.neighbourhood(e.id, depth, 200), api.provenance(e.id, 12)]);
      setNeighbours(n);
      setProv(p);
    } catch (x) {
      setErr(String(x));
    }
  }, [depth]);

  useEffect(() => {
    if (selected) {
      api.neighbourhood(selected.id, depth, 200).then(setNeighbours).catch((e) => setErr(String(e)));
    }
  }, [depth, selected]);

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
      setErr(String(e));
    }
  }, [selected, pathTo]);

  if (err) {
    return (
      <div className="border border-[var(--color-accent-red)] p-2">
        <div className="font-semibold text-[var(--color-accent-red)]">DIAGNOSTIC: REQUEST FAILED</div>
        <pre className="mt-1 whitespace-pre-wrap text-[11px]">{err}</pre>
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
            note="extract ratio = extracted text / source PDF bytes"
          >
            <table>
              <thead>
                <tr>
                  <th>slug</th>
                  <th>genre</th>
                  <th className="num">source</th>
                  <th className="num">text</th>
                  <th className="num">ratio</th>
                  <th className="num">entities</th>
                  <th className="num">mentions</th>
                </tr>
              </thead>
              <tbody>
                {docs.map((d) => (
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
            <p className="mt-2 text-[11px] text-[var(--color-ink-muted)]">
              The ratio is not a constant. A positioned form yields 0.048; dense
              regulation yields 1.089, because a PDF already compresses its own
              content streams. Source size does not predict database size.
            </p>
          </Section>

          <Section title="Entity search" note="exact &gt; punctuation-insensitive &gt; prefix &gt; trigram">
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
                placeholder="AC-1 / 5USC552 / Public Law 118"
              />
              <button type="submit">SEARCH</button>
            </form>
            <table>
              <thead>
                <tr>
                  <th>kind</th>
                  <th>label</th>
                  <th className="num">mentions</th>
                  <th className="num">docs</th>
                  <th className="num">score</th>
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

          <Section title="Connected components" note="pgr_connectedComponents, size >= 2">
            <table>
              <thead>
                <tr><th className="num">size</th><th>largest members</th></tr>
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
              <Section title="Shortest path" note="pgr_dijkstra, cost = 1 / co-citation weight">
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
                      <tr><th className="num">seq</th><th>kind</th><th>label</th><th className="num">agg cost</th></tr>
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
                      <th className="num">depth</th>
                      <th>kind</th>
                      <th>label</th>
                      <th>via document</th>
                      <th className="num">weight</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {neighbours.slice(0, 60).map((n) => (
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
              </Section>

              <Section title="Provenance" note="why this node exists">
                <table>
                  <thead>
                    <tr><th>document</th><th className="num">offset</th><th>source text</th></tr>
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
