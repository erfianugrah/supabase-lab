/**
 * RW01 - what each target server is, and which of the functions the other
 * modules lean on it actually has.
 *
 * Read-only. Records server_version, the settings that change WAL volume
 * (full_page_writes, wal_compression, data_checksums, wal_log_hints), the
 * autovacuum thresholds RW02/RW03 compute "would trigger" from, shared_buffers
 * (RW04's cold-cache reading depends on it), and whether
 * pg_stat_force_next_flush() and suppress_redundant_updates_trigger() exist -
 * checked with to_regproc on each server rather than assumed from the version.
 *
 * Not settled by this module: anything about a hosted project's settings.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { hasFunction, rigUp, targets, withConn } from "../lib/rig";

const ID = "RW01";

const SETTINGS = [
  "server_version",
  "full_page_writes",
  "wal_compression",
  "data_checksums",
  "wal_log_hints",
  "wal_level",
  "shared_buffers",
  "checkpoint_timeout",
  "max_wal_size",
  "autovacuum",
  "autovacuum_vacuum_threshold",
  "autovacuum_vacuum_scale_factor",
  "autovacuum_vacuum_insert_threshold",
  "stats_fetch_consistency",
];

const mod: TestModule = {
  id: ID,
  title: "Target servers: version, WAL-relevant settings, function availability",
  where: "local",
  requires: [],

  async run(_ctx: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];
    for (const t of targets()) {
      if (!(await rigUp(t))) {
        out.push({ id: `${ID}-${t.role}`, title: this.title, status: "skip", detail: `not answering on 127.0.0.1:${t.port}` });
        continue;
      }
      const m = await withConn(t, async (c) => {
        const vals: Record<string, string | number> = { image: t.image, user: t.user };
        for (const s of SETTINGS) {
          const r = await c.query("select current_setting($1, true) as v", [s]);
          vals[s] = r.rows[0]?.v ?? "(absent)";
        }
        vals.version = (await c.query("select version() as v")).rows[0].v;
        vals.has_pg_stat_force_next_flush = (await hasFunction(c, "pg_stat_force_next_flush")) ? "yes" : "no";
        vals.has_suppress_redundant_updates_trigger = (await hasFunction(c, "suppress_redundant_updates_trigger")) ? "yes" : "no";
        vals.has_pg_stat_wal = (await c.query("select to_regclass('pg_catalog.pg_stat_wal') is not null as ok")).rows[0].ok ? "yes" : "no";
        vals.rolsuper = (await c.query("select rolsuper::text as s from pg_roles where rolname = current_user")).rows[0].s;
        return vals;
      });
      out.push({ id: `${ID}-${t.role}`, title: this.title, status: "pass", detail: String(m.version), measurements: m });
    }
    return out;
  },
};

export default mod;
