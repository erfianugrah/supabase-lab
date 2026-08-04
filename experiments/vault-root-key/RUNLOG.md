# RUNLOG - vault-root-key

Two projects, no AWS. Answers the one item in the migration guides that has
no recovery path if it is wrong: does a Vault secret survive being carried to
a different project, and is the published rescue for its encryption root key
real?

The guide currently tells a reader that the root key can be retrieved from
`GET /v1/projects/{ref}/pgsodium`, applied to the target project, and that the
window closes permanently when the source is deleted. None of those three has
ever been called in a lab, and the middle one - the recovery step - is stated
without an endpoint or a method at all.

## What is being separated

The interesting design point is that the NEGATIVE test comes first and is the
one that makes everything else interpretable.

| id | state | expectation |
|---|---|---|
| V01 | both projects fresh | `/pgsodium` returns a root key, and the two projects' keys differ |
| V02 | ciphertext copied, key NOT carried | decrypt is refused |
| V03 | root key applied to the target | the same ciphertext now decrypts |
| V04 | source project destroyed | the key is no longer retrievable |

Run V03 first and there is no way to distinguish "the key mattered" from "the
ciphertext was portable all along". The planner sorts by id inside the
destructive tier, so V02 always precedes V03; that ordering is a property of
the harness, not of the Makefile, and should not be worked around.

If V02 PASSES in the sense of decrypting without the key, the guide's most
urgent warning is wrong and V03 is moot. That outcome is recorded as a `fail`
of the claim, not treated as an error to retry away.

## V03 probes rather than asserts

The guide's recovery step is "apply that value to the target project's
pgsodium config" - no verb, no path, no footnote. Calling one guessed endpoint
and reporting 404 would produce a confident wrong conclusion ("there is no way
to do this") when the truth might be a different verb or field name. So V03
tries PUT, PATCH and POST against `/projects/{ref}/pgsodium` and records every
status. Either outcome is publishable:

- one is accepted -> the guide can finally name a method
- all refuse -> the published rescue path has no `/v1` surface, and the guide
  should say so rather than implying a one-liner exists

Acceptance is checked against effect, not status code. A 2xx that changes
nothing is a real failure mode on this platform - `custom_jwks` in
cross-project-auth returns 201, echoes the key material back intact, and never
resolves - so V03b re-runs the decrypt instead of trusting the write.

## V04 is a separate pass, deliberately

It needs the source project to NOT exist. The deletion goes through
`tofu -target` (`make probe-deleted-source`), not a DELETE call, so state stays
truthful and a later `make destroy` is still a clean no-drift run. The dead ref
is captured BEFORE the destroy and passed as `PVLAB_DEAD_REF`: afterwards
`tofu output -raw source_ref` is empty, and probing an empty ref would return a
cheerful 404 that means nothing.

## Secret hygiene

The root key value never enters a measurement, a detail string, or the
evidence blob - only its length, character class, and a hash. `evidence/` is
gitignored, but a live encryption root key is not something to put in a file
that is one `git add -f` away from a public repo. V01 compares the two
projects by digest, which answers "same key?" without either run holding the
plaintext.

## Runs

_(none yet - scaffold committed ahead of the first run)_

## Cost / teardown

Two Micro projects, well under an hour. `make destroy`. Note that after
`make probe-deleted-source` the source is already gone, so the final destroy
removes the target only.
