/**
 * TL16 - SSL enforcement on, then off, through the Management API
 * (`PUT /v1/projects/{ref}/ssl-enforcement`).
 *
 * Questions this answers that the docs leave open:
 *   TL16a  the API call: status, latency, `appliedSuccessfully`.
 *   TL16b  does it restart Postgres? `pg_postmaster_start_time()` before and
 *          after, plus a sampler on the shared pooler (TLS) and REST across
 *          the switch. A sampled failure can be the restart OR an hba refusal
 *          of the pooler's plaintext hop; the failure text says which.
 *   TL16c  time until plaintext (`sslmode=disable`) is refused on each
 *          reachable path, and the verbatim refusal - including whether the
 *          SHARED POOLER refuses plaintext too, or only Postgres does.
 *   TL16d  the pooler -> Postgres hop with enforcement on (pg_stat_ssl for
 *          the pooled backend). With it off that hop is plaintext (TL11).
 *   TL16e  the same matrix cells after switching back off: plaintext
 *          accepted again, and how long that took.
 *
 * Restores whatever setting it found. DESTRUCTIVE (changes the setting,
 * possibly restarts the database).
 */
import { mgmt } from "../../../harness/src/mgmt";
import { sampleDuring } from "../../../harness/src/sampler";
import type { TestModule, TestResult } from "../../../harness/src/types";
import { flatten, pgProbe, restProbe, sleep } from "../../medium-serverless/lib/setup";
import { nodeSession, pgPaths, psql, SELF_SSL_SQL } from "../lib/pg";

const WAIT_MS = 4 * 60_000;

async function setEnforcement(ctx: Parameters<TestModule["run"]>[0], on: boolean) {
  const t0 = Date.now();
  const r = await mgmt(ctx, "PUT", `/projects/${ctx.ref}/ssl-enforcement`, { requestedConfig: { database: on } });
  return { status: r.status, ms: Date.now() - t0, body: r.text.slice(0, 200), applied: (r.json as { appliedSuccessfully?: boolean } | undefined)?.appliedSuccessfully };
}

const mod: TestModule = {
  id: "TL16",
  title: "SSL enforcement: on and off, restart or not, plaintext refusal per path, pooler hop",
  where: "local",
  requires: ["pat", "db"],
  destructive: true,
  async run(ctx) {
    const out: TestResult[] = [];
    const before = await mgmt(ctx, "GET", `/projects/${ctx.ref}/ssl-enforcement`);
    const initial = (before.json as { currentConfig?: { database?: boolean } } | undefined)?.currentConfig?.database ?? false;
    const paths = (await pgPaths(ctx)).filter((p) => p.reachable);
    const shared = paths.find((p) => p.name === "shared_5432");
    if (!shared) return [{ id: "TL16", title: mod.title, status: "skip", detail: "no shared pooler path - PAT missing or pooler config unreadable" }];
    const startTime = async () => String((await nodeSession(shared, ctx.dbPassword, "select pg_postmaster_start_time()::text as t")).rows[0]?.t ?? "?");
    const plaintext = async () => Object.fromEntries(await Promise.all(paths.map(async (p) => [p.name, await psql(p, ctx.dbPassword, { sslmode: "disable" }, "select 1")] as const)));

    for (const target of [true, false]) {
      const leg = target ? "on" : "off";
      const st0 = await startTime();
      const flips: Record<string, number | string> = {};
      const lastText: Record<string, string> = {};
      let call: Awaited<ReturnType<typeof setEnforcement>> | null = null;
      const t0 = Date.now();
      const windows = await sampleDuring([pgProbe({ name: "shared_5432_tls", host: shared.host, port: shared.port, user: shared.user }, ctx.dbPassword), restProbe(ctx)], { intervalMs: 1000, maxWaitMs: WAIT_MS, settleMs: 10_000, log: ctx.log }, async () => {
        call = await setEnforcement(ctx, target);
        while (Date.now() - t0 < WAIT_MS) {
          const r = await plaintext();
          for (const [name, res] of Object.entries(r)) {
            if (flips[name] === undefined) lastText[name] = res.ok ? "accepted" : res.err;
            // Enforcement on: waiting for a REFUSAL - an hba/SSL rejection, not
            // "Connection refused", which the first run (2026-10-02) showed is
            // the restart the switch triggers. Off: waiting for acceptance.
            const refusal = !res.ok && /pg_hba|no encryption|SSL|ssl/.test(res.err) && !/Connection refused|timeout expired/.test(res.err);
            if (flips[name] === undefined && (target ? refusal : res.ok)) flips[name] = Math.round((Date.now() - t0) / 1000);
          }
          if (paths.every((p) => flips[p.name] !== undefined)) break;
          await sleep(3000);
        }
      });
      const st1 = await startTime();
      const c = call as Awaited<ReturnType<typeof setEnforcement>> | null;
      out.push({
        id: `TL16-${leg}`,
        title: `SSL enforcement ${leg}: API call, restart, sampled paths, plaintext ${target ? "refusal" : "acceptance"} per path`,
        status: c && c.status < 300 ? "info" : "fail",
        detail: `PUT HTTP ${c?.status} in ${c?.ms}ms appliedSuccessfully=${c?.applied}; postmaster start ${st0 === st1 ? "unchanged (no restart)" : `${st0} -> ${st1} (RESTARTED)`}; sampled: ${windows.map((w) => `${w.name} ${w.failures}/${w.samples} failed${w.windowMs !== null ? `, window ${Math.round(w.windowMs / 1000)}s` : ""}`).join(", ")}; plaintext per path: ${paths.map((p) => `${p.name} ${flips[p.name] === undefined ? `no change in ${WAIT_MS / 60_000} min` : `flipped at ${flips[p.name]}s`} (${lastText[p.name]})`).join("; ")}`,
        measurements: {
          put_http: c?.status ?? 0,
          put_ms: c?.ms ?? 0,
          applied: String(c?.applied),
          restarted: st0 === st1 ? "no" : "yes",
          ...flatten(windows),
          // flatten() writes the medium-serverless constant (500); this module samples at 1000.
          probe_interval_ms: 1000,
          ...Object.fromEntries(paths.map((p) => [`${p.name}_plaintext_flip_s`, flips[p.name] ?? "never"])),
          ...Object.fromEntries(paths.map((p) => [`${p.name}_plaintext`, (lastText[p.name] ?? "").slice(0, 90)])),
        },
      });
      if (target) {
        const hops: string[] = [];
        const m: Record<string, string> = {};
        for (const p of paths) {
          const s = await psql(p, ctx.dbPassword, { sslmode: "require" }, SELF_SSL_SQL);
          m[`${p.name}_hop`] = s.ok ? s.out : `fail: ${s.err.slice(0, 80)}`;
          hops.push(`${p.name}: ${m[`${p.name}_hop`]}`);
        }
        out.push({ id: "TL16-hop", title: "with enforcement on: pg_stat_ssl for the backend behind each path (pooler -> Postgres hop)", status: "info", detail: hops.join("; "), measurements: m });
      }
    }
    if (initial) await setEnforcement(ctx, true);
    out.push({ id: "TL16-restore", title: "restored the setting found at start", status: "info", detail: `initial database enforcement = ${initial}`, measurements: { initial: String(initial) } });
    return out;
  },
};
export default mod;
