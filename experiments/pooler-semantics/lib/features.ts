/**
 * The feature probes, one closure each, run against ONE already-connected
 * client. Which connection mode that client is on is the caller's business -
 * that is what makes this a matrix rather than seven near-identical tests.
 *
 * Every probe is written so its failure carries the SERVER's wording. A reader
 * planning a migration wants to know that their app will see
 * `prepared statement "s1" does not exist`, not that "prepared statements are
 * unsupported" - the first is greppable in their logs, the second is not.
 *
 * Transport is `pg`'s Client, the same one t02-connectivity.ts uses. There is
 * no Bun.SQL in this repo.
 */
import type { Client, Notification } from "pg";
import { FeatureFailure, type Feature } from "../../../harness/src/matrix";

/** How long a self-NOTIFY is given to come back. Chosen, not measured. */
const NOTIFY_WAIT_MS = 3000;

async function backendPid(client: Client): Promise<number> {
  const r = await client.query<{ pid: number }>("select pg_backend_pid() as pid");
  const row = r.rows[0];
  if (!row) throw new FeatureFailure("pg_backend_pid() returned no row");
  return Number(row.pid);
}

/**
 * `tag` must be identifier-safe: it is interpolated into DECLARE / LISTEN /
 * CREATE TEMP TABLE, none of which take parameters. `advisoryKey` is
 * per-RUN, not per-mode: in transaction mode the unlock lands on a different
 * backend than the lock, so the lock LEAKS until that backend is recycled. A
 * fresh key each run is what stops a leaked lock from wedging the next one.
 */
export function featuresFor(client: Client, tag: string, advisoryKey: number): Feature[] {
  const stmt = `pvlab_ps_${tag}`;
  const chan = `pvlab_ch_${tag}`;
  const cursor = `pvlab_cur_${tag}`;
  const temp = `pvlab_tmp_${tag}`;

  return [
    {
      // The mechanism behind every row below. If the backend changes between
      // two statements, nothing session-scoped can survive, and the specific
      // failures become predictions rather than surprises.
      name: "pid_stable",
      async run() {
        const a = await backendPid(client);
        const b = await backendPid(client);
        if (a !== b)
          throw new FeatureFailure(
            `backend changed between two consecutive statements: pid ${a} -> ${b}`,
          );
        return `pid ${a}`;
      },
    },
    {
      // Exactly t02-connectivity.ts's probe: ONE named statement, prepared and
      // executed in a single call. AGENTS.md records this working on 6543.
      name: "prepared_first",
      async run() {
        await client.query({ name: stmt, text: "select 1 as one" });
      },
    },
    {
      // The stronger question t02 did not ask: does the PREPARED statement
      // survive to a later call? node-postgres caches the name per connection
      // and sends Bind/Execute with no Parse the second time, which is how a
      // real client behaves and where a transaction pooler breaks.
      name: "prepared_reuse",
      async run() {
        await client.query("select 1");
        await client.query({ name: stmt, text: "select 1 as one" });
        return "bind/execute with no re-parse";
      },
    },
    {
      name: "advisory_lock",
      async run() {
        await client.query("select pg_advisory_lock($1::bigint)", [advisoryKey]);
        try {
          const r = await client.query<{ released: boolean }>(
            "select pg_advisory_unlock($1::bigint) as released",
            [advisoryKey],
          );
          const row = r.rows[0];
          if (!row) throw new FeatureFailure("pg_advisory_unlock returned no row");
          if (row.released !== true)
            // Postgres RAISES NOTHING here - it returns false and logs a
            // warning. Without FeatureFailure this reads as a pass.
            throw new FeatureFailure(
              `pg_advisory_unlock returned ${row.released}: the session lock was not held by the backend that ran the second statement (lock leaked until that backend is recycled)`,
            );
        } finally {
          await client.query("select pg_advisory_unlock_all()").catch(() => {});
        }
      },
    },
    {
      name: "listen_notify",
      async run() {
        let deliver: () => void = () => {};
        const delivered = new Promise<"delivered">((res) => {
          deliver = () => res("delivered");
        });
        const handler = (msg: Notification) => {
          if (msg.channel === chan) deliver();
        };
        client.on("notification", handler);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await client.query(`listen ${chan}`);
          await client.query(`notify ${chan}, 'pvlab'`);
          const timeout = new Promise<"timeout">((res) => {
            timer = setTimeout(() => res("timeout"), NOTIFY_WAIT_MS);
          });
          if ((await Promise.race([delivered, timeout])) === "timeout")
            throw new FeatureFailure(
              `no NOTIFY delivered within ${NOTIFY_WAIT_MS}ms - the LISTEN registration did not survive to the next statement`,
            );
        } finally {
          if (timer) clearTimeout(timer);
          client.removeListener("notification", handler);
          await client.query(`unlisten ${chan}`).catch(() => {});
        }
      },
    },
    {
      name: "session_guc",
      async run() {
        await client.query("set my.pvlab_probe = 'v1'");
        // current_setting RAISES on an unknown parameter, so a reset session
        // gives `unrecognized configuration parameter "my.pvlab_probe"` -
        // precisely the string an application would see.
        const r = await client.query<{ v: string }>(
          "select current_setting('my.pvlab_probe') as v",
        );
        const row = r.rows[0];
        if (!row) throw new FeatureFailure("current_setting returned no row");
        if (row.v !== "v1") throw new FeatureFailure(`GUC read back as "${row.v}", expected "v1"`);
      },
    },
    {
      // WITH HOLD because a plain DECLARE outside a transaction block is
      // rejected by Postgres itself. Whether WITH HOLD works outside one is
      // answered by the control row, not asserted here.
      name: "cursor_with_hold",
      async run() {
        await client.query(`declare ${cursor} cursor with hold for select generate_series(1,3)`);
        try {
          const r = await client.query(`fetch all from ${cursor}`);
          if (r.rowCount !== 3)
            throw new FeatureFailure(`fetch all returned ${r.rowCount} rows, expected 3`);
        } finally {
          await client.query(`close ${cursor}`).catch(() => {});
        }
      },
    },
    {
      name: "temp_table",
      async run() {
        await client.query(`create temp table ${temp}(i int)`);
        try {
          await client.query(`insert into ${temp} values (1)`);
          const r = await client.query<{ n: number }>(`select count(*)::int as n from ${temp}`);
          const row = r.rows[0];
          if (!row) throw new FeatureFailure("count returned no row");
          if (row.n !== 1) throw new FeatureFailure(`temp table held ${row.n} rows, expected 1`);
        } finally {
          await client.query(`drop table if exists ${temp}`).catch(() => {});
        }
      },
    },
    {
      // A transaction pooler is expected to PIN the connection for the length
      // of an explicit transaction. If it does not, no multi-statement write
      // is safe on that path, which outranks every other row here.
      name: "explicit_txn",
      async run() {
        await client.query("begin");
        try {
          const a = await backendPid(client);
          const b = await backendPid(client);
          if (a !== b)
            throw new FeatureFailure(
              `backend changed INSIDE an explicit transaction: pid ${a} -> ${b}`,
            );
          await client.query("commit");
          return `pinned to pid ${a}`;
        } catch (e) {
          await client.query("rollback").catch(() => {});
          throw e;
        }
      },
    },
  ];
}
