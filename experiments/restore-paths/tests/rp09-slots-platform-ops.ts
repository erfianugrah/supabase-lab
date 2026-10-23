/**
 * RP09 - logical replication slots across platform operations, and the
 * restore-point / undo routes on Pro.
 *
 * Doc claims (guides/platform/backups, guides/platform/upgrading): slots must
 * be dropped before a restore and before a major upgrade. The docs say
 * nothing about a restart, a compute resize or creating a read replica.
 * Hypothesis: the slot survives each (it lives in pg_replslot on the same
 * disk, and a clean shutdown checkpoint persists its position).
 * Competing: an operation that replaces the instance or does not shut down
 * cleanly loses the slot or rewinds confirmed_flush_lsn, so a consumer sees
 * duplicates (or, through the SQL interface, gaps).
 *
 * One throwaway Pro project (Small: the read-replica minimum per
 * guides/platform/read-replicas/getting-started), ap-southeast-1. Three
 * slots on one table written once per ~200 ms through the session pooler:
 *
 *   rp09_pgo  pgoutput, consumed with pg_logical_slot_get_binary_changes
 *             through the session pooler every ~1 s
 *   rp09_w2j  wal2json, pg_logical_slot_get_changes, same cadence
 *   rp09_w2s  wal2json, pg_recvlogical --start over the direct IPv6 host
 *             (a walsender, so the slot reads `active`)
 *
 * An observer reads pg_replication_slots every ~2 s. After a consumer loses
 * its connection it waits for an observer read taken after the server came
 * back before it consumes again, so "confirmed_flush_lsn after" is the
 * slot's position before any consumer moved it.
 *
 *   RP09a  settings and slot creation (plugins, REPLICATION attribute,
 *          max_replication_slots, max_slot_wal_keep_size).
 *   RP09b  compute resize Small -> Medium
 *   RP09c  compute resize Medium -> Small
 *   RP09d  read replica create (same region; replica's own slot view)
 *   RP09e  read replica remove
 *   RP09f  restart
 *   RP09g  totals after the writer stops and consumers drain
 *   RP09h  restore-point and undo on Pro (GET, POST, then undo only if the
 *          POST was accepted)
 *   RP09i  cleanup
 *
 * Per op and per slot: present after, active after, restart_lsn and
 * confirmed_flush_lsn before vs first read after, retained WAL, whether
 * Postgres restarted (pg_postmaster_start_time), duplicates (all, and the
 * rewind class: a transaction redelivered at or before what the consumer had
 * already confirmed) and gaps (writer-acked ids never received, counted after
 * the final drain).
 *
 * DESTRUCTIVE and BILLABLE (Small, a Medium window, a replica). Not settled
 * here: an unclean crash, PITR restore and major upgrade (documented as
 * slot-dropping), other sizes, Enterprise for restore-point/undo.
 */
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { mgmt } from "../../../harness/src/mgmt";
import { sql } from "../../../harness/src/platform";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { again, createProject, deleteProject, errText, poolerClient, randomPassword, sleep, subjectOf, waitProjectStatus, type Subject } from "../lib/rp";
import {
  Ledger,
  SNAPSHOT_SQL,
  bigToLsn,
  gaps,
  lsnToBig,
  phaseCounts,
  snapLine,
  sqlConsumer,
  streamConsumer,
  type Runner,
  type Snapshot,
  type StreamRunner,
} from "../lib/slots";

const REGION = "ap-southeast-1";
const SETTLE_MS = Number(process.env.RP09_SETTLE_S ?? 90) * 1000;
const SLOTS = [
  { key: "pgo_sql", slot: "rp09_pgo" },
  { key: "w2j_sql", slot: "rp09_w2j" },
  { key: "w2j_stream", slot: "rp09_w2s" },
] as const;

interface OpRecord {
  id: string;
  title: string;
  phase: string;
  http: number;
  body: string;
  attempts: string[];
  statuses: string[];
  backHealthyS: number | string;
  pre?: Snapshot;
  /** Per slot, the first observer read after that consumer's outage (or the end read if none). */
  post: Record<string, Snapshot | undefined>;
  end?: Snapshot;
  /** Per consumer: its confirmed position when it lost the connection. */
  confirmedAtLoss: Record<string, string>;
  extra: Record<string, number | string>;
  note: string;
}

const mod: TestModule = {
  id: "RP09",
  title: "Logical slots across resize, read-replica create/remove and restart; restore-point/undo on Pro",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];
    const org = ctx.orgs.pro ?? "";
    if (!org) return [{ id: "RP09", title: "RP09", status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    const t00 = Date.now();
    let ref = "";
    const pw = randomPassword();
    let phase = "setup";
    const snaps: Snapshot[] = [];
    const acked = new Map<number, string>();
    const writer = { stalls: [] as { phase: string; s: number }[], lastOk: 0, errors: [] as string[] };
    const ledgers: Record<string, Ledger> = Object.fromEntries(SLOTS.map((s) => [s.key, new Ledger(s.key)]));
    const runners: Runner[] = [];
    let stream: StreamRunner | undefined;
    let running = true;
    let observing = true;
    let observerTask: Promise<void> | undefined;
    let writerTask: Promise<void> | undefined;
    const ops: OpRecord[] = [];
    let s: Subject | undefined;
    let replicaId = "";

    const lastSnap = () => snaps[snaps.length - 1];
    /** Wait for an observer read taken after `t` (and, if Postgres restarted, after the restart). */
    const snapAfter = async (t: number, maxMs = 10 * 60_000): Promise<Snapshot | undefined> => {
      const t0 = Date.now();
      while (Date.now() - t0 < maxMs) {
        const x = snaps.find((z) => z.at > t);
        if (x) return x;
        await sleep(500);
      }
      return undefined;
    };

    try {
      const name = `rp-rp09-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const created = await createProject(ctx, org, name, pw, "small");
      ref = created.ref;
      if (process.env.RP09_REF_LOG && ref) appendFileSync(process.env.RP09_REF_LOG, `${ref} ${name} RP09 ${new Date().toISOString()}\n`);
      if (!ref) return [{ id: "RP09a", title: "create", status: "fail", detail: `HTTP ${created.status} ${created.text}` }];
      const healthy = await waitProjectStatus(ctx, ref, "ACTIVE_HEALTHY", 20 * 60_000);
      if (!healthy.ok) throw new Error(`not healthy: ${healthy.last}`);
      const healthyAt = Date.now();
      s = await again(() => subjectOf(ctx, ref));
      const subj = s;
      for (let i = 0; i < 24; i++) {
        const r = await sql(subj.ctx, "select 1");
        if (r.status === 201) break;
        await sleep(5000);
      }

      /* ---- RP09a ---- */
      const setup = await sql(
        subj.ctx,
        "create table public.rp_slot_events (id bigserial primary key, at timestamptz not null default clock_timestamp()); create publication rp_slot_pub for table public.rp_slot_events;",
      );
      const mk: Record<string, string> = {};
      for (const [slot, plugin] of [
        ["rp09_pgo", "pgoutput"],
        ["rp09_w2j", "wal2json"],
        ["rp09_w2s", "wal2json"],
      ] as const) {
        const r = await sql(subj.ctx, `select (pg_create_logical_replication_slot('${slot}', '${plugin}')).lsn::text as lsn`);
        mk[slot] = r.status === 201 ? `ok ${r.rows[0]?.lsn}` : `HTTP ${r.status} ${r.error}`.slice(0, 160);
      }
      const set = await sql(
        subj.ctx,
        "select version() as v, current_setting('wal_level') as wl, current_setting('max_replication_slots') as mrs, current_setting('max_wal_senders') as mws, current_setting('max_slot_wal_keep_size') as keep, current_setting('wal_sender_timeout') as wst, current_setting('sync_replication_slots', true) as srs, current_setting('hot_standby_feedback') as hsf, (select rolreplication from pg_roles where rolname = 'postgres') as rr, (select count(*) from pg_replication_slots) as nslots",
      );
      const x = set.rows[0] ?? {};
      out.push({
        id: "RP09a",
        title: "settings and slot creation on a fresh Small project",
        status: Object.values(mk).every((v) => v.startsWith("ok")) && setup.status === 201 ? "info" : "fail",
        detail: `table+publication HTTP ${setup.status}; slots ${JSON.stringify(mk)}`,
        measurements: {
          create_http: created.status,
          healthy_after_s: Math.round(healthy.ms / 1000),
          size_requested: "small",
          pg_version: String(x.v ?? "").split(" on ")[0] ?? "",
          wal_level: String(x.wl ?? ""),
          max_replication_slots: String(x.mrs ?? ""),
          max_wal_senders: String(x.mws ?? ""),
          max_slot_wal_keep_size: String(x.keep ?? ""),
          wal_sender_timeout: String(x.wst ?? ""),
          sync_replication_slots: String(x.srs ?? ""),
          hot_standby_feedback: String(x.hsf ?? ""),
          postgres_rolreplication: String(x.rr ?? ""),
          slots_after_create: String(x.nslots ?? ""),
          slot_pgoutput: mk.rp09_pgo ?? "",
          slot_wal2json_sql: mk.rp09_w2j ?? "",
          slot_wal2json_stream: mk.rp09_w2s ?? "",
        },
      });
      if (!Object.values(mk).every((v) => v.startsWith("ok"))) throw new Error("slot creation failed");

      /* ---- observer ---- */
      observerTask = (async () => {
        let c: Client | null = null;
        while (observing) {
          try {
            if (!c) c = await poolerClient(subj, pw);
            const r = await c.query(SNAPSHOT_SQL);
            const row = r.rows[0] as { cur: string; pm: string; mrs: string; slots: Snapshot["slots"] };
            snaps.push({ at: Date.now(), phase, currentLsn: row.cur, postmasterStart: row.pm, maxSlots: row.mrs, slots: row.slots });
          } catch {
            if (c) await c.end().catch(() => {});
            c = null;
          }
          await sleep(2000);
        }
        if (c) await c.end().catch(() => {});
      })();

      /* ---- writer ---- */
      writerTask = (async () => {
        let c: Client | null = null;
        while (running) {
          try {
            if (!c) c = await poolerClient(subj, pw);
            const r = await c.query("insert into public.rp_slot_events default values returning id");
            acked.set(Number(r.rows[0]?.id), phase);
            const now = Date.now();
            if (writer.lastOk && now - writer.lastOk > 5000) writer.stalls.push({ phase, s: Math.round((now - writer.lastOk) / 1000) });
            writer.lastOk = now;
          } catch (e) {
            const t = errText(e);
            if (!writer.errors.includes(t) && writer.errors.length < 20) writer.errors.push(t);
            if (c) await c.end().catch(() => {});
            c = null;
            await sleep(1000);
            continue;
          }
          await sleep(200);
        }
        if (c) await c.end().catch(() => {});
      })();

      /* ---- consumers ---- */
      const gate = (key: string) => async (lostAt: number) => {
        // Hold until the observer has read the slot after this reconnect. For
        // the stream this runs before a respawn, possibly while the server is
        // still down, so the hold is long (S1 used 120 s, shorter than the
        // resize outages, and the stream reconnected before the first read).
        await snapAfter(Date.now(), 10 * 60_000);
        void key;
        void lostAt;
      };
      for (const [key, slot, plugin] of [
        ["pgo_sql", "rp09_pgo", "pgoutput"],
        ["w2j_sql", "rp09_w2j", "wal2json"],
      ] as const) {
        runners.push(
          sqlConsumer({
            ledger: ledgers[key] as Ledger,
            plugin,
            slot,
            connect: () => poolerClient(subj, pw),
            phase: () => phase,
            afterReconnect: gate(key),
          }),
        );
      }
      const dir = mkdtempSync(join(tmpdir(), "rp09-"));
      stream = streamConsumer({
        ledger: ledgers.w2j_stream as Ledger,
        slot: "rp09_w2s",
        host: `db.${ref}.supabase.co`,
        password: pw,
        phase: () => phase,
        dir,
        log: ctx.log,
        beforeRespawn: gate("w2j_stream"),
      });
      runners.push(stream);

      phase = "baseline";
      await sleep(60_000);

      /* ---- one operation, measured ---- */
      const measureOp = async (
        id: string,
        title: string,
        opPhase: string,
        issue: () => Promise<{ http: number; body: string; attempts: string[] }>,
        wait: (tIssued: number) => Promise<{ statuses: string[]; backHealthyS: number | string; extra?: Record<string, number | string>; note?: string }>,
      ): Promise<OpRecord> => {
        const pre = lastSnap();
        const lossMarks: Record<string, { at: number; confirmed: bigint } | undefined> = {};
        const lastOkBefore: Record<string, number> = Object.fromEntries(SLOTS.map((z) => [z.key, (ledgers[z.key] as Ledger).lastOkAt]));
        phase = opPhase;
        // Track each consumer's confirmed position as of its last success, sampled every 250 ms.
        let tracking = true;
        const tracker = (async () => {
          const prev: Record<string, { ok: number; confirmed: bigint }> = Object.fromEntries(
            SLOTS.map((z) => [z.key, { ok: (ledgers[z.key] as Ledger).lastOkAt, confirmed: (ledgers[z.key] as Ledger).confirmed }]),
          );
          while (tracking) {
            for (const z of SLOTS) {
              const l = ledgers[z.key] as Ledger;
              const p = prev[z.key] as { ok: number; confirmed: bigint };
              // A consumer is "lost" once it has gone 6 s without a success.
              if (!lossMarks[z.key] && l.lastOkAt && Date.now() - l.lastOkAt > 6000) lossMarks[z.key] = { at: l.lastOkAt, confirmed: p.confirmed };
              if (l.lastOkAt !== p.ok) prev[z.key] = { ok: l.lastOkAt, confirmed: l.confirmed };
            }
            await sleep(250);
          }
        })();
        const tIssue = Date.now();
        const iss = await issue();
        let w: Awaited<ReturnType<typeof wait>> = { statuses: [], backHealthyS: "n/a" };
        if (iss.http >= 200 && iss.http < 300) w = await wait(tIssue);
        await sleep(SETTLE_MS);
        tracking = false;
        await tracker;
        const post: Record<string, Snapshot | undefined> = {};
        const confirmedAtLoss: Record<string, string> = {};
        for (const z of SLOTS) {
          const m = lossMarks[z.key];
          if (m) {
            confirmedAtLoss[z.key] = bigToLsn(m.confirmed);
            // First observer read once the server answered again after the loss.
            const pmBefore = pre?.postmasterStart;
            post[z.key] = snaps.find((q) => q.at > m.at + 1000 && (q.postmasterStart !== pmBefore || q.at > m.at + 20_000));
          } else {
            confirmedAtLoss[z.key] = "no loss";
          }
        }
        void lastOkBefore;
        const rec: OpRecord = {
          id,
          title,
          phase: opPhase,
          http: iss.http,
          body: iss.body,
          attempts: iss.attempts,
          statuses: w.statuses,
          backHealthyS: w.backHealthyS,
          pre,
          post,
          end: lastSnap(),
          confirmedAtLoss,
          extra: w.extra ?? {},
          note: w.note ?? "",
        };
        ops.push(rec);
        ctx.log(`${id} ${title}: HTTP ${iss.http}, statuses ${w.statuses.join(">")}, back ${w.backHealthyS}s`);
        return rec;
      };

      /**
       * Poll project status every 5 s until it leaves ACTIVE_HEALTHY and comes
       * back; or, if it never leaves, until Postgres has restarted (observer's
       * pg_postmaster_start_time changed) and the status reads healthy; or
       * until `stayMs` passes with neither.
       */
      const statusWait = async (tIssued: number, stayMs = 180_000, maxMs = 25 * 60_000) => {
        const seen: string[] = [];
        const pmAtIssue = snaps.filter((z) => z.at <= tIssued).pop()?.postmasterStart ?? "";
        let left = false;
        let back: number | string = "never";
        let note = "";
        while (Date.now() - tIssued < maxMs) {
          const p = await mgmt(ctx, "GET", `/projects/${ref}`).catch(() => undefined);
          if (p && p.status === 200) {
            const st = String((p.json as { status?: string } | undefined)?.status ?? "?");
            if (seen[seen.length - 1] !== st) seen.push(st);
            if (st !== "ACTIVE_HEALTHY") left = true;
            if (st === "ACTIVE_HEALTHY" && left) {
              back = Math.round((Date.now() - tIssued) / 1000);
              break;
            }
            const pmNow = lastSnap()?.postmasterStart ?? "";
            if (!left && st === "ACTIVE_HEALTHY" && pmAtIssue && pmNow && pmNow !== pmAtIssue) {
              back = Math.round((Date.now() - tIssued) / 1000);
              note = "status never left ACTIVE_HEALTHY; Postgres restarted";
              break;
            }
            if (!left && Date.now() - tIssued > stayMs) {
              back = "never left ACTIVE_HEALTHY";
              break;
            }
          }
          await sleep(5000);
        }
        // Wait for the observer to read again after the status came back.
        await snapAfter(Date.now(), 5 * 60_000);
        return { statuses: seen, backHealthyS: back, note };
      };

      const resize = (variant: string) => async () => {
        const attempts: string[] = [];
        const t0 = Date.now();
        let r = await mgmt(ctx, "PATCH", `/projects/${ref}/billing/addons`, { addon_type: "compute_instance", addon_variant: variant });
        attempts.push(`0s HTTP ${r.status} ${r.text.slice(0, 120)}`);
        for (let i = 0; i < 6 && (r.status === 429 || r.throttled); i++) {
          const m = /try again in (\d+)/.exec(r.text);
          await sleep(((m ? Number(m[1]) : 1) * 60 + 5) * 1000);
          r = await mgmt(ctx, "PATCH", `/projects/${ref}/billing/addons`, { addon_type: "compute_instance", addon_variant: variant });
          attempts.push(`${Math.round((Date.now() - t0) / 1000)}s HTTP ${r.status} ${r.text.slice(0, 120)}`);
        }
        return { http: r.status, body: r.text.slice(0, 200), attempts };
      };

      /* ---- RP09b, RP09c: resize ---- */
      await measureOp("RP09b", "compute resize Small -> Medium", "resize_up", resize("ci_medium"), (t) => statusWait(t, 600_000));
      await measureOp("RP09c", "compute resize Medium -> Small", "resize_down", resize("ci_small"), (t) => statusWait(t, 600_000));

      /* ---- RP09d, RP09e: read replica ---- */
      await measureOp(
        "RP09d",
        `read replica create (${REGION})`,
        "replica_create",
        async () => {
          const attempts: string[] = [];
          const t0 = Date.now();
          let r = await mgmt(ctx, "POST", `/projects/${ref}/read-replicas/setup`, { read_replica_region: REGION });
          attempts.push(`0s HTTP ${r.status} ${r.text.slice(0, 160)}`);
          while (r.status >= 300 && r.status !== 402 && Date.now() - t0 < 10 * 60_000) {
            await sleep(30_000);
            r = await mgmt(ctx, "POST", `/projects/${ref}/read-replicas/setup`, { read_replica_region: REGION });
            attempts.push(`${Math.round((Date.now() - t0) / 1000)}s HTTP ${r.status} ${r.text.slice(0, 160)}`);
          }
          return { http: r.status, body: r.text.slice(0, 200), attempts };
        },
        async (tIssued) => {
          const seen: string[] = [];
          let appeared: number | string = "never";
          let served: number | string = "never";
          let view = "";
          let lastErr = "";
          while (Date.now() - tIssued < 40 * 60_000) {
            const p = await mgmt(ctx, "GET", `/projects/${ref}`).catch(() => undefined);
            const st = String((p?.json as { status?: string } | undefined)?.status ?? "?");
            if (p?.status === 200 && seen[seen.length - 1] !== st) seen.push(st);
            const cfg = await mgmt(ctx, "GET", `/projects/${ref}/config/database/pooler`).catch(() => undefined);
            const arr = Array.isArray(cfg?.json) ? (cfg?.json as Array<Record<string, unknown>>) : [];
            const rep = arr.find((e) => e.database_type === "READ_REPLICA");
            if (rep) {
              replicaId = String(rep.identifier ?? "");
              if (appeared === "never") appeared = Math.round((Date.now() - tIssued) / 1000);
              const c = new Client({
                host: String(rep.db_host),
                port: 5432,
                user: String(rep.db_user),
                database: "postgres",
                password: pw,
                ssl: { rejectUnauthorized: false },
                connectionTimeoutMillis: 10_000,
              });
              c.on("error", () => {});
              try {
                await c.connect();
                const q = await c.query(
                  "select pg_is_in_recovery() as rec, current_setting('max_replication_slots') as mrs, current_setting('hot_standby_feedback') as hsf, (select coalesce(string_agg(slot_name || ':' || slot_type || ':' || coalesce(plugin, '-') || ':synced=' || synced::text || ':active=' || active::text, ', ' order by slot_name), '(none)') from pg_replication_slots) as slots, (select count(*) from public.rp_slot_events) as rows",
                );
                const z = q.rows[0] ?? {};
                view = `in_recovery=${z.rec} max_replication_slots=${z.mrs} hot_standby_feedback=${z.hsf} slots=${z.slots} rows=${z.rows}`;
                served = Math.round((Date.now() - tIssued) / 1000);
                break;
              } catch (e) {
                lastErr = errText(e);
              } finally {
                await c.end().catch(() => {});
              }
            }
            await sleep(15_000);
          }
          // Primary's own slot list now (a physical slot for the replica?).
          await snapAfter(Date.now(), 120_000);
          return {
            statuses: seen,
            backHealthyS: served,
            extra: { replica_entry_s: appeared, replica_served_s: served, replica_view: view || `unserved: ${lastErr}`.slice(0, 300) },
            note: lastErr,
          };
        },
      );

      if (replicaId) {
        await measureOp(
          "RP09e",
          "read replica remove",
          "replica_remove",
          async () => {
            const r = await mgmt(ctx, "POST", `/projects/${ref}/read-replicas/remove`, { database_identifier: replicaId });
            return { http: r.status, body: r.text.slice(0, 200), attempts: [`0s HTTP ${r.status} ${r.text.slice(0, 120)}`] };
          },
          async (tIssued) => {
            let gone: number | string = "never";
            const seen: string[] = [];
            while (Date.now() - tIssued < 15 * 60_000) {
              const p = await mgmt(ctx, "GET", `/projects/${ref}`).catch(() => undefined);
              const st = String((p?.json as { status?: string } | undefined)?.status ?? "?");
              if (p?.status === 200 && seen[seen.length - 1] !== st) seen.push(st);
              const cfg = await mgmt(ctx, "GET", `/projects/${ref}/config/database/pooler`).catch(() => undefined);
              const arr = Array.isArray(cfg?.json) ? (cfg?.json as Array<Record<string, unknown>>) : [];
              if (cfg?.status === 200 && !arr.some((e) => e.database_type === "READ_REPLICA")) {
                gone = Math.round((Date.now() - tIssued) / 1000);
                replicaId = "";
                break;
              }
              await sleep(15_000);
            }
            return { statuses: seen, backHealthyS: gone, extra: { replica_gone_s: gone } };
          },
        );
      }

      /* ---- RP09f: restart ---- */
      await measureOp(
        "RP09f",
        "restart",
        "restart",
        async () => {
          const attempts: string[] = [];
          const t0 = Date.now();
          let r = await mgmt(ctx, "POST", `/projects/${ref}/restart`);
          attempts.push(`0s HTTP ${r.status} ${r.text.slice(0, 120)}`);
          while (r.status === 400 && /ten minutes/i.test(r.text) && Date.now() - t0 < 12 * 60_000) {
            await sleep(60_000);
            r = await mgmt(ctx, "POST", `/projects/${ref}/restart`);
            attempts.push(`${Math.round((Date.now() - t0) / 1000)}s HTTP ${r.status} ${r.text.slice(0, 120)}`);
          }
          return { http: r.status, body: r.text.slice(0, 200), attempts };
        },
        (t) => statusWait(t),
      );
      void healthyAt;

      /* ---- drain ---- */
      phase = "drain";
      running = false;
      await writerTask;
      const maxAcked = Math.max(0, ...acked.keys());
      const tDrain = Date.now();
      while (Date.now() - tDrain < 180_000) {
        if (SLOTS.every((z) => (ledgers[z.key] as Ledger).seen.has(maxAcked))) break;
        await sleep(2000);
      }
      const drainS = Math.round((Date.now() - tDrain) / 1000);
      await snapAfter(Date.now(), 30_000);
      const finalSnap = lastSnap();

      /* ---- emit per-op results ---- */
      for (const op of ops) {
        const m: Record<string, number | string> = {
          op_http: op.http,
          op_attempts: op.attempts.length,
          statuses: op.statuses.join(">") || "n/a",
          back_s: op.backHealthyS,
          postmaster_restarted: String(Boolean(op.pre && op.end && op.pre.postmasterStart !== op.end.postmasterStart)),
          max_replication_slots_before: op.pre?.maxSlots ?? "?",
          max_replication_slots_after: op.end?.maxSlots ?? "?",
          slots_before: op.pre?.slots.length ?? -1,
          slots_after: op.end?.slots.length ?? -1,
          ...op.extra,
        };
        const wst = writer.stalls.filter((z) => z.phase === op.phase).map((z) => z.s);
        m.writer_acked = [...acked.values()].filter((p) => p === op.phase).length;
        m.writer_max_stall_s = wst.length ? Math.max(...wst) : 0;
        for (const z of SLOTS) {
          const l = ledgers[z.key] as Ledger;
          const pre = op.pre?.slots.find((q) => q.slot_name === z.slot);
          const postSnap = op.post[z.key] ?? op.end;
          const post = postSnap?.slots.find((q) => q.slot_name === z.slot);
          const end = op.end?.slots.find((q) => q.slot_name === z.slot);
          const pc = phaseCounts(op.phase, acked, l);
          const st = l.stalls.filter((q) => q.phase === op.phase).map((q) => q.s);
          let rewind: number | string = "n/a";
          const atLoss = op.confirmedAtLoss[z.key] ?? "";
          if (post?.confirmed_flush_lsn && /\//.test(atLoss)) {
            const d = lsnToBig(atLoss) - lsnToBig(post.confirmed_flush_lsn);
            rewind = d > 0n ? Number(d) : 0;
          }
          m[`${z.key}_present_after`] = String(Boolean(end));
          m[`${z.key}_active_after`] = String(end?.active ?? "absent");
          m[`${z.key}_confirmed_before`] = pre?.confirmed_flush_lsn ?? "absent";
          m[`${z.key}_consumer_confirmed_at_loss`] = atLoss;
          m[`${z.key}_confirmed_first_read_after`] = post?.confirmed_flush_lsn ?? "absent";
          m[`${z.key}_rewind_bytes`] = rewind;
          m[`${z.key}_restart_lsn_before`] = pre?.restart_lsn ?? "absent";
          m[`${z.key}_restart_lsn_after`] = end?.restart_lsn ?? "absent";
          m[`${z.key}_retained_bytes_before`] = pre?.retained_bytes ?? "absent";
          m[`${z.key}_retained_bytes_after`] = end?.retained_bytes ?? "absent";
          m[`${z.key}_wal_status_after`] = end?.wal_status ?? "absent";
          m[`${z.key}_received`] = pc.recv;
          m[`${z.key}_duplicates`] = pc.dup;
          m[`${z.key}_duplicates_rewind_class`] = pc.dupRewind;
          m[`${z.key}_gaps`] = pc.gap;
          m[`${z.key}_max_stall_s`] = st.length ? Math.max(...st) : 0;
        }
        const allPresent = SLOTS.every((z) => m[`${z.key}_present_after`] === "true");
        const noLoss = SLOTS.every((z) => m[`${z.key}_gaps`] === 0 && m[`${z.key}_duplicates_rewind_class`] === 0);
        out.push({
          id: op.id,
          title: op.title,
          status: op.http >= 300 ? "fail" : allPresent && noLoss ? "pass" : "fail",
          detail:
            `HTTP ${op.http}; ${op.statuses.join(">") || "no status read"}; back ${op.backHealthyS}; postmaster restarted ${m.postmaster_restarted}; ` +
            SLOTS.map((z) => `${z.key} present=${m[`${z.key}_present_after`]} dup=${m[`${z.key}_duplicates`]} rewind_dup=${m[`${z.key}_duplicates_rewind_class`]} gaps=${m[`${z.key}_gaps`]}`).join("; "),
          measurements: m,
          evidence: [
            `attempts: ${op.attempts.join(" | ")}`,
            `pre: ${snapLine(op.pre)}`,
            ...SLOTS.map((z) => `first read after ${z.key} loss: ${snapLine(op.post[z.key])}`),
            `end: ${snapLine(op.end)}`,
            op.note ? `note: ${op.note}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        });
      }

      /* ---- RP09g totals ---- */
      const g: Record<string, number | string> = { writer_acked_total: acked.size, drain_s: drainS, run_min: Math.round((Date.now() - t00) / 60000) };
      for (const z of SLOTS) {
        const l = ledgers[z.key] as Ledger;
        g[`${z.key}_received_total`] = l.received.length;
        g[`${z.key}_distinct`] = l.seen.size;
        g[`${z.key}_duplicates_total`] = l.redeliveries.length;
        g[`${z.key}_duplicates_rewind_class_total`] = l.redeliveries.filter((r) => r.rewind).length;
        g[`${z.key}_gaps_total`] = gaps(acked, l).length;
        g[`${z.key}_calls`] = l.calls;
      }
      g.stream_spawns = stream?.spawns ?? 0;
      out.push({
        id: "RP09g",
        title: "totals after the writer stopped and consumers drained",
        status: SLOTS.every((z) => g[`${z.key}_gaps_total`] === 0) ? "info" : "fail",
        detail: SLOTS.map((z) => `${z.key}: ${g[`${z.key}_distinct`]}/${acked.size} distinct, dup ${g[`${z.key}_duplicates_total`]}, gaps ${g[`${z.key}_gaps_total`]}`).join("; "),
        measurements: g,
        evidence: [
          `final: ${snapLine(finalSnap)}`,
          `writer errors: ${writer.errors.join(" | ")}`,
          ...SLOTS.map((z) => `${z.key} errors: ${(ledgers[z.key] as Ledger).errors.join(" | ")}`),
          ...SLOTS.map((z) => `${z.key} redeliveries: ${(ledgers[z.key] as Ledger).redeliveries.slice(0, 40).map((r) => `${r.id}@${r.phase}${r.rewind ? "*" : ""}`).join(",")}`),
          ...SLOTS.map((z) => `${z.key} gaps: ${gaps(acked, ledgers[z.key] as Ledger).slice(0, 40).map((q) => `${q.id}@${q.phase}`).join(",")}`),
          `stream exits: ${(stream?.exits ?? []).join(" | ")}`,
        ].join("\n"),
      });

      /* ---- RP09h restore-point / undo ---- */
      const rpName = "rp09-mark";
      const g0 = await mgmt(ctx, "GET", `/projects/${ref}/database/backups/restore-point`);
      const p0 = await mgmt(ctx, "POST", `/projects/${ref}/database/backups/restore-point`, { name: rpName });
      const g1 = await mgmt(ctx, "GET", `/projects/${ref}/database/backups/restore-point?name=${rpName}`);
      let undo = { status: 0, text: "not sent: restore-point POST not accepted" };
      if (p0.status >= 200 && p0.status < 300) {
        await sleep(30_000);
        const u = await mgmt(ctx, "POST", `/projects/${ref}/database/backups/undo`, { name: rpName });
        undo = { status: u.status, text: u.text.slice(0, 200) };
      } else {
        // The route's answer to an undo for a name that was never created, for the record.
        const u = await mgmt(ctx, "POST", `/projects/${ref}/database/backups/undo`, { name: rpName });
        undo = { status: u.status, text: `(no restore point) ${u.text.slice(0, 180)}` };
      }
      out.push({
        id: "RP09h",
        title: "restore-point and undo on a Pro project (Small, logical slots present)",
        status: "info",
        detail: `GET ${g0.status}; POST ${p0.status}; GET by name ${g1.status}; undo ${undo.status}`,
        measurements: {
          restore_point_get_http: g0.status,
          restore_point_get_body: g0.text.slice(0, 160),
          restore_point_post_http: p0.status,
          restore_point_post_body: p0.text.slice(0, 160),
          restore_point_get_by_name_http: g1.status,
          restore_point_get_by_name_body: g1.text.slice(0, 160),
          undo_http: undo.status,
          undo_body: undo.text.slice(0, 200),
        },
      });
    } catch (e) {
      out.push({ id: "RP09", title: "RP09 aborted", status: "fail", detail: `threw: ${errText(e)} (phase ${phase})` });
    } finally {
      running = false;
      observing = false;
      await Promise.all(runners.map((r) => r.stop().catch(() => {})));
      await writerTask?.catch(() => {});
      await observerTask?.catch(() => {});
      if (ref) {
        let rm = "no replica";
        if (replicaId) {
          const r = await mgmt(ctx, "POST", `/projects/${ref}/read-replicas/remove`, { database_identifier: replicaId }).catch(() => null);
          rm = `replica remove HTTP ${r?.status ?? 0}`;
        }
        const st = await deleteProject(ctx, ref).catch(() => -1);
        out.push({ id: "RP09i", title: "cleanup: project deleted", status: st >= 200 && st < 300 ? "info" : "fail", detail: `${rm}; DELETE HTTP ${st}` });
      }
    }
    return out;
  },
};

export default mod;
