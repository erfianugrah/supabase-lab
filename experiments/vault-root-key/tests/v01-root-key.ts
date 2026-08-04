/**
 * V01 - does GET /v1/projects/{ref}/pgsodium exist, and what does it return?
 *
 * The region-migration guide's most dangerous item rests on this endpoint:
 * it is the only stated way to carry a Vault root key to the project a move
 * lands you on, and the guide says there is no recovery path without it. The
 * endpoint has never been called in a lab. If it 404s - deprecated, renamed,
 * moved behind /platform like the association API - the published rescue is
 * impossible and the guide is telling people to rely on something that is
 * not there.
 *
 * Two projects are read, not one. A root key that is identical across two
 * fresh projects would mean it is not project-scoped at all, which would
 * change the whole story; recording both is how that gets noticed rather
 * than assumed.
 *
 * The key VALUE never enters a measurement or the evidence blob. Only its
 * length and character class are recorded - the guide's claim is about the
 * format ("<64 hex chars>"), and evidence/ is gitignored precisely because
 * it is not trustworthy enough to hold a live root key.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { mgmt } from "../../../harness/src/mgmt";

interface KeyShape {
  status: number;
  present: boolean;
  length: number;
  charClass: string;
  fields: string;
  digest: string;
}

/** Never returns the key. */
async function fingerprint(ctx: Ctx, ref: string): Promise<KeyShape> {
  const r = await mgmt(ctx, "GET", `/projects/${ref}/pgsodium`);
  const body = (r.json ?? {}) as Record<string, unknown>;
  const key = typeof body.root_key === "string" ? body.root_key : "";
  const charClass = !key
    ? "n/a"
    : /^[0-9a-f]+$/i.test(key)
      ? "hex"
      : /^[A-Za-z0-9+/=]+$/.test(key)
        ? "base64ish"
        : "other";
  // A digest lets a later run answer "same key?" without either run ever
  // holding the plaintext.
  const digest = key
    ? Bun.hash(key).toString(16)
    : "none";
  return {
    status: r.status,
    present: key.length > 0,
    length: key.length,
    charClass,
    fields: Object.keys(body).sort().join("|") || "none",
    digest,
  };
}

const mod: TestModule = {
  id: "V01",
  title: "pgsodium root key endpoint: exists, shape, project-scoped",
  where: "local",
  requires: ["pat", "peer"],
  async run(ctx) {
    const target = ctx.peers.target;
    if (!target) {
      return {
        id: "V01",
        title: this.title,
        status: "skip",
        detail: "PVLAB_PEER_TARGET not set - this experiment needs both projects",
      };
    }

    const src = await fingerprint(ctx, ctx.ref);
    const dst = await fingerprint(ctx, target);
    const results: TestResult[] = [];

    results.push({
      id: "V01a",
      title: "GET /v1/projects/{ref}/pgsodium returns a root key",
      status: src.status === 200 && src.present ? "pass" : "fail",
      detail:
        src.status === 200
          ? `root_key present=${src.present}, ${src.length} chars, ${src.charClass}`
          : `HTTP ${src.status} - the published rescue path does not exist on this endpoint`,
      measurements: {
        status: src.status,
        present: String(src.present),
        length: src.length,
        char_class: src.charClass,
        body_fields: src.fields,
      },
    });

    results.push({
      id: "V01b",
      title: "The root key is project-scoped",
      // Two fresh projects sharing a root key would be a much bigger finding
      // than anything else in this experiment.
      status: src.present && dst.present ? (src.digest !== dst.digest ? "pass" : "fail") : "skip",
      detail:
        !src.present || !dst.present
          ? "one or both projects returned no root key"
          : src.digest !== dst.digest
            ? "source and target keys differ, as expected"
            : "IDENTICAL root keys on two fresh projects - not project-scoped",
      measurements: {
        source_digest: src.digest,
        target_digest: dst.digest,
        target_status: dst.status,
      },
    });

    return results;
  },
};
export default mod;
