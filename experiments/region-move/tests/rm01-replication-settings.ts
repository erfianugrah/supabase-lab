/**
 * RM01 - logical-replication settings on the smallest compute a Pro org can
 * create. A per-tenant region move by logical replication needs a slot and a
 * walsender on the source and apply/sync workers on the target; the lab had
 * read these on Small and Medium only (10 slots, 10 walsenders).
 *
 * RM01a asks POST /v1/projects for `nano` on the Pro org and records the answer
 * verbatim; if it is created, RM01a reads the settings there and deletes it.
 * RM01b reads the same settings on the shared Micro source.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import {
  connect,
  createProject,
  deleteProject,
  ensurePair,
  SRC_REGION,
  waitConnectable,
  waitHealthy,
  type Proj,
} from "../lib/projects.js";

const SETTINGS = [
  "server_version",
  "wal_level",
  "max_replication_slots",
  "max_wal_senders",
  "max_logical_replication_workers",
  "max_sync_workers_per_subscription",
  "max_worker_processes",
  "max_slot_wal_keep_size",
  "shared_buffers",
  "max_connections",
];

async function readSettings(p: Proj): Promise<Record<string, string>> {
  const c = await connect(p);
  try {
    const out: Record<string, string> = {};
    const r = await c.query<{ name: string; setting: string; unit: string | null }>(
      "select name, setting, unit from pg_settings where name = any($1)",
      [SETTINGS],
    );
    for (const row of r.rows) out[row.name] = row.unit ? `${row.setting} ${row.unit}` : row.setting;
    // statement_timeout as the postgres role sees it on a fresh session (role-level setting included).
    const t = await c.query<{ v: string }>("select current_setting('statement_timeout') as v");
    out["statement_timeout (postgres session)"] = t.rows[0]?.v ?? "";
    const rs = await c.query<{ cfg: string[] | null }>(
      "select rolconfig as cfg from pg_roles where rolname = 'postgres'",
    );
    out["postgres rolconfig"] = (rs.rows[0]?.cfg ?? []).join(" ");
    return out;
  } finally {
    await c.end();
  }
}

const mod: TestModule = {
  id: "RM01",
  title: "RM01 - replication settings on the smallest creatable compute",
  where: "local",
  requires: ["pat", "org"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const results: TestResult[] = [];

    const t0 = Date.now();
    const nano = await createProject(ctx, "nano", SRC_REGION, "nano");
    if (!nano.proj) {
      results.push({
        id: "RM01a",
        title: "RM01a - POST /v1/projects desired_instance_size=nano on a Pro org",
        status: "info",
        detail: `refused: HTTP ${nano.status}`,
        measurements: { http: nano.status },
        evidence: nano.text.slice(0, 600),
      });
    } else {
      try {
        const secs = await waitHealthy(ctx, nano.proj, t0);
        await waitConnectable(ctx, nano.proj, t0);
        const s = await readSettings(nano.proj);
        const sz = await (async () => {
          const r = await fetch(`https://api.supabase.com/v1/projects/${nano.proj!.ref}/billing/addons`, {
            headers: { Authorization: `Bearer ${ctx.pat}` },
          });
          return `${r.status} ${(await r.text()).slice(0, 300)}`;
        })();
        results.push({
          id: "RM01a",
          title: "RM01a - POST /v1/projects desired_instance_size=nano on a Pro org",
          status: "pass",
          detail: `created (HTTP ${nano.status}); healthy after ${secs} s; slots ${s.max_replication_slots}, walsenders ${s.max_wal_senders}, logical workers ${s.max_logical_replication_workers}`,
          measurements: { http: nano.status, healthy_s: secs, connect_s: nano.proj.connectSeconds ?? -1, ...s },
          evidence: `billing/addons: ${sz}`,
        });
      } catch (e) {
        results.push({
          id: "RM01a",
          title: "RM01a - POST /v1/projects desired_instance_size=nano on a Pro org",
          status: "fail",
          detail: `created (HTTP ${nano.status}) but the read failed: ${e instanceof Error ? e.message : String(e)}`,
          evidence: nano.text.slice(0, 600),
        });
      } finally {
        await deleteProject(ctx, nano.proj);
      }
    }

    const { src } = await ensurePair(ctx);
    const s = await readSettings(src);
    results.push({
      id: "RM01b",
      title: "RM01b - the same settings on Micro (shared source)",
      status: "pass",
      detail: `micro ${src.region}: slots ${s.max_replication_slots}, walsenders ${s.max_wal_senders}, logical workers ${s.max_logical_replication_workers}, sync/sub ${s.max_sync_workers_per_subscription}`,
      measurements: s,
    });
    return results;
  },
};

export default mod;
