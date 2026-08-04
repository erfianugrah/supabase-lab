/**
 * R01 - the standby key create is rate limited.
 *
 * On a fresh project, creating a signing key returns a rate-limit message
 * with a hard ISO8601 deadline rather than a retry-after header. This test
 * captures the refusal, parses the deadline, waits it out, and records how
 * long the wait was. The wait is a measurement, not an obstacle to retry
 * past: once the deadline passes, the create succeeds and the standby key is
 * left in place for R02 to promote.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import {
  keys,
  waitReady,
  listSigningKeys,
  createSigningKey,
} from "../lib/rotation";

const mod: TestModule = {
  id: "R01",
  title: "Standby signing key creation is rate limited on a fresh project",
  where: "local",
  requires: ["pat", "peer"],
  destructive: true, // creates a signing key on the hub
  async run(ctx) {
    const spoke = ctx.peers.spoke;
    if (!spoke) {
      return {
        id: "R01",
        title: this.title,
        status: "skip",
        detail: "PVLAB_PEER_SPOKE not set - this experiment needs two projects",
      };
    }
    const results: TestResult[] = [];
    const hub = ctx.ref;
    const host = `${hub}.supabase.co`;

    await waitReady(ctx, hub);

    const hubKeys = await keys(ctx, hub);
    if (!hubKeys.service) {
      return [
        ...results,
        {
          id: "R01z",
          title: "key fetch",
          status: "fail",
          detail: "could not read hub service_role key",
        },
      ];
    }

    // ---- Record initial signing key state. ----
    const before = await listSigningKeys(host, hubKeys.service);
    results.push({
      id: "R01a",
      title: "Initial signing keys",
      status: before.length >= 1 ? "pass" : "fail",
      detail: `${before.length} key(s): ${before.map((k) => `${k.kid}(${k.status})`).join(", ")}`,
      measurements: { initial_count: before.length },
    });

    // ---- Attempt to create a standby key. Expect rate limiting. ----
    const attempt1 = await createSigningKey(host, hubKeys.service);

    // Parse the rate-limit message. The body carries a message like
    // "Please wait until 2026-08-04T12:34:56Z" with a 4xx status.
    const message = typeof attempt1.json === "object" && attempt1.json !== null && !Array.isArray(attempt1.json)
      ? String((attempt1.json as Record<string, unknown>).message ?? "")
      : "";
    const deadlineMatch = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/.exec(message);
    const deadline = deadlineMatch ? new Date(deadlineMatch[0]) : null;

    results.push({
      id: "R01b",
      title: "First create attempt - rate limited",
      status: deadline ? "pass" : "fail",
      detail: deadline
        ? `rate limited until ${deadline.toISOString()}`
        : `unexpected: HTTP ${attempt1.status} "${message}"`,
      measurements: {
        http_status: attempt1.status,
        has_deadline: String(Boolean(deadline)),
      },
      evidence: attempt1.text.slice(0, 300),
    });

    if (!deadline) {
      // If not rate limited (unusual but possible if R01 is re-run on a
      // project that's past the window), the key might have been created
      // already. Check and report.
      const after = await listSigningKeys(host, hubKeys.service);
      const standby = after.find((k) => k.status === "standby");
      results.push({
        id: "R01c",
        title: "Standby key after first attempt",
        status: standby ? "info" : "fail",
        detail: standby
          ? `key ${standby.kid} created without rate limiting`
          : "no standby key and no rate-limit message",
        measurements: { standby_exists: String(Boolean(standby)), key_count: after.length },
      });
      return results;
    }

    // ---- Wait out the deadline. ----
    const now = Date.now();
    const waitMs = Math.max(0, deadline.getTime() - now + 2000); // 2s buffer past the deadline
    const t0 = performance.now();
    if (waitMs > 0) {
      await new Promise((r) => setTimeout(r, waitMs));
    }
    const waitedMs = Math.round(performance.now() - t0);

    // ---- Second attempt after the deadline. ----
    const attempt2 = await createSigningKey(host, hubKeys.service);
    const after = await listSigningKeys(host, hubKeys.service);
    const standby = after.find((k) => k.status === "standby");

    results.push({
      id: "R01d",
      title: "Second create attempt after deadline",
      status: attempt2.status < 300 && standby ? "pass" : "fail",
      detail: standby
        ? `standby key ${standby.kid} created after ${waitedMs}ms wait`
        : `create returned HTTP ${attempt2.status}: ${attempt2.text.slice(0, 120)}`,
      measurements: {
        waited_ms: waitedMs,
        http_status: attempt2.status,
        standby_exists: String(Boolean(standby)),
        key_count: after.length,
      },
    });

    // Record that the old key is still active after creating a standby.
    const active = after.find((k) => k.status === "active");
    results.push({
      id: "R01e",
      title: "Active key unchanged after creating standby",
      status: active ? "pass" : "fail",
      detail: active
        ? `${active.kid} still active; standby=${standby?.kid ?? "none"}`
        : "no active key found",
      measurements: { active_count: after.filter((k) => k.status === "active").length },
    });

    return results;
  },
};
export default mod;
