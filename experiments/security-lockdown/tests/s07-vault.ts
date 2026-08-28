/**
 * S07 - Vault: secrets stored encrypted at rest, decryptable through a view.
 *
 * The self-hosted-PostgREST and IAP paths need a place to keep the service key
 * and issuer secrets that is not a plaintext column. Supabase Vault
 * (supabase_vault) encrypts secrets in the database and exposes a decrypting
 * view. Verify a round-trip: the stored ciphertext is not the plaintext, the
 * decrypting view returns it.
 *
 * DESTRUCTIVE: creates the extension + a secret; deletes the secret in finally.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import { sql } from "../lib/sec.js";

async function rows(ctx: Ctx, q: string): Promise<Record<string, unknown>[]> {
  const r = await mgmt(ctx, "POST", `/projects/${ctx.ref}/database/query`, { query: q });
  return Array.isArray(r.json) ? (r.json as Record<string, unknown>[]) : [];
}

const NAME = "s07_probe";
const PLAINTEXT = "s3cr3t-service-key-value";

const mod: TestModule = {
  id: "S07",
  title: "Vault: secrets encrypted at rest, decrypted through a view",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const results: TestResult[] = [];
    try {
      const ext = await rows(ctx, "create extension if not exists supabase_vault with schema vault; select 1 as ok;");
      if (!ext.length) {
        return [{ id: "S07", title: this.title, status: "info", detail: "supabase_vault extension not available on this project" }];
      }
      await sql(ctx, `select vault.create_secret('${PLAINTEXT}', '${NAME}', 'S07 probe');`);
      const enc = await rows(ctx, `select secret from vault.secrets where name = '${NAME}';`);
      const dec = await rows(ctx, `select decrypted_secret from vault.decrypted_secrets where name = '${NAME}';`);
      const ciphertext = String(enc[0]?.secret ?? "");
      const plaintext = String(dec[0]?.decrypted_secret ?? "");

      results.push({
        id: "S07a",
        title: "secret stored encrypted, recovered through the decrypting view",
        status: plaintext === PLAINTEXT && ciphertext !== "" && ciphertext !== PLAINTEXT ? "pass" : "fail",
        detail: `vault.secrets holds ciphertext (${ciphertext.slice(0, 16)}..., not the plaintext); vault.decrypted_secrets returns the value. A place for the service key and issuer secrets that is not a plaintext column.`,
        measurements: { ciphertext_is_plaintext: String(ciphertext === PLAINTEXT), decrypted_matches: String(plaintext === PLAINTEXT) },
      });
    } catch (e) {
      results.push({ id: "S07err", title: "S07 aborted", status: "fail", detail: e instanceof Error ? e.message : String(e) });
    } finally {
      await sql(ctx, `delete from vault.secrets where name = '${NAME}';`).catch(() => {});
    }
    return results;
  },
};
export default mod;
