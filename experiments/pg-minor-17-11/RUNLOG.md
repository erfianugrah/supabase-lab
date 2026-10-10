# pg-minor-17-11 - RUNLOG

Local only: throwaway containers on one Docker Desktop VM, no managed project,
no PAT, no tofu state, no cloud spend. README.md has the question and the
method; this file is the per-run record. Measured values are separated from
what the public documents say; anything not run is labelled "not measured".
Version strings below come from tool output in the run session (`docker info`,
`select version()`, the cited pages), not from recall.

## 2026-10-10 - PG00 to PG05, three full runs (n = 3)

Vantage: Docker Desktop on an Apple-silicon Mac (`docker info`: server 29.8.2,
kernel 7.0.14-linuxkit, 10 CPUs, 8.2 GB for the VM), linux/arm64 images (all
PostgreSQL builds report `aarch64-unknown-linux-gnu`). One container at a time
on loopback.

Images (public Docker Hub `supabase/postgres`, pinned in `lib/rig.ts` by
manifest-list digest, resolved 2026-10-10):

| pair | old image (before the minor) | new image (after the minor) |
|---|---|---|
| 17 | `17.6.1.178`, server 17.6 | `17.11.0.004`, server 17.11 |
| 15 | `15.14.1.178`, server 15.14 | `15.19.0.004`, server 15.19 |

The old tag is the last build of the old minor line on Docker Hub on
2026-10-10 (`17.6.1.178` was published 2026-09-28), not the build any hosted
project ran.

Upgrade model: the old image creates the data directory and the fixture, is
stopped with a fast shutdown, and the new image starts on the SAME data
directory. That reproduces "binaries replaced, data kept". It is not the
hosted upgrade procedure, which this run did not touch.

Artifacts (redacted copies of the raw runs, each with a `.facts.md` beside it):

- run A `out/2026-10-10/run-2026-10-10T00-26-34-618Z.json`
- run B `out/2026-10-10/run-2026-10-10T00-29-13-701Z.json`
- run C `out/2026-10-10/run-2026-10-10T00-31-54-766Z.json`

Each holds 12 results (PG00, PG01 to PG05, one per pair): 8 pass, 2 fail
(both PG05, see below), 2 info (PG00). The artifact's `labCommit` is the repo
HEAD underneath the run (this experiment was uncommitted), and its `region`
field is the harness default; neither says anything about the run. Of 508
measurement cells, run B differs from run A in 20 and run C differs from run A
in 19, all of them index-layout noise listed per module below. Smoke-test runs
of single modules earlier the same day are in the gitignored `evidence/` and
are unpublished and not quoted.

Sources the documents-side statements come from:

- Supabase changelog, 2026-09-25: https://supabase.com/changelog/postgres-15-19-17-11-breaking-changes
- PostgreSQL release notes, pages `docs/17/release-17-11.html` and
  `docs/15/release-15-19.html` (this minor) and `docs/current/release-18-2.html`
  (the "current" docs page for major 18), all on www.postgresql.org, read
  2026-10-10
- upstream source at the tags `REL_17_6`, `REL_17_11`, `REL_15_14`,
  `REL_15_19` of github.com/postgres/postgres, read via raw.githubusercontent.com
  on 2026-10-10 (file checksums below).

### PG00 - what the images are

| | 17.6 image | 17.11 image | 15.14 image | 15.19 image |
|---|---|---|---|---|
| default `postgres` database locale provider | icu | icu | libc | libc |
| collation, encoding | en_US.UTF-8, UTF8 | en_US.UTF-8, UTF8 | en_US.UTF-8, UTF8 | en_US.UTF-8, UTF8 |
| amcheck / ltree / btree_gist / pgcrypto default version | 1.4 / 1.3 / 1.7 / 1.3 | 1.4 / 1.3 / 1.7 / 1.3 | 1.3 / 1.2 / 1.7 / 1.3 | 1.3 / 1.2 / 1.7 / 1.3 |
| `gist_index_check` present | no | no | no | no |
| `postgres` role is superuser | false | false | false | false |
| ltree library md5 (first 12) | c5f93a537ffa | faba1133d2b1 | c4b6ea8a3254 | a8e6c142c8ad |
| btree_gist library md5 | bea8d206c3c7 | 48d3267d67b8 | 9e77fc878bbe | 6fa4030c82c0 |
| pgcrypto library md5 | dd6f9a70a0ed | a91529606bd8 | 7190d1802b1d | 8bf659d605cb |

The extension libraries differ between the old and new image in both pairs
(`lib_ltree_differs`, `lib_btree_gist_differs`, `lib_pgcrypto_differs` all
`yes`). amcheck on these images knows only the B-tree checks, so no GiST index
in this run was checked by amcheck. The hosted project's database locale is
not measured here.

### PG01 - pgcrypto bf / blowfish / cast5 (pass, both pairs, 3 of 3 runs)

Fixture: `pgp_sym_encrypt` of one fixed sentence under key K1 with
`cipher-algo` = bf, blowfish, cast5, aes128, aes256, 3des and no option, on the
old image; the same stored bytes read on the new image. "Plaintext visible"
means the sentence appears in the ciphertext bytes (`compress-algo=0`).

| cipher | old: plaintext visible | old: right key | old: WRONG key | new: right key, default | new: WRONG key, default | new: right key + `ignore-cipher-failure=1` | new: WRONG key + option | new: fresh encrypt |
|---|---|---|---|---|---|---|---|---|
| bf, blowfish, cast5 | yes | decrypts | decrypts | error 39000 `encrypt error: Cipher cannot be initialized` | the same error | decrypts | decrypts | the same error |
| aes128, aes256, 3des, no option | no | decrypts | error 39000 `Wrong key or corrupt data` | decrypts | `Wrong key or corrupt data` | decrypts | `Wrong key or corrupt data` | ok |

The same table holds for the 17 pair and the 15 pair, and for each of the
three runs. Further cells (run A, PG01-pg17 and PG01-pg15):

- The old image does not know the decrypt option: `ignore-cipher-failure=1`
  on the old image answers `Illegal argument to function`
  (`old_accepts_ignore_cipher_failure`). The option exists only after the
  upgrade.
- Detection by decrypting every stored value with a wrong passphrase: on the
  old image it flags exactly `bf,blowfish,cast5` (`old_scan_flagged`). On the
  new image by default it flags nothing (`new_scan_default_flagged = (none)`)
  because those values now raise an error like a properly encrypted value does;
  the two error texts differ (`Cipher cannot be initialized` against `Wrong
  key or corrupt data`). With the option set it flags exactly
  `bf,blowfish,cast5` again (`new_scan_with_option_flagged`).
- Remediation on the new image: decrypt with the option and re-encrypt with
  `cipher-algo=aes256`. The 3 re-encrypted rows decrypt with the right key,
  refuse a wrong key, and the sentence is not visible in the bytes
  (`new_reencrypted_*`).

Documents' claim, same entry of the changelog: data encrypted with these
ciphers "was effectively stored unencrypted", decryption "succeeds even with
the wrong key", it "fails to decrypt by default after the upgrade" and is
"recoverable with the ignore-cipher-failure=1 decrypt option". Each of those
statements reproduced on both pairs. The upstream release notes for this
minor give the mechanism (a cipher that could not be initialised, for example
because OpenSSL's legacy provider is not loaded, was not noticed and the
block was XORed with the plaintext); this run did not look at the OpenSSL
provider state, so the mechanism is the upstream note's reading, not a
measurement.

Not measured: `pgp_pub_encrypt` / `pgp_pub_decrypt` (no OpenPGP key pair
generator in the image; the changelog says the wrong-key probe does not apply
to public-key messages), the `_bytea` variants, any hosted project.

### PG02 - CREATE OPERATOR with a non-built-in estimator (pass, both pairs, 3 of 3 runs)

Estimators used: ltree's `ltreeparentsel` as RESTRICT and intarray's
`_int_overlap_joinsel` as JOIN (functions an extension installs, owned by a
superuser; the first is safe to plan with, the second is never planned), plus a
C-language wrapper function over intarray's `_int_matchsel` that
`supabase_admin` created in another schema. The vulnerable estimator named by
the CVE entry is never executed.

| step (role) | old image | new image |
|---|---|---|
| CREATE OPERATOR with `eqsel` / `eqjoinsel` (postgres) | ok | ok |
| ... RESTRICT = ltreeparentsel (postgres) | ok | `42501 must be superuser to specify a non-built-in restriction estimator function` |
| ... JOIN = `_int_overlap_joinsel` (postgres) | ok | `42501 must be superuser to specify a non-built-in join estimator function` |
| ... RESTRICT = the C wrapper (postgres) | ok | the same `42501` restriction error |
| ALTER OPERATOR ... SET (RESTRICT = ltreeparentsel) (postgres) | ok | the same `42501` restriction error |
| ALTER OPERATOR ... SET (RESTRICT = eqsel) (postgres) | ok | ok |
| the three non-built-in creations (supabase_admin) | ok (wrapper) | ok, ok, ok |
| CREATE FUNCTION ... LANGUAGE c (postgres) | `42501 permission denied for language c` | the same |

Existing operators: the two operators `postgres` created on the old image with
`ltreeparentsel` and `_int_overlap_joinsel` are still present after the swap
(`pg_operator` shows them) and an `EXPLAIN` and a `count(*)` over the
restrict-estimator one succeed as `postgres` (`ok (2 plan lines)`, `ok (count
1)`). The detection query used here (operators outside `pg_catalog` with a
non-system estimator that no extension owns) lists 4 operators on both images.

Dump and restore (the "branching, dump/restore" path in the changelog):
`pg_dump -s` of the schema from the new server holds 3 operators (one built-in
estimator, one RESTRICT, one JOIN). Restored as `postgres` into a fresh
database: 2 errors, first `must be superuser to specify a non-built-in join
estimator function`, and 1 of 3 operators present. Restored as
`supabase_admin`: 0 errors, 3 of 3 present.

Documents' claim: "Only superusers may now attach a non-built-in selectivity
estimator"; "Existing operators keep working. Only re-creation (dump/restore,
branching, major-version upgrade) fails". Reproduced for dump and restore on
both pairs. Not measured: a hosted branch, a platform major-version upgrade,
extension-installed operators of PostGIS or others (the changelog says they
are unaffected; here only the creation of ltree and intarray in the target
database as `postgres` worked, which is a weaker statement).

### PG03 - btree_gist NaN, float4 and float8 (pass, both pairs, 3 of 3 runs)

Fixture per type: 2000 ordinary values, 50 NaN, 5 Infinity (2055 rows), a GiST
index built on the old image, 10 predicates counted by sequential scan and by
index scan. Cells below are counts at four stages (old image, new image stale,
new image after `REINDEX INDEX CONCURRENTLY`, new image fresh index), run A,
float8 (float4 is the same for the NaN rows):

| predicate | sequential count (all stages) | idx: old | idx: new stale | idx: new reindexed | idx: new fresh |
|---|---|---|---|---|---|
| `x = 'NaN'` | 50 | 0 | 0 | 50 | 50 |
| `x >= 'NaN'` | 50 | 0 | 0 | 50 | 50 |
| `x < 'NaN'` | 2005 | 0 | 2005 | 2005 | 2005 |
| `x <= 'NaN'` | 2055 | 0 | 2055 | 2055 | 2055 |
| `x > 'NaN'`, `x = 5`, `x <= 10` | 0, 1, 10 | equal | equal | equal | equal |

Predicates with a wrong index count (idx differs from seq), of 10, per type
and stage, identical in all three runs: float4 5 old, 3 stale, 0 reindexed, 0
fresh; float8 7 old, 5 stale, 0 reindexed, 0 fresh. Stale-index lists: float4
`eq_NaN, ge_NaN, ge_Infinity`; float8 `eq_NaN, ge_NaN, gt_1000, ge_1999,
ge_Infinity`. The NaN-equality counts are stable; the stale counts for the
range predicates move with how the index was laid out. Ranges over runs A, B,
C on the stale index, 17 pair: float8 `x >= 1999` 53, 37, 45 (true 57); float4
`x >= 'Infinity'` 50, 45, 45 (true 55). 15 pair: float8 `x >= 1999` 39, 49, 38.
`REINDEX INDEX CONCURRENTLY` ran without error on both types and both pairs.
A detection query for GiST indexes on `gist_float4_ops` / `gist_float8_ops`
returned the one index per type.

Documents' claim: indexes built before the upgrade "can return wrong results
for rows containing NaN until reindexed" and `REINDEX INDEX CONCURRENTLY` is
the remedy. Reproduced on both pairs; the old image's own index was already
wrong, so the wrongness predates the upgrade and the stale index on the new
image only partly improves (the sequential scan gives the true answer at both
stages). Not measured: other btree_gist opclasses (numeric, text, ...),
multicolumn keys, any hosted project.

### PG04 - ltree values with more than about 14,653 labels (pass, both pairs, 3 of 3 runs)

Sweep: `text2ltree('a.a. ... .a')` of n labels against the one-label `'a'`
(true answer: greater), n = 14640 to 14670, 20000, 40000, 65535 (34 values).

| | old image | new image |
|---|---|---|
| first n answering "not greater" | 14655 | none |
| values answering wrongly | 19 of 34 | 0 of 34 |

Both pairs, all runs. Fixture for the index part: 453 rows, all-`a` chains of
1 to 400 labels, 1000 to 14000 (steps of 500) and 14660 to 14760 (steps of 4)
labels, a B-tree built on the old image. Every value is a chain of `a`, so
the true order is `nlevel()` and the truth for each predicate is a count over
`nlevel()`. Detection used here, `nlevel(p) > 14653`: 26 rows.

| predicate | truth | seq old / stale / reindexed / fresh | idx old / stale / reindexed / fresh |
|---|---|---|---|
| `p >` a 3-label value | 450 | 424 / 450 / 450 / 450 | 0 / 450 / 450 / 450 |
| `p >` the 14660-label value | 25 | 25 / 25 / 25 / 25 | 25 / 25 / 25 / 25 |
| `p <` the 1000-label value | 400 | all 400 | all 400 |
| `p =` the 14700-label value | 1 | all 1 | all 1 |

amcheck on the B-tree (`bt_index_check(index, true)` and
`bt_index_parent_check(index, true, true)`), both pairs:

| stage | `bt_index_check` | `bt_index_parent_check` |
|---|---|---|
| old image, index just built | ok | `XX002 could not find tuple using search from root page in index "dd_bt"` |
| new image, stale | ok | ok |
| new image, after REINDEX CONCURRENTLY | ok | ok |
| new image, fresh index | ok | ok |

Reading, limited to this fixture: on the old image the comparison gave wrong
answers (a 3-label predicate counted 424 by scan and 0 by index against a
truth of 450), and the index built on it failed the parent check. On the new
image the stale index passed both amcheck functions and answered every
predicate correctly. Two readings fit that last result: the stale tree
happens to be ordered consistently with the corrected comparison for this
fixture, or the fixture's shape hides a violation. The separating probe
(other value mixes, more rows, an index with deep values on interior pages)
was not run, so "stale index is safe" is not established. The changelog's and
upstream's advice is to reindex any index that holds such values.

Documents' claim: more than about 14,653 labels "could compare incorrectly,
which can corrupt B-tree indexes". The upstream notes for this minor say the
same ("probably corrupt"). The first wrong n, 14655, matches that threshold.
Not measured: long-label overflows below 14,653 labels, ltree GiST indexes on
deep values, a hosted project.

### PG05 - ltree GiST index against the operator, case-insensitive labels (fail, both pairs, 3 of 3 runs)

This is the one entry of the changelog that did not reproduce, and the
measurement is the opposite of the documented remedy.

Fixture per database: 300 words of 4 to 6 letters from an alphabet of ASCII
and accented letters in both cases (fixed seed), 6 named probe rows, 20000
filler rows (20306 rows), a GiST index with `siglen = 2000` built on the old
image. For each word, `p ~ 'WORD@'` and `p ~ 'word@'` (600 queries per stage)
are counted by sequential scan (the operator) and by index scan. Each stored
word matches both queries by the operator, so a lower index count is a row the
index failed to return. Databases: the default `postgres` database (ICU on the
17 pair, libc on the 15 pair, per PG00) and a second libc `en_US.UTF-8`
database. Run A; runs B and C in brackets where they differ.

| database, pair | queries with rows missing from the index: old image | new stale | new reindexed | new fresh |
|---|---|---|---|---|
| default db, 17 (ICU) | 437 of 600 | 437 | 437 [436, 436] | 437 [436, 437] |
| libc db, 17 | 437 [435, 436] | 437 [435, 436] | 437 [437, 438] | 437 [437, 438] |
| default db, 15 (libc) | 437 [438, 437] | 437 [438, 437] | 437 [437, 433] | 437 [436, 437] |
| libc db, 15 | 435 [436, 437] | 435 [436, 437] | 437 [436, 436] | 437 [437, 437] |

In every cell the index returned too few rows and never too many
(`*_idx_extra_rows` 0 of 600). Roughly 72 percent of the queries lose rows
before the upgrade, after it, after `REINDEX INDEX CONCURRENTLY`, and on an
index built from scratch on the new image. The pattern behind the number
(from an exploratory session, not from the artifact): a missing row is a
stored word whose accented letters are in a different case from the query's,
for example a stored word with uppercase accented letters against the same
letters lower-cased in the query. A query that matches the stored case
returns every row.

Operator side, named probes (seq / idx, run A, identical in B and C):

| probe | default db 17 (ICU) | libc db 17 | default db 15 (libc) | libc db 15 |
|---|---|---|---|---|
| `(U+0130)STANBUL@`, old image | 1 / 1 | 1 / 1 | 1 / 1 | 1 / 1 |
| `(U+0130)STANBUL@`, new image, all three index states | 1 / 1 | 3 / 1 | 3 / 1 | 3 / 1 |
| `istanbul@`, new image, all three index states | 2 / 2 | 3 / 2 | 3 / 2 | 3 / 2 |
| `(U+00C9)CLAIR@.(U+00D1)AND(U+00DA)@`, every stage | 2 / 0 | 2 / 0 | 2 / 0 | 2 / 0 |

So on libc databases the operator's answer changed across the minor (U+0130 now
folds so that `(U+0130)STANBUL@` matches three stored rows instead of one) while the
index still returned one, before and after REINDEX; on the ICU database the
operator's answer did not change. Across the 600 random-word queries the
sequential counts changed in 0 of 600 on both images
(`*_seq_counts_changed_old_to_new`), because the alphabet has no U+0130.

Source reading (not measured; fetched 2026-10-10): `contrib/ltree/crc32.c`,
the function that hashes labels into the GiST signature (lower-casing byte by
byte with `tolower`), has the same md5 prefix `95b400b4` at `REL_15_14`,
`REL_15_19`, `REL_17_6` and `REL_17_11`. `contrib/ltree/lquery_op.c`, the
operator side, has different checksums between the old and new tag in both
lines. The release-18-2 page describes a fix that makes the index routines
use the database's default collation and requires reindexing ltree indexes.
The release-17-11 and release-15-19 pages list only the integer-overflow
entry under ltree for this minor. A search of the release-17-8 and
release-17-9 pages for "ltree" returned nothing; the release-17-10 and
release-15-18 pages have an entry about case-folding changing a string's byte
length and the release-15-16 page one about multibyte handling, neither an
index-hash change. The reading that fits all of it: the index-side change the
changelog describes is the one on the release-18-2 page, and the two images
carry only operator-side changes. That is an inference from source and notes,
plus the measurement that REINDEX changes nothing; the alternative that a
Supabase-patched build on the hosted platform differs from the public image
was not tested.

Documents' claim (changelog): "indexes on ltree columns built under the
previous version can silently return incomplete results on databases using a
multibyte encoding or a non-libc collation provider" and need reindexing. The
"incomplete results" half reproduced, before the upgrade as well; the
reindex remedy did not change the outcome on these images.

Not measured: a single-byte database (no such locale in the image), the
builtin locale provider, major 18, ltree B-tree and hash indexes on
non-ASCII labels, other alphabets, whether a hosted project's database uses
ICU.

### What this RUNLOG does not settle

- Everything is the public Docker Hub image on one VM; a hosted project's
  image, extensions list and database locale are not measured.
- The upgrade is a data-directory swap, not the platform's procedure.
- Cell values for GiST range predicates on a stale index depend on index
  layout and vary by run (ranges above); only the zero and full-count cells
  are stable.
- Timing, memory and cost were not measured; the Management API was not
  touched.
