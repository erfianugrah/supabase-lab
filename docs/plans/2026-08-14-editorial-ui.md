# demo UI: the editorial surface (as-at bridging, timelines, registry pins)

> **STATUS 2026-08-14: PLANNING.** Depends on `2026-08-14-editorial-graph-layer.md`
> (Slice A) having landed: the RPCs it adds are this slice's data sources.
> Implements Track E2 of the demo-readiness plan. Companion loop plan:
> `2026-08-14-editorial-ui-loop.md` (same conventions as the editorial-layer
> loop: local model writes, frontier model judges).

**Goal:** the demo headliness people and organisations with a time axis, not
citations. Tables and lists still (the node-link renderer is the NEXT slice);
this slice rewires the existing surfaces onto the editorial RPCs.

## Current state (post-Slice A, measured)

- demo.entity_timeline(entity), demo.neighbourhood_as_at(root, as_of, ...),
  demo.bridges_as_at(as_of, lim), demo.entity_registry_ids(entity) exist,
  granted to anon, exposed via PostgREST.
- Entity kinds now include person, org, abn alongside the four citation kinds.
- The demo UI knows only the four citation kinds (KINDS/KIND_LABEL/KIND_COLOR
  in demo/src/lib/api.ts) and renders dates nowhere.

## Work

0. PostgREST named-argument calling: the NEW RPCs use p_-prefixed parameter
   names (p_entity, p_as_of, p_lim), the OLD seven are unprefixed (root, lim,
   q, ...). The rpc() helper passes the args object verbatim, so each client
   method must use the right convention - check 04-api.sql/08-editorial.sql
   before writing the call.
1. `demo/src/lib/api.ts`: KIND_LABEL + KIND_COLOR for person/org/abn (distinct,
   muted, utilitarian - no new CSS variables if the existing scale has slots);
   zod schemas + client methods for the four new RPCs (parse, never cast).
2. `demo/src/components/Explorer.tsx`:
   - The bridging panel gets an "as at YYYY-MM-DD" date input. Set: calls
     bridgesAsAt. Empty: cross_document_entities as today. The date uses the
     native <input type="date"> - no picker library.
   - Entity detail gains a Timeline section (entity_timeline, date-ordered,
     snippet + doc slug per row) and, when entity_registry_ids returns rows,
     a Registry identifiers subsection shown as the deterministic pin.
   - The kind filter chips include the new kinds.
3. `demo/README.md`: the API table gains the four new RPCs.
4. No new dependencies. No wrangler deploy (the operator deploys after
   review).

## Out of scope

GraphViz / node-link rendering (next slice), seed/db changes, anything under
tests/ or lib/.
