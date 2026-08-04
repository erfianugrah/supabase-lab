# RUNLOG - tenant-promotion

Two Supabase projects, no AWS. Answers the question a tiered-tenancy
architecture turns on: when a tenant is promoted from a shared project to
its own dedicated one, can a client that learns its placement at runtime
follow without re-authenticating?

`shared` plays the starting tier - the project a tenant is promoted OUT of.
`dedicated` plays the destination - the tenant's own project. The harness
passes `ctx.ref` as the shared project (because it is the "subject" in
harness terms) and `ctx.peers.dedicated` as the destination.

This is a port of two live-run bash experiments from 2026-08-04. The
findings are recorded elsewhere; what lives here is the mechanism - typed
test modules in the repo's idiom, provisioned with OpenTofu, with teardown
that cannot leak billable resources.

## Tests (P01-P04)

All four are `where: "local"` because every question is about what the auth
tier and Management API accept over the public internet. No VPC, no runner,
no endpoint; the PAT and two project refs are the whole input. All
`destructive` because every test writes schema, auth rows, or both.

### P01 - promotion carries the tenant, and the client finds it

The positive case. Tenant A reads its rows on the shared project; its auth
rows are copied to the dedicated project in FK order (users -> identities
-> sessions -> refresh_tokens, with the target assigning its own
`refresh_tokens.id`) and `auth.refresh_tokens_id_seq` is resynced;
the refresh token the client ALREADY HELD
mints a session at the dedicated project with no password grant; it reads
its row there.

Two mandatory controls:
- A second tenant (B) is unaffected by the promotion.
- The old placement is probed after the move: it still serves. That is the
  finding, not a bug - promotion that copies is a different risk profile
  from one that cuts over.

### P02 - MFA survives promotion

A real TOTP factor is enrolled on the shared project and verified with a
computed code (HMAC-SHA1, 30s step, 6 digits, RFC 6238). After the auth
rows are promoted, the SAME secret produces a code that verifies at the
dedicated project. The resulting token's AAL is recorded.

A TOTP secret that needs to be re-enrolled after promotion breaks every
MFA-requiring client, which would quietly exclude MFA users from the
zero-re-login result.

### P03 - retiring the source identity

After the user is promoted, the source user is deleted via the admin API.
Four probes follow:

1. Password grant at the source - must be refused.
2. Previously-issued refresh token at the source - must be refused.
3. Password login at the dedicated project - must still work (target
   unaffected).
4. The tenant's application rows at the source - must still exist. Identity
   retires, data does not.

### P04 - ref-hiding without a proxy

Probes the Management API's vanity-subdomain endpoints
(`check-availability`, `activate`) on the dedicated project. A refusal is a
recorded result with its status code, never a thrown error. The predecessor
bash script read check-availability's 201 as a refusal and skipped
activate, which is why this test exists.

## What the first live run changed

The port went green on the offline gates and then failed twice against real
projects, which is the argument for running it.

1. `auth.refresh_tokens.user_id` is `character varying`, not `uuid`. The copy
   predicate compared it against a subquery returning `uuid`, so the dump
   errored - and because an INSERT of zero rows succeeds, the copy reported a
   pass having moved nothing. `copyTable` now returns the dump result and a
   failed read can no longer read as an empty-but-successful copy.
2. Do not carry the source's surrogate id for `auth.refresh_tokens`. It is a
   bigserial, and a target that has seen any prior auth activity already
   occupies the low ids, so the insert dies on `refresh_tokens_pkey`. The
   token string is what the client presents; the id belongs to the target.
   The predecessor bash never hit this because it created a fresh project per
   run and destroyed it afterwards - the collision only appears when the same
   pair is probed twice, which this repo does by design.
3. The vanity endpoint wants a bare subdomain LABEL. A dotted hostname is
   rejected 400 before availability is evaluated.

Emails are randomised per run for the same reason: `adminCreate` 422s on a
duplicate address, so constant addresses make a module pass exactly once
against a given pair of projects.

## Provisioning

Two Micro projects in ap-southeast-1, as the sibling experiments use.
Placeholders for the shared AWS variables block (aws_account_id,
aws_access_key_id, aws_secret_access_key, breakglass_cidr) so tofu accepts
the root secrets.tfvars.

## Conventions

- Management API client: `import { mgmt } from "../../../harness/src/mgmt"`.
  No hand-rolled second copy.
- Peer refs come from `ctx.peers.dedicated`, not `process.env`. Each module
  self-skips with a reason naming `PVLAB_PEER_DEDICATED` when the peer is
  absent.
- `measurements` values are `number | string` only. Booleans coerced with
  `String()`.
- A measured `fail` is data, never retried to green. A control that could
  not establish its precondition yields `skip`, not `pass`.
- Ids sort within the destructive tier: P01 runs before P02/P03 (which
  depend on the promotion mechanism being set up).
- No account-specific identifiers anywhere in tracked files.
- Secrets never enter a measurement, detail, or evidence string.

## What this does NOT answer

- Whether the promotion mechanism works with OAuth/OIDC identities.
  Password-only was tested here.
- The `public.items` sequence after promotion. `auth.refresh_tokens_id_seq`
  IS resynced (see lib/promote.ts), because GoTrue rotates the refresh token
  on every use so a stale sequence breaks the tenant's next refresh. The
  application table's own sequence is not - a first INSERT after promotion
  would collide, and a real promotion has to handle that too.
- The cross-project-auth approach (third-party trust) as an alternative to
  row-copy promotion. That is tested in experiments/cross-project-auth/ and
  answers a different question: "can a token be trusted across projects"
  rather than "can the identity be moved".
- Refresh behaviour after source retirement. P03 confirms the source stops
  issuing; the dedicated project's refresh path is tested in P01.
- Any cost or latency comparison between the two approaches. This is a
  correctness experiment.