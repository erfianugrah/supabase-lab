/**
 * D13 - raise provisioned disk IOPS and throughput on a RUNNING gp3 project:
 * interruption per connection path, restart, time to reported and effective,
 * and the cooldown on a second change.
 *
 * Question: when provisioned IOPS and throughput are raised on a running gp3
 * project, do connections through direct 5432, the Supavisor session pooler
 * (5432), the Supavisor transaction pooler (6543) and the Data API see any
 * interruption; does Postgres restart; how long from the API call until the
 * new values are reported and until they are effective; is a second change
 * shortly after refused, with what status and message?
 *
 * Docs (claims under test): compute-and-disk says provisioning IOPS and
 * throughput "requires Large compute size or above" (D08: a dashboard gate,
 * the API accepted it on Micro) and "After any disk attribute change, there is
 * a cooldown period of approximately four hours"; neither page states
 * downtime for a disk performance change. AWS (EBS user guide, since
 * 2026-01-15): up to four Elastic Volumes modifications per rolling 24 hours,
 * the next allowed once the previous one is `completed`.
 *
 * Shape (one throwaway project, Pro org, ap-northeast-1, created Large):
 *   1. IPv4 add-on, so the direct path is reachable from this IPv4-only
 *      vantage; the module records direct as not tested if it never answers.
 *   2. Seven paths sampled for the whole run: direct, session and transaction
 *      pooler, each as a held connection (1 s) and a fresh connection (2 s),
 *      plus `rest_read` (an anon row read through the Data API, 1 s). When the
 *      Data API refuses the project (2026-11-04: the Pro org was under an
 *      org-level restriction, HTTP 402), rest_read is dropped and the summary
 *      says so (`data_api_tested`); the Postgres paths still run.
 *      `PVLAB_D13_ORG_ROLE=team` creates the project in `ctx.orgs.team` instead.
 *   3. 5 min baseline. The platform validates IOPS against size (D11: 500
 *      IOPS per GB, minimum 3,000). The target is the most the current volume
 *      allows, up to 6,000 (targetIops): a project created Large started on
 *      8 GB (2026-11-04), so 3,000 -> 4,000 with no size change. Only when the
 *      volume is too small (2 GB Micro projects in October) does the module
 *      first grow the size alone to GROW_GB (24), sample it (10 min after it
 *      is reported), and then meet the cooldown before the IOPS change.
 *   4. Write loads L1, U1 (unlogged control), L2 at the old values, 5 min
 *      quiet, then attempt 1: the IOPS/throughput change.
 *   5. If refused by the cooldown: wait for the time the refusal names, load
 *      L0 12 min before it, 5 min quiet baseline, then retry.
 *   6. After the accepted POST: config polled every 5 s until it reads the new
 *      values, project status every 10 s; clean 3 min window, then loads P1-P4
 *      at +3, +7, +11 and +15 min (effective-limit probes), sampling to
 *      +25 min (at least 10 min after the values were reported).
 *   7. A second change (throughput 250 -> 300 MiB/s) and its response.
 *
 * Restart: every held-probe sample reads pg_postmaster_start_time(); the
 * Management API query endpoint reads it at each stage boundary too.
 *
 * The write load (lib/live-paths.ts ioLoad) is sized in bytes: two sessions
 * insert 500,000 rows of about 1.9 kB each (about 2 GB heap, as much WAL),
 * then CHECKPOINT. Large's documented compute disk limits are 79 MB/s
 * baseline and 594 MB/s burst, so the provisioned 125 -> 250 MiB/s step is
 * only visible while the instance is in burst; each load lasts tens of
 * seconds. Large sequential writes are throughput-bound, not IOPS-bound, so
 * the IOPS half of the change is NOT tested for effect.
 *
 * DESTRUCTIVE: creates and deletes one Large project, enables the IPv4
 * add-on, raises IOPS/throughput (and grows the disk only when the volume is
 * too small). About 50 min without a grow; about five hours with one, because
 * of the cooldown.
 * Cleanup: the module deletes the project; `make sweep` in this experiment
 * deletes any project whose name starts with PREFIX.
 *
 * Not settled by this module: IOPS effect (see above), io2, a decrease, a
 * project under its own write load during the change, other regions or
 * sizes, and anything with n > 1.
 */
import { lookup } from "node:dns/promises";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { mgmt, mgmtBase } from "../../../harness/src/mgmt";
import { fetchKeys, sql } from "../../../harness/src/platform";
import { restReadProbe, seedProbeTable } from "../../../harness/src/real-probes";
import { suspendedMs, withHostSuspension } from "../../../harness/src/host-pause";
import { attrsReached, GP3_IOPS_PER_GB, minSizeGbForIops, nextAllowedMs, parseCooldown, retryMinutes, type DiskAttrs, type PathPhaseStats } from "../lib/disk-change";
import { Continuous, freshProbe, heldProbe, ioLoad, PostmasterLog, timed, type LoadResult, type PgTarget, type TimedProbe } from "../lib/live-paths";

const ID = "D13";
const REGION = process.env.PVLAB_D13_REGION ?? "ap-northeast-1";
const SIZE = process.env.PVLAB_D13_SIZE ?? "large";
export const PREFIX = process.env.PVLAB_D13_PREFIX ?? "d13-iops-";
const GROW_GB = Number(process.env.PVLAB_D13_GROW_GB ?? 24);
/** Which `ctx.orgs` role to create the project in (`pro` by default; `team` when the Pro org is restricted). */
const ORG_ROLE = process.env.PVLAB_D13_ORG_ROLE ?? "pro";
const LOAD_ROWS = Number(process.env.PVLAB_D13_LOAD_ROWS ?? 500_000);
/**
 * Target IOPS: PVLAB_D13_TARGET_IOPS, else the most the CURRENT volume allows
 * (500 per GB, D11) up to 6,000, so no size change is needed when the volume
 * is big enough. A project created Large started on 8 GB on 2026-11-04 (run 2),
 * so the default is 3,000 -> 4,000 with no grow and no cooldown wait; a 2 GB
 * or 6 GB volume still takes the grow path (and the four-hour wait) to 6,000.
 */
const TARGET_IOPS_ENV = Number(process.env.PVLAB_D13_TARGET_IOPS ?? 0);
function targetIops(sizeGb: number, currentIops: number): number {
  if (TARGET_IOPS_ENV > 0) return TARGET_IOPS_ENV;
  const fit = Math.min(6000, sizeGb * GP3_IOPS_PER_GB);
  return fit > currentIops ? fit : 6000;
}
const TARGET_TPUT = 250;
const SECOND_TPUT = 300;

const MIN = 60_000;
const BASELINE_MS = 5 * MIN;
const GROW_TAIL_MS = 10 * MIN;
const QUIET_MS = 5 * MIN;
const LOAD_LEAD_MS = 12 * MIN;
const POST_LOADS_MIN = [3, 7, 11, 15];
const POST_TAIL_MS = 25 * MIN;
const AFTER_REPORT_MS = 10 * MIN;
const SECOND_TAIL_MS = 5 * MIN;
const MAX_EXTRA_WAIT_MS = 90 * MIN;
const HELD_MS = 1_000;
const FRESH_MS = 2_000;
const REST_MS = 1_000;

const sleep = (ms: number) => Bun.sleep(Math.max(0, ms));
async function sleepUntil(t: number): Promise<void> {
  while (Date.now() < t) await sleep(Math.min(30_000, t - Date.now()));
}
const secs = (ms: number) => Math.round(ms / 100) / 10;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 240);

interface Raw {
  status: number;
  text: string;
  headers: string;
  at: number;
}

/** POST /config/disk with the response headers kept (mgmt() drops them). */
async function postDisk(ctx: Ctx, ref: string, attrs: DiskAttrs): Promise<Raw> {
  const at = Date.now();
  try {
    const r = await fetch(`${mgmtBase(ctx)}/projects/${ref}/config/disk`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ctx.pat}`, "Content-Type": "application/json" },
      body: JSON.stringify({ attributes: attrs }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = (await r.text()).slice(0, 600);
    const headers = ["retry-after", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset"]
      .map((h) => (r.headers.get(h) ? `${h}=${r.headers.get(h)}` : ""))
      .filter(Boolean)
      .join("; ");
    return { status: r.status, text, headers, at };
  } catch (e) {
    return { status: -1, text: errText(e), headers: "", at };
  }
}

const isCooldown = (r: Raw) => r.status === 429 && /can only be modified/i.test(r.text);

/** POST, retrying only a request-rate 429 (not the cooldown), honouring retry-after. */
async function postDiskRateSafe(ctx: Ctx, ref: string, attrs: DiskAttrs, log: (m: string) => void): Promise<Raw> {
  let r = await postDisk(ctx, ref, attrs);
  for (let i = 0; i < 5 && r.status === 429 && !isCooldown(r); i++) {
    const ra = Number(/retry-after=(\d+)/.exec(r.headers)?.[1] ?? 30);
    log(`POST /config/disk rate-limited (${r.text.slice(0, 80)}), retry in ${ra} s`);
    await sleep(ra * 1000 + 1000);
    r = await postDisk(ctx, ref, attrs);
  }
  return r;
}

interface DiskRead {
  status: number;
  attrs?: DiskAttrs;
  text: string;
}

async function getDisk(ctx: Ctx, ref: string): Promise<DiskRead> {
  const r = await mgmt(ctx, "GET", `/projects/${ref}/config/disk`).catch(() => null);
  if (!r) return { status: -1, text: "error" };
  const attrs = (r.json as { attributes?: DiskAttrs } | undefined)?.attributes;
  return { status: r.status, attrs, text: r.text.slice(0, 300) };
}

async function statusOf(ctx: Ctx, ref: string): Promise<string> {
  const p = await mgmt(ctx, "GET", `/projects/${ref}`).catch(() => null);
  return ((p?.json as { status?: string } | undefined)?.status ?? `HTTP ${p?.status ?? "error"}`) as string;
}

async function postmasterStart(ctx: Ctx, ref: string): Promise<string> {
  const r = await sql({ ...ctx, ref }, "select pg_postmaster_start_time()::text as pst").catch(() => null);
  if (!r || r.error) return `unread (${r?.status ?? "error"})`;
  return String(r.rows[0]?.pst ?? "unread");
}

/**
 * Polls a change in the background: config every 5 s until the target reads
 * back (then every 60 s), project status every 10 s for 5 min (then 60 s).
 * Records each distinct config body and status with seconds after the POST.
 */
class ChangeWatch {
  reportedAt: number | null = null;
  readonly bodies: string[] = [];
  readonly statuses: string[] = [];
  private stopped = false;
  private readonly done: Promise<void>;
  constructor(
    private readonly ctx: Ctx,
    private readonly ref: string,
    private readonly target: DiskAttrs,
    private readonly sentAt: number,
    private readonly log: (m: string) => void,
  ) {
    this.done = this.run();
  }
  private async run(): Promise<void> {
    let lastBody = "";
    let lastStatus = "";
    let nextStatus = 0;
    while (!this.stopped) {
      const now = Date.now();
      const d = await getDisk(this.ctx, this.ref);
      const rel = secs(Date.now() - this.sentAt);
      if (d.status === 200) {
        if (d.text !== lastBody) {
          lastBody = d.text;
          this.bodies.push(`+${rel}s ${d.text}`);
          this.log(`config/disk at +${rel}s: ${d.text}`);
        }
        if (this.reportedAt === null && attrsReached(d.attrs, this.target)) {
          this.reportedAt = Date.now();
          this.log(`target reported at +${rel}s`);
        }
      }
      if (now >= nextStatus) {
        const s = await statusOf(this.ctx, this.ref);
        if (s !== lastStatus) {
          lastStatus = s;
          this.statuses.push(`+${secs(Date.now() - this.sentAt)}s ${s}`);
          this.log(`project status at +${secs(Date.now() - this.sentAt)}s: ${s}`);
        }
        nextStatus = now + (now - this.sentAt < 5 * MIN ? 10_000 : 60_000);
      }
      const wait = this.reportedAt === null || now - this.sentAt < 5 * MIN ? 5_000 : 60_000;
      const until = Date.now() + wait;
      while (!this.stopped && Date.now() < until) await sleep(500);
    }
  }
  async end(): Promise<void> {
    this.stopped = true;
    await this.done;
  }
}

interface Attempt {
  label: string;
  raw: Raw;
}

interface State {
  ref: string;
  t0: number;
  healthyS: number;
  ipv4: { patchStatus: number; retries: number; aS: number; directS: number; note: string } | null;
  seedS: number;
  disk0?: DiskAttrs;
  growGb?: number;
  targetIops?: number;
  pgVersion: string;
  pst: Record<string, string>;
  grow?: { raw: Raw; watch: ChangeWatch; target: DiskAttrs };
  attempts: Attempt[];
  main?: { raw: Raw; watch: ChangeWatch; target: DiskAttrs; growToMainS: number | null };
  second?: { raw: Raw; watch?: ChangeWatch; afterMainS: number };
  loads: { load: LoadResult; startAfterMainS: number | null }[];
  diskEnd?: DiskRead;
  directTested: boolean;
  loadPath: string;
  orgPlan: string;
  restTested: boolean;
  restNote: string;
  notes: string[];
}

function fmt(v: number | null | undefined): number | string {
  return v === null || v === undefined ? "n/a" : v;
}

/** Fold per-phase stats of one path over a set of phases. */
function fold(st: PathPhaseStats[], names: Set<string>) {
  const sel = st.filter((s) => names.has(s.phase));
  return {
    samples: sel.reduce((a, s) => a + s.samples, 0),
    failures: sel.reduce((a, s) => a + s.failures, 0),
    maxOutageS: Math.max(0, ...sel.map((s) => s.maxOutageS)),
    maxGapS: Math.max(0, ...sel.map((s) => s.maxGapS)),
    maxMs: Math.max(0, ...sel.map((s) => s.maxMs ?? 0)),
  };
}

function windowRow(id: string, title: string, stats: Map<string, PathPhaseStats[]>, names: string[], extra: Record<string, number | string> = {}): TestResult {
  const set = new Set(names);
  const meas: Record<string, number | string> = { phases: names.join(",") || "none", ...extra };
  const parts: string[] = [];
  for (const [path, st] of stats) {
    const f = fold(st, set);
    meas[`${path}_failed`] = `${f.failures}/${f.samples}`;
    meas[`${path}_max_outage_s`] = f.maxOutageS;
    meas[`${path}_max_gap_s`] = f.maxGapS;
    meas[`${path}_max_ms`] = f.maxMs;
    parts.push(`${path} ${f.failures}/${f.samples}${f.failures ? ` (max outage ${f.maxOutageS} s)` : ""}`);
  }
  return { id, title, status: "info", detail: parts.join("; "), measurements: meas };
}

function loadMeas(prefix: string, l: LoadResult, startAfterMainS: number | null): Record<string, number | string> {
  return {
    [`${prefix}_ok`]: l.ok ? "yes" : `no: ${l.error.slice(0, 100)}`,
    [`${prefix}_start_after_change_s`]: fmt(startAfterMainS),
    [`${prefix}_insert_ms`]: l.insertMs,
    [`${prefix}_checkpoint`]: l.checkpoint,
    [`${prefix}_checkpoint_ms`]: l.checkpointMs,
    [`${prefix}_total_ms`]: l.totalMs,
    [`${prefix}_heap_mb`]: Math.round(l.heapBytes / 1e6),
    [`${prefix}_wal_mb`]: Math.round(l.walBytes / 1e6),
    [`${prefix}_unlogged`]: l.unlogged ? "yes" : "no",
    [`${prefix}_written_mbps`]: l.writtenMBps,
    [`${prefix}_wal_mbps`]: l.walMBps,
    [`${prefix}_disk_device`]: l.disk?.device ?? "no fresh metrics",
    [`${prefix}_disk_window_s`]: fmt(l.disk?.seconds),
    [`${prefix}_disk_written_mb`]: fmt(l.disk?.writtenMB),
    [`${prefix}_disk_write_mbps_window_avg`]: fmt(l.disk?.writeMBps),
    [`${prefix}_disk_write_iops_window_avg`]: fmt(l.disk?.writeIops),
    [`${prefix}_cpu_busy_frac_window`]: fmt(l.disk?.cpuBusyFrac),
  };
}

function attemptMeas(prefix: string, r: Raw): Record<string, number | string> {
  const c = parseCooldown(r.text);
  return {
    [`${prefix}_status`]: r.status,
    [`${prefix}_body`]: r.text.slice(0, 300) || "(empty)",
    [`${prefix}_headers`]: r.headers || "none",
    [`${prefix}_cooldown_hours`]: fmt(c.hours),
    [`${prefix}_last_modified`]: c.lastModifiedText || "n/a",
  };
}

const mod: TestModule = {
  id: ID,
  title: "Live disk IOPS/throughput raise on a running gp3 project: interruption, restart, timing, cooldown",
  where: "local",
  requires: ["pat"],
  destructive: true,
  // Backstop only: a hang past this leaves the project for `make sweep`.
  timeoutMs: 9 * 60 * MIN,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const org = ctx.orgs[ORG_ROLE] ?? "";
    if (!org) return [{ id: ID, title: this.title, status: "skip", detail: `PVLAB_ORG_${ORG_ROLE.toUpperCase()} not set` }];
    const w0 = Date.now();
    const m0 = performance.now();
    const log = (m: string) => ctx.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
    const S: State = {
      ref: "", t0: w0, healthyS: -1, ipv4: null, seedS: -1, pgVersion: "", pst: {}, attempts: [], loads: [],
      directTested: false, loadPath: "", notes: [], orgPlan: "", restTested: false, restNote: "",
    };
    let cont: Continuous | null = null;
    let error = "";
    const orgRead = await mgmt(ctx, "GET", `/organizations/${org}`).catch(() => null);
    S.orgPlan = String((orgRead?.json as { plan?: string } | undefined)?.plan ?? `unread (HTTP ${orgRead?.status ?? "error"})`);
    const events: string[] = [];
    const pm = new PostmasterLog();

    try {
      // ---- project
      const password = `${crypto.randomUUID()}Aa1!`; // per run, memory only
      const create = await mgmt(ctx, "POST", "/projects", {
        organization_slug: org,
        name: `${PREFIX}${w0}`,
        db_pass: password,
        region: REGION,
        desired_instance_size: SIZE,
      });
      S.ref = ((create.json as { ref?: string } | undefined)?.ref ?? "") as string;
      if (create.status !== 201 || !S.ref) throw new Error(`create: HTTP ${create.status}: ${create.text.slice(0, 200)}`);
      const ref = S.ref;
      log(`project created (${PREFIX}${w0}), ${SIZE}, ${REGION}`);
      let status = "";
      while (Date.now() - w0 < 20 * MIN && status !== "ACTIVE_HEALTHY") {
        await sleep(10_000);
        status = await statusOf(ctx, ref);
      }
      if (status !== "ACTIVE_HEALTHY") throw new Error(`never healthy: ${status}`);
      S.healthyS = secs(Date.now() - w0);
      const apiHost = `${ref}.supabase.co`;
      const pctx: Ctx = { ...ctx, ref, apiHost };

      let keys: { anon: string; service: string } | null = null;
      for (let i = 0; i < 12 && !keys; i++) {
        keys = await fetchKeys(pctx).catch(() => null);
        if (!keys) await sleep(5_000);
      }
      if (!keys) throw new Error("no api keys");

      let pooler: { db_host: string; db_user: string } | undefined;
      for (let i = 0; i < 30 && !pooler; i++) {
        const r = await mgmt(ctx, "GET", `/projects/${ref}/config/database/pooler`);
        pooler = (Array.isArray(r.json) ? (r.json as { database_type: string; db_host: string; db_user: string }[]) : []).find((e) => e.database_type === "PRIMARY");
        if (!pooler) await sleep(10_000);
      }
      if (!pooler) throw new Error("no PRIMARY pooler entry");

      const direct: PgTarget = { host: `db.${ref}.supabase.co`, port: 5432, user: "postgres", password };
      const session: PgTarget = { host: pooler.db_host, port: 5432, user: pooler.db_user, password };
      const txn: PgTarget = { ...session, port: 6543 };

      // ---- IPv4 add-on for the direct path
      {
        const t = Date.now();
        let r = await mgmt(ctx, "PATCH", `/projects/${ref}/billing/addons`, { addon_type: "ipv4", addon_variant: "ipv4_default" });
        let retries = 0;
        while (r.status === 429 && retries < 5) {
          retries += 1;
          const m = retryMinutes(r.text) ?? 1;
          log(`ipv4 add-on: 429 (${r.text.slice(0, 100)}), retry in ${m} min`);
          await sleep(m * MIN + 5_000);
          r = await mgmt(ctx, "PATCH", `/projects/${ref}/billing/addons`, { addon_type: "ipv4", addon_variant: "ipv4_default" });
        }
        let aS = -1;
        let directS = -1;
        let last = "";
        if (r.status < 300) {
          const fp = freshProbe("ipv4_check", direct, 0);
          while (Date.now() - t < 15 * MIN && directS < 0) {
            if (aS < 0 && (await lookup(direct.host, { family: 4, all: true }).catch(() => [])).length) aS = secs(Date.now() - t);
            if (aS >= 0) {
              const o = await fp.run();
              if (o.ok) directS = secs(Date.now() - t);
              else last = o.error ?? "";
            }
            if (directS < 0) await sleep(10_000);
          }
        }
        S.ipv4 = { patchStatus: r.status, retries, aS, directS, note: directS < 0 ? `direct never answered: ${last || r.text.slice(0, 120)}` : "" };
        S.directTested = directS >= 0;
        log(`ipv4 add-on: PATCH ${r.status}; A record ${aS} s; direct answered ${directS} s`);
      }

      // The Data API can be refused for the whole org (2026-11-04 run 1: HTTP 402
      // "Service for this project is restricted due to the following violations:
      // ..."); then the Postgres paths still run and rest_read is recorded as not tested.
      try {
        S.seedS = await seedProbeTable(pctx, apiHost, keys.anon, { maxMs: 180_000 });
        S.restTested = true;
      } catch (e) {
        const one = await fetch(`https://${apiHost}/rest/v1/pvlab_probe?id=eq.1&select=id`, {
          headers: { apikey: keys.anon, Authorization: `Bearer ${keys.anon}` },
          signal: AbortSignal.timeout(10_000),
        })
          .then(async (r) => `HTTP ${r.status} ${(await r.text()).slice(0, 300)}`)
          .catch((x: unknown) => errText(x));
        S.restNote = `${errText(e).slice(0, 160)}; one read: ${one}`;
        log(`Data API NOT tested: ${S.restNote}`);
      }
      const d0 = await getDisk(ctx, ref);
      S.disk0 = d0.attrs;
      const v = await sql(pctx, "select current_setting('server_version') as v, current_setting('max_wal_size') as w, current_setting('shared_buffers') as b").catch(() => null);
      S.pgVersion = v && !v.error ? `${v.rows[0]?.v} (max_wal_size ${v.rows[0]?.w}, shared_buffers ${v.rows[0]?.b})` : "unread";
      S.pst.setup = await postmasterStart(ctx, ref);
      log(`disk at start: ${d0.text}; postgres ${S.pgVersion}; postmaster ${S.pst.setup}`);
      if (!S.disk0?.type || S.disk0.size_gb === undefined || S.disk0.iops === undefined || S.disk0.throughput_mibps === undefined) {
        throw new Error(`config/disk unreadable: HTTP ${d0.status} ${d0.text}`);
      }
      if (S.disk0.type !== "gp3") throw new Error(`disk type ${S.disk0.type}, not gp3`);

      // ---- sampling
      const probes: TimedProbe[] = [];
      if (S.directTested) probes.push(heldProbe("direct_held", direct, HELD_MS, pm, events, log), freshProbe("direct_fresh", direct, FRESH_MS));
      probes.push(
        heldProbe("session_held", session, HELD_MS, pm, events, log),
        freshProbe("session_fresh", session, FRESH_MS),
        heldProbe("txn_held", txn, HELD_MS, pm, events, log),
        freshProbe("txn_fresh", txn, FRESH_MS),
      );
      if (S.restTested) {
        const rr = restReadProbe(apiHost, keys.anon);
        probes.push(timed("rest_read", REST_MS, () => rr.run()));
      }
      const loadTarget = S.directTested ? direct : session;
      S.loadPath = S.directTested ? "direct 5432" : "session pooler 5432";
      const load = (label: string, unlogged = false) =>
        ioLoad(label, loadTarget, { rows: LOAD_ROWS, sessions: 2, apiHost, serviceKey: keys!.service, log, unlogged });

      cont = new Continuous(probes, log);
      const C = cont;
      C.start("baseline");
      await sleep(BASELINE_MS);

      // ---- size-only grow, only if the IOPS target needs it (D11 floor)
      const TARGET_IOPS = targetIops(S.disk0.size_gb, S.disk0.iops);
      S.targetIops = TARGET_IOPS;
      const growGb = S.disk0.size_gb >= minSizeGbForIops(TARGET_IOPS) ? S.disk0.size_gb : Math.max(GROW_GB, minSizeGbForIops(TARGET_IOPS));
      const base: DiskAttrs = { type: "gp3", size_gb: growGb, iops: S.disk0.iops, throughput_mibps: S.disk0.throughput_mibps };
      S.growGb = growGb;
      let growSent = Date.now();
      if (growGb > S.disk0.size_gb) {
        const growTarget: DiskAttrs = { size_gb: growGb };
        let raw = await postDiskRateSafe(ctx, ref, base, log);
        // A fresh project's disk can already carry a recent modification
        // (orioledb RUNLOG: 8 GB with a last_modified_at after creation); wait it out, once.
        if (isCooldown(raw)) {
          const until = nextAllowedMs(parseCooldown(raw.text), raw.at);
          S.notes.push(`grow refused at first by the cooldown (${raw.text.slice(0, 160)}); waited until ${new Date(until).toISOString()}`);
          log(`grow refused by the cooldown, waiting until ${new Date(until).toISOString()}`);
          C.phase("pre_grow_wait");
          await sleepUntil(until + 30_000);
          C.phase("baseline_pre_grow");
          await sleep(BASELINE_MS);
          raw = await postDiskRateSafe(ctx, ref, base, log);
        }
        growSent = raw.at;
        C.phase("grow", raw.at);
        log(`grow POST ${raw.status} ${raw.text.slice(0, 200)}`);
        if (raw.status >= 300) throw new Error(`grow refused: HTTP ${raw.status} ${raw.text.slice(0, 200)}`);
        const watch = new ChangeWatch(ctx, ref, growTarget, raw.at, log);
        S.grow = { raw, watch, target: growTarget };
        while (watch.reportedAt === null && Date.now() - raw.at < 15 * MIN) await sleep(2_000);
        await sleepUntil((watch.reportedAt ?? raw.at) + GROW_TAIL_MS);
        await watch.end();
        S.pst.after_grow = await postmasterStart(ctx, ref);
      } else {
        S.notes.push(`disk already ${S.disk0.size_gb} GB, no grow`);
      }

      // ---- effective-limit control at the old values, then attempt 1
      // Two logged loads and an unlogged control: run 2 (2026-11-04) read 43.2 s
      // and then 28.9 s for the same logged load at the same settings.
      C.phase("load_L1");
      S.loads.push({ load: await load("L1"), startAfterMainS: null });
      C.phase("load_U1");
      S.loads.push({ load: await load("U1", true), startAfterMainS: null });
      C.phase("load_L2");
      S.loads.push({ load: await load("L2"), startAfterMainS: null });
      C.phase("quiet_pre_attempt1");
      await sleep(QUIET_MS);
      const target: DiskAttrs = { iops: TARGET_IOPS, throughput_mibps: TARGET_TPUT };
      const body: DiskAttrs = { ...base, iops: TARGET_IOPS, throughput_mibps: TARGET_TPUT };
      let accepted: Raw | null = null;
      {
        const raw = await postDiskRateSafe(ctx, ref, body, log);
        S.attempts.push({ label: "attempt1", raw });
        log(`attempt1 (${S.grow ? `${secs(raw.at - growSent)} s after the grow POST` : "no grow before it"}): ${raw.status} ${raw.headers} ${raw.text.slice(0, 240)}`);
        if (raw.status < 300) accepted = raw;
        else if (!isCooldown(raw)) throw new Error(`attempt1 rejected, not a cooldown: HTTP ${raw.status} ${raw.text.slice(0, 200)}`);
      }

      // ---- wait out the cooldown the refusal names
      if (!accepted) {
        const first = S.attempts[0]!.raw;
        let allowedAt = nextAllowedMs(parseCooldown(first.text), growSent);
        log(`cooldown: next change allowed at ${new Date(allowedAt).toISOString()} by the refusal text`);
        C.phase("cooldown_wait");
        let nextStatus = 0;
        let lastStatus = "";
        while (Date.now() < allowedAt - LOAD_LEAD_MS) {
          if (Date.now() >= nextStatus) {
            const s = await statusOf(ctx, ref);
            if (s !== lastStatus) log(`project status during the wait: ${s}`);
            lastStatus = s;
            nextStatus = Date.now() + 10 * MIN;
          }
          await sleep(Math.min(60_000, allowedAt - LOAD_LEAD_MS - Date.now()));
        }
        C.phase("load_L0");
        S.loads.push({ load: await load("L0"), startAfterMainS: null });
        C.phase("baseline_main");
        S.pst.before_main = await postmasterStart(ctx, ref);
        await sleepUntil(Math.max(allowedAt + 30_000, Date.now() + QUIET_MS));
        const giveUp = Date.now() + MAX_EXTRA_WAIT_MS;
        let n = 1;
        while (!accepted && Date.now() < giveUp) {
          n += 1;
          const raw = await postDiskRateSafe(ctx, ref, body, log);
          S.attempts.push({ label: `attempt${n}`, raw });
          log(`attempt${n} (${secs(raw.at - growSent)} s after the grow POST): ${raw.status} ${raw.headers} ${raw.text.slice(0, 240)}`);
          if (raw.status < 300) accepted = raw;
          else if (!isCooldown(raw)) throw new Error(`attempt${n} rejected, not a cooldown: HTTP ${raw.status} ${raw.text.slice(0, 200)}`);
          else {
            allowedAt = nextAllowedMs(parseCooldown(raw.text), growSent);
            await sleep(allowedAt > Date.now() ? allowedAt - Date.now() + 30_000 : 5 * MIN);
          }
        }
        if (!accepted) throw new Error(`change still refused ${secs(Date.now() - growSent)} s after the grow`);
      } else {
        S.pst.before_main = S.pst.after_grow ?? S.pst.setup ?? "";
      }

      // ---- the change
      const T0 = accepted.at;
      C.phase("change", T0);
      const watch = new ChangeWatch(ctx, ref, target, T0, log);
      S.main = { raw: accepted, watch, target, growToMainS: S.grow ? secs(T0 - growSent) : null };
      for (const [i, m] of POST_LOADS_MIN.entries()) {
        await sleepUntil(T0 + m * MIN);
        C.phase(`load_P${i + 1}`);
        const startS = secs(Date.now() - T0);
        S.loads.push({ load: await load(`P${i + 1}`), startAfterMainS: startS });
        C.phase(i + 1 < POST_LOADS_MIN.length ? `post_quiet_${i + 1}` : "post_tail");
      }
      await sleepUntil(Math.max(T0 + POST_TAIL_MS, (watch.reportedAt ?? T0) + AFTER_REPORT_MS));
      await watch.end();
      S.pst.after_main = await postmasterStart(ctx, ref);

      // ---- second change
      {
        const raw = await postDiskRateSafe(ctx, ref, { ...body, throughput_mibps: SECOND_TPUT }, log);
        C.phase("second_change", raw.at);
        S.second = { raw, afterMainS: secs(raw.at - T0) };
        log(`second change (${S.second.afterMainS} s after the accepted change): ${raw.status} ${raw.headers} ${raw.text.slice(0, 240)}`);
        if (raw.status < 300) {
          const w2 = new ChangeWatch(ctx, ref, { throughput_mibps: SECOND_TPUT }, raw.at, log);
          S.second.watch = w2;
          while (w2.reportedAt === null && Date.now() - raw.at < 15 * MIN) await sleep(2_000);
          await sleepUntil((w2.reportedAt ?? raw.at) + AFTER_REPORT_MS);
          await w2.end();
        } else {
          await sleep(SECOND_TAIL_MS);
        }
      }
      S.pst.end = await postmasterStart(ctx, ref);
      S.diskEnd = await getDisk(ctx, ref);
    } catch (e) {
      error = errText(e);
      log(`D13 stopped early: ${error}`);
    }

    // ---- stop, report, delete
    let endMs = Date.now();
    if (cont) endMs = await cont.stop().catch(() => Date.now());
    for (const w of [S.grow?.watch, S.main?.watch, S.second?.watch]) await w?.end().catch(() => {});
    const results: TestResult[] = [];
    try {
      results.push(...buildRows(S, cont, endMs, error, events, pm));
    } catch (e) {
      results.push({ id: ID, title: "D13: row build", status: "fail", detail: `row build threw: ${errText(e)}` });
    }
    if (S.ref) {
      const d = await mgmt(ctx, "DELETE", `/projects/${S.ref}`).catch(() => null);
      let gone = false;
      let left = -1;
      for (let i = 0; i < 24 && !gone; i++) {
        await sleep(5_000);
        const r = await mgmt(ctx, "GET", "/projects").catch(() => null);
        const arr = (Array.isArray(r?.json) ? r!.json : []) as { ref?: string; id?: string; name?: string }[];
        gone = r?.status === 200 && !arr.some((p) => (p.ref ?? p.id) === S.ref);
        left = arr.filter((p) => (p.name ?? "").startsWith(PREFIX)).length;
      }
      log(`delete: HTTP ${d?.status ?? "error"}; gone ${gone}; ${left} project(s) with prefix ${PREFIX}`);
      results.push({
        id: `${ID}-teardown`,
        title: "D13: delete the project, confirm it left GET /projects",
        status: gone ? "pass" : "fail",
        detail: `DELETE HTTP ${d?.status ?? "error"}; ${gone ? "absent from" : "still in"} GET /projects; ${left} project(s) with prefix ${PREFIX}`,
        measurements: { delete_status: d?.status ?? -1, gone: gone ? "yes" : "no", projects_with_prefix: left },
      });
    }
    const susp = suspendedMs(w0, Date.now(), m0, performance.now());
    return results.map((r, i) => (i === 0 ? withHostSuspension(r, susp) : r));
  },
};

function buildRows(S: State, cont: Continuous | null, endMs: number, error: string, events: string[], pm: PostmasterLog): TestResult[] {
  const out: TestResult[] = [];
  const pstSeen = [...pm.seen.entries()].map(([pst, v]) => `${new Date(pst * 1000).toISOString()} (first on ${v.path} at ${new Date(v.firstAt).toISOString()})`);
  const restarted = pm.seen.size > 1 || new Set(Object.values(S.pst).filter((s) => !s.startsWith("unread"))).size > 1;
  const stats = cont ? cont.stats(endMs) : new Map<string, PathPhaseStats[]>();
  const phaseNames = cont ? cont.phases.map((p) => p.name) : [];
  const pausedS = cont ? Math.round(cont.pauses.reduce((a, p) => a + (p.toMs - p.fromMs), 0) / 1000) : 0;

  // summary
  const m = S.main;
  const reportedS = m?.watch.reportedAt ? secs(m.watch.reportedAt - m.raw.at) : "never";
  out.push({
    id: ID,
    title: `D13: raise IOPS ${S.disk0?.iops ?? "?"} -> ${S.targetIops ?? "?"} and throughput ${S.disk0?.throughput_mibps ?? "?"} -> ${TARGET_TPUT} MiB/s on a running gp3 project (summary)`,
    status: error || !m ? "fail" : "info",
    detail: [
      error ? `stopped early: ${error}` : "",
      m
        ? `change accepted${m.growToMainS === null ? " with no size change before it" : ` ${m.growToMainS} s after the size-only grow`} (${S.attempts.length - 1} refusal(s) before it); values reported ${reportedS} s after the POST`
        : "change not made",
      `postmaster restarted: ${restarted ? "YES" : "no"} (${pm.seen.size} distinct start time(s) on held connections)`,
      S.directTested ? "" : "direct 5432 NOT tested (IPv4 add-on path never answered)",
      S.restTested ? "" : "Data API NOT tested (see data_api_tested)",
    ]
      .filter(Boolean)
      .join("; "),
    measurements: {
      region: REGION,
      compute: SIZE,
      org_role: ORG_ROLE,
      org_plan: S.orgPlan,
      healthy_after_create_s: S.healthyS,
      postgres: S.pgVersion,
      disk_at_start: S.disk0 ? `${S.disk0.type} ${S.disk0.size_gb} GB ${S.disk0.iops} IOPS ${S.disk0.throughput_mibps} MiB/s` : "unread",
      disk_at_end: S.diskEnd?.text ?? "unread",
      ipv4_patch_status: S.ipv4?.patchStatus ?? -1,
      ipv4_patch_429_retries: S.ipv4?.retries ?? -1,
      ipv4_a_record_s: S.ipv4?.aS ?? -1,
      ipv4_direct_answered_s: S.ipv4?.directS ?? -1,
      direct_tested: S.directTested ? "yes" : `no: ${S.ipv4?.note ?? "add-on not attempted"}`,
      probe_table_ready_s: S.seedS,
      data_api_tested: S.restTested ? "yes" : `no: ${S.restNote}`,
      held_interval_ms: HELD_MS,
      fresh_interval_ms: FRESH_MS,
      rest_read_interval_ms: REST_MS,
      paths: [...stats.keys()].join(","),
      load_path: S.loadPath || "n/a",
      phases: phaseNames.join(","),
      postmaster_restarted: restarted ? "yes" : "no",
      postmaster_starts_seen_held: pstSeen.join(" | ") || "none",
      ...Object.fromEntries(Object.entries(S.pst).map(([k, v]) => [`postmaster_start_mgmt_${k}`, v])),
      held_connection_error_events: events.length,
      host_paused_s_in_sampling: pausedS,
      notes: S.notes.join("; ") || "none",
    },
    evidence: events.length ? `held connection error events:\n${events.join("\n")}` : undefined,
  });

  // per-window path rows
  const has = (n: string) => phaseNames.includes(n);
  out.push(windowRow(`${ID}-baseline`, "D13: baseline windows (before the grow, the cooldown wait, before the change)", stats, ["baseline", "pre_grow_wait", "baseline_pre_grow", "cooldown_wait", "baseline_main"].filter(has)));
  if (S.grow) {
    const g = S.grow;
    out.push(
      windowRow(`${ID}a`, `D13a: size-only grow ${S.disk0?.size_gb} -> ${S.growGb} GB (POST to 10 min after reported)`, stats, ["grow"].filter(has), {
        post_status: g.raw.status,
        post_body: g.raw.text.slice(0, 200) || "(empty)",
        reported_after_s: g.watch.reportedAt ? secs(g.watch.reportedAt - g.raw.at) : "never",
        status_values: g.watch.statuses.join(" | ") || "none",
        config_bodies: g.watch.bodies.join(" | ").slice(0, 900) || "none",
        postmaster_before: S.pst.setup ?? "unread",
        postmaster_after: S.pst.after_grow ?? "unread",
      }),
    );
  }
  const a1 = S.attempts[0];
  if (a1) {
    out.push({
      id: `${ID}b`,
      title: S.grow ? "D13b: IOPS/throughput change shortly after a size-only change" : "D13b: first IOPS/throughput POST (no size change before it)",
      status: "info",
      detail: `${a1.raw.status} ${a1.raw.text.slice(0, 200)}`,
      measurements: {
        after_grow_post_s: S.grow ? secs(a1.raw.at - S.grow.raw.at) : "n/a (no grow)",
        ...attemptMeas("attempt1", a1.raw),
        // Every POST of the change, refused or not: run 2 (2026-11-04) kept its
        // ten later refusals only in the log, because D13c is built only after an accepted change.
        attempts_total: S.attempts.length,
        attempts_refused_429: S.attempts.filter((a) => a.raw.status === 429).length,
        attempts_all: S.attempts
          .map((a) => `${a.label} ${a.raw.status}${S.grow ? ` +${secs(a.raw.at - S.grow.raw.at)}s` : ""}${parseCooldown(a.raw.text).lastModifiedText ? ` last-modified ${parseCooldown(a.raw.text).lastModifiedText}` : ""}`)
          .join(" | "),
      },
    });
  }
  if (m) {
    const quiet = ["change", "post_quiet_1", "post_quiet_2", "post_quiet_3", "post_tail"].filter(has);
    const loads = ["load_P1", "load_P2", "load_P3", "load_P4"].filter(has);
    const later = S.attempts.slice(1);
    out.push(
      windowRow(`${ID}c`, "D13c: the IOPS/throughput change - quiet windows from the accepted POST to +25 min (load windows excluded)", stats, quiet, {
        post_status: m.raw.status,
        post_body: m.raw.text.slice(0, 200) || "(empty)",
        accepted_after_grow_post_s: m.growToMainS ?? "n/a (no grow)",
        refusals_before_accept: S.attempts.length - 1,
        refusal_times_after_grow_post_s: S.attempts.filter((a) => a.raw.status >= 300).map((a) => (S.grow ? secs(a.raw.at - S.grow.raw.at) : "?")).join(",") || "none",
        later_attempts: later.map((a) => `${a.label} ${a.raw.status}`).join(", ") || "none",
        reported_after_s: reportedS,
        status_values: m.watch.statuses.join(" | ") || "none",
        config_bodies: m.watch.bodies.join(" | ").slice(0, 900) || "none",
        postmaster_before: S.pst.before_main ?? "unread",
        postmaster_after: S.pst.after_main ?? "unread",
      }),
    );
    out.push(windowRow(`${ID}c-loads`, "D13c: path samples inside the post-change load windows (P1-P4)", stats, loads));
    out.push(windowRow(`${ID}c-change3min`, "D13c: path samples in the first 3 min after the accepted POST (no load)", stats, ["change"].filter(has)));
  }
  if (S.loads.length) {
    const meas: Record<string, number | string> = { rows_per_session: LOAD_ROWS, sessions: 2, path: S.loadPath };
    for (const l of S.loads) Object.assign(meas, loadMeas(`load_${l.load.label}`, l.load, l.startAfterMainS));
    out.push({
      id: `${ID}d`,
      title: "D13d: write load (about 2 GB heap + WAL, then CHECKPOINT) before and after the change",
      status: S.loads.every((l) => l.load.ok) ? "info" : "fail",
      detail: S.loads.map((l) => `${l.load.label}${l.startAfterMainS !== null ? ` (+${l.startAfterMainS}s)` : ""}: insert ${l.load.insertMs} ms${l.load.unlogged ? " (unlogged)" : ""}, ${l.load.writtenMBps} MB/s written`).join("; "),
      measurements: meas,
    });
  }
  if (S.second) {
    const s2 = S.second;
    out.push(
      windowRow(`${ID}e`, `D13e: second change (throughput ${TARGET_TPUT} -> ${SECOND_TPUT} MiB/s) after the accepted change`, stats, ["second_change"].filter(has), {
        after_change_post_s: s2.afterMainS,
        ...attemptMeas("second", s2.raw),
        reported_after_s: s2.watch ? (s2.watch.reportedAt ? secs(s2.watch.reportedAt - s2.raw.at) : "never") : "n/a (refused)",
      }),
    );
  }
  // every phase on its own, for the record
  for (const [i, name] of phaseNames.entries()) {
    out.push(windowRow(`${ID}-p${String(i).padStart(2, "0")}`, `D13 phase ${name}`, stats, [name], {
      phase_start_s: cont ? secs((cont.phases[i]?.startMs ?? 0) - cont.t0) : -1,
      host_paused_s: cont ? Math.round(cont.pauses.filter((p) => p.phase === name).reduce((a, p) => a + (p.toMs - p.fromMs), 0) / 1000) : 0,
    }));
  }
  if (cont) {
    const lines = cont.failureLog(300);
    out.push({
      id: `${ID}-failures`,
      title: "D13: every failed sample (seconds after sampling start, UTC, path, phase, latency, error)",
      status: "info",
      detail: `${lines.filter((l) => l.startsWith("+")).length} failed samples listed`,
      measurements: { failed_samples_listed: lines.filter((l) => l.startsWith("+")).length },
      evidence: lines.join("\n") || "no failed samples",
    });
  }
  return out;
}

export default mod;
