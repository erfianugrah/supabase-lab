/**
 * AR04 - Auth's share of the database connection pool. GoTrue takes a
 * percentage of the project's max_connections, and password hashing holds a
 * connection for the duration of the hash, so the share is a second ceiling on
 * sign-up throughput beside core count (AR03).
 *
 *   AR04a  which connection knobs config/auth exposes and their values, and
 *          the project's max_connections read from Postgres. INFO - the exact
 *          field name and whether it is settable per tier is not asserted here;
 *          the row records what the surface is so a reader can see whether the
 *          lever exists on this project, without this module guessing a name.
 *
 * Not settled by this module: whether changing the share takes effect on the
 * running auth service without a restart, and the HA-replica doubling (each
 * replica takes the share) - both need a mutate-and-observe run this INFO row
 * deliberately does not do.
 *
 * Read-only: reads config/auth and one SQL row. No mutation.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { sql } from "../../../harness/src/platform";
import { getAuthConfig } from "../lib/auth";

const CONN_FIELDS = ["db_max_pool_size", "db_conn_percentage", "max_pool_size", "conn_percentage", "database_max_pool_size"];

const mod: TestModule = {
  id: "AR04",
  title: "Auth's database connection share (surface, recorded)",
  where: "local",
  requires: ["pat"],
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!ctx.ref) return [{ id: "AR04", title: this.title, status: "skip", detail: "no project ref (PVLAB_REF)" }];
    const base = await getAuthConfig(ctx);
    const present = CONN_FIELDS.filter((f) => f in base).map((f) => `${f}=${String(base[f])}`);

    const mc = await sql(ctx, "select setting from pg_settings where name = 'max_connections'");
    const maxConn = (mc.rows[0]?.setting as string | undefined) ?? "unknown";

    return [
      {
        id: "AR04a",
        title: "connection-share knobs on config/auth, and project max_connections",
        status: "info",
        detail: `config/auth connection fields present: ${present.join(", ") || "none of " + CONN_FIELDS.join("/")} | max_connections=${maxConn}`,
        measurements: {
          conn_fields_present: present.join(",") || "none",
          max_connections: maxConn,
        },
      },
    ];
  },
};

export default mod;
