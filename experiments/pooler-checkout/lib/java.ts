/**
 * Java side of PC08: pinned jars, pinned JDK image, one container per cell.
 *
 * There is no JRE on the orchestrator, so drivers/java/Probe.java runs in the
 * Eclipse Temurin image below through the JDK's single-file source launcher
 * (`java -cp '/w/lib/*' /w/Probe.java`). The jars come from Maven Central and
 * are checked against the sha256 pinned here (the sha1 Maven Central publishes
 * matched on 2026-11-04). Everything the probe needs, the password included,
 * reaches the container as `-e NAME` with the value in the docker client's
 * environment, never on argv (harness/src/argv-secrets.test.ts).
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { $ } from "bun";

/** eclipse-temurin 21.0.13_9-jdk-noble, multi-arch index digest read from Docker Hub on 2026-11-04. */
export const JDK_IMAGE = "eclipse-temurin:21.0.13_9-jdk-noble@sha256:114cabb73033ca4ce7ceec3deb62396bc1b716282bae051ed3c1d82e38fcab2d";

export const JARS: { path: string; sha256: string }[] = [
  { path: "org/postgresql/postgresql/42.7.14/postgresql-42.7.14.jar", sha256: "73914527305a40cce504b0d3d90b23caf565136912d607ae8ae7c5895512332c" },
  { path: "com/zaxxer/HikariCP/7.1.0/HikariCP-7.1.0.jar", sha256: "2be45c641b841e81df87292e181f2c203500c5f0e9a1676f135927387f3cf40b" },
  { path: "org/slf4j/slf4j-api/2.0.17/slf4j-api-2.0.17.jar", sha256: "7b751d952061954d5abfed7181c1f645d336091b679891591d63329c622eb832" },
  { path: "org/slf4j/slf4j-simple/2.0.17/slf4j-simple-2.0.17.jar", sha256: "ddfea59ac074c6d3e24ac2c38622d2d963895e17f70b38ed4bdae4d780be6964" },
];
const CENTRAL = "https://repo1.maven.org/maven2";

export const JAVA_DIR = process.env.PVLAB_PC_JAVA_DIR ?? resolve(process.cwd(), "drivers/java");

const sha256 = (b: ArrayBuffer | Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex");

/** Download missing jars into drivers/java/lib and verify every jar's sha256. Returns an error string or "". */
export async function ensureJars(dir = JAVA_DIR): Promise<string> {
  const lib = resolve(dir, "lib");
  mkdirSync(lib, { recursive: true });
  for (const j of JARS) {
    const file = resolve(lib, j.path.split("/").at(-1)!);
    if (!existsSync(file)) {
      const r = await fetch(`${CENTRAL}/${j.path}`);
      if (!r.ok) return `download ${j.path}: HTTP ${r.status}`;
      writeFileSync(file, new Uint8Array(await r.arrayBuffer()));
    }
    const got = sha256(await Bun.file(file).arrayBuffer());
    if (got !== j.sha256) return `${j.path}: sha256 ${got} does not match the pin ${j.sha256}`;
  }
  return "";
}

export async function ensureImage(): Promise<string> {
  const have = await $`docker image inspect ${JDK_IMAGE}`.quiet().nothrow();
  if (have.exitCode === 0) return "";
  const pull = await $`docker pull -q ${JDK_IMAGE}`.quiet().nothrow();
  return pull.exitCode === 0 ? "" : `docker pull: ${pull.stderr.toString().slice(-200)}`;
}

export interface JavaRun {
  lines: Record<string, unknown>[];
  summary?: Record<string, unknown>;
  config?: Record<string, unknown>;
  exitCode: number;
  timedOut: boolean;
  stderr: string;
  /** host wall clock minus monotonic clock across the run: > 2000 means the host slept */
  hostDriftMs: number;
}

/**
 * Run the probe once. `env` holds every setting (PGHOST, PGPASSWORD, MODE, ...);
 * each key becomes `-e KEY` on argv and its value travels in the docker client's env.
 */
export async function runJava(
  name: string,
  env: Record<string, string>,
  opts: { timeoutMs: number; network?: string; onLine?: (o: Record<string, unknown>) => void; rawDir?: string },
): Promise<JavaRun> {
  const w0 = Date.now();
  const m0 = performance.now();
  const eFlags = Object.keys(env).flatMap((k) => ["-e", k]);
  const argv = [
    "docker",
    "run",
    "--rm",
    "--name",
    name,
    ...(opts.network ? ["--network", opts.network] : []),
    ...eFlags,
    "-v",
    `${JAVA_DIR}:/w:ro`,
    JDK_IMAGE,
    "java",
    "-Dorg.slf4j.simpleLogger.defaultLogLevel=warn",
    "-Dorg.slf4j.simpleLogger.showDateTime=true",
    "-cp",
    "/w/lib/*",
    "/w/Probe.java",
  ];
  const proc = Bun.spawn(argv, { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const killer = setTimeout(() => {
    timedOut = true;
    // SIGTERM first: the probe prints its summary (terminated_by_signal) from a shutdown hook.
    void $`docker stop -t 15 ${name}`.quiet().nothrow();
  }, opts.timeoutMs);
  const lines: Record<string, unknown>[] = [];
  let buf = "";
  const errP = new Response(proc.stderr).text();
  const dec = new TextDecoder();
  for await (const chunk of proc.stdout) {
    buf += dec.decode(chunk);
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.startsWith("{")) continue;
      try {
        const o = JSON.parse(line) as Record<string, unknown>;
        lines.push(o);
        opts.onLine?.(o);
      } catch {
        // partial or foreign line
      }
    }
  }
  const exitCode = await proc.exited;
  clearTimeout(killer);
  const stderr = await errP;
  if (opts.rawDir) {
    mkdirSync(opts.rawDir, { recursive: true });
    writeFileSync(resolve(opts.rawDir, `${name}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    writeFileSync(resolve(opts.rawDir, `${name}.stderr.txt`), stderr.slice(0, 2_000_000));
  }
  return {
    lines,
    summary: lines.find((l) => l.e === "summary"),
    config: lines.find((l) => l.e === "config"),
    exitCode,
    timedOut,
    stderr,
    hostDriftMs: Math.round(Date.now() - w0 - (performance.now() - m0)),
  };
}

// ---------- pure reductions (unit tested in java.test.ts)

export interface OpStat {
  ok: number;
  fail: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  max_ms: number;
}
export interface ErrRow {
  op: string;
  class: string;
  sqlstate: string;
  count: number;
  first_at_ms: number;
  elapsed_min_ms: number;
  elapsed_max_ms: number;
  example: string;
}
export interface PoolRow {
  instance: number;
  init_error: string;
  fill_ms: number;
  total_at_start: number;
  connect_attempts: number;
  connect_failures: number;
  connect_p50_ms: number;
  connect_max_ms: number;
  hikari_timeouts: number;
  total_end?: number;
}

const rnd = (x: number) => Math.round(x);

/** One line per error kind, most frequent first: `count x op Class [state] (min-max ms): example`. */
export function errorLines(errors: ErrRow[], max = 6): string {
  return errors
    .slice(0, max)
    .map((e) => `${e.count}x ${e.op} ${e.class} [${e.sqlstate}] (${rnd(e.elapsed_min_ms)}-${rnd(e.elapsed_max_ms)} ms): ${e.example.slice(0, 220)}`)
    .join(" | ");
}

/** Flatten a probe summary into report measurements (numbers and short strings only). */
export function flatten(s: Record<string, unknown>): Record<string, number | string> {
  const ops = (s.ops ?? {}) as Record<string, OpStat>;
  const pools = (s.pools ?? []) as PoolRow[];
  const errors = (s.errors ?? []) as ErrRow[];
  const out: Record<string, number | string> = {
    wall_ms: Number(s.wall_ms ?? -1),
    wall_cap_hit: s.wall_cap_hit ? "yes" : "no",
    threads: Number(s.threads ?? 0),
    terminated_by_signal: s.terminated_by_signal ? "yes" : "no",
    threads_alive_at_end: Number(s.threads_alive_at_end ?? 0),
    threads_alive: ((s.threads_alive ?? []) as { op: string; in_op_ms: number }[]).map((t) => `${t.op}:${t.in_op_ms}ms`).join(" ") || "none",
  };
  for (const [name, o] of Object.entries(ops)) {
    out[`${name}_ok`] = o.ok;
    out[`${name}_fail`] = o.fail;
    if (o.ok > 0) {
      out[`${name}_p50_ms`] = o.p50_ms;
      out[`${name}_p95_ms`] = o.p95_ms;
      out[`${name}_p99_ms`] = o.p99_ms;
      out[`${name}_max_ms`] = o.max_ms;
    }
  }
  if ("throughput_iter_per_s" in s && ops.iteration) out.throughput_iter_per_s = Number(s.throughput_iter_per_s);
  if (ops.iteration || ops.select) {
    out.wrong_results = Number(s.wrong_results ?? 0);
    out.wrong_examples = ((s.wrong_examples ?? []) as string[]).slice(0, 6).join(" | ").slice(0, 900) || "none";
    out.backend_pid_samples = Number(s.backend_pid_samples ?? 0);
    out.backend_switches = Number(s.backend_switches ?? 0);
    out.distinct_backend_pids = Number(s.distinct_backend_pids ?? 0);
  }
  out.first_error_ms = Number(s.first_error_ms ?? -1);
  out.error_kinds = Number(s.error_kinds ?? 0);
  out.errors_top = errorLines(errors) || "none";
  out.connect_attempts = pools.reduce((a, p) => a + p.connect_attempts, 0);
  out.connect_failures = pools.reduce((a, p) => a + p.connect_failures, 0);
  out.hikari_timeouts = pools.reduce((a, p) => a + p.hikari_timeouts, 0);
  out.pool_init_errors = pools.filter((p) => p.init_error).length;
  out.pool_totals_at_start = pools.map((p) => p.total_at_start).join("/");
  return out;
}

/** Hikari/pgjdbc WARN and ERROR lines on stderr, grouped with digits folded: top `max` as `count x text`. */
export function stderrKinds(stderr: string, max = 4): { warn_lines: number; top: string } {
  const counts = new Map<string, number>();
  let n = 0;
  for (const line of stderr.split("\n")) {
    const m = /\b(WARN|ERROR)\b\s+(.*)$/.exec(line);
    if (!m) continue;
    n++;
    const k = `${m[1]} ${m[2]!.replace(/\d+/g, "N").slice(0, 160)}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([k, c]) => `${c}x ${k}`)
    .join(" | ");
  return { warn_lines: n, top: top || "none" };
}
