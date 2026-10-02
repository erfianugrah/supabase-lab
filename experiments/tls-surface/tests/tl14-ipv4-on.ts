/**
 * TL14 - switch the IPv4 add-on on, so direct 5432 and the dedicated
 * PgBouncer on 6543 become reachable from this IPv4-only vantage and the
 * NEXT read-only pass of TL10-TL12 covers them.
 *
 * Not a measurement of the add-on (medium-serverless MS02 measured the DNS
 * swap); this is plumbing with a readiness check: wait for an A record, then
 * for 10 s of sustained `select 1` on direct 5432 before declaring the paths
 * usable. DESTRUCTIVE and BILLABLE (the add-on bills hourly while on);
 * TL18 removes it, `make destroy` removes it with the project.
 */
import type { TestModule } from "../../../harness/src/types";
import { $ } from "bun";
import { addons, applyAddon, directTarget, pgOnce, sleep } from "../../medium-serverless/lib/setup";

/**
 * A records via a fresh `dig` each poll, not node:dns in this process: on
 * 2026-10-02 the in-process lookup never saw the record on two runs (12- and
 * 20-minute budgets) while `dig` and the next process did. Cause not established.
 */
async function hasA(host: string): Promise<boolean> {
  const out = (await $`dig +short ${host} A`.quiet().nothrow()).stdout.toString();
  return out.split("\n").some((l) => /^\d+\.\d+\.\d+\.\d+$/.test(l.trim()));
}

const mod: TestModule = {
  id: "TL14",
  title: "IPv4 add-on on: direct 5432 and dedicated 6543 reachable for the next pass",
  where: "local",
  requires: ["pat", "db"],
  destructive: true,
  async run(ctx) {
    const ad = await addons(ctx);
    const t0 = Date.now();
    let applied = "already selected";
    if (!ad.selected.some((a) => a.type === "ipv4")) {
      if (!ad.available.includes("ipv4")) return [{ id: "TL14", title: mod.title, status: "skip", detail: `ipv4 not in available_addons [${ad.available.join(",")}]` }];
      const r = await applyAddon(ctx, "ipv4", "ipv4_default");
      applied = `HTTP ${r.status}${r.status >= 300 ? ` ${r.text}` : ""}`;
      if (r.status >= 300) return [{ id: "TL14", title: mod.title, status: "fail", detail: `apply ${applied}` }];
    }
    let aAt: number | null = null;
    let okFrom: number | null = null;
    let last = "";
    // 20 min budget; the add-on's DNS swap has not been timed here (MS02 did).
    while (Date.now() - t0 < 20 * 60_000) {
      if (aAt === null && (await hasA(ctx.phzHost))) aAt = Date.now() - t0;
      if (aAt !== null) {
        const r = await pgOnce(directTarget(ctx), ctx.dbPassword);
        last = r.ok ? "ok" : (r.error ?? "");
        if (r.ok) okFrom ??= Date.now();
        else okFrom = null;
        if (okFrom && Date.now() - okFrom >= 10_000) break;
      }
      await sleep(3000);
    }
    const ready = okFrom !== null && Date.now() - okFrom >= 10_000;
    return [
      {
        id: "TL14",
        title: mod.title,
        status: ready ? "pass" : "fail",
        detail: `add-on ${applied}; A record after ${aAt === null ? "never" : `${Math.round(aAt / 1000)}s`}; direct 5432 ${ready ? `sustained after ${Math.round((okFrom! - t0) / 1000)}s` : `not ready (${last})`}`,
        measurements: { applied, a_record_s: aAt === null ? "never" : Math.round(aAt / 1000), direct_ready_s: ready ? Math.round((okFrom! - t0) / 1000) : "never" },
      },
    ];
  },
};
export default mod;
