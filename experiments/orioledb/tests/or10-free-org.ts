/**
 * OR10 - can a Free-plan organization create an OrioleDB project?
 *
 * The announcement text this experiment started from says OrioleDB needs a
 * Pro organization or higher; the public changelog entry for the public beta
 * (https://supabase.com/changelog) lists Free, Pro, Team and Enterprise, and
 * OR01c reads `instances.orioledb` as `hasAccess=true` on the Free org. This
 * module makes the call: `POST /v1/projects` in the Free org
 * (`PVLAB_ORG_FREE`) with `postgres_engine: "17-oriole"` and no compute size,
 * waits for the project to be healthy, reads back `database.postgres_engine`
 * and the server's `orioledb_version()` and `default_table_access_method`
 * (one pooler connection), then deletes it in `finally`.
 *
 * Skips without `PVLAB_ORG_FREE`. A free org allows two active projects; a
 * refusal for that reason is recorded verbatim, it is not an OrioleDB result.
 *
 * Not settled: anything about Free-plan OrioleDB behaviour after creation
 * (pausing after inactivity, resource limits, the nano compute's orioledb.*
 * pool settings beyond the ones read here).
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { mgmt } from "../../../harness/src/mgmt";
import { connect, sleep, NAME_PREFIX, REGION, type Proj } from "../lib/pair";

const ID = "OR10";

const mod: TestModule = {
  id: ID,
  title: "OrioleDB project on a Free-plan organization",
  where: "local",
  requires: ["pat"],
  destructive: true,

  async run(ctx: Ctx): Promise<TestResult[]> {
    const org = ctx.orgs.free;
    if (!org) return [{ id: ID, title: this.title, status: "skip", detail: "PVLAB_ORG_FREE not set" }];
    const password = `${crypto.randomUUID().replace(/-/g, "")}Aa1`;
    const name = `${NAME_PREFIX}-free-${Date.now()}`;
    let ref = "";
    try {
      const r = await mgmt(ctx, "POST", "/projects", {
        organization_slug: org,
        name,
        db_pass: password,
        region_selection: { type: "specific", code: REGION },
        postgres_engine: "17-oriole",
      });
      ref = String((r.json as { ref?: string } | undefined)?.ref ?? "");
      if (r.status !== 201 || !ref) {
        return [{ id: ID, title: this.title, status: "info", detail: `create HTTP ${r.status}: ${r.text.replace(/\s+/g, " ").slice(0, 300)}`, measurements: { create_status: r.status, create_body: r.text.replace(/\s+/g, " ").slice(0, 300) } }];
      }
      let st = "";
      for (let i = 0; i < 90 && st !== "ACTIVE_HEALTHY"; i++) {
        await sleep(10_000);
        st = String(((await mgmt(ctx, "GET", `/projects/${ref}`)).json as { status?: string } | undefined)?.status ?? "");
      }
      const g = await mgmt(ctx, "GET", `/projects/${ref}`);
      const db = ((g.json as { database?: Record<string, unknown> } | undefined)?.database ?? {}) as Record<string, unknown>;
      const m: Record<string, string | number> = {
        create_status: r.status,
        final_status: st,
        postgres_engine: String(db.postgres_engine ?? "(absent)"),
        release_channel: String(db.release_channel ?? "(absent)"),
      };
      const pr = await mgmt(ctx, "GET", `/projects/${ref}/config/database/pooler`);
      const cs = String(((Array.isArray(pr.json) ? pr.json : [])[0] as { connectionString?: string } | undefined)?.connectionString ?? "");
      const host = /@([^:/]+):/.exec(cs)?.[1] ?? "";
      if (host && st === "ACTIVE_HEALTHY") {
        const p: Proj = { role: "free", ref, name, password, host, owned: true };
        for (let i = 0; i < 12; i++) {
          try {
            const c = await connect(p);
            m.orioledb_version = String((await c.query("select orioledb_version() as v")).rows[0]?.v);
            m.default_table_access_method = String((await c.query("show default_table_access_method")).rows[0]?.default_table_access_method);
            m.shared_buffers = String((await c.query("show shared_buffers")).rows[0]?.shared_buffers);
            m["orioledb.main_buffers"] = String((await c.query("show orioledb.main_buffers")).rows[0]?.["orioledb.main_buffers"]);
            await c.end();
            break;
          } catch (e) {
            m.connect_error = (e as Error).message.slice(0, 160);
            await sleep(10_000);
          }
        }
      }
      return [
        {
          id: ID,
          title: this.title,
          status: m.postgres_engine === "17-oriole" ? "pass" : "info",
          detail: `create ${r.status}; engine ${m.postgres_engine}; status ${st}`,
          measurements: m,
        },
      ];
    } finally {
      if (ref) await mgmt(ctx, "DELETE", `/projects/${ref}`);
    }
  },
};

export default mod;
