import { KIND_COLOR, type Neighbour, type SubgraphEdge } from "../lib/api";

/**
 * Radial node-link view over demo.subgraph() output.
 *
 * No force layout, no library: the recursive CTE already ranks every node by
 * depth, so concentric rings ARE the honest layout - root at the centre,
 * depth-1 on the inner ring, depth-2 on the outer. Angles spread evenly per
 * ring, ordered by weight so the strongest links sit together at the top.
 * Deterministic: the same data always draws the same picture.
 *
 * Ring capacity is the real constraint, so it is stated rather than hidden:
 * at most `maxNodes` nodes by weight render, and the caller prints the count.
 */

export interface VizNode {
  id: number;
  x: number;
  y: number;
  r: number;
  depth: number;
  kind: string;
  label: string;
  weight: number;
}

export interface Layout {
  nodes: VizNode[];
  links: { a: VizNode; b: VizNode; weight: number }[];
  shown: number;
  total: number;
}

const W = 760;
const H = 520;
const CX = W / 2;
const CY = H / 2;
const RING: Record<number, number> = { 1: 150, 2: 225, 3: 225 };

export function layout(
  nodes: Neighbour[],
  edges: SubgraphEdge[],
  maxNodes = 40,
): Layout {
  // Strongest first, root always kept. Depth beyond 3 folds onto the outer
  // ring (the UI caps traversal at 3 anyway).
  const sorted = [...nodes].sort((a, b) => a.depth - b.depth || b.weight - a.weight);
  const kept = sorted.slice(0, maxNodes);
  const keptIds = new Set(kept.map((n) => n.id));
  const maxWeight = Math.max(1, ...kept.map((n) => n.weight));

  const byDepth = new Map<number, Neighbour[]>();
  for (const n of kept) {
    const d = Math.min(n.depth, 3);
    byDepth.set(d, [...(byDepth.get(d) ?? []), n]);
  }

  const placed = new Map<number, VizNode>();
  for (const [depth, ring] of byDepth) {
    if (depth === 0) {
      for (const n of ring) {
        placed.set(n.id, {
          id: n.id, x: CX, y: CY, r: 12, depth: 0, kind: n.kind,
          label: n.label, weight: n.weight,
        });
      }
      continue;
    }
    const radius = RING[depth] ?? 225;
    ring.forEach((n, i) => {
      // Start at twelve o'clock and go clockwise.
      const angle = (2 * Math.PI * i) / ring.length - Math.PI / 2;
      placed.set(n.id, {
        id: n.id,
        x: CX + radius * Math.cos(angle),
        y: CY + radius * Math.sin(angle),
        r: 4 + 9 * Math.sqrt(n.weight / maxWeight),
        depth,
        kind: n.kind,
        label: n.label,
        weight: n.weight,
      });
    });
  }

  // Real co-occurrence graphs have hubs (an attendance list cliques the whole
  // chamber), so drawing every edge draws a hairball: 120 nodes x 6561 edges
  // measured on the deepest councillor, 2026-08-14. Each node keeps only its
  // top 3 edges by weight - the picture shows the strongest ties, and
  // click-through does the walking.
  const perNode = new Map<number, number>();
  const links = edges
    .filter((e) => keptIds.has(e.source) && keptIds.has(e.target))
    .sort((a, b) => b.weight - a.weight)
    .filter((e) => {
      const s = perNode.get(e.source) ?? 0;
      const t = perNode.get(e.target) ?? 0;
      if (s >= 3 && t >= 3) return false;
      perNode.set(e.source, s + 1);
      perNode.set(e.target, t + 1);
      return true;
    })
    .map((e) => ({ a: placed.get(e.source)!, b: placed.get(e.target)!, weight: e.weight }))
    .filter((l) => l.a && l.b);

  return { nodes: [...placed.values()], links, shown: kept.length, total: nodes.length };
}

export default function GraphViz({
  nodes,
  edges,
  onOpen,
}: {
  nodes: Neighbour[];
  edges: SubgraphEdge[];
  onOpen: (node: VizNode) => void;
}) {
  const { nodes: placed, links } = layout(nodes, edges);
  if (placed.length <= 1) {
    return <p className="text-[var(--color-ink-muted)]">NO EDGES</p>;
  }
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full border border-[var(--color-hairline)] bg-[var(--color-bg)]"
      role="img"
      aria-label="entity neighbourhood graph"
    >
      {links.map((l, i) => (
        <line
          key={i}
          x1={l.a.x}
          y1={l.a.y}
          x2={l.b.x}
          y2={l.b.y}
          stroke="var(--color-hairline-strong)"
          strokeWidth={Math.min(3, 0.5 + l.weight / 8)}
        />
      ))}
      {placed.map((n) => (
        <g
          key={n.id}
          className="cursor-pointer"
          onClick={() => onOpen(n)}
        >
          <title>{`${n.label} (${n.kind}, depth ${n.depth}, weight ${n.weight}) - click to open`}</title>
          <circle
            cx={n.x}
            cy={n.y}
            r={n.r}
            fill={n.depth === 0 ? "var(--color-ink)" : (KIND_COLOR[n.kind] ?? "var(--color-ink-muted)")}
          />
          <text
            x={n.x}
            y={n.y + n.r + 10}
            textAnchor="middle"
            className="fill-current text-[10px]"
          >
            {n.label.length > 22 ? `${n.label.slice(0, 21)}...` : n.label}
          </text>
        </g>
      ))}
    </svg>
  );
}
