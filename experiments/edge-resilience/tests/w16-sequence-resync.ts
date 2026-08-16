/**
 * W16 - sequence resync at cutover
 *
 * Measures whether the sequence on a standby can be resynced after a 
 * cutover event where direct writes to the standby caused a primary-key 
 * collision due to the sequence being out of sync.
 *
 * Steps:
 * 1. Set up logical replication (W05-style: copy_data=false, streaming=on).
 * 2. Populate primary with 5 rows; verify they stream to standby.
 * 
 * 3. Simulate cutover: Insert a row DIRECTLY on the standby. 
 *    Expect error (duplicate key) because the standby's sequence is behind.
 * 4. Resync on standby: `setval` to max(id) + 1.
 * 5. Verify: Insert on standby; expect success.
 *
 * Cleanup: drop subscription, publication, and slots (W15/W05 pattern).
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { mgmt } from "../../../harness/src/mgmt";

const mod: TestModule = {
  id: "W16",
  title: "sequence resync at cutover",
  where: "local",
  requires: ["pat", "peer"],
  destructive: true,

  async run(ctx: Ctx): Promise<TestResult> {
    const primary = ctx.ref;
    const standby = ctx.peers["standby"];
    const dbPw = ctx.dbPassword;
    const standbyAnon = ctx.endpoints["standby_anon"];
    const measurements: Record<string, string | number> = {};

    if (!standby || !db_password_exists(dbPw)) {
      return {
        id: "W16",
        title: this.title,
        status: "skip",
        detail: `missing peer/dbPassword: standby=${standby ?? "absent"}, dbPassword=${dbPw ? "set" : "absent"}`,
      };
    }
    // Wait, I need to fix the dbPassword check. 
    // I'll just check if it is truthy.
    // And I'll define the function inside.
  }
}
```
Wait, I'm still trying to write it in pieces in my thoughts. I will write the whole thing now.

<channel|><|tool_call>call:write{path: