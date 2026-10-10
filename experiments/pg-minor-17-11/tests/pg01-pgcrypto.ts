/**
 * PG01 - pgcrypto legacy ciphers across the minor (public changelog:
 * https://supabase.com/changelog/postgres-15-19-17-11-breaking-changes).
 *
 * Per pair (17.6 -> 17.11, 15.14 -> 15.19), on one data directory:
 *
 *   old image   pgp_sym_encrypt with cipher-algo = bf, blowfish, cast5 and the
 *               controls aes128, aes256, 3des and "no option". For each: is the
 *               plaintext sentinel visible in the ciphertext bytes (compress-algo=0),
 *               does decrypt with the right key work, does decrypt with a WRONG
 *               key work, and does the old image know the decrypt option
 *               ignore-cipher-failure=1 at all. Ciphertexts are kept in a table.
 *   new image   the same stored ciphertexts: right key, wrong key, right key +
 *               ignore-cipher-failure=1, wrong key + ignore-cipher-failure=1;
 *               a fresh pgp_sym_encrypt per cipher; the changelog's detection
 *               idea (decrypt every stored value with a deliberately wrong
 *               passphrase, flag the ones that succeed) run on the old image, on
 *               the new image by default and on the new image with the option;
 *               then the remediation (decrypt with the option, re-encrypt with
 *               aes256, decrypt again with the right and a wrong key).
 *
 * The pass band is "the changelog's description of each step reproduces"; a
 * deviation is recorded in `detail` and the measurements, not retried.
 *
 * Not measured here: pgp_pub_encrypt / pgp_pub_decrypt (needs an OpenPGP key
 * pair and no generator is available in the image); the _bytea variants; any
 * hosted project; the platform's upgrade procedure.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { one, outcome, pairs, skipReason, tryq, withRig, type Pair, type Rig } from "../lib/rig";
import type { Client } from "pg";

const ID = "PG01";
const SENTINEL = "SENTINELPLAINTEXT";
const RIGHT = "k1-right-key";
const WRONG = "k2-wrong-key";
const CIPHERS = ["bf", "blowfish", "cast5", "aes128", "aes256", "3des", "default"] as const;
const LEGACY = new Set(["bf", "blowfish", "cast5"]);

const opt = (c: string, extra = "") => [c === "default" ? "" : `cipher-algo=${c}`, extra].filter(Boolean).join(", ");

async function decryptCell(c: Client, ct: string, key: string, options: string): Promise<string> {
  const t = await tryq(c, "select extensions.pgp_sym_decrypt(decode($1,'hex'), $2, $3) as v", [ct, key, options]);
  return outcome(t, (rows) => (rows[0]?.v === SENTINEL ? "decrypts" : `decrypts to something else (${String(rows[0]?.v)})`));
}

/** The changelog's detection idea: try a deliberately wrong passphrase on every stored value. */
async function scan(c: Client, options: string): Promise<{ flagged: string[]; errors: Record<string, string> }> {
  const rows = (await c.query("select cipher, encode(ct,'hex') as h from pc order by cipher")).rows as { cipher: string; h: string }[];
  const flagged: string[] = [];
  const errors: Record<string, string> = {};
  for (const r of rows) {
    const t = await tryq(c, "select extensions.pgp_sym_decrypt(decode($1,'hex'), $2, $3) as v", [r.h, WRONG, options]);
    if (t.ok) flagged.push(r.cipher);
    else errors[r.cipher] = t.err ?? "";
  }
  return { flagged, errors };
}

async function runPair(p: Pair): Promise<TestResult> {
  const m: Record<string, string | number> = {};
  const dev: string[] = [];
  const expect = (label: string, cond: boolean) => {
    if (!cond) dev.push(label);
  };

  await withRig(p, async (r: Rig) => {
    // ---- old image
    await r.start("old");
    await r.withClient("supabase_admin", "postgres", async (c) => {
      m.old_server_version = await one(c, "select current_setting('server_version')");
      await c.query("create table pc(cipher text primary key, ct bytea not null, ct_raw bytea not null)");
      for (const ci of CIPHERS) {
        const o = opt(ci);
        const o0 = opt(ci, "compress-algo=0");
        const ins = await tryq(
          c,
          `insert into pc select $1, extensions.pgp_sym_encrypt($2, $3, $4), extensions.pgp_sym_encrypt($2, $3, $5)`,
          [ci, SENTINEL, RIGHT, o, o0],
        );
        m[`old_${ci}_encrypt`] = outcome(ins);
      }
      const rows = (
        await c.query(
          "select cipher, encode(ct,'hex') h, position($1::bytea in ct_raw) > 0 as visible from pc order by cipher",
          [SENTINEL],
        )
      ).rows as { cipher: string; h: string; visible: boolean }[];
      for (const row of rows) {
        m[`old_${row.cipher}_plaintext_visible_in_ciphertext`] = row.visible ? "yes" : "no";
        m[`old_${row.cipher}_decrypt_right_key`] = await decryptCell(c, row.h, RIGHT, "");
        m[`old_${row.cipher}_decrypt_wrong_key`] = await decryptCell(c, row.h, WRONG, "");
      }
      m.old_accepts_ignore_cipher_failure = await decryptCell(
        c,
        rows.find((x) => x.cipher === "aes256")!.h,
        RIGHT,
        "ignore-cipher-failure=1",
      );
      const s = await scan(c, "");
      m.old_scan_flagged = s.flagged.join(",") || "(none)";
      for (const ci of LEGACY) {
        expect(`old ${ci}: plaintext visible`, m[`old_${ci}_plaintext_visible_in_ciphertext`] === "yes");
        expect(`old ${ci}: wrong key decrypts`, m[`old_${ci}_decrypt_wrong_key`] === "decrypts");
      }
      for (const ci of ["aes128", "aes256", "3des", "default"]) {
        expect(`old ${ci}: wrong key refused`, String(m[`old_${ci}_decrypt_wrong_key`]).startsWith("ERR"));
      }
    });
    await r.stop();

    // ---- new image, same data directory
    await r.start("new");
    await r.withClient("supabase_admin", "postgres", async (c) => {
      m.new_server_version = await one(c, "select current_setting('server_version')");
      const rows = (await c.query("select cipher, encode(ct,'hex') h from pc order by cipher")).rows as { cipher: string; h: string }[];
      for (const row of rows) {
        const ci = row.cipher;
        m[`new_${ci}_decrypt_right_key`] = await decryptCell(c, row.h, RIGHT, "");
        m[`new_${ci}_decrypt_wrong_key`] = await decryptCell(c, row.h, WRONG, "");
        m[`new_${ci}_decrypt_right_key_ignore`] = await decryptCell(c, row.h, RIGHT, "ignore-cipher-failure=1");
        m[`new_${ci}_decrypt_wrong_key_ignore`] = await decryptCell(c, row.h, WRONG, "ignore-cipher-failure=1");
        const enc = await tryq(c, "select extensions.pgp_sym_encrypt($1, $2, $3) is not null as ok", [SENTINEL, RIGHT, opt(ci)]);
        m[`new_${ci}_fresh_encrypt`] = outcome(enc);
        if (LEGACY.has(ci)) {
          expect(`new ${ci}: stored value fails by default`, String(m[`new_${ci}_decrypt_right_key`]).startsWith("ERR"));
          expect(`new ${ci}: option recovers with right key`, m[`new_${ci}_decrypt_right_key_ignore`] === "decrypts");
          expect(`new ${ci}: option decrypts with wrong key (data was effectively unencrypted)`, m[`new_${ci}_decrypt_wrong_key_ignore`] === "decrypts");
          expect(`new ${ci}: fresh encrypt refused`, String(m[`new_${ci}_fresh_encrypt`]).startsWith("ERR"));
        } else {
          expect(`new ${ci}: stored value still decrypts`, m[`new_${ci}_decrypt_right_key`] === "decrypts");
          expect(`new ${ci}: wrong key still refused`, String(m[`new_${ci}_decrypt_wrong_key`]).startsWith("ERR"));
          expect(`new ${ci}: wrong key still refused with the option`, String(m[`new_${ci}_decrypt_wrong_key_ignore`]).startsWith("ERR"));
        }
      }
      const d = await scan(c, "");
      m.new_scan_default_flagged = d.flagged.join(",") || "(none)";
      m.new_scan_default_error_bf = d.errors.bf ?? "(no error)";
      m.new_scan_default_error_aes256 = d.errors.aes256 ?? "(no error)";
      const w = await scan(c, "ignore-cipher-failure=1");
      m.new_scan_with_option_flagged = w.flagged.join(",") || "(none)";

      // remediation: decrypt with the option, re-encrypt with aes256
      const rem = await tryq(
        c,
        `create table pc2 as
           select cipher, extensions.pgp_sym_encrypt(
                    extensions.pgp_sym_decrypt(ct, $1, 'ignore-cipher-failure=1'), $1, 'cipher-algo=aes256, compress-algo=0') as ct
           from pc where cipher in ('bf','blowfish','cast5')`,
        [RIGHT],
      );
      m.new_reencrypt_with_option = outcome(rem);
      if (rem.ok) {
        const r2 = (await c.query("select cipher, encode(ct,'hex') h, position($1::bytea in ct) > 0 as visible from pc2 order by cipher", [SENTINEL])).rows as {
          cipher: string;
          h: string;
          visible: boolean;
        }[];
        m.new_reencrypted_rows = r2.length;
        m.new_reencrypted_plaintext_visible = r2.some((x) => x.visible) ? "yes" : "no";
        const rightCells: string[] = [];
        const wrongCells: string[] = [];
        for (const x of r2) {
          rightCells.push(await decryptCell(c, x.h, RIGHT, ""));
          wrongCells.push(await decryptCell(c, x.h, WRONG, ""));
        }
        m.new_reencrypted_decrypt_right_key = rightCells.every((x) => x === "decrypts") ? "decrypts (all rows)" : "not all rows decrypt";
        m.new_reencrypted_decrypt_wrong_key = wrongCells.every((x) => x.startsWith("ERR")) ? "refused (all rows)" : "some row decrypts";
        expect("remediation: re-encrypted rows decrypt with the right key", m.new_reencrypted_decrypt_right_key === "decrypts (all rows)");
        expect("remediation: re-encrypted rows refuse a wrong key", m.new_reencrypted_decrypt_wrong_key === "refused (all rows)");
        expect("remediation: plaintext not visible after re-encrypt", m.new_reencrypted_plaintext_visible === "no");
      }
      expect("scan on old flags exactly the legacy ciphers", m.old_scan_flagged === "bf,blowfish,cast5");
      expect("scan on new by default flags nothing", m.new_scan_default_flagged === "(none)");
      expect("scan on new with the option flags exactly the legacy ciphers", m.new_scan_with_option_flagged === "bf,blowfish,cast5");
    });
    await r.stop();
  });

  m.old_ignore_option_known_to_old_image = String(m.old_accepts_ignore_cipher_failure).startsWith("ERR") ? "no" : "yes";
  return {
    id: `${ID}-pg${p.major}`,
    title: `pgcrypto legacy ciphers (PG ${p.major}: ${p.oldTag} -> ${p.newTag})`,
    status: dev.length ? "fail" : "pass",
    detail: dev.length
      ? `deviations from the changelog's description: ${dev.join("; ")}`
      : "old: bf/blowfish/cast5 ciphertext holds the plaintext and a wrong key decrypts; new: stored values fail by default, recover with ignore-cipher-failure=1",
    measurements: m,
  };
}

const mod: TestModule = {
  id: ID,
  title: "pgcrypto bf/blowfish/cast5 across the minor",
  where: "local",
  requires: [],
  destructive: true,
  async run(_ctx: Ctx): Promise<TestResult[]> {
    const why = await skipReason();
    if (why) return [{ id: ID, title: this.title, status: "skip", detail: why }];
    const out: TestResult[] = [];
    for (const p of pairs()) {
      try {
        out.push(await runPair(p));
      } catch (e) {
        out.push({ id: `${ID}-pg${p.major}`, title: this.title, status: "fail", detail: `threw: ${(e as Error).message}` });
      }
    }
    return out;
  },
};

export default mod;
