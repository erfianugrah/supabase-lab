/**
 * MS06 - can a read replica live in the SAME region as its primary, and how
 * long until it serves reads?
 *
 * The docs describe replicas "across multiple regions" and never say the
 * replica region may equal the primary's. privatelink-aws T28 was written to
 * try exactly this and never ran; sfp-platforms S07e got a `204` on setup
 * (after PITR was enabled) and did not wait for the replica. Rows:
 *
 *   MS06a  prerequisite: the `pitr` add-on (`pitr_7`) - applied here if absent,
 *          because S07e measured replica setup refusing until physical
 *          backups exist. Status and whether setup is then accepted.
 *   MS06b  POST read-replicas/setup {read_replica_region: <primary region>}:
 *          HTTP status; if refused, the verbatim body is the finding.
 *   MS06c  time until the replica appears in the pooler config as a
 *          READ_REPLICA entry, and until a connection through its Supavisor
 *          string answers `select pg_is_in_recovery()` = true.
 *   MS06d  removal: POST read-replicas/remove {database_identifier} and the
 *          time until the entry is gone. Then `pitr_7` is removed again
 *          (status recorded - it may be refused).
 *
 * DESTRUCTIVE and BILLABLE: a replica bills as a second Medium while it
 * exists (bounded at 25 minutes here), PITR bills for the hours it is on.
 * Not settled: replica lag under load, and whether promotion is offered for a
 * same-region replica.
 */
import { mgmt } from "../../../harness/src/mgmt";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { addons, applyAddon, errText, primaryPooler, removeAddon, sleep, supavisorConfig, waitHealthy } from "../lib/setup";
import { Client } from "pg";

const SETUP_RETRY_MAX_MS = 10 * 60_000;
const APPEAR_MAX_MS = 25 * 60_000;
const REMOVE_MAX_MS = 10 * 60_000;

const mod: TestModule = {
  id: "MS06",
  title: "Same-region read replica (ap-southeast-2 next to ap-southeast-2): accepted, time-to-serve, removal",
  where: "local",
  requires: ["pat", "db"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];
    const proj = await mgmt(ctx, "GET", `/projects/${ctx.ref}`);
    const region = String((proj.json as { region?: string })?.region ?? ctx.region);

    // MS06a - PITR prerequisite
    let ad = await addons(ctx);
    let pitrApplied = false;
    let pitrStatus = "already selected";
    if (!ad.selected.some((a) => a.type === "pitr")) {
      if (!ad.available.includes("pitr")) {
        out.push({ id: "MS06a", title: "pitr add-on prerequisite", status: "skip", detail: `pitr not in available_addons [${ad.available.join(",")}]` });
        return out;
      }
      const r = await applyAddon(ctx, "pitr", "pitr_7");
      pitrApplied = r.status < 300;
      pitrStatus = `HTTP ${r.status}${r.status >= 300 ? ` ${r.text}` : ""}`;
    }
    ad = await addons(ctx);
    out.push({
      id: "MS06a",
      title: "pitr add-on (pitr_7) as the replica prerequisite",
      status: ad.selected.some((a) => a.type === "pitr") ? "pass" : "fail",
      detail: `pitr ${pitrStatus}; selected now [${ad.selected.map((a) => a.variant).join(",")}]`,
      measurements: { pitr_status: pitrStatus, pitr_applied_by_module: String(pitrApplied) },
    });
    if (!ad.selected.some((a) => a.type === "pitr")) return out;

    // MS06b - setup, retried while the platform reports a prerequisite not yet met.
    const t0 = Date.now();
    let setup = await mgmt(ctx, "POST", `/projects/${ctx.ref}/read-replicas/setup`, { read_replica_region: region });
    const attempts: string[] = [`${Math.round((Date.now() - t0) / 1000)}s HTTP ${setup.status} ${setup.text.slice(0, 160)}`];
    while (setup.status >= 300 && setup.status !== 402 && Date.now() - t0 < SETUP_RETRY_MAX_MS) {
      await sleep(30_000);
      setup = await mgmt(ctx, "POST", `/projects/${ctx.ref}/read-replicas/setup`, { read_replica_region: region });
      attempts.push(`${Math.round((Date.now() - t0) / 1000)}s HTTP ${setup.status} ${setup.text.slice(0, 160)}`);
    }
    out.push({
      id: "MS06b",
      title: `POST read-replicas/setup with read_replica_region = ${region} (the primary's region)`,
      status: setup.status < 300 ? "pass" : "fail",
      detail: setup.status < 300 ? `accepted HTTP ${setup.status} after ${attempts.length} attempt(s), ${Math.round((Date.now() - t0) / 1000)}s` : `refused: ${attempts[attempts.length - 1]}`,
      measurements: { setup_http: setup.status, setup_attempts: attempts.length, setup_accepted_after_s: Math.round((Date.now() - t0) / 1000) },
      evidence: attempts.join("\n"),
    });
    if (setup.status >= 300) {
      if (pitrApplied) {
        const rm = await removeAddon(ctx, "pitr_7");
        out.push({ id: "MS06d", title: "cleanup: remove pitr_7", status: "info", detail: `DELETE pitr_7 HTTP ${rm.status} ${rm.text}` });
      }
      return out;
    }

    // MS06c - appear + serve
    const t1 = Date.now();
    let entry: Awaited<ReturnType<typeof supavisorConfig>>[number] | undefined;
    let appearedS: number | string = "never";
    let servedS: number | string = "never";
    let recovery = "";
    let lastErr = "";
    let replicaHost = "";
    while (Date.now() - t1 < APPEAR_MAX_MS) {
      const cfg = await supavisorConfig(ctx).catch(() => []);
      entry = cfg.find((e) => e.database_type === "READ_REPLICA");
      if (entry && appearedS === "never") {
        appearedS = Math.round((Date.now() - t1) / 1000);
        ctx.log(`replica entry ${entry.identifier} at ${appearedS}s`);
      }
      if (entry?.connection_string) {
        try {
          const url = new URL(entry.connection_string.replace(/^postgres(ql)?:\/\//, "http://"));
          replicaHost = url.hostname;
          const c = new Client({
            host: url.hostname,
            port: Number(url.port || 6543),
            user: decodeURIComponent(url.username),
            password: ctx.dbPassword,
            database: "postgres",
            ssl: { rejectUnauthorized: false },
            connectionTimeoutMillis: 8000,
          });
          await c.connect();
          const r = await c.query<{ rec: boolean }>("select pg_is_in_recovery() as rec");
          await c.end();
          recovery = String(r.rows[0]?.rec);
          servedS = Math.round((Date.now() - t1) / 1000);
          break;
        } catch (e) {
          lastErr = errText(e);
        }
      }
      await sleep(15_000);
    }
    const hRep = await waitHealthy(ctx, ["db"], 1000).catch(() => ({ last: {} as Record<string, string> }));
    out.push({
      id: "MS06c",
      title: "replica appears in the pooler config and serves a read",
      status: servedS !== "never" ? "pass" : "fail",
      detail: entry ? `identifier ${entry.identifier} appeared after ${appearedS}s; ${servedS !== "never" ? `served pg_is_in_recovery()=${recovery} after ${servedS}s via ${replicaHost}` : `never served within ${APPEAR_MAX_MS / 60000} min (last: ${lastErr})`}` : `no READ_REPLICA entry within ${APPEAR_MAX_MS / 60000} min`,
      measurements: { appeared_s: appearedS, served_s: servedS, pg_is_in_recovery: recovery, identifier: entry?.identifier ?? "", replica_user: entry?.db_user ?? "", primary_db_health: hRep.last.db ?? "" },
    });

    // MS06d - remove
    const t2 = Date.now();
    let rm = { status: 0, text: "no identifier to remove" };
    let goneS: number | string = "n/a";
    if (entry) {
      const r = await mgmt(ctx, "POST", `/projects/${ctx.ref}/read-replicas/remove`, { database_identifier: entry.identifier });
      rm = { status: r.status, text: r.text.slice(0, 200) };
      while (Date.now() - t2 < REMOVE_MAX_MS) {
        const cfg = await supavisorConfig(ctx).catch(() => null);
        if (cfg && !cfg.some((e) => e.database_type === "READ_REPLICA")) {
          goneS = Math.round((Date.now() - t2) / 1000);
          break;
        }
        await sleep(15_000);
      }
    }
    const pitrRm = pitrApplied ? await removeAddon(ctx, "pitr_7") : { status: 0, text: "left as found" };
    out.push({
      id: "MS06d",
      title: "removal: replica gone from the pooler config; pitr_7 removed again",
      status: entry ? (goneS !== "n/a" ? "pass" : "fail") : "skip",
      detail: `remove HTTP ${rm.status}; entry gone after ${goneS}s; pitr_7 DELETE HTTP ${pitrRm.status} ${pitrRm.text}`.slice(0, 300),
      measurements: { remove_http: rm.status, gone_s: goneS, pitr_remove_http: pitrRm.status },
    });
    void primaryPooler;
    return out;
  },
};
export default mod;
