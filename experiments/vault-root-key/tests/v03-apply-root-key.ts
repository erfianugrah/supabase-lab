/**
 * V03 - can the source's root key actually be applied to the target?
 *
 * This is the recovery half of the region guide's most dangerous item, and
 * the guide does not say how to do it. Its instruction is "apply that value
 * to the target project's pgsodium config" with no endpoint, no method, and
 * no footnote. So this test does not verify a documented procedure - it
 * establishes whether ANY procedure is reachable, which is the actual open
 * question.
 *
 * Deliberately written as a probe over candidate shapes rather than a call to
 * one endpoint. Guessing a single method and reporting 404 would produce a
 * confident wrong conclusion ("there is no way to do this") when the truth
 * might be that the verb or the field name differs. Every candidate's status
 * is recorded, so the result is interpretable either way:
 *
 *   - one of them succeeds  -> the guide can finally name a method
 *   - all of them refuse    -> the published rescue path has no API surface,
 *                              and the guide must say so instead of implying
 *                              a one-liner exists
 *
 * Runs after V02 (planner sorts by id within the destructive tier), so the
 * "cannot decrypt" baseline is already on record when the key is applied.
 */
import { Client } from "pg";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { mgmt } from "../../../harness/src/mgmt";

const SECRET_NAME = "pvlab_vault_probe";
const SECRET_VALUE = "pvlab-known-plaintext-v02";

interface Candidate {
  label: string;
  method: string;
  path: (ref: string) => string;
  body: (rootKey: string) => Record<string, unknown>;
}

const CANDIDATES: Candidate[] = [
  {
    label: "PUT /pgsodium {root_key}",
    method: "PUT",
    path: (ref) => `/projects/${ref}/pgsodium`,
    body: (k) => ({ root_key: k }),
  },
  {
    label: "PATCH /pgsodium {root_key}",
    method: "PATCH",
    path: (ref) => `/projects/${ref}/pgsodium`,
    body: (k) => ({ root_key: k }),
  },
  {
    label: "POST /pgsodium {root_key}",
    method: "POST",
    path: (ref) => `/projects/${ref}/pgsodium`,
    body: (k) => ({ root_key: k }),
  },
];

const mod: TestModule = {
  id: "V03",
  title: "Applying a source root key to the target: is there a method at all?",
  where: "local",
  requires: ["pat", "peer", "db"],
  destructive: true, // rewrites the target's encryption root key
  async run(ctx: Ctx) {
    const target = ctx.peers.target;
    if (!target) {
      return {
        id: "V03",
        title: this.title,
        status: "skip",
        detail: "PVLAB_PEER_TARGET not set - this experiment needs both projects",
      };
    }

    const got = await mgmt(ctx, "GET", `/projects/${ctx.ref}/pgsodium`);
    const rootKey =
      typeof (got.json as Record<string, unknown> | undefined)?.root_key === "string"
        ? ((got.json as Record<string, unknown>).root_key as string)
        : "";
    if (!rootKey) {
      return {
        id: "V03",
        title: this.title,
        status: "skip",
        detail: `source root key unavailable (V01 should have caught this; GET returned ${got.status})`,
      };
    }

    const results: TestResult[] = [];
    const statuses: Record<string, string | number> = {};
    let accepted: Candidate | undefined;

    for (const c of CANDIDATES) {
      const r = await mgmt(ctx, c.method, c.path(target), c.body(rootKey));
      statuses[c.label] = r.throttled ? "throttled" : r.status;
      if (r.status >= 200 && r.status < 300 && !accepted) accepted = c;
    }

    results.push({
      id: "V03a",
      title: "A Management API method accepts a root key on the target",
      status: accepted ? "pass" : "fail",
      detail: accepted
        ? `accepted by: ${accepted.label}`
        : "no candidate shape was accepted - the guide's 'apply that value' step has no API surface here",
      measurements: statuses,
    });

    if (!accepted) return results;

    // Acceptance is not application. Re-run the V02 decrypt now that the key
    // is supposedly in place: a 200 that changes nothing is the failure mode
    // worth catching, and it is exactly what the custom_jwks finding in
    // cross-project-auth looked like.
    const dst = new Client({
      host: `db.${target}.supabase.co`,
      port: 5432,
      user: "postgres",
      database: "postgres",
      password: ctx.dbPassword,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 15000,
    });

    try {
      await dst.connect();
      let status: TestResult["status"];
      let detail: string;
      let errMsg = "";
      try {
        const q = await dst.query<{ decrypted_secret: string }>(
          "select decrypted_secret from vault.decrypted_secrets where name = $1",
          [SECRET_NAME],
        );
        const plaintext = q.rows[0]?.decrypted_secret;
        status = plaintext === SECRET_VALUE ? "pass" : "fail";
        detail =
          plaintext === SECRET_VALUE
            ? "the copied ciphertext now decrypts on the target - the rescue path works end to end"
            : `still not readable (${plaintext === undefined ? "no row" : "value mismatch"}) - the write was accepted but did not take effect`;
      } catch (e) {
        const err = e as { code?: string; message?: string };
        errMsg = err.message ?? String(e);
        status = "fail";
        detail = `still refused after applying the key: ${err.code ?? "?"} ${errMsg.slice(0, 160)}`;
      }

      results.push({
        id: "V03b",
        title: "The copied ciphertext decrypts after the key is applied",
        status,
        detail,
        measurements: { applied_via: accepted.label },
        evidence: errMsg.slice(0, 600),
      });
    } finally {
      await dst.end().catch(() => {});
    }

    return results;
  },
};
export default mod;
