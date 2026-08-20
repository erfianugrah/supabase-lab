/**
 * R06 - what Broadcast's store-and-forward looks like in the catalog.
 *
 * The public Realtime architecture page states: Broadcast creates a
 * publication on realtime.messages, which is partitioned by day, with
 * partitions retained 3 days. The residency doc quotes this; nothing has
 * measured it. This module inspects the catalog of a fresh project:
 *
 *   - does realtime.messages exist
 *   - is it partitioned (pg_inherits children), and do the partition names
 *     show daily granularity
 *   - is it under a publication
 *
 * What a fresh project CANNOT show: the 3-day retention. No partitions are
 * old enough to have been dropped on a project that has existed for minutes.
 * That is stated, not fudged. Presence fan-out ("state sent to all connected
 * Realtime nodes") is not observable from a single vantage at all - also
 * stated, not probed.
 */
import { createClient } from "@supabase/supabase-js";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { getKeys, psql } from "../lib";

const mod: TestModule = {
  id: "R06",
  title: "realtime.messages catalog shape",
  where: "local",
  requires: ["db"],
  async run(ctx: Ctx): Promise<TestResult[]> {
    const exists = await psql(
      ctx,
      `select count(*) from pg_tables where schemaname = 'realtime' and tablename = 'messages'`,
    );
    if (!exists.ok) {
      return [
        {
          id: "R06a",
          title: this.title,
          status: "fail",
          detail: `catalog query failed: ${exists.out.slice(0, 200)}`,
        },
      ];
    }
    if (exists.out.trim() !== "1") {
      return [
        {
          id: "R06a",
          title: this.title,
          status: "info",
          detail: `realtime.messages does not exist on this project (count=${exists.out.trim()}) - created on first broadcast use?`,
          measurements: { messages_table: "absent" },
        },
      ];
    }

    // Partition scheme of the parent, then force the write path. A fresh
    // project has NO partitions attached (first run measured this), and a
    // SQL broadcast warns "no partition of relation messages found for row"
    // and drops the message - partitions appear to be created by the
    // Realtime service itself, so connect a websocket client to wake it.
    const partkey = await psql(ctx, `select pg_get_partkeydef('realtime.messages'::regclass)`);
    const send = await psql(
      ctx,
      `select realtime.send(jsonb_build_object('probe','r06'), 'r06_probe', 'r06', false)`,
    );

    const keys = await getKeys(ctx);
    let wsNote = "no anon key";
    if (keys.anon) {
      const sb = createClient(`https://${ctx.apiHost}`, keys.anon);
      const chan = sb.channel("r06", { config: { broadcast: { self: true } } });
      wsNote = await new Promise<string>((resolve) => {
        const t = setTimeout(() => resolve("subscribe timeout (10s)"), 10_000);
        chan.subscribe((status) => {
          if (status === "SUBSCRIBED") {
            clearTimeout(t);
            resolve("subscribed");
          }
        });
      });
      await chan.send({ type: "broadcast", event: "r06_probe", payload: {} }).catch(() => {});
      await new Promise((r) => setTimeout(r, 3000));
      await sb.removeChannel(chan).catch(() => {});
      sb.realtime.disconnect();
    }

    const parts = await psql(
      ctx,
      `select string_agg(inhrelid::regclass::text, ',' order by inhrelid::regclass::text) from pg_inherits where inhparent = 'realtime.messages'::regclass`,
    );
    const pub = await psql(
      ctx,
      `select string_agg(pubname || ':' || schemaname || '.' || tablename, ',') from pg_publication_tables where schemaname = 'realtime'`,
    );
    const rows = await psql(ctx, `select count(*) from realtime.messages`);

    const partitions = parts.out.trim();
    const daily = /messages_\d{4}_\d{2}_\d{2}/.test(partitions);

    const measurements: Record<string, string | number> = {
      messages_table: "present",
      partition_key: partkey.ok && partkey.out.trim() ? partkey.out.trim() : "unknown",
      sql_send_result: send.ok ? "ok" : send.out.slice(0, 120),
      ws_subscribe: wsNote,
      partition_count: partitions ? partitions.split(",").length : 0,
      daily_partition_names: daily ? "yes" : "no",
      publication: pub.ok && pub.out.trim() ? pub.out.trim() : "none",
      rows_after_send: rows.ok ? rows.out.trim() : "query failed",
    };

    return [
      {
        id: "R06a",
        title: this.title,
        status: daily ? "pass" : "info",
        detail: daily
          ? `realtime.messages is daily-partitioned (${measurements.partition_count} partitions); publication: ${measurements.publication}. Retention (3 days) not observable on a minutes-old project.`
          : `realtime.messages exists but partition shape is not the documented daily scheme: "${partitions.slice(0, 150)}"`,
        measurements,
        evidence: partitions.slice(0, 500),
      },
    ];
  },
};
export default mod;
