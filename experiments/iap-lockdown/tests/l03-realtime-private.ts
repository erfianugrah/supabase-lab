/**
 * L03 - Realtime private_only against the inventory.
 *
 * T23 (http-tier-lockdown) measured the enforcement point in isolation
 * (handshake succeeds, refusal lands in the join reply). This module is the
 * same lever inside the full inventory: after private_only=true, what do
 * REST/Auth/Storage/EF answer? Expected: unchanged - the lever is Realtime-
 * scoped - but the point of the experiment is that "expected" gets measured.
 *
 * DESTRUCTIVE: PATCHes /config/realtime; restores baseline in finally.
 *
 * Implementation notes when this gets written:
 * - Realtime join helper already exists: lib/inventory.ts realtimeJoin().
 * - T23 is the reference for flip/poll/restore semantics (9s to effect,
 *   120s cap, poll until join refuses).
 * - Assert: handshake STILL SUCCEEDS under private_only (authorization
 *   control, not network). Rest of inventory recorded as info rows.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";

const mod: TestModule = {
  id: "L03",
  title: "Realtime private_only against the full inventory",
  where: "local",
  requires: ["pat", "anon-key"],
  destructive: true,
  async run(_ctx: Ctx): Promise<TestResult> {
    return {
      id: "L03",
      title: this.title,
      status: "skip",
      detail: "STUB - see file header. Lever: PATCH /v1/projects/{ref}/config/realtime { private_only }. Reference: privatelink-aws/tests/t23-realtime-private.ts.",
    };
  },
};
export default mod;
