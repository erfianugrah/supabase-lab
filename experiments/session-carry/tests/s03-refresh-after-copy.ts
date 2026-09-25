/**
 * S03 - a refresh at the source AFTER the copy: what the target does with each
 * token the client might hold.
 *
 * The plan under test says a post-copy refresh at the source makes the copied row "an
 * older generation", and that presenting it past the 10s reuse interval
 * terminates the session. That conflates two projects. Timeline:
 *
 *   login at source -> R1; copy rows (target holds R1, unrevoked)
 *   refresh at source: R1 -> R2 (source revokes R1)
 *
 *   S03a  R2 at the target - R2 was never copied. Expected: not_found.
 *   S03b  R1 at the target - the target never saw R1 revoked.
 *   S03c  R2 at the source still refreshes (-> R3): if S03b passed, one
 *         session now has two live lineages on two projects.
 *   S03d  R1 at the source after >10s - the reuse detection the plan
 *         describes, which lives at the SOURCE.
 *   S03e  R3 at the source after S03d - is the source lineage revoked?
 *   S03f  the target lineage from S03b after S03d/e - independent?
 *
 * Runs whether or not the key is shared: refresh does not depend on it.
 */
import type { TestModule, TestResult } from "../../../harness/src/types";
import {
  copyUser,
  errText,
  host,
  keys,
  newSession,
  refreshSession,
  skipNoPeer,
  str,
  waitReady,
} from "../lib/carry";

const row = (
  id: string,
  title: string,
  r: { status: number; json: Record<string, unknown>; text: string },
  expectOk: boolean | undefined,
): TestResult => ({
  id,
  title,
  status: expectOk === undefined ? "info" : (r.status < 300) === expectOk ? "pass" : "fail",
  detail: errText(r),
  measurements: { status: r.status, error_code: String(r.json.error_code ?? "none") },
});

const mod: TestModule = {
  id: "S03",
  title: "Refresh at the source after the copy",
  where: "local",
  requires: ["pat", "peer"],
  destructive: true,
  async run(ctx) {
    const src = ctx.ref;
    const dst = ctx.peers.target;
    if (!dst) return skipNoPeer("S03", this.title);
    await waitReady(ctx, src);
    await waitReady(ctx, dst);
    const sk = await keys(ctx, src);
    const dk = await keys(ctx, dst);
    if (!sk.anon || !sk.service || !dk.anon) {
      return { id: "S03z", title: "key fetch", status: "fail", detail: "could not read API keys" };
    }
    const s = await newSession(src, { anon: sk.anon, service: sk.service }, "s03");
    if ("error" in s) return { id: "S03z", title: "source session", status: "fail", detail: s.error };
    const R1 = s.refresh;

    const copy = await copyUser(ctx, src, dst, s.uid, "S03c0");
    const results: TestResult[] = [...copy.results];
    if (!copy.ok) return results;

    const toR2 = await refreshSession(host(src), sk.anon, R1);
    const R2 = str(toR2.json.refresh_token);
    results.push(row("S03p", "Precondition: refresh at the source after the copy (R1 -> R2)", toR2, true));
    if (!R2) return results;

    results.push(
      row("S03a", "R2 (issued after the copy) at the target", await refreshSession(host(dst), dk.anon, R2), false),
    );

    const r1t = await refreshSession(host(dst), dk.anon, R1);
    results.push(row("S03b", "R1 (revoked at the source, not at the target) at the target", r1t, undefined));
    const R1t = str(r1t.json.refresh_token);

    const toR3 = await refreshSession(host(src), sk.anon, R2);
    const R3 = str(toR3.json.refresh_token);
    results.push(row("S03c", "R2 still refreshes at the source", toR3, undefined));

    // Past the default 10s reuse interval, so reuse detection applies.
    await new Promise((x) => setTimeout(x, 12000));
    results.push(
      row("S03d", "R1 re-presented at the source after >10s (reuse)", await refreshSession(host(src), sk.anon, R1), undefined),
    );
    if (R3) {
      results.push(
        row("S03e", "Source lineage (R3) after the reuse at the source", await refreshSession(host(src), sk.anon, R3), undefined),
      );
    }
    if (R1t) {
      results.push(
        row("S03f", "Target lineage after the reuse at the source", await refreshSession(host(dst), dk.anon, R1t), undefined),
      );
    }
    return results;
  },
};
export default mod;
