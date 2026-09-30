/**
 * MS03 - a network restriction against every Postgres path, including the
 * dedicated PgBouncer, with the verbatim refusal per path.
 *
 * security-lockdown S10 measured the SHARED pooler's refusal
 * (`FATAL (EADDRNOTALLOWED) address not in tenant`); platform-downtime D02
 * measured time-to-bite on the same path. Neither reached the dedicated pooler
 * or direct 5432, because that vantage had no IPv4 path to them. PgBouncer has
 * no tenant concept, so its refusal MODE (immediate error vs. connect timeout)
 * is what a serverless client's retry budget depends on. Rows:
 *
 *   MS03a  baseline: every path connects at 0.0.0.0/0.
 *   MS03b  restricted to 192.0.2.0/24 (excludes this machine): time-to-bite
 *          and the first failure text on direct 5432, dedicated 6543, shared
 *          5432, shared 6543; REST probed once as the control that HTTP is
 *          untouched.
 *   MS03c  restored to 0.0.0.0/0: time-to-recover per path.
 *
 * DESTRUCTIVE: mutates network restrictions; restores in `finally`. Needs the
 * IPv4 add-on on (MS02) for the two db.<ref> paths to have a baseline.
 */
import { mgmt } from "../../../harness/src/mgmt";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { dedicatedTarget, directTarget, pgOnce, primaryPooler, restProbe, sharedTargets, sleep, type PgTarget } from "../lib/setup";

const RESTRICT = { dbAllowedCidrs: ["192.0.2.0/24"], dbAllowedCidrsV6: ["2001:db8::/32"] };
const OPEN = { dbAllowedCidrs: ["0.0.0.0/0"], dbAllowedCidrsV6: ["::/0"] };
const POLL_MS = 1000;
const BITE_MAX_MS = 180_000;
const RECOVER_MAX_MS = 180_000;

const mod: TestModule = {
  id: "MS03",
  title: "Network restriction: bite time and refusal text per Postgres path, incl. the dedicated pooler",
  where: "local",
  requires: ["pat", "db", "anon-key"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const sv = await primaryPooler(ctx);
    const paths: PgTarget[] = [directTarget(ctx), dedicatedTarget(ctx)];
    if (sv) {
      const s = sharedTargets(sv);
      paths.push(s.session, s.txn);
    }
    const rest = restProbe(ctx);
    const out: TestResult[] = [];

    const base = await Promise.all(paths.map((p) => pgOnce(p, ctx.dbPassword)));
    const live = paths.filter((_, i) => base[i]!.ok);
    out.push({
      id: "MS03a",
      title: "baseline at 0.0.0.0/0",
      status: live.length === paths.length ? "pass" : live.length ? "info" : "skip",
      detail: paths.map((p, i) => `${p.name}: ${base[i]!.ok ? "ok" : base[i]!.error}`).join("; "),
      measurements: Object.fromEntries(paths.map((p, i) => [`${p.name}_baseline`, base[i]!.ok ? "ok" : "down"])),
    });
    if (!live.length) return out;

    try {
      const t0 = Date.now();
      const apply = await mgmt(ctx, "POST", `/projects/${ctx.ref}/network-restrictions/apply`, RESTRICT);
      const applyMs = Date.now() - t0;
      const bite = new Map<string, { ms: number; error: string }>();
      while (Date.now() - t0 < BITE_MAX_MS && bite.size < live.length) {
        await Promise.all(
          live.filter((p) => !bite.has(p.name)).map(async (p) => {
            const r = await pgOnce(p, ctx.dbPassword);
            if (!r.ok) bite.set(p.name, { ms: Date.now() - t0, error: r.error ?? "" });
          }),
        );
        if (bite.size < live.length) await sleep(POLL_MS);
      }
      const restNow = await rest.run();
      const m: Record<string, string | number> = { apply_http: apply.status, apply_ms: applyMs, rest_during_restriction: restNow.ok ? "ok" : restNow.error ?? "down" };
      for (const p of live) {
        const b = bite.get(p.name);
        m[`${p.name}_bite_s`] = b ? Math.round(b.ms / 100) / 10 : "never";
        m[`${p.name}_refusal`] = b ? b.error : "still connecting";
      }
      out.push({
        id: "MS03b",
        title: "restricted to 192.0.2.0/24: time-to-bite and refusal text per path",
        status: bite.size === live.length ? "pass" : "fail",
        detail: live.map((p) => `${p.name}: ${bite.has(p.name) ? `${Math.round(bite.get(p.name)!.ms / 1000)}s "${bite.get(p.name)!.error}"` : "not refused"}`).join("; "),
        measurements: m,
        evidence: [...bite.entries()].map(([k, v]) => `${k} @${v.ms}ms: ${v.error}`).join("\n"),
      });
    } finally {
      const t1 = Date.now();
      const open = await mgmt(ctx, "POST", `/projects/${ctx.ref}/network-restrictions/apply`, OPEN).catch(() => ({ status: 0 }));
      const back = new Map<string, number>();
      while (Date.now() - t1 < RECOVER_MAX_MS && back.size < live.length) {
        await Promise.all(
          live.filter((p) => !back.has(p.name)).map(async (p) => {
            const r = await pgOnce(p, ctx.dbPassword);
            if (r.ok) back.set(p.name, Date.now() - t1);
          }),
        );
        if (back.size < live.length) await sleep(POLL_MS);
      }
      out.push({
        id: "MS03c",
        title: "restored to 0.0.0.0/0: time-to-recover per path",
        status: back.size === live.length ? "pass" : "fail",
        detail: live.map((p) => `${p.name}: ${back.has(p.name) ? `${Math.round(back.get(p.name)! / 1000)}s` : "NOT back - check the dashboard"}`).join("; "),
        measurements: { restore_http: open.status, ...Object.fromEntries(live.map((p) => [`${p.name}_recover_s`, back.has(p.name) ? Math.round(back.get(p.name)! / 100) / 10 : "never"])) },
      });
    }
    return out;
  },
};
export default mod;
