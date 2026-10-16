/**
 * TD08 - Local-first: a Turso embedded replica on the local vantage, write-to-visible lag after sync and local vs remote read latency
 *
 * Side: the LOCAL vantage only (this machine, colo "local"). The replica is a
 * local SQLite file opened with @libsql/client (native libsql binding) and
 * `syncUrl` = the fixture's Turso database (libSQL, group in
 * aws-ap-southeast-2); "remote" is @libsql/client/web over HTTP to the same
 * database (the primary). Sync is manual (`client.sync()`), so lag below is
 * the cost of one pull, not a sync interval.
 *
 *   TD08a          open + first sync of a fresh replica file: ms, frames
 *                  synced, seeded row count visible locally (the replica
 *                  pulls the whole database, including any other module's
 *                  tables, so frames depend on the database's history)
 *   TD08b          write-at-primary to visible-after-sync lag: an INSERT
 *                  through the remote client, then sync() + local read
 *                  until the row is there; lag = write ack to visible,
 *                  syncs needed, plus whether the row was visible locally
 *                  BEFORE any sync (expected 0). n after warm-up.
 *   TD08c-local    PK read on the replica file vs
 *   TD08c-remote   the same read over HTTP at the primary; round-robin per
 *                  iteration, n after warm-up; `separated` applies the
 *                  plan's p25-p75 rule
 *   TD08d          INSERT through the replica client (forwarded to the
 *                  primary): ms, and whether the row reads back from the
 *                  local file immediately (read-your-writes)
 *   TD08e-d1       no equivalent: recorded, not measured
 *   TD08e-pg       no equivalent: recorded, not measured
 *   TD08z          cleanup
 *   TD08g          the same embedded replica against the Turso-engine database
 *                  (when the fixture has one): opens and syncs, or the error
 *   TD08f<k>-<engine>  Turso Sync (@tursodatabase/sync, lib/td08-sync.ts) on
 *                  the libSQL database and the Turso-engine one: f1 connect,
 *                  f2 B write + push then A pull (lag, visibility), f3 local
 *                  PK read, f4 the same row updated offline on A and B, A
 *                  pushes first (which write survives, push errors); n = TD08_N
 *
 * Sizes (env): full n=30, warm-up 3, 1000 seeded rows; TD_SMOKE=1: n=5,
 * warm-up 1, 100 rows (TD08_N, TD08_WARMUP, TD08_SEED_ROWS override).
 *
 * Not settled by this module: periodic sync (syncInterval), offline writes,
 * Turso Sync (@tursodatabase/sync, which the docs recommend for new
 * projects), a replica inside a Worker (no filesystem), conflict behaviour,
 * replica size limits, the Worker vantage.
 *
 * DESTRUCTIVE: creates table td08_kv on the fixture's Turso database and a
 * replica file in a temp dir; the table is dropped and the dir removed in
 * finally. Self-skips without the fixture.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Client, createClient } from "@libsql/client";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { fixtureOrSkip, tursoClient } from "../lib/client";
import { rng, roundRobin, separated, summarize, summaryColumns } from "../lib/stats";
import { chunk, multiInsert, r3, td08Sizes } from "../lib/td05-06-08-data";
import { type SyncTarget, syncRows } from "../lib/td08-sync";
import { turso, tursoCreds } from "../lib/vendors";

const ID = "TD08";
const SEED = 8081015;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);
const now = () => performance.now();

const mod: TestModule = {
  id: ID,
  title: "Local-first: a Turso embedded replica on the local vantage, write-to-visible lag after sync and local vs remote read latency",
  where: "local",
  // The battery always runs with the PAT; requiring it keeps an offline run from probing a live fixture.
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const fx = await fixtureOrSkip(ctx);
    if ("skip" in fx) return [{ id: ID, title: this.title, status: "skip", detail: fx.skip }];
    const sz = td08Sizes();
    const out: TestResult[] = [];
    const base = { vantage: "local", colo: "local", turso_location: fx.turso?.location ?? "", libsql_driver: "@libsql/client (native libsql) / @libsql/client/web" };
    const remote = tursoClient(fx);
    let replica: Client | undefined;
    let dir = "";
    const usage = async (): Promise<Record<string, number> | null> => {
      const t = tursoCreds();
      if (!t) return null;
      const r = await turso<{ database?: { usage?: Record<string, number> } }>(t, "GET", `databases/${encodeURIComponent(fx.turso!.db)}/usage`).catch(() => null);
      return r?.status === 200 ? (r.json.database?.usage ?? null) : null;
    };

    try {
      ctx.log(`${ID}: sizes ${JSON.stringify(sz)}`);
      await remote.batch(["DROP TABLE IF EXISTS td08_kv", "CREATE TABLE td08_kv (k INTEGER PRIMARY KEY, v TEXT NOT NULL, w INTEGER NOT NULL)"], "write");
      const seedRows = Array.from({ length: sz.seedRows }, (_, i) => [i + 1, `seed-${i + 1}`, 0] as [number, string, number]);
      for (const rows of chunk(seedRows, 200)) {
        const { sql, params } = multiInsert("sqlite", "td08_kv", ["k", "v", "w"], rows);
        await remote.execute({ sql, args: params });
      }
      const u0 = await usage();

      // a. fresh replica: open + first sync
      dir = await mkdtemp(join(tmpdir(), "td08-"));
      const t0 = now();
      replica = createClient({ url: `file:${join(dir, "replica.db")}`, syncUrl: fx.turso!.url, authToken: fx.turso!.token!, intMode: "number" });
      const openMs = now() - t0;
      const t1 = now();
      const first = await replica.sync();
      const syncMs = now() - t1;
      const cnt = Number((await replica.execute("SELECT count(*) AS n FROM td08_kv")).rows[0]?.n ?? Number.NaN);
      out.push({
        id: `${ID}a`,
        title: "fresh embedded replica: open and first sync (local)",
        status: cnt === sz.seedRows ? "pass" : "fail",
        detail: `open ${r3(openMs)} ms (native createClient, blocks while it bootstraps the file), first sync ${r3(syncMs)} ms, ${first?.frames_synced ?? "?"} frames, ${cnt}/${sz.seedRows} seeded rows visible locally`,
        measurements: { backend: "turso_embedded", ...base, n: 1, open_ms: r3(openMs), first_sync_ms: r3(syncMs), frames_synced: first?.frames_synced ?? Number.NaN, frame_no: first?.frame_no ?? Number.NaN, rows_visible: cnt, rows_seeded: sz.seedRows },
      });

      // b. write at primary -> visible after sync
      const lag: { lag: number; write: number; syncs: number; sync: number[]; before: boolean; warm: boolean; err?: string }[] = [];
      for (let i = 0; i < sz.warmup + sz.n; i++) {
        const k = 1_000_000 + i;
        const w0 = now();
        try {
          await remote.execute({ sql: "INSERT INTO td08_kv (k, v, w) VALUES (?, ?, 1)", args: [k, `lag-${i}`] });
        } catch (e) {
          lag.push({ lag: Number.NaN, write: now() - w0, syncs: 0, sync: [], before: false, warm: i < sz.warmup, err: errMsg(e) });
          continue;
        }
        const ack = now();
        const before = (await replica.execute({ sql: "SELECT v FROM td08_kv WHERE k = ?", args: [k] })).rows.length > 0;
        const syncs: number[] = [];
        let seen = before;
        while (!seen && syncs.length < 10) {
          const s0 = now();
          await replica.sync();
          syncs.push(now() - s0);
          seen = (await replica.execute({ sql: "SELECT v FROM td08_kv WHERE k = ?", args: [k] })).rows.length > 0;
        }
        lag.push({ lag: seen ? now() - ack : Number.NaN, write: ack - w0, syncs: syncs.length, sync: syncs, before, warm: i < sz.warmup, ...(seen ? {} : { err: "not visible after 10 syncs" }) });
      }
      const lk = lag.filter((x) => !x.warm && Number.isFinite(x.lag));
      const ls = { ...summarize(lk.map((x) => x.lag)), dropped: lag.filter((x) => x.warm).length };
      const lagFails = lag.filter((x) => !x.warm && !Number.isFinite(x.lag));
      out.push({
        id: `${ID}b`,
        title: "write at the primary (HTTP) to visible in the replica after sync() (local)",
        status: lagFails.length === 0 && ls.n > 0 ? "pass" : "fail",
        detail: `lag p50 ${ls.p50} ms, p95 ${ls.p95} ms (n=${ls.n}, ${ls.dropped} warm-up dropped); max syncs needed ${Math.max(0, ...lk.map((x) => x.syncs))}; visible before any sync in ${lk.filter((x) => x.before).length}/${lk.length}${lagFails.length ? `; ${lagFails.length} failed: ${lagFails[0]!.err}` : ""}`,
        measurements: {
          backend: "turso_embedded",
          ...base,
          ...summaryColumns("lag_ms", ls),
          remote_write_ms_p50: summarize(lk.map((x) => x.write)).p50,
          sync_ms_p50: summarize(lk.flatMap((x) => x.sync)).p50,
          sync_ms_p95: summarize(lk.flatMap((x) => x.sync)).p95,
          syncs_needed_max: Math.max(0, ...lk.map((x) => x.syncs)),
          visible_before_sync: lk.filter((x) => x.before).length,
          failed: lagFails.length,
        },
      });

      // c. PK read: local replica file vs remote HTTP, round-robin
      const r = rng(SEED);
      const reads = new Map<string, { ms: number; warm: boolean; ok: boolean; err?: string }[]>([
        ["local", []],
        ["remote", []],
      ]);
      for (const slot of roundRobin(["local", "remote"] as const, sz.warmup + sz.n, sz.warmup)) {
        const k = 1 + Math.floor(r() * sz.seedRows);
        const c = slot.item === "local" ? replica : remote;
        const s0 = now();
        try {
          const res = await c.execute({ sql: "SELECT v FROM td08_kv WHERE k = ?", args: [k] });
          reads.get(slot.item)!.push({ ms: now() - s0, warm: slot.warmup, ok: res.rows.length === 1 });
        } catch (e) {
          reads.get(slot.item)!.push({ ms: now() - s0, warm: slot.warmup, ok: false, err: errMsg(e) });
        }
      }
      const sum = (side: string) => {
        const l = reads.get(side)!;
        return { ...summarize(l.filter((x) => !x.warm && x.ok).map((x) => x.ms)), dropped: l.filter((x) => x.warm).length };
      };
      const sl = sum("local");
      const sr = sum("remote");
      const sep = separated(sl, sr);
      for (const side of ["local", "remote"] as const) {
        const s = side === "local" ? sl : sr;
        const fails = reads.get(side)!.filter((x) => !x.warm && !x.ok);
        out.push({
          id: `${ID}c-${side}`,
          title: side === "local" ? "PK read from the embedded replica file (local)" : "PK read over HTTP at the primary (local, @libsql/client/web)",
          status: fails.length === 0 && s.n > 0 ? "pass" : "fail",
          detail: `p50 ${s.p50} ms, p95 ${s.p95} ms (n=${s.n}, ${s.dropped} warm-up dropped); p25-p75 separated: ${sep === null ? "no" : sep === "a" ? "local faster" : "remote faster"}${fails.length ? `; ${fails.length} failed: ${fails[0]!.err ?? "row missing"}` : ""}`,
          measurements: { backend: side === "local" ? "turso_embedded" : "turso_http", ...base, ...summaryColumns("ms", s), failed: fails.length, separated: sep === null ? "no" : sep === "a" ? "local faster" : "remote faster" },
        });
      }

      // d. write through the replica client, then read it back locally at once
      const wr: { ms: number; warm: boolean; ok: boolean; local: boolean; err?: string }[] = [];
      for (let i = 0; i < sz.warmup + sz.n; i++) {
        const k = 2_000_000 + i;
        const s0 = now();
        try {
          await replica.execute({ sql: "INSERT INTO td08_kv (k, v, w) VALUES (?, ?, 2)", args: [k, `via-replica-${i}`] });
          const ms = now() - s0;
          const local = (await replica.execute({ sql: "SELECT v FROM td08_kv WHERE k = ?", args: [k] })).rows.length > 0;
          wr.push({ ms, warm: i < sz.warmup, ok: true, local });
        } catch (e) {
          wr.push({ ms: now() - s0, warm: i < sz.warmup, ok: false, local: false, err: errMsg(e) });
        }
      }
      const wk = wr.filter((x) => !x.warm && x.ok);
      const ws = { ...summarize(wk.map((x) => x.ms)), dropped: wr.filter((x) => x.warm).length };
      const atPrimary = Number((await remote.execute("SELECT count(*) AS n FROM td08_kv WHERE w = 2")).rows[0]?.n ?? Number.NaN);
      const wFails = wr.filter((x) => !x.warm && !x.ok);
      out.push({
        id: `${ID}d`,
        title: "INSERT through the embedded replica client (forwarded to the primary), read back locally at once (local)",
        status: wFails.length === 0 && ws.n > 0 ? "pass" : "fail",
        detail: `write p50 ${ws.p50} ms, p95 ${ws.p95} ms (n=${ws.n}); visible in the local file right after: ${wk.filter((x) => x.local).length}/${wk.length}; rows at the primary ${atPrimary}/${wr.filter((x) => x.ok).length}${wFails.length ? `; ${wFails.length} failed: ${wFails[0]!.err}` : ""}`,
        measurements: { backend: "turso_embedded", ...base, ...summaryColumns("write_ms", ws), read_your_write_local: wk.filter((x) => x.local).length, rows_at_primary: atPrimary, failed: wFails.length },
      });

      const u1 = await usage();
      if (u0 && u1) {
        out.push({
          id: `${ID}a-usage`,
          title: "Turso usage counters across TD08 (Platform API; may lag)",
          status: "info",
          detail: `bytes_synced +${(u1.bytes_synced ?? Number.NaN) - (u0.bytes_synced ?? Number.NaN)}, rows_read +${(u1.rows_read ?? Number.NaN) - (u0.rows_read ?? Number.NaN)}`,
          measurements: {
            backend: "turso",
            source: "GET /v1/organizations/{org}/databases/{db}/usage",
            bytes_synced_delta: (u1.bytes_synced ?? Number.NaN) - (u0.bytes_synced ?? Number.NaN),
            rows_read_delta: (u1.rows_read ?? Number.NaN) - (u0.rows_read ?? Number.NaN),
            rows_written_delta: (u1.rows_written ?? Number.NaN) - (u0.rows_written ?? Number.NaN),
          },
        });
      }
    } catch (e) {
      out.push({ id: ID, title: this.title, status: "fail", detail: `threw: ${errMsg(e)}` });
    } finally {
      for (const [b, what] of [
        ["d1", "D1 (Worker binding, REST)"],
        ["pg", "Supabase Postgres (pg, PostgREST)"],
      ] as const) {
        out.push({
          id: `${ID}e-${b}`,
          title: `${what}: client-embedded replica`,
          status: "info",
          detail: "no equivalent: the drivers this experiment uses offer no local-file replica that syncs from the server; recorded as not applicable, not measured",
          measurements: { backend: b, vantage: "local", n: 0, equivalent: "none" },
        });
      }
      const bad: string[] = [];
      replica?.close();
      if (dir) await rm(dir, { recursive: true, force: true }).catch((e) => bad.push(`rm: ${errMsg(e)}`));
      await remote.execute("DROP TABLE IF EXISTS td08_kv").catch((e) => bad.push(`drop: ${errMsg(e)}`));
      remote.close();
      out.push({ id: `${ID}z`, title: "cleanup", status: bad.length ? "fail" : "pass", detail: bad.length ? bad.join("; ") : "dropped td08_kv on Turso, removed the local replica file" });
    }
    // g: the same embedded replica (native @libsql/client, syncUrl) pointed at the Turso-engine database.
    if (fx.tursodb?.url && fx.tursodb.token) {
      const gdir = await mkdtemp(join(tmpdir(), "td08g-"));
      const host = fx.tursodb.hostname;
      let rep: Client | undefined;
      let res: string;
      let ok = false;
      try {
        rep = createClient({ url: `file:${join(gdir, "replica.db")}`, syncUrl: fx.tursodb.url, authToken: fx.tursodb.token, intMode: "number" });
        const s = await rep.sync();
        await rep.execute("SELECT 1");
        ok = true;
        res = `synced, ${s?.frames_synced ?? "?"} frames`;
      } catch (e) {
        res = host ? errMsg(e).split(host).join("<redacted>") : errMsg(e);
      } finally {
        rep?.close();
        await rm(gdir, { recursive: true, force: true }).catch(() => undefined);
      }
      out.push({
        id: `${ID}g`,
        title: "Embedded replica (native @libsql/client, syncUrl) against the Turso-engine database (local)",
        status: "info",
        detail: ok ? `works: ${res}` : `does not open: ${res}`,
        measurements: { backend: "turso_embedded_tursodb", vantage: "local", colo: "local", outcome: ok ? "synced" : "error" },
      });
    }
    // f: Turso Sync on the libSQL database and, when the fixture has one, the Turso-engine database.
    const lits = [fx.turso?.hostname, fx.tursodb?.hostname, fx.turso?.org].filter((x): x is string => !!x);
    const red = (s: string) => lits.reduce((acc, l) => acc.split(l).join("<redacted>"), s);
    const targets: SyncTarget[] = [{ engine: "libsql", url: fx.turso!.url, token: fx.turso!.token! }];
    if (fx.tursodb?.url && fx.tursodb.token) targets.push({ engine: "tursodb", url: fx.tursodb.url, token: fx.tursodb.token });
    for (const tg of targets) out.push(...(await syncRows(`${ID}f`, tg, sz, red)));
    return out;
  },
};
export default mod;
