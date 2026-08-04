/**
 * D02 - does closing the database to a /32 interrupt the HTTP tier?
 *
 * DESTRUCTIVE: applies a network restriction, then restores it.
 *
 * The cheapest destructive operation available, and the one most likely to
 * produce a NULL result - which is worth publishing either way. Network
 * restrictions are a database-socket control, so the expectation is that the
 * pooler notices and REST, Auth, Storage and Realtime do not. If the HTTP tier
 * does blip, that is a finding about where the control actually sits.
 *
 * The restore happens INSIDE the sampled operation, after a dwell. The first
 * version of this module restored in the `finally` instead, which meant
 * recovery could not occur until after sampling had already stopped: the run
 * always burned the full window and always reported "never recovered", so it
 * could measure that a restriction bites but never how long the outage lasts.
 * The `finally` restore stays as an idempotent safety net - leaving the project
 * restricted would make the next module read a pre-existing outage and skip,
 * turning one bad run into a void suite.
 */
import type { TestModule, TestResult } from "../../../harness/src/types";
import { sampleDuring } from "../../../harness/src/sampler";
import { buildProbes, verdict, INTERVAL_MS, SETTLE_MS } from "../lib/setup";

const MAX_WAIT_MS = 240_000;
/** Long enough for the deny to take effect and be seen for a while. */
const DWELL_MS = 60_000;
/** TEST-NET-1 (RFC 5737). Guaranteed not to be us. */
const DENY_CIDR = "192.0.2.1/32";
const ALLOW_ALL = "0.0.0.0/0";

const mod: TestModule = {
  id: "D02",
  title: "Network restriction flip: does closing the DB interrupt the HTTP tier?",
  where: "local",
  requires: ["pat", "anon-key"],
  destructive: true,
  async run(ctx): Promise<TestResult> {
    const { probes, note } = await buildProbes(ctx);
    ctx.log(note);

    const apply = async (cidrs: string[]) => {
      const res = await fetch(
        `https://api.supabase.com/v1/projects/${ctx.ref}/network-restrictions/apply`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${ctx.pat}`, "Content-Type": "application/json" },
          body: JSON.stringify({ dbAllowedCidrs: cidrs }),
          signal: AbortSignal.timeout(30_000),
        },
      );
      if (!res.ok) throw new Error(`restriction apply failed: HTTP ${res.status}`);
      ctx.log(`restrictions -> ${cidrs.join(",")}: HTTP ${res.status}`);
    };

    try {
      const windows = await sampleDuring(
        probes,
        { intervalMs: INTERVAL_MS, maxWaitMs: MAX_WAIT_MS, settleMs: SETTLE_MS, log: ctx.log },
        async () => {
          await apply([DENY_CIDR]);
          await Bun.sleep(DWELL_MS);
          await apply([ALLOW_ALL]);
        },
      );
      return verdict("D02", mod.title, windows) as TestResult;
    } finally {
      await apply([ALLOW_ALL]).catch((e) =>
        ctx.log(`RESTORE FAILED - project may still be restricted: ${e}`),
      );
    }
  },
};
export default mod;
