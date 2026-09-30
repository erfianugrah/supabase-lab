/**
 * MS09 - the client-connection ceiling on Medium: where each pooler starts
 * queueing and where it refuses, against the published 600.
 *
 * privatelink-aws measured this on Micro through a PrivateLink endpoint and
 * found the refusal count irreproducible (174-288 against a published 200)
 * but the ORDER stable: queue first, refuse later. This repeats it on Medium
 * from the public IPv4 path for both poolers, so "what fails first" has a
 * Medium answer. Rows:
 *
 *   MS09a  dedicated 6543: connections opened in steps of 50 up to 700, each
 *          holding one `select pg_sleep(2)` then idling. Per step: connect
 *          p50/p95, failures with verbatim text, NOTICE count ("client being
 *          queued"). The first refusal's count and text.
 *   MS09b  shared 6543: the same.
 *
 * DESTRUCTIVE: saturates the pooler for a few minutes. All connections are
 * closed in `finally`. Not settled: the ceiling as a precise integer (see
 * above), and behaviour of long-lived idle clients over hours (T29 soak).
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { dedicatedTarget, errText, pgClient, pgbouncerConfig, primaryPooler, sharedTargets, sleep, type PgTarget } from "../lib/setup";
import type { Client } from "pg";

const STEP = 50;
const MAX = Number(process.env.PVLAB_RAMP_MAX ?? 700);
const CONNECT_TIMEOUT_MS = 15_000;

function pct(xs: number[], p: number): number | string {
  if (!xs.length) return "n/a";
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? "n/a";
}

async function ramp(ctx: Ctx, t: PgTarget, published: number | string): Promise<TestResult> {
  const held: Client[] = [];
  const steps: string[] = [];
  let notices = 0;
  // Mutated from inside the per-connection closures, so kept on an object:
  // TS narrows a `let` assigned only in closures to `never` at the read site.
  const first: { refusal: { at: number; text: string } | null; timeout: number | null } = { refusal: null, timeout: null };
  const modes = new Set<string>();
  try {
    for (let target = STEP; target <= MAX; target += STEP) {
      const lat: number[] = [];
      let fails = 0;
      const batch = Array.from({ length: STEP }, async () => {
        const c = pgClient(t, ctx.dbPassword, CONNECT_TIMEOUT_MS);
        c.on("notice", (n) => {
          notices++;
          if (/queued/i.test(String(n.message))) modes.add(`NOTICE ${String(n.message).slice(0, 80)}`);
        });
        c.on("error", () => {});
        const t0 = Date.now();
        try {
          await c.connect();
          await c.query("select pg_sleep(2)");
          lat.push(Date.now() - t0);
          held.push(c);
        } catch (e) {
          fails++;
          const msg = errText(e);
          modes.add(msg.slice(0, 100));
          const count = held.length + 1;
          if (/timeout/i.test(msg)) first.timeout ??= count;
          else first.refusal ??= { at: count, text: msg };
          await c.end().catch(() => {});
        }
      });
      await Promise.all(batch);
      steps.push(`${held.length} held after step to ${target}: connect p50 ${pct(lat, 50)}ms p95 ${pct(lat, 95)}ms, ${fails} failed, notices so far ${notices}`);
      ctx.log(`${t.name} ${steps[steps.length - 1]}`);
      if (first.refusal && fails === STEP) break;
      await sleep(1000);
    }
  } finally {
    await Promise.all(held.map((c) => c.end().catch(() => {})));
  }
  return {
    id: t.name === "dedicated_6543" ? "MS09a" : "MS09b",
    title: `${t.name}: client ramp to ${MAX} in steps of ${STEP} (published cap ${published})`,
    status: "info",
    detail: first.refusal ? `first refusal at client #${first.refusal.at}: ${first.refusal.text}` : first.timeout ? `no refusal; first connect TIMEOUT at client #${first.timeout} - queueing, not refusing` : `no refusal or timeout up to ${MAX} clients`,
    measurements: {
      path: t.name,
      published_cap: published,
      held_max: steps.length ? Number(/^(\d+) held/.exec(steps[steps.length - 1]!)?.[1] ?? 0) : 0,
      first_refusal_at: first.refusal?.at ?? "none",
      first_refusal_text: first.refusal?.text ?? "",
      first_timeout_at: first.timeout ?? "none",
      notices: notices,
    },
    evidence: [...steps, "modes: " + [...modes].join(" || ")].join("\n"),
  };
}

const mod: TestModule = {
  id: "MS09",
  title: "Client-connection ramp on Medium: queue vs refuse, per pooler",
  where: "local",
  requires: ["pat", "db"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const sv = await primaryPooler(ctx);
    const pgb = await pgbouncerConfig(ctx);
    const out: TestResult[] = [];
    out.push(await ramp(ctx, dedicatedTarget(ctx), pgb.cfg.max_client_conn ?? "unknown"));
    await sleep(20_000);
    if (sv) out.push(await ramp(ctx, sharedTargets(sv).txn, sv.max_client_conn ?? "unknown"));
    return out;
  },
};
export default mod;
