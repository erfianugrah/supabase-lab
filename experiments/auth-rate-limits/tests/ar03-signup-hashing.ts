/**
 * AR03 - sign-up throughput is bcrypt-bound, not rate-limit-bound. Password
 * hashing is CPU work (tens of ms) that cannot be parallelised past core count,
 * so per-request latency rises as concurrency rises on a fixed instance - the
 * reason a sign-up burst queues on CPU well before any rate limit trips.
 *
 * Admin-create is the vehicle: POST /auth/v1/admin/users hashes the password
 * with bcrypt but sends no email, so the email-send cap (AR01b) does not
 * interfere and the measurement is the hash cost alone.
 *
 *   AR03a  concurrency 1: N sequential admin-creates. Baseline per-request
 *          latency - one hash at a time.
 *   AR03b  concurrency C: N admin-creates fired in C-wide batches. If hashing is
 *          CPU-bound on a small instance, median per-request latency rises
 *          versus AR03a. PASS if p50(concurrent) > p50(sequential) by a clear
 *          margin (contention is real); INFO-style detail carries both curves.
 *
 * Not settled by this module: the absolute RPS ceiling (depends on the tier's
 * core count, not measured here) and whether the managed sign-in path shows the
 * same curve (admin-create is the isolated hash probe).
 *
 * DESTRUCTIVE: creates confirmed users, deletes them in finally.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { fetchKeys } from "../../../harness/src/platform";
import { adminCreateUser, deleteUsersByPrefix, pctl } from "../lib/auth";

const N = 24;
const C = 8;
// Fixed synthetic test password, low entropy on purpose (secret scanners).
const PW = "supabase-lab-test-password";

const mod: TestModule = {
  id: "AR03",
  title: "Sign-up throughput is bcrypt-bound: latency rises with concurrency",
  where: "local",
  requires: ["pat", "anon-key"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!ctx.ref) return [{ id: "AR03", title: this.title, status: "skip", detail: "no project ref (PVLAB_REF)" }];
    const keys = await fetchKeys(ctx);
    if (!keys.service) return [{ id: "AR03", title: this.title, status: "skip", detail: "no service_role key" }];
    const out: TestResult[] = [];
    const email = (tag: string, i: number) => `ar03.${tag}.${Date.now()}.${i}@example.com`;

    try {
      // AR03a - sequential.
      const seq: number[] = [];
      for (let i = 0; i < N; i++) {
        const r = await adminCreateUser(ctx, keys.service, email("seq", i), PW);
        if (r.status < 300) seq.push(r.ms);
      }
      const seqP50 = pctl(seq, 50);
      out.push({
        id: "AR03a",
        title: `sequential admin-create x${N} (concurrency 1)`,
        status: seq.length ? "pass" : "fail",
        detail: seq.length ? `p50 ${seqP50}ms, p95 ${pctl(seq, 95)}ms over ${seq.length} creates` : "no successful creates",
        measurements: { ok: seq.length, p50_ms: seqP50, p95_ms: pctl(seq, 95) },
      });

      // AR03b - C-wide batches.
      const con: number[] = [];
      for (let i = 0; i < N; i += C) {
        const batch = await Promise.all(
          Array.from({ length: Math.min(C, N - i) }, (_, j) => adminCreateUser(ctx, keys.service!, email("con", i + j), PW)),
        );
        for (const r of batch) if (r.status < 300) con.push(r.ms);
      }
      const conP50 = pctl(con, 50);
      const rises = seqP50 > 0 && conP50 > seqP50 * 1.3;
      out.push({
        id: "AR03b",
        title: `concurrent admin-create x${N} at concurrency ${C}: per-request latency vs sequential`,
        status: con.length ? (rises ? "pass" : "info") : "fail",
        detail: con.length
          ? `p50 ${conP50}ms (seq ${seqP50}ms), p95 ${pctl(con, 95)}ms - ${rises ? "latency rose under concurrency (CPU-bound)" : "no clear rise; instance had CPU headroom or the pool absorbed it"}`
          : "no successful creates",
        measurements: { ok: con.length, p50_ms: conP50, seq_p50_ms: seqP50, p95_ms: pctl(con, 95), rose: rises ? 1 : 0 },
      });
    } catch (e) {
      out.push({ id: "AR03", title: this.title, status: "fail", detail: `threw: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      const del = await deleteUsersByPrefix(ctx, keys.service, "ar03.").catch(() => 0);
      out.push({ id: "AR03z", title: "cleanup: delete ar03.* users", status: "pass", detail: `deleted ${del} users (best effort; a second run clears any left by paging)` });
    }
    return out;
  },
};

export default mod;
