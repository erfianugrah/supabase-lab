/**
 * V02 - the negative control, and the most important test here.
 *
 * Create a Vault secret on the source, copy the CIPHERTEXT row to the target
 * without carrying the root key, and try to read it back. The region guide
 * says this fails with:
 *
 *   ERROR: 22000 pgsodium_crypto_aead_det_decrypt_by_id: invalid ciphertext
 *
 * That error string is what readers will grep for, and it has never been
 * reproduced. Two ways this test earns its place:
 *
 * 1. If the copy decrypts fine WITHOUT the key, then the root key does not
 *    matter, the guide's most urgent warning is wrong, and V03 is moot.
 * 2. If it fails with a DIFFERENT error, the published signature is wrong and
 *    anyone matching on it will mis-handle the failure.
 *
 * Running this before V03 is deliberate and the harness preserves it: the
 * planner sorts by id within the destructive tier, so V02 always precedes
 * V03. Applying the key first would leave no way to tell a working copy from
 * a copy that never needed the key.
 */
import { Client } from "pg";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";

const SECRET_NAME = "pvlab_vault_probe";
const SECRET_VALUE = "pvlab-known-plaintext-v02";

function conn(ref: string, password: string): Client {
  return new Client({
    host: `db.${ref}.supabase.co`,
    port: 5432,
    user: "postgres",
    database: "postgres",
    password,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
  });
}

const mod: TestModule = {
  id: "V02",
  title: "Vault ciphertext copied WITHOUT the root key fails to decrypt",
  where: "local",
  requires: ["pat", "peer", "db"],
  destructive: true, // writes vault.secrets on both projects
  async run(ctx: Ctx) {
    const target = ctx.peers.target;
    if (!target) {
      return {
        id: "V02",
        title: this.title,
        status: "skip",
        detail: "PVLAB_PEER_TARGET not set - this experiment needs both projects",
      };
    }

    const src = conn(ctx.ref, ctx.dbPassword);
    const dst = conn(target, ctx.dbPassword);
    const results: TestResult[] = [];

    try {
      await src.connect();
      await dst.connect();

      // Baseline: the secret must be readable on the project that encrypted
      // it, or a failure on the target says nothing about the key.
      await src.query("select vault.create_secret($1, $2)", [SECRET_VALUE, SECRET_NAME]);
      const readBack = await src.query<{ decrypted_secret: string }>(
        "select decrypted_secret from vault.decrypted_secrets where name = $1",
        [SECRET_NAME],
      );
      const sourceOk = readBack.rows[0]?.decrypted_secret === SECRET_VALUE;

      results.push({
        id: "V02a",
        title: "Baseline: the secret decrypts on the project that created it",
        status: sourceOk ? "pass" : "fail",
        detail: sourceOk ? "plaintext matches" : "source could not read its own secret",
        measurements: { rows: readBack.rowCount ?? 0, matches: String(sourceOk) },
      });

      // Copy the stored row verbatim: id, name, and the ciphertext column.
      const raw = await src.query<{ id: string; name: string; secret: string; nonce: string | null }>(
        "select id::text, name, secret, nonce::text from vault.secrets where name = $1",
        [SECRET_NAME],
      );
      const row = raw.rows[0];
      if (!row) {
        results.push({
          id: "V02b",
          title: "Copy ciphertext to the target",
          status: "fail",
          detail: "no row in vault.secrets to copy",
        });
        return results;
      }

      await dst.query(
        "insert into vault.secrets (id, name, secret, nonce) values ($1::uuid, $2, $3, $4::bytea) " +
          "on conflict (id) do update set secret = excluded.secret",
        [row.id, row.name, row.secret, row.nonce],
      );

      let decryptStatus: TestResult["status"];
      let detail: string;
      let errCode = "none";
      let errMsg = "";
      try {
        const got = await dst.query<{ decrypted_secret: string }>(
          "select decrypted_secret from vault.decrypted_secrets where name = $1",
          [SECRET_NAME],
        );
        const plaintext = got.rows[0]?.decrypted_secret;
        if (plaintext === SECRET_VALUE) {
          // The guide's premise is wrong if we land here.
          decryptStatus = "fail";
          detail =
            "ciphertext decrypted on the target WITHOUT carrying the root key - the root-key warning does not hold";
        } else {
          decryptStatus = "info";
          detail = `no error, but plaintext did not match (got ${plaintext === undefined ? "no row" : "different value"})`;
        }
      } catch (e) {
        const err = e as { code?: string; message?: string };
        errCode = err.code ?? "unknown";
        errMsg = err.message ?? String(e);
        // The expected outcome: refused for want of the key.
        decryptStatus = "pass";
        detail = `refused: ${errCode} ${errMsg.slice(0, 160)}`;
      }

      results.push({
        id: "V02b",
        title: "Target cannot decrypt a foreign-key ciphertext",
        status: decryptStatus,
        detail,
        measurements: {
          error_code: errCode,
          // The guide publishes 22000 and a specific function name. Record
          // whether today's platform still produces that exact signature.
          matches_published_code: String(errCode === "22000"),
          matches_published_text: String(/invalid ciphertext/i.test(errMsg)),
        },
        evidence: errMsg.slice(0, 600),
      });

      return results;
    } finally {
      await src.end().catch(() => {});
      await dst.end().catch(() => {});
    }
  },
};
export default mod;
