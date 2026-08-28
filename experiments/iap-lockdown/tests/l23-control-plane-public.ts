/**
 * L23 - the control plane stays public.
 *
 * Under the fully-locked Phase C state (PrivateLink + restrict-all + Data
 * API off), record that api.supabase.com and Studio remain reachable and
 * functional: the Management API can still read the project, mutate config,
 * and mint keys. This is the scope boundary of any "private by default"
 * claim - the project can be private, the control plane cannot, and a
 * design review that forgets it has an ungated admin surface.
 *
 * Read-only probes (GET /v1/projects/{ref}, GET postgrest config) plus one
 * write-and-revert (PATCH max_rows, PATCH back) to prove the plane is not
 * merely readable but operational. Marked destructive for the write; sorts
 * last among Phase C modules by id.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";

const mod: TestModule = {
  id: "L23",
  title: "control plane stays public under full lockdown",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(_ctx: Ctx): Promise<TestResult> {
    return {
      id: "L23",
      title: this.title,
      status: "skip",
      detail: "STUB - see file header. Read + write-and-revert against /v1 while the project is fully locked.",
    };
  },
};
export default mod;
