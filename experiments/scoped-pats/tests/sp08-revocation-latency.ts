/**
 * SP08 - how long a deleted scoped token keeps working. Not stated in the
 * changelog or the guide; any figure here is first-party.
 *
 * PVLAB_SCOPED_PAT_REVOKE is a throwaway token scoped to the fixture project
 * (Project Settings = Read). The module polls `GET /projects/{fixture}` with
 * it every PVLAB_SP_WATCH_INTERVAL_S (default 15 s) for up to
 * PVLAB_SP_WATCH_S (default 900 s). When the log prints
 * `WATCH: delete the token now`, delete it in the dashboard. The first status
 * change is the revocation; the resolution is the poll interval and the
 * operator's click time is not captured, so the figure is seconds since the
 * first poll.
 *
 * Needs PVLAB_PEER_FIXTURE.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { fmt, watch } from "../lib/watch.js";
import { roleOf, skipReason, tokenFor } from "../lib/tokens.js";

const role = roleOf("revoke");

const mod: TestModule = {
  id: "SP08",
  title: "Deleted scoped token: seconds until the API refuses it (operator deletes mid-run)",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const tok = tokenFor(role);
    const ref = ctx.peers.fixture ?? "";
    if (!tok || !ref) {
      return [
        {
          id: "SP08",
          title: "SP08",
          status: "skip",
          detail: !tok ? skipReason(role) : "PVLAB_PEER_FIXTURE not set",
        },
      ];
    }
    ctx.log("WATCH: delete the token now (dashboard). Polling...");
    const w = await watch(tok, [{ id: "project", method: "GET", path: `/projects/${ref}` }], ctx.log);
    const changed = w.transitions.length > 0;
    return [
      {
        id: "SP08",
        title: "SP08: GET /projects/{fixture} with the token before and after deletion",
        status: changed ? "info" : "skip",
        detail: changed
          ? `poll interval ${w.intervalS} s; seconds are since the first poll, not since the click`
          : `no change in ${w.seconds} s over ${w.polls} polls; the operator may not have deleted the token`,
        measurements: {
          initial: w.initial.project ?? "",
          final: w.final.project ?? "",
          polls: w.polls,
          interval_s: w.intervalS,
          transitions: fmt(w.transitions),
        },
      },
    ];
  },
};
export default mod;
