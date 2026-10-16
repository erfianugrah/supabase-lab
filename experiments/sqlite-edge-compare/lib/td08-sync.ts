/**
 * TD08f: Turso Sync (@tursodatabase/sync), the sync path Turso's docs
 * recommend for new projects, on the local vantage against the libSQL and
 * the Turso-engine database. Two local clients (A and B), each a local
 * database file that pushes and pulls. The embedded replica (TD08a-d) does
 * not open a Turso-engine database ("file is not a database", 2026-10-16);
 * Turso Sync does.
 *
 * The package is imported dynamically so the pure helpers here stay testable
 * without it.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client/web";
import type { TestResult } from "../../../harness/src/types";
import { summarize, summaryColumns } from "./stats";
import { r3 } from "./td05-06-08-data";

export type ConflictOutcome = "last-push-wins" | "first-push-wins" | "second-push-refused" | "diverged" | "other";

/**
 * A and B update the same row offline; `first` pushes, then `second`; both
 * pull. `afterFirst` / `afterSecond` are the values each client reads after
 * the pulls.
 */
export function conflictOutcome(o: { first: string; second: string; afterFirst: string; afterSecond: string; secondPushError: string | null }): ConflictOutcome {
  if (o.secondPushError) return "second-push-refused";
  if (o.afterFirst !== o.afterSecond) return "diverged";
  if (o.afterFirst === o.second) return "last-push-wins";
  if (o.afterFirst === o.first) return "first-push-wins";
  return "other";
}

export interface SyncTarget {
  engine: "libsql" | "tursodb";
  url: string;
  token: string;
}

type SyncDb = {
  exec(sql: string): Promise<void>;
  prepare(sql: string): Promise<{ get(...args: unknown[]): Promise<Record<string, unknown> | undefined> }>;
  push(): Promise<void>;
  pull(): Promise<boolean>;
  close(): Promise<void>;
};

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);
const now = () => performance.now();

/** TD08f rows for one database. Never throws; cleans up its table and files. */
export async function syncRows(id: string, tg: SyncTarget, sz: { n: number; warmup: number }, red: (s: string) => string): Promise<TestResult[]> {
  const out: TestResult[] = [];
  const base = { backend: `turso_sync_${tg.engine}`, engine: tg.engine, vantage: "local", colo: "local" };
  let mod: { connect(o: Record<string, unknown>): Promise<SyncDb> };
  try {
    mod = (await import("@tursodatabase/sync")) as unknown as typeof mod;
  } catch (e) {
    return [{ id: `${id}-${tg.engine}`, title: `Turso Sync on ${tg.engine}`, status: "skip", detail: `@tursodatabase/sync not installed: ${msg(e)}` }];
  }
  const remote = createClient({ url: tg.url, authToken: tg.token, intMode: "number" });
  const dir = await mkdtemp(join(tmpdir(), "td08f-"));
  const dbs: SyncDb[] = [];
  const open = async (name: string) => {
    const d = await mod.connect({ path: join(dir, `${name}.db`), url: tg.url, authToken: tg.token, clientName: `td08f-${name}` });
    dbs.push(d);
    return d;
  };
  const read = async (d: SyncDb, k: number) => String((await (await d.prepare("SELECT v FROM td08_sync WHERE k = ?")).get(k))?.v ?? "");
  try {
    await remote.execute("DROP TABLE IF EXISTS td08_sync");
    await remote.execute("CREATE TABLE td08_sync (k INTEGER PRIMARY KEY, v TEXT NOT NULL)");

    // f1: bootstrap two clients.
    let t0 = now();
    const a = await open("a");
    const openA = now() - t0;
    t0 = now();
    const b = await open("b");
    const openB = now() - t0;
    out.push({
      id: `${id}1-${tg.engine}`,
      title: `Turso Sync connect (bootstrap a fresh local file) on ${tg.engine} (local)`,
      status: "pass",
      detail: `client A ${r3(openA)} ms, client B ${r3(openB)} ms`,
      measurements: { ...base, connect_a_ms: r3(openA), connect_b_ms: r3(openB) },
    });

    // f2: B writes + pushes, A pulls; visible on A?
    const push: number[] = [];
    const pull: number[] = [];
    let visible = 0;
    let notBefore = 0;
    let fails = 0;
    let firstErr = "";
    for (let i = 0; i < sz.n + sz.warmup; i++) {
      const k = 1000 + i;
      try {
        await b.exec(`INSERT INTO td08_sync (k, v) VALUES (${k}, 'b-${i}')`);
        const before = await read(a, k);
        let t = now();
        await b.push();
        const p = now() - t;
        t = now();
        await a.pull();
        const q = now() - t;
        const seen = (await read(a, k)) === `b-${i}`;
        if (i < sz.warmup) continue;
        push.push(p);
        pull.push(q);
        if (seen) visible++;
        if (before === "") notBefore++;
      } catch (e) {
        if (i >= sz.warmup) fails++;
        firstErr ||= red(msg(e));
      }
    }
    const ps = summarize(push);
    const ls = summarize(pull);
    const tot = summarize(push.map((x, i) => x + pull[i]!));
    out.push({
      id: `${id}2-${tg.engine}`,
      title: `Turso Sync write on B, push, pull on A: lag and visibility on ${tg.engine} (local)`,
      status: fails === 0 && visible === sz.n ? "pass" : "fail",
      detail: `push p50 ${ps.p50} ms, pull p50 ${ls.p50} ms, push+pull p50 ${tot.p50} ms (n=${ps.n}, ${sz.warmup} warm-up dropped); visible on A after one pull ${visible}/${sz.n}; absent on A before the push ${notBefore}/${sz.n}${fails ? `; ${fails} failed: ${firstErr}` : ""}`,
      measurements: { ...base, ...summaryColumns("push_ms", ps), ...summaryColumns("pull_ms", ls), push_plus_pull_ms_p50: tot.p50, visible_after_one_pull: visible, absent_before_push: notBefore, failed: fails },
    });

    // f3: local reads on A.
    const reads: number[] = [];
    for (let i = 0; i < sz.n * 10; i++) {
      const t = now();
      await read(a, 1000 + (i % sz.n));
      reads.push(now() - t);
    }
    const rs = summarize(reads);
    out.push({
      id: `${id}3-${tg.engine}`,
      title: `Turso Sync local PK read on ${tg.engine} (local file)`,
      status: rs.n > 0 ? "pass" : "fail",
      detail: `p50 ${rs.p50} ms, p95 ${rs.p95} ms (n=${rs.n})`,
      measurements: { ...base, ...summaryColumns("ms", rs) },
    });

    // f4: concurrent offline updates of one row; A pushes first, then B; both pull.
    await a.exec("INSERT INTO td08_sync (k, v) VALUES (1, 'seed')");
    await a.push();
    await b.pull();
    const counts = new Map<ConflictOutcome, number>();
    const errs: string[] = [];
    for (let i = 0; i < sz.n; i++) {
      const [fa, fb] = [`a-${i}`, `b-${i}`];
      await a.exec(`UPDATE td08_sync SET v = '${fa}' WHERE k = 1`);
      await b.exec(`UPDATE td08_sync SET v = '${fb}' WHERE k = 1`);
      await a.push();
      let pushErr: string | null = null;
      try {
        await b.push();
      } catch (e) {
        pushErr = red(msg(e));
        errs.push(pushErr);
      }
      await a.pull();
      await b.pull();
      const o = conflictOutcome({ first: fa, second: fb, afterFirst: await read(a, 1), afterSecond: await read(b, 1), secondPushError: pushErr });
      counts.set(o, (counts.get(o) ?? 0) + 1);
    }
    const atServer = String((await remote.execute("SELECT v FROM td08_sync WHERE k = 1")).rows[0]?.v ?? "");
    const tally = [...counts.entries()].map(([k, v]) => `${k} ${v}`).join(", ");
    out.push({
      id: `${id}4-${tg.engine}`,
      title: `Turso Sync: A and B update the same row offline, A pushes first, then B (${tg.engine}, local)`,
      status: "info",
      detail: `${sz.n} trials: ${tally}; server value after the last trial ${atServer === `b-${sz.n - 1}` ? "B's last write" : atServer === `a-${sz.n - 1}` ? "A's last write" : JSON.stringify(atServer)}${errs.length ? `; push errors: ${errs[0]}` : "; no push raised an error"}`,
      measurements: { ...base, trials: sz.n, ...Object.fromEntries([...counts.entries()].map(([k, v]) => [k.replace(/-/g, "_"), v])), push_errors: errs.length },
    });
  } catch (e) {
    out.push({ id: `${id}-${tg.engine}`, title: `Turso Sync on ${tg.engine}`, status: "fail", detail: `threw: ${red(msg(e))}` });
  } finally {
    const bad: string[] = [];
    for (const d of dbs) await d.close().catch(() => undefined);
    await rm(dir, { recursive: true, force: true }).catch((e) => bad.push(`rm: ${msg(e)}`));
    await remote.execute("DROP TABLE IF EXISTS td08_sync").catch((e) => bad.push(`drop: ${red(msg(e))}`));
    remote.close();
    out.push({ id: `${id}z-${tg.engine}`, title: `cleanup (Turso Sync, ${tg.engine})`, status: bad.length ? "fail" : "pass", detail: bad.length ? bad.join("; ") : "dropped td08_sync, removed the local files" });
  }
  return out;
}
