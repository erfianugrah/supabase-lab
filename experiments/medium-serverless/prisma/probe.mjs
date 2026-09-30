// Concurrent Prisma 6 workload against DATABASE_URL, one JSON line out.
//
// Each worker runs ROUNDS iterations of the four calls a tenant-scoped request makes:
// a filtered findMany, a count, a parameterised $queryRaw (Prisma sends these
// as prepared statements, which is where a transaction pooler without
// prepared-statement support breaks), and a create. Errors are bucketed by
// Prisma error code + the server's SQLSTATE/message prefix so the RUNLOG can
// quote them verbatim.
import { PrismaClient } from "@prisma/client";

const CONCURRENCY = Number(process.env.CONCURRENCY ?? 20);
const ROUNDS = Number(process.env.ROUNDS ?? 25);
const LABEL = process.env.LABEL ?? "unlabelled";

const prisma = new PrismaClient({ log: [] });
const lat = [];
const errors = new Map();
let ok = 0;

function bucket(e) {
  const code = e?.code ?? e?.constructor?.name ?? "Error";
  const meta = e?.meta?.code ? ` sqlstate=${e.meta.code}` : "";
  const msg = String(e?.meta?.message ?? e?.message ?? "").replace(/\s+/g, " ").slice(0, 140);
  const k = `${code}${meta}: ${msg}`;
  errors.set(k, (errors.get(k) ?? 0) + 1);
}

async function worker(w) {
  const tenant = `tenant-${w % 5}`;
  for (let i = 0; i < ROUNDS; i++) {
    const t0 = Date.now();
    try {
      await prisma.msRecord.findMany({ where: { tenantId: tenant }, take: 10 });
      await prisma.msRecord.count({ where: { tenantId: tenant } });
      await prisma.$queryRaw`select count(*)::int as n from ms_record where tenant_id = ${tenant} and id > ${i}`;
      await prisma.msRecord.create({ data: { tenantId: tenant, name: `w${w}-r${i}` } });
      ok++;
      lat.push(Date.now() - t0);
    } catch (e) {
      bucket(e);
    }
  }
}

const pct = (p) => {
  if (!lat.length) return null;
  const s = [...lat].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

const t0 = Date.now();
let connectError = null;
try {
  await prisma.$connect();
  await Promise.all(Array.from({ length: CONCURRENCY }, (_, w) => worker(w)));
} catch (e) {
  connectError = String(e?.message ?? e).replace(/\s+/g, " ").slice(0, 200);
} finally {
  await prisma.$disconnect().catch(() => {});
}

console.log(
  JSON.stringify({
    label: LABEL,
    concurrency: CONCURRENCY,
    rounds: ROUNDS,
    ok_iterations: ok,
    failed_iterations: CONCURRENCY * ROUNDS - ok,
    p50_ms: pct(50),
    p95_ms: pct(95),
    wall_ms: Date.now() - t0,
    connect_error: connectError,
    errors: [...errors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => ({ n, k })),
  }),
);
