/**
 * L05 - key revocation: what a project with no browser-usable keys answers.
 *
 * The IAP-as-proxy pattern only becomes a real gate when the keys that could
 * bypass the proxy stop working. Measures:
 *
 *   L05a - GET /api-keys/legacy baseline; record both key generations present.
 *   L05b - PUT /api-keys/legacy?enabled=false, poll to effect, full inventory
 *          with the legacy anon JWT: every surface should refuse. Then the
 *          publishable key: does it still work with legacy disabled? (Both
 *          outcomes are findings worth recording verbatim.)
 *   L05c - the keyless inventory: no credential at all.
 *   L05d - re-enable legacy, confirm service restored; then DELETE the
 *          publishable key (leaving zero browser-usable keys) and re-inventory
 *          with the legacy pair only.
 *   L05e - governance row, recorded not asserted: POST /api-keys can mint a
 *          new publishable key at any time with the PAT, so "revoked" is a
 *          posture the control plane can always reopen. Mint + delete one as
 *          the proof.
 *
 * Key API shapes (docs.erfi.io supabase-api/api/secrets.md):
 *   POST /v1/projects/{ref}/api-keys?reveal=true  body { type: "publishable"|"secret", name, secret_jwt_template? }
 *   GET/PUT /v1/projects/{ref}/api-keys/legacy    PUT takes ?enabled=true|false
 *   DELETE /v1/projects/{ref}/api-keys/{id}
 * Reveal is required or the api_key field comes back masked with U+00B7 dots
 * (sfp-platforms S14b lesson).
 *
 * DESTRUCTIVE: disables legacy keys mid-run; restores in finally. If the
 * restore fails the module MUST say so in capitals - a project left with
 * legacy keys disabled breaks every sibling module that follows.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";

const mod: TestModule = {
  id: "L05",
  title: "key revocation: legacy off, publishable deleted, what a keyless project answers",
  where: "local",
  requires: ["pat", "anon-key"],
  destructive: true,
  async run(_ctx: Ctx): Promise<TestResult> {
    return {
      id: "L05",
      title: this.title,
      status: "skip",
      detail: "STUB - see file header. Levers: PUT /v1/projects/{ref}/api-keys/legacy?enabled=..., DELETE /v1/projects/{ref}/api-keys/{id}.",
    };
  },
};
export default mod;
