/**
 * V04 - what does the root-key endpoint say once the source project is gone?
 *
 * The region guide's urgency rests on this: the window to retrieve the key
 * closes permanently when the old project is deleted, and it publishes the
 * refusal as `400 {"message":"Resource has been removed"}`. Never measured.
 *
 * Structurally different from V01-V03: it needs the source to NOT exist, so
 * it cannot run in the same pass. `make probe-deleted-source` destroys only
 * the source resource through tofu (-target), which keeps deletion an
 * OpenTofu operation rather than an API call the state does not know about,
 * then runs this test alone with the now-dead ref passed in.
 *
 * The dead ref arrives as PVLAB_DEAD_REF rather than ctx.ref, because after
 * the targeted destroy `tofu output -raw source_ref` is empty and a test that
 * silently probed an empty ref would report a cheerful 404 that means nothing.
 */
import type { TestModule } from "../../../harness/src/types";
import { mgmt } from "../../../harness/src/mgmt";

const mod: TestModule = {
  id: "V04",
  title: "Root key after the source project is deleted",
  where: "local",
  requires: ["pat"],
  destructive: true, // only meaningful after the source has been destroyed
  async run(ctx) {
    const dead = process.env.PVLAB_DEAD_REF;
    if (!dead) {
      return {
        id: "V04",
        title: this.title,
        status: "skip",
        detail: "PVLAB_DEAD_REF not set - run 'make probe-deleted-source'",
      };
    }

    const r = await mgmt(ctx, "GET", `/projects/${dead}/pgsodium`);
    const body = (r.json ?? {}) as Record<string, unknown>;
    const message = typeof body.message === "string" ? body.message : "";
    const stillHasKey = typeof body.root_key === "string" && body.root_key.length > 0;

    return {
      id: "V04",
      title: this.title,
      // "pass" means the window really does close. A key still being served
      // for a deleted project would be the more alarming outcome and is
      // recorded as a failure of the claim, not of the test.
      status: stillHasKey ? "fail" : r.status >= 400 ? "pass" : "info",
      detail: stillHasKey
        ? "root key STILL retrievable for a deleted project"
        : `HTTP ${r.status} ${message || "(no message field)"}`,
      measurements: {
        status: r.status,
        matches_published_status: String(r.status === 400),
        matches_published_message: String(/resource has been removed/i.test(message)),
        root_key_present: String(stillHasKey),
      },
      evidence: r.text.slice(0, 600),
    };
  },
};
export default mod;
