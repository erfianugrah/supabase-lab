/**
 * HS07 - Tear down what HS04 and HS06 brought up: the HS06 Workers (and with
 * them their Workers Custom Domains), the custom hostname, its DNS records,
 * and the `custom_domain` add-on. Opt-in only (not in the Makefile's ALL):
 * `make domain-down DOMAIN=<host>`. Also run it before `make destroy`, since
 * destroying the project does not remove records from the Cloudflare zone.
 *
 * DESTRUCTIVE. Self-skips without PVLAB_ENDPOINT_CUSTOM_DOMAIN or Cloudflare
 * credentials.
 */
import { mgmt } from "../../../harness/src/mgmt";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { cfAvailable, listRecords, removeRecords, zoneId } from "../lib/cfdns";
import { WORKERS } from "../lib/site";

/** `wrangler delete` with the key trio from the environment; exit code only. */
async function deleteWorker(name: string): Promise<number> {
  const proc = Bun.spawn(["bunx", "wrangler", "delete", "--name", name, "--force"], { cwd: "site", stdout: "pipe", stderr: "pipe" });
  await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return proc.exited;
}

const mod: TestModule = {
  id: "HS07",
  title: "Custom domain down: hostname, DNS records, add-on",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const host = ctx.endpoints.custom_domain;
    if (!ctx.ref || !host) return [{ id: "HS07", title: this.title, status: "skip", detail: "no PVLAB_ENDPOINT_CUSTOM_DOMAIN" }];
    if (!cfAvailable()) return [{ id: "HS07", title: this.title, status: "skip", detail: "no CLOUDFLARE_API_KEY/CLOUDFLARE_EMAIL in the environment" }];
    const workers = process.env.CLOUDFLARE_ACCOUNT_ID
      ? `storage ${await deleteWorker(WORKERS.storage)}, fn ${await deleteWorker(WORKERS.fn)}`
      : "not attempted (no CLOUDFLARE_ACCOUNT_ID)";
    const del = await mgmt(ctx, "DELETE", `/projects/${ctx.ref}/custom-hostname`);
    const zone = await zoneId(host);
    // The host itself plus the validation names the platform asked for, which
    // all sit under it (`_acme-challenge.<host>`, `_cf-custom-hostname.<host>`).
    const names = [host, `_acme-challenge.${host}`, `_cf-custom-hostname.${host}`];
    const removed = await removeRecords(zone, names);
    let left = 0;
    for (const n of names) left += (await listRecords(zone, n)).length;
    const addon = await mgmt(ctx, "DELETE", `/projects/${ctx.ref}/billing/addons/cd_default`);
    return [
      {
        id: "HS07",
        title: this.title,
        status: left === 0 && (del.status < 300 || del.status === 404) ? "pass" : "fail",
        detail: `wrangler delete exits: ${workers}; DELETE custom-hostname HTTP ${del.status}; ${removed} DNS record(s) removed, ${left} left; add-on DELETE HTTP ${addon.status}`,
        measurements: { workers, delete_http: del.status, dns_removed: removed, dns_left: left, addon_delete_http: addon.status },
      },
    ];
  },
};
export default mod;
