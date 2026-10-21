/**
 * OR11 - is OrioleDB's experimental S3 mode reachable on a hosted project?
 *
 * The OrioleDB docs describe an experimental S3 mode (decoupled storage):
 * `orioledb.s3_mode`, `archive_library = 'orioledb'`, the `orioledb.s3_*`
 * connection settings (postmaster-level, `s3_desired_size` sighup)
 * (https://orioledb.com/docs/usage/decoupled-storage). The local beta19 image
 * compiles them in, default off. This module creates one OrioleDB project in
 * the Pro org (`PVLAB_ORG_PRO`, default compute), reads the same settings
 * through the session pooler, reads the Management API's Postgres config for
 * any S3 key, and tries `ALTER SYSTEM SET orioledb.s3_mode = on` as the
 * hosted `postgres` role (expected refusal; recorded verbatim). Deleted in
 * `finally`.
 *
 * Not settled: whether Supabase could turn S3 mode on for a project (an
 * operator path the API does not show); anything about S3 mode's behaviour,
 * which experiments/wal-on-s3 measures on a local rig.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { mgmt } from "../../../harness/src/mgmt";
import { connect, sleep, NAME_PREFIX, REGION, type Proj } from "../lib/pair";

const ID = "OR11";

const mod: TestModule = {
  id: ID,
  title: "OrioleDB S3-mode settings on a hosted project",
  where: "local",
  requires: ["pat"],
  destructive: true,

  async run(ctx: Ctx): Promise<TestResult[]> {
    const org = ctx.orgs.pro;
    if (!org) return [{ id: ID, title: this.title, status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    const password = `${crypto.randomUUID().replace(/-/g, "")}Aa1`;
    const name = `${NAME_PREFIX}-s3-${Date.now()}`;
    let ref = "";
    const m: Record<string, string | number> = {};
    try {
      const r = await mgmt(ctx, "POST", "/projects", {
        organization_slug: org,
        name,
        db_pass: password,
        region_selection: { type: "specific", code: REGION },
        postgres_engine: "17-oriole",
      });
      ref = String((r.json as { ref?: string } | undefined)?.ref ?? "");
      m.create_status = r.status;
      if (r.status !== 201 || !ref) {
        m.create_body = r.text.replace(/\s+/g, " ").slice(0, 300);
        return [{ id: ID, title: this.title, status: "info", detail: `create HTTP ${r.status}`, measurements: m }];
      }
      let st = "";
      for (let i = 0; i < 90 && st !== "ACTIVE_HEALTHY"; i++) {
        await sleep(10_000);
        st = String(((await mgmt(ctx, "GET", `/projects/${ref}`)).json as { status?: string } | undefined)?.status ?? "");
      }
      m.final_status = st;

      const pgc = await mgmt(ctx, "GET", `/projects/${ref}/config/database/postgres`);
      const keys = Object.keys((pgc.json ?? {}) as Record<string, unknown>);
      m.mgmt_postgres_config_http = pgc.status;
      m.mgmt_postgres_config_keys = keys.length;
      m.mgmt_postgres_config_s3_keys = keys.filter((k) => /s3|archive|oriole/i.test(k)).join(",") || "none";

      const pr = await mgmt(ctx, "GET", `/projects/${ref}/config/database/pooler`);
      const cs = String(((Array.isArray(pr.json) ? pr.json : [])[0] as { connectionString?: string } | undefined)?.connectionString ?? "");
      const host = /@([^:/]+):/.exec(cs)?.[1] ?? "";
      if (host && st === "ACTIVE_HEALTHY") {
        const p: Proj = { role: "s3", ref, name, password, host, owned: true };
        for (let i = 0; i < 12; i++) {
          try {
            const c = await connect(p);
            m.version = String((await c.query("select version() as v")).rows[0]?.v).slice(0, 120);
            m.orioledb_version = String((await c.query("select orioledb_version() as v")).rows[0]?.v);
            const s = await c.query(
              `select name, setting, context from pg_settings
               where name like 'orioledb.s3%' or name in ('archive_library','archive_mode','archive_command','wal_level')
               order by name`,
            );
            m.settings_rows = s.rows.length;
            for (const row of s.rows) m[`setting_${row.name}`] = `${row.setting === "" ? "(empty)" : row.setting} [${row.context}]`;
            try {
              await c.query("alter system set orioledb.s3_mode = on");
              m.alter_system_s3_mode = "accepted";
              await c.query("alter system reset orioledb.s3_mode").catch(() => undefined);
            } catch (e) {
              m.alter_system_s3_mode = `refused: ${(e as Error).message.slice(0, 140)}`;
            }
            await c.end();
            break;
          } catch (e) {
            m.connect_error = (e as Error).message.slice(0, 160);
            await sleep(10_000);
          }
        }
      }
      const s3mode = String(m["setting_orioledb.s3_mode"] ?? "absent");
      return [
        {
          id: ID,
          title: this.title,
          status: "info",
          detail: `orioledb.s3_mode ${s3mode}; ALTER SYSTEM ${String(m.alter_system_s3_mode ?? "not tried").slice(0, 40)}; mgmt config s3 keys: ${m.mgmt_postgres_config_s3_keys}`,
          measurements: m,
        },
      ];
    } finally {
      if (ref) await mgmt(ctx, "DELETE", `/projects/${ref}`);
    }
  },
};

export default mod;
