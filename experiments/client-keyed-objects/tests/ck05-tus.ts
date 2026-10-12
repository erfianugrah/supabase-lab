/**
 * CK05 - Does a 2 GiB client-encrypted upload through TUS survive a hard
 * interruption and resume from a new process on every target?
 *
 * SIDE: each target's Storage (TUS at <storageUrl>/upload/resumable, 6 MiB transport chunks), as the primary tenant's editor;
 * the full read is S3 GetObject as the viewer.
 *
 *   CK05-<target>  upload killed (SIGKILL) at >= 40 % reported progress; a new
 *                process resumes from the asset id alone (catalogue row +
 *                server state); plaintext SHA-256 of the upload and of a full
 *                decrypting read equal the fixture; 256 chunk hashes in the
 *                catalogue. info_* columns are wall times from one laptop
 *                vantage, not throughput claims.
 *
 * Not settled: other vantages, concurrent uploads, links slow enough that one
 * transfer outlives the 300 s token (the client refreshes before each part or
 * PATCH, which this run exercises only as far as its own duration).
 * DESTRUCTIVE: writes a 2 GiB object per target; removed with the stack or
 * project.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { errMsg, loadRun, row, scrub } from "../lib/ckrun";
import { interruptResume } from "../lib/flows";

const mod: TestModule = {
  id: "CK05",
  title: "2 GiB upload via tus, interrupted and resumed",
  where: "local",
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const l = loadRun(ctx);
    if ("skip" in l) return [{ id: "CK05", title: this.title, status: "skip", detail: l.skip }];
    const out: TestResult[] = [];
    for (const t of l.targets) {
      try {
        out.push(await interruptResume(l, t, "CK05", "tus", "big_tus"));
      } catch (e) {
        out.push(row("CK05", t, this.title, "fail", `threw: ${scrub(l, errMsg(e))}`));
      }
    }
    return out;
  },
};
export default mod;
