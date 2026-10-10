// One driver, one pool, CONC workers issuing `select 1` every INTERVAL_MS, one
// JSON line per attempt on stdout. The TCP fault is injected from OUTSIDE by
// the PC03 module (toxiproxy API), so this script never knows when it happens;
// every line carries wall-clock epoch milliseconds so the module can line the
// two clocks up.
//
// DRIVER: pg | pg-nohandler | postgresjs | prisma
// A failed attempt is retried ONCE after RETRY_DELAY_MS; both outcomes are logged, so a
// single run answers both "what does the app see with no retry" and "what does
// it see with retry-once".
const DRIVER = process.env.DRIVER ?? "pg";
const URLSTR = process.env.PROXY_URL ?? "";
const CONC = Number(process.env.CONC ?? 5);
const DURATION_MS = Number(process.env.DURATION_MS ?? 30000);
const INTERVAL_MS = Number(process.env.INTERVAL_MS ?? 200);
const QUERY_TIMEOUT_MS = Number(process.env.QUERY_TIMEOUT_MS ?? 10000);
// Wait before the single retry. 0 retries inside a fault window of the same length; the 2026-10-10 runs 1 and 2 used 0, run 3 used 300.
const RETRY_DELAY_MS = Number(process.env.RETRY_DELAY_MS ?? 0);

const u = new URL(URLSTR);
const conn = {
  host: u.hostname,
  port: Number(u.port),
  user: decodeURIComponent(u.username),
  password: decodeURIComponent(u.password),
  database: u.pathname.slice(1) || "postgres",
};

const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const errOf = (e) => ({
  code: String(e?.code ?? e?.errno ?? e?.name ?? "Error"),
  msg: String(e?.message ?? e).replace(/\s+/g, " ").slice(0, 160),
});

let run; // () => Promise<unknown>
let close = async () => {};

if (DRIVER === "pg" || DRIVER === "pg-nohandler") {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ ...conn, ssl: { rejectUnauthorized: false }, max: CONC, connectionTimeoutMillis: 10000 });
  if (DRIVER === "pg") pool.on("error", (e) => out({ e: "pool_error", t: Date.now(), ...errOf(e) }));
  run = () => pool.query("select 1");
  close = () => pool.end();
} else if (DRIVER === "postgresjs") {
  const { default: postgres } = await import("postgres");
  const sql = postgres({ ...conn, ssl: { rejectUnauthorized: false }, max: CONC, prepare: false, connect_timeout: 10 });
  run = () => sql`select 1`;
  close = () => sql.end({ timeout: 2 });
} else if (DRIVER === "prisma") {
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient({ datasources: { db: { url: URLSTR } }, log: [] });
  run = () => prisma.$queryRaw`select 1 as one`;
  close = () => prisma.$disconnect();
} else {
  throw new Error(`unknown DRIVER ${DRIVER}`);
}

const withTimeout = (p) =>
  Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error(`no answer in ${QUERY_TIMEOUT_MS} ms`), { code: "APP_TIMEOUT" })), QUERY_TIMEOUT_MS)),
  ]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function attempt() {
  const t0 = Date.now();
  try {
    await withTimeout(run());
    return { ok: true, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, ...errOf(e) };
  }
}

// Warm the pool: CONC concurrent queries force CONC connections open.
const warm = await Promise.all(Array.from({ length: CONC }, () => attempt()));
if (warm.some((w) => !w.ok)) {
  out({ e: "warmup_fail", t: Date.now(), first: warm.find((w) => !w.ok) });
  process.exit(3);
}
out({ e: "ready", t: Date.now(), driver: DRIVER, warm_ms: warm.map((w) => w.ms) });

const stopAt = Date.now() + DURATION_MS;
await Promise.all(
  Array.from({ length: CONC }, async (_, w) => {
    while (Date.now() < stopAt) {
      const t = Date.now();
      const a = await attempt();
      const rec = { e: "q", w, t, ok: a.ok, ms: a.ms };
      if (!a.ok) {
        rec.code = a.code;
        rec.msg = a.msg;
        if (RETRY_DELAY_MS) await sleep(RETRY_DELAY_MS);
        const r = await attempt();
        rec.retry_ok = r.ok;
        rec.retry_ms = r.ms;
        if (!r.ok) rec.retry_code = r.code;
      }
      out(rec);
      await sleep(INTERVAL_MS);
    }
  }),
);
out({ e: "done", t: Date.now() });
await Promise.race([close().catch(() => {}), sleep(3000)]);
process.exit(0);
