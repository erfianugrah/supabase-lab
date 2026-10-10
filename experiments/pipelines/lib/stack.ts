/**
 * The local half of the pipelines lab: a docker compose stack (DuckLake
 * catalog, S3-compatible store, the open-source ETL replicator), a rendered
 * replicator config, a long-lived DuckDB session that reads the destination
 * through the catalog, and a node-postgres handle on the source project.
 *
 * Lives under lib/ because the registry scans tests/ and would try to register
 * it as a module.
 *
 * Nothing here touches the managed Pipelines service. The replicator is the
 * open-source engine image the product docs say the managed service runs; the
 * lab pins its tag so every figure names the build it came from.
 */
import { $ } from "bun";
import { Client } from "pg";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export const EXP_DIR = resolve(import.meta.dir, "..");
export const RUN_DIR = `${EXP_DIR}/.run`;

/** Commit of github.com/supabase/etl whose public image the lab runs. */
export const REPLICATOR_TAG =
  process.env.PL_REPLICATOR_TAG ?? "3fc88dd52a553292836832907b9555d67b87d7e4";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;
export const stripAnsi = (s: string) => s.replace(ANSI, "");

// ---------------------------------------------------------------- run env

export interface RunEnv {
  PL_CATALOG_PASSWORD: string;
  PL_S3_KEY: string;
  PL_S3_SECRET: string;
}

const rand = () => crypto.randomUUID().replace(/-/g, "");

/** Throwaway local credentials, generated once into .run/env (gitignored). */
export async function runEnv(): Promise<RunEnv> {
  await mkdir(RUN_DIR, { recursive: true });
  const f = `${RUN_DIR}/env`;
  if (!existsSync(f)) {
    await writeFile(
      f,
      `PL_CATALOG_PASSWORD=${rand().slice(0, 24)}\nPL_S3_KEY=plkey${rand().slice(0, 8)}\nPL_S3_SECRET=${rand().slice(0, 24)}\n`,
    );
  }
  const kv: Record<string, string> = {};
  for (const l of (await readFile(f, "utf8")).split("\n")) {
    const i = l.indexOf("=");
    if (i > 0) kv[l.slice(0, i)] = l.slice(i + 1).trim();
  }
  const e = kv as unknown as RunEnv;
  return e;
}

// ---------------------------------------------------------------- compose

export interface Sh {
  code: number;
  out: string;
}

export async function compose(args: string[], appEnv: Record<string, string> = {}): Promise<Sh> {
  const e = await runEnv();
  const p = Bun.spawn(
    [
      "docker", "compose", "--env-file", `${RUN_DIR}/env`, "--profile", "replicator", ...args,
    ],
    {
      cwd: EXP_DIR,
      env: {
        ...process.env,
        PL_REPLICATOR_TAG: REPLICATOR_TAG,
        ...e,
        ...appEnv,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [o, er] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  return { code, out: stripAnsi(o + er) };
}

/** Catalog + object store + bucket, idempotent. */
export async function destinationUp(): Promise<void> {
  const up = await compose(["up", "-d", "catalog", "s3"]);
  if (up.code !== 0) throw new Error(`compose up failed: ${up.out.slice(-400)}`);
  // The object store accepts S3 calls only after its volume server registers;
  // the bucket job retries for two minutes.
  const b = await compose(["up", "bucket"]);
  if (b.code !== 0) throw new Error(`bucket job failed: ${b.out.slice(-400)}`);
}

export async function destinationDown(): Promise<void> {
  await compose(["down", "-v", "--remove-orphans"]);
}

// ---------------------------------------------------------------- source

export interface Src {
  ref: string;
  host: string;
  password: string;
}

export async function rootCert(src: Src): Promise<string> {
  const f = `${RUN_DIR}/root.crt`;
  if (existsSync(f)) return readFile(f, "utf8");
  // postgres STARTTLS is not in the system openssl (LibreSSL) - use a container.
  const r = await $`docker run --rm alpine/openssl s_client -starttls postgres -connect ${src.host}:5432 -showcerts`
    .quiet()
    .nothrow();
  const certs = r.stdout.toString().match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
  const root = certs.at(-1);
  if (!root) throw new Error("no certificate chain from source");
  await writeFile(f, `${root}\n`);
  return `${root}\n`;
}

/** node-postgres handle on the source, direct 5432, TLS verified against the chain root. */
export class SrcDb {
  private c: Client | null = null;
  constructor(
    private src: Src,
    private ca: string,
  ) {}

  private async conn(): Promise<Client> {
    if (this.c) return this.c;
    const c = new Client({
      host: this.src.host,
      port: 5432,
      user: "postgres",
      password: this.src.password,
      database: "postgres",
      ssl: { ca: this.ca },
      connectionTimeoutMillis: 20_000,
    });
    c.on("error", () => {
      this.c = null;
    });
    await c.connect();
    this.c = c;
    return c;
  }

  async q(sql: string, params: unknown[] = []): Promise<Record<string, string>[]> {
    for (let attempt = 0; ; attempt++) {
      try {
        const c = await this.conn();
        const res = await (params.length ? c.query(sql, params as unknown[]) : c.query(sql));
        // multi-statement text returns one result per statement; the last one with rows wins
        const r = Array.isArray(res) ? ([...res].reverse().find((x) => x.rows.length) ?? res.at(-1)!) : res;
        return (r.rows as Record<string, unknown>[]).map((row) =>
          Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v === null ? "" : String(v)])),
        );
      } catch (e) {
        const dead = this.c;
        this.c = null;
        (dead as unknown as { connection?: { stream?: { destroy(): void } } } | null)?.connection?.stream?.destroy();
        // the laptop's resolver intermittently fails to resolve the project host for 30 s or more
        if (attempt >= 9) throw e;
        await sleep(4000);
      }
    }
  }

  async scalar(sql: string): Promise<string> {
    const rows = await this.q(sql);
    const first = rows[0];
    return first ? (Object.values(first)[0] ?? "") : "";
  }

  async close(): Promise<void> {
    const c = this.c;
    this.c = null;
    if (!c) return;
    // `end()` never resolves on a connection the server already dropped, which hung a whole run.
    await Promise.race([c.end().catch(() => undefined), sleep(3000)]);
    (c as unknown as { connection?: { stream?: { destroy(): void } } }).connection?.stream?.destroy();
  }
}

// ---------------------------------------------------------------- replicator

export interface PipelineOpts {
  /** Tables (schema-qualified) in the publication. */
  tables: string[];
  /** Per-run data prefix and metadata schema, so a run never reuses another's DuckLake. */
  tag: string;
  /** batch.max_fill_ms; the engine default is 10000. */
  maxFillMs?: number;
  /** invalidated_slot_behavior: "error" (default) or "recreate". */
  invalidated?: "error" | "recreate";
  /** pipeline.id, default 1; also names the slots. */
  id?: number;
  /** Replicate as this role instead of postgres; the state store stays on postgres. */
  replUser?: { name: string; password: string };
}

/** Render .run/replicator/{base,dev}.yaml for one run. */
export async function renderConfig(src: Src, o: PipelineOpts): Promise<void> {
  const tmpl = await readFile(`${EXP_DIR}/config/base.template.yaml`, "utf8");
  const cert = (await rootCert(src))
    .trimEnd()
    .split("\n")
    .map((l) => `        ${l}`)
    .join("\n");
  const extra = [
    o.maxFillMs !== undefined ? `  batch:\n    max_fill_ms: ${o.maxFillMs}` : "",
    o.invalidated ? `  invalidated_slot_behavior: ${o.invalidated}` : "",
    o.replUser
      ? `  run_source_migrations: false
  store_pg_connection:
    host: "${src.host}"
    port: 5432
    name: "postgres"
    username: "postgres"
    tls:
      enabled: true
      trusted_root_certs: |
${cert}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  const body = tmpl
    .replace("__SRC_HOST__", src.host)
    .replace("__REPL_USER__", o.replUser?.name ?? "postgres")
    .replace("__ROOT_CERT__", cert)
    .replace("__PIPELINE_EXTRA__", extra)
    .replaceAll("__TAG__", o.tag)
    .replace("__PIPELINE_ID__", String(o.id ?? 1));
  await mkdir(`${RUN_DIR}/replicator`, { recursive: true });
  await writeFile(`${RUN_DIR}/replicator/base.yaml`, body);
  await writeFile(`${RUN_DIR}/replicator/dev.yaml`, "{}\n");
}

function pwEnv(src: Src, o?: PipelineOpts): Record<string, string> {
  return o?.replUser
    ? {
        APP_PIPELINE__PG_CONNECTION__PASSWORD: o.replUser.password,
        APP_PIPELINE__STORE_PG_CONNECTION__PASSWORD: src.password,
      }
    : { APP_PIPELINE__PG_CONNECTION__PASSWORD: src.password };
}

export const slotPrefix = "supabase_etl";

/**
 * Remove every trace of a previous pipeline from the source: stop the
 * replicator, drop its slots, drop the publication and the installed schema
 * and event trigger. Leaves the lab's own data tables alone.
 */
export async function resetSource(db: SrcDb, keepInstall = false): Promise<void> {
  await compose(["stop", "replicator"]);
  await compose(["rm", "-f", "replicator"]);
  // A slot can stay active for a moment after its client dies.
  for (let i = 0; i < 12; i++) {
    const active = await db.scalar(
      `select count(*) from pg_replication_slots where slot_name like '${slotPrefix}%' and active`,
    );
    if (active === "0") break;
    await sleep(2500);
  }
  await db.q(
    `select pg_drop_replication_slot(slot_name) from pg_replication_slots where slot_name like '${slotPrefix}%'`,
  );
  if (!keepInstall) {
    await db.q("drop event trigger if exists supabase_etl_ddl_message_trigger");
    await db.q("drop schema if exists etl cascade");
  }
  await db.q("drop publication if exists pl_pub");
}

let currentPipeline = 1;
let currentTagValue = "";
/** The destination tag (data prefix and metadata schema) of the pipeline started last. */
export const currentTag = () => currentTagValue;
/** A fresh tag per started pipeline: a destination is never reused across runs or modules. */
const stamp = Date.now().toString(36);
let tagSeq = 0;

export async function startPipeline(src: Src, db: SrcDb, o: PipelineOpts): Promise<number> {
  currentPipeline = o.id ?? 1;
  tagSeq += 1;
  o = { ...o, tag: `${o.tag}_${stamp}_${tagSeq}` };
  currentTagValue = o.tag;
  await renderConfig(src, o);
  await db.q(`create publication pl_pub for table ${o.tables.join(", ")}`);
  const t0 = Date.now();
  const r = await compose(["up", "-d", "--force-recreate", "replicator"], pwEnv(src, o));
  if (r.code !== 0) throw new Error(`replicator up failed: ${r.out.slice(-400)}`);
  return t0;
}

export async function stopReplicator(graceSeconds = 30): Promise<Sh> {
  return compose(["stop", "-t", String(graceSeconds), "replicator"]);
}

export async function killReplicator(): Promise<void> {
  const p = await $`docker kill pl-replicator-1`.quiet().nothrow();
  if (p.exitCode !== 0) throw new Error(`docker kill: ${p.stderr.toString()}`);
}

export async function startReplicator(src: Src, o?: PipelineOpts): Promise<Sh> {
  // Same container, same config: `start`, not `up`, so nothing is re-rendered.
  return compose(["start", "replicator"], pwEnv(src, o));
}

export async function replicatorLogs(sinceIso?: string): Promise<string> {
  const args = ["logs", "--no-color", "--no-log-prefix", ...(sinceIso ? ["--since", sinceIso] : []), "replicator"];
  return (await compose(args)).out;
}

export async function replicatorRunning(): Promise<boolean> {
  const p = await $`docker inspect -f {{.State.Running}} pl-replicator-1`.quiet().nothrow();
  return p.stdout.toString().trim() === "true";
}

/** Current replication state per table: `table -> state`. */
export async function tableStates(db: SrcDb, tables: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const t of tables) {
    const rows = await db.q(
      `select state::text as s from etl.replication_state where pipeline_id = ${currentPipeline} and table_id = '${t}'::regclass::oid and is_current`,
    );
    out[t] = rows[0]?.s ?? "none";
  }
  return out;
}

export async function waitTablesReady(
  db: SrcDb,
  tables: string[],
  maxMs: number,
  pollMs = 2000,
  accept: string[] = ["ready"],
): Promise<{ ms: number; states: Record<string, string>; ok: boolean }> {
  const t0 = Date.now();
  let states: Record<string, string> = {};
  while (Date.now() - t0 < maxMs) {
    try {
      states = await tableStates(db, tables);
    } catch {
      states = {};
    }
    if (tables.every((t) => accept.includes(states[t] ?? ""))) return { ms: Date.now() - t0, states, ok: true };
    if (Object.values(states).includes("errored")) return { ms: Date.now() - t0, states, ok: false };
    await sleep(pollMs);
  }
  return { ms: Date.now() - t0, states, ok: false };
}

// ---------------------------------------------------------------- DuckDB

/**
 * One long-lived DuckDB CLI attached read-only to the DuckLake. Starting a
 * process per query costs about a second of extension load and catalog attach,
 * which is larger than the lag being measured.
 */
export class Duck {
  private p: ReturnType<typeof Bun.spawn> | null = null;
  private buf = "";
  private errBuf = "";
  private waiters: Array<() => void> = [];
  private n = 0;

  constructor(
    private env: RunEnv,
    private tag: string,
  ) {}

  async start(): Promise<void> {
    this.p = Bun.spawn(["duckdb", "-csv", "-noheader"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const pump = async (s: ReadableStream<Uint8Array>, which: "out" | "err") => {
      const dec = new TextDecoder();
      for await (const chunk of s as unknown as AsyncIterable<Uint8Array>) {
        const t = dec.decode(chunk);
        if (which === "out") this.buf += t;
        else this.errBuf += t;
        for (const w of this.waiters.splice(0)) w();
      }
    };
    void pump(this.p.stdout as ReadableStream<Uint8Array>, "out");
    void pump(this.p.stderr as ReadableStream<Uint8Array>, "err");
    const e = this.env;
    await this.run(
      `LOAD ducklake; LOAD postgres; LOAD httpfs;
CREATE SECRET s3 (TYPE s3, KEY_ID '${e.PL_S3_KEY}', SECRET '${e.PL_S3_SECRET}', ENDPOINT 'localhost:59000', URL_STYLE 'path', USE_SSL false, REGION 'us-east-1');
ATTACH 'ducklake:postgres:dbname=ducklake_catalog host=localhost port=55432 user=etl password=${e.PL_CATALOG_PASSWORD}' AS lake (DATA_PATH 's3://ducklake/${this.tag}', METADATA_SCHEMA '${this.tag}', READ_ONLY);`,
    );
  }

  /** Run SQL, return the output lines before the sentinel plus any stderr. */
  async run(sql: string, timeoutMs = 60_000): Promise<{ lines: string[]; err: string }> {
    const p = this.p;
    if (!p) throw new Error("duck not started");
    const id = `PL_END_${++this.n}`;
    this.buf = "";
    this.errBuf = "";
    // biome-ignore lint: bun's FileSink
    const stdin = p.stdin as unknown as { write(s: string): number; flush(): void };
    stdin.write(`${sql.trim().replace(/;?$/, ";")}\nselect '${id}';\n`);
    stdin.flush();
    const t0 = Date.now();
    while (!this.buf.includes(id)) {
      if (Date.now() - t0 > timeoutMs) throw new Error(`duck timeout: ${sql.slice(0, 80)}`);
      await new Promise<void>((r) => {
        this.waiters.push(r);
        setTimeout(r, 200);
      });
    }
    const lines = this.buf.split("\n").filter((l) => l.length > 0 && !l.includes(id));
    return { lines, err: this.errBuf.trim() };
  }

  async scalar(sql: string): Promise<string> {
    const r = await this.run(sql);
    return r.lines.at(-1) ?? "";
  }

  async rows(sql: string): Promise<string[][]> {
    const r = await this.run(sql);
    return r.lines.map((l) => l.split(","));
  }

  close(): void {
    try {
      this.p?.kill();
    } catch {
      /* ignore */
    }
    this.p = null;
  }
}

// ---------------------------------------------------------------- slots

export interface SlotRow {
  slot_name: string;
  active: string;
  wal_status: string;
  safe_wal_size: string;
  retained_bytes: string;
  lag_bytes: string;
  invalidation_reason: string;
}

export async function slots(db: SrcDb): Promise<SlotRow[]> {
  return (await db.q(
    `select slot_name, active::text, coalesce(wal_status,'') as wal_status, coalesce(safe_wal_size::text,'') as safe_wal_size,
            coalesce((pg_current_wal_lsn() - restart_lsn)::bigint::text,'') as retained_bytes,
            coalesce((pg_current_wal_lsn() - confirmed_flush_lsn)::bigint::text,'') as lag_bytes,
            coalesce(invalidation_reason,'') as invalidation_reason
       from pg_replication_slots where slot_name like '${slotPrefix}%' order by slot_name`,
  )) as unknown as SlotRow[];
}

/** The main (apply) slot, which carries ongoing replication. */
export function applySlot(rows: SlotRow[]): SlotRow | undefined {
  return rows.find((r) => r.slot_name.startsWith(`${slotPrefix}_apply_`));
}

export const num = (s: string | undefined) => (s === undefined || s === "" ? NaN : Number(s));
