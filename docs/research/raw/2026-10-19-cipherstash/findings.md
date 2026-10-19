# CipherStash public-source findings (fetched 2026-10-19)

Context for experiments/cipherstash-eql. Pinned sources:
cipherstash/encrypt-query-language@9f45c275c4531cabe70321018533c74b66bd1f16 (archived, moved),
cipherstash/stack@66092fe450b555353a138d0d104f204cfcf255b1. Docs corpus:
https://cipherstash.com/docs/llms-full.txt

## EQL install

- One SQL file per release (`cipherstash-encrypt.sql`); eql-3.0.6 (2026-10-03) is in the stack monorepo: https://github.com/cipherstash/stack/releases/tag/eql-3.0.6
- No superuser except the optional block-ORE operator class; on 42501 the installer skips it and disables the ORE domains: https://github.com/cipherstash/encrypt-query-language/blob/9f45c275c4531cabe70321018533c74b66bd1f16/docs/reference/permissions.md#L23-L51
- Installer issues no GRANTs; runtime roles need USAGE/EXECUTE on `eql_v3` and `eql_v3_internal` (same file, "Granting access").
- Needs pgcrypto in `extensions` or `public`: https://github.com/cipherstash/encrypt-query-language/blob/9f45c275c4531cabe70321018533c74b66bd1f16/packages/eql/sql/cipherstash-encrypt.sql#L280-L312
- "There is no separate Supabase build of EQL": https://github.com/cipherstash/encrypt-query-language/blob/9f45c275c4531cabe70321018533c74b66bd1f16/SUPABASE.md#L3-L10
- CI covers Postgres 14-17: https://github.com/cipherstash/encrypt-query-language/blob/9f45c275c4531cabe70321018533c74b66bd1f16/.github/workflows/test-eql.yml#L84-L104

## Offline ciphertext

- `FakeDataKeySource`: "round-trip without ZeroKMS credentials or network access", "models none of ZeroKMS's authorization semantics": https://github.com/cipherstash/stack/blob/66092fe450b555353a138d0d104f204cfcf255b1/packages/stack-kms/src/key_source.rs#L117-L160
- The TS SDK, CLI and Proxy need `CS_*` credentials or a device login; "ZeroKMS is a hosted service": https://cipherstash.com/llms.txt

## supabase-js wrapper limits (vendor docs)

- Equality, range and ordering only; no encrypted free-text or JSON through PostgREST; the filter operand is a full stored envelope in the GET query string, "configure application and proxy logs not to retain query strings"; `.csv()` throws: https://cipherstash.com/docs/integrations/supabase/supabase-js
- Keep RLS predicates on plaintext columns; a privileged direct connection may bypass RLS: https://cipherstash.com/docs/integrations/supabase

## Binary data

- No bytes plaintext type: https://github.com/cipherstash/stack/blob/66092fe450b555353a138d0d104f204cfcf255b1/languages/typescript/packages/protect-ffi/crates/protect-ffi/src/js_plaintext.rs#L36-L59 ; EQL scalars: https://cipherstash.com/docs/reference/eql/core-concepts
- "CipherStash does not replace disk, volume, object, or backup encryption; those layers protect different failure modes.": https://cipherstash.com/docs/concepts/compare/aws-kms
- No doc covers envelope encryption of a data key with CipherStash.

## ZeroKMS

- Key split: ZeroKMS holds an authority key, the application holds a client key; a unique data key per value is derived in the application and never stored or sent: https://cipherstash.com/docs/concepts/key-management
- Regions listed: ap-southeast-2, eu-central-1, eu-west-1, us-east-1, us-east-2, us-west-1, us-west-2; AWS only; one workspace per region, data encrypted in one region cannot be decrypted in another: https://cipherstash.com/docs/solutions/data-residency
- Deployment: a legacy page says "It can also be deployed within your own cloud account or on-prem" (https://cipherstash.com/docs/stack/cipherstash/kms.mdx); the current docs describe a hosted service (https://cipherstash.com/llms.txt). The two disagree; no self-hosting procedure is documented.
- Outage: "While ZeroKMS is unavailable, your applications cannot perform cryptographic operations": https://cipherstash.com/docs/stack/cipherstash/kms/disaster-recovery
- Every encrypt or decrypt call (or bulk batch) needs ZeroKMS to participate in key derivation: https://cipherstash.com/docs/concepts/key-management

## Licences

- stack monorepo root, EQL, protect-ffi: MIT. `stack-encrypt`, `stack-kms`, `cipherstash-client`, Proxy: PolyForm Internal Use 1.0.0.
