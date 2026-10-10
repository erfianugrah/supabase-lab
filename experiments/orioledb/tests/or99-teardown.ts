/**
 * OR99 - delete every project this run created (the pair and the extra
 * OrioleDB projects) and read the org's listing back.
 *
 * Passes when every project created by this process is gone from
 * `GET /v1/projects` within 150 s of the DELETE. Projects supplied through
 * `PVLAB_PEER_*` (reused for development) are never deleted. Also runs from a
 * `beforeExit` and SIGINT/SIGTERM hook, so a run limited with `--only` still
 * cleans up.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { teardownPair } from "../lib/pair";

const mod: TestModule = {
  id: "OR99",
  title: "Teardown: delete the projects this run created",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult> {
    const r = await teardownPair(ctx);
    return {
      id: "OR99",
      title: this.title,
      status: r.stillListed.length === 0 ? "pass" : "fail",
      detail: `deleted: ${r.deleted.join(", ") || "(none created)"}${r.stillListed.length ? `; still listed: ${r.stillListed.join(", ")}` : ""}`,
      measurements: { deleted: r.deleted.length, still_listed: r.stillListed.length },
    };
  },
};

export default mod;
