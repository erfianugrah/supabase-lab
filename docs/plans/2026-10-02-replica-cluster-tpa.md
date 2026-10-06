# Third-party auth on a multi-node read cluster - plan

**Goal:** Test whether turning on third-party auth (an external IdP's JWKS
added to the data plane's verifiers) is safe on a topology where several
independent PostgREST nodes sit behind a router, each node verifying tokens
from its own copy of the key set, and where the nodes may run an older
PostgREST major than current managed projects.

**Topology under test (generic):**

```
client -> router -- GET  -> node A | node B | node C   (round robin)
                 \-- non-GET -> node A (primary)
node A: Postgres primary + PostgREST
node B, C: Postgres physical standby + PostgREST
```

Every node verifies JWTs locally from its own `jwt-secret` (a JWKS). The
router does not verify. A key that reaches some nodes and not others is
therefore visible only to the share of requests the router sends there.

**IdP under test:** a single `OKP` / `Ed25519` / `alg: EdDSA` signing key
published as a JWKS. Prior runs (third-party-auth TPA01, cross-project-auth,
key-rotation) used ES256 issuers only, so EdDSA acceptance is unmeasured
here.

**What prior runs already settle (do not re-derive):**
- Registering an issuer via `POST /config/auth/third-party-auth` adds trust
  and changes nothing for native GoTrue tokens (third-party-auth TPA03).
- `jwks_url` and `oidc_issuer_url` resolve almost immediately; `custom_jwks`
  never resolves (cross-project-auth X01).
- Trust create/delete takes effect in under 2 s each way (X02).
- The consumer's resolved key set is frozen at integration creation and
  does not follow issuer rotation (key-rotation R02).

---

## Hypotheses

| id | hypothesis | why it matters |
|---|---|---|
| H1 | PostgREST 11.2.0 verifies an EdDSA/Ed25519 token from a JWKS `jwt-secret`, as 12.2.3 and current do | an older major that cannot parse `OKP` keys would refuse every external token, or fail to load the JWKS at all |
| H2 | A JWKS holding the existing HS256 `oct` key plus the new `OKP` key still verifies existing HS256 tokens, with and without a `kid` header, on 11.2.0 / 12.2.3 / current | the no-regression question: adding a key must not break the tokens already in use |
| H3 | If the new key reaches only some nodes, GETs through the router succeed in proportion to updated nodes, while non-GETs follow the primary's state alone | defines the validation step: probe every node directly, not only through the router, because one probe through the router can pass by luck |
| H4 | A changed `jwt-secret` is picked up by a config reload without a restart on 11.2.0 (reload mechanism per version to be confirmed from that version's docs before RC04 is written); if a restart is needed, measure the per-node refusal window under load | sizes the risk of the change itself: zero-downtime reload versus a short per-node outage |
| H5 | On a managed project, an Ed25519 `jwks_url` issuer is accepted end to end on PostgREST, Storage and Realtime | extends TPA01 to EdDSA and closes the "Storage/Realtime never probed" gap |
| H6 | When the IdP rotates its Ed25519 key, a managed consumer keeps the old key set (R02 for a non-Supabase issuer) | an EdDSA IdP rotation has the same maintenance window as the Supabase-issuer case, or a shorter one |

## Not tested (cannot be reproduced here)

- Any operator-side mechanism that copies one project's auth config to the
  other projects in a cluster. RC05 shows what happens without one (each
  project holds only what was registered on it); whether a given real
  cluster has such a mechanism is a property of that environment, checked
  with the per-node probe from H3.
- Primary failure / promotion. Nothing here exercises failover.
- Any API gateway layer that does its own JWT verification. Verification is
  assumed to be in the services; H1-H4 isolate PostgREST.

---

## Rungs

**Local rung (H1-H4)** - no cloud resources.
- One Postgres primary plus two physical standbys on localhost ports, three
  PostgREST processes per version under test (11.2.0, 12.2.3, current),
  official static release binaries.
- A local IdP: Web Crypto Ed25519 keypair, JWKS file, minted tokens
  (`sub`, `role: authenticated`, `aud`, `exp`), plus an HS256 token signed
  with the "existing" secret.
- Router: the pg-router Worker (`~/work/pg-router`) under `bun run dev`
  (`wrangler dev`) with `PRIMARY_ORIGIN` = node A and `REPLICA_ORIGINS` =
  nodes B, C. It already implements the routing shape under test (GET/HEAD
  `/rest/v1/*` round robin tagged `x-sb-lb: 1`, everything else to the
  primary) and stamps `x-pg-router-via` on each response. It forwards
  `Authorization` unverified (`src/jwt.ts` only decodes `sub` for
  read-your-writes) and fails over only on 5xx or network errors
  (`src/index.ts` `restReadWithFailover`), so a 401 from a node missing the
  key reaches the client instead of being retried away. Run with
  `READ_YOUR_WRITES_MS=0`, `COLLAPSE_ENABLED=false` and
  `RATE_LIMIT_ENABLED=false` so nothing pins or merges requests. A stock
  load balancer may retry differently; RC03 measures pg-router's behaviour
  only. Two deliberate differences from a typical managed read-path
  balancer, kept in mind when reading RC03/RC05 shares: pg-router picks
  replicas round robin (a random pick gives the same expected share with
  more spread), and pg-router does no API-key handling of its own, so each
  upstream's own gateway handles `apikey` exactly as a direct request would.
  The replica list holds the non-primary nodes only, so GETs never land on
  the primary.
- Probes record per-request node, HTTP status and the PostgREST error code
  (`PGRST301` and friends), never the token.

**Managed rung (H5-H6)** - extend `experiments/third-party-auth`:
- TPA05: Ed25519 issuer via `jwks_url` -> PostgREST 200, Storage list,
  Realtime channel join with the external token; GoTrue `/auth/v1/user` 403
  as the control.
- TPA06: rotate the Ed25519 key at the issuer (Edge Function serves the new
  JWKS), poll PostgREST with new-key and old-key tokens for 20 min,
  record the consumer's `resolved_jwks` kids each probe (key-rotation R02
  shape).

## Modules

| id | rung | asserts |
|---|---|---|
| RC01 | local | per version: server starts with the mixed JWKS; EdDSA token 200; token signed by an unknown Ed25519 key 401 `PGRST301` (negative control) |
| RC02 | local | per version: HS256 token without `kid` 200, with `kid` 200, under the mixed JWKS; same tokens under the HS-only JWKS as baseline |
| RC03 | local | new key on node A only: 300 GETs via pg-router, success share per `x-pg-router-via` node; 50 POSTs to the primary; then direct probes to each node. Also asserts the 401s did not trip pg-router's circuit breaker (`GET /__admin/metrics` with `X-Admin-Key` from a throwaway `ADMIN_KEY` in `.dev.vars`: circuits stay `closed`), so a partial rollout surfaces as intermittent 401s rather than silent rerouting |
| RC04 | local | per version: rewrite `jwt-secret` on one node, reload, time to first EdDSA 200; repeat with restart under a steady GET load (rate chosen at run time, not a measured figure), record the refused-request window |
| RC05 | managed | three throwaway projects (A, B, C) with identical seeded schema, pg-router in front (`PRIMARY_ORIGIN` = A, `REPLICA_ORIGINS` = B, C). Register the Ed25519 issuer via `POST /config/auth/third-party-auth` on A only; 300 GETs via pg-router, success share per node; then register on B and C and repeat. Each project verifies with its own config, so this measures H3 on the managed data plane rather than on hand-configured PostgREST |
| TPA05 | managed | H5 |
| TPA06 | managed | H6 |

## Tracking ledger

| id | question | how | status |
|---|---|---|---|
| Q1 | Does 11.2.0 accept an `OKP`/Ed25519 JWKS and verify EdDSA | RC01 | open |
| Q2 | Do existing HS256 tokens survive the mixed JWKS on every version | RC02 | open |
| Q3 | Partial rollout through a GET round-robin router: what share fails | RC03 (local), RC05 (managed) | open |
| Q4 | Reload versus restart for a `jwt-secret` change, and the window | RC04 | open |
| Q5 | Ed25519 issuer end to end on managed PostgREST/Storage/Realtime | TPA05 | open |
| Q6 | Ed25519 issuer rotation on managed | TPA06 | open |

## Expected output

A RUNLOG entry per rung, an AGENTS.md key-facts block, and a short
pre-change checklist derived from the results: which version floor is
needed, how to probe each node directly, and whether the change needs a
restart window.
