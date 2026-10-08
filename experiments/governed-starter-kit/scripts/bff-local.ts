/**
 * Local end-to-end check of the BFF demo (fanout-api + upstream-mock) on a
 * throwaway local Supabase stack in Docker. Nothing hosted is touched.
 *
 *   bun scripts/bff-local.ts           start, check, stop     (make bff-local)
 *   KEEP=1 bun scripts/bff-local.ts    leave the stack running afterwards
 *
 * Env: BFF_LOCAL_DIR (default $TMPDIR/kit-bff-local), BFF_REPS (default 5).
 *
 * What it does (stack helpers in lib/local-stack.ts): `supabase init` in
 * BFF_LOCAL_DIR with ports shifted to 5442x (so it does not collide with a
 * stack on the default 5432x or with agent-local on 5452x), a minimal
 * `supabase start` (db, auth, rest, kong), sql/00-baseline.sql and
 * sql/50-fanout.sql through psql, two users through the Auth admin API,
 * then `supabase functions serve` with a generated upstream key, and the
 * checks in lib/bff-checks.ts (the same ones K05 runs against a deployed
 * project) as those users. Results go to evidence/bff-local-<ts>.json
 * (gitignored); no key, password or token is printed.
 *
 * Inside Docker the functions reach the mock through the gateway at
 * http://kong:8000, so UPSTREAM_BASE_URL differs from a hosted deploy
 * (https://<ref>.supabase.co/functions/v1/upstream-mock) and nothing else does.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BffCheck, bffChecks, type Call, callFanout, type Session } from "../lib/bff-checks";
import { applySql, createUser, KIT, prepareDir, randomHex, serveFunctions, type StackSpec, startStack, type Status, stopStack } from "../lib/local-stack";

const REPS = Number(process.env.BFF_REPS ?? 5);
const TIMEOUT_MS = 800;
const SPEC: StackSpec = {
  dir: process.env.BFF_LOCAL_DIR ?? join(tmpdir(), "kit-bff-local"),
  projectId: "kit-bff-local",
  portBlock: "544",
  functions: ["fanout-api", "upstream-mock"],
  extraConfig: "[functions.upstream-mock]\nverify_jwt = false\n",
};

function writeEnv(upstreamKey: string): string {
  const envFile = join(SPEC.dir, "functions.env");
  writeFileSync(
    envFile,
    ["UPSTREAM_BASE_URL=http://kong:8000/functions/v1/upstream-mock", `UPSTREAM_API_KEY=${upstreamKey}`, `FANOUT_UPSTREAM_TIMEOUT_MS=${TIMEOUT_MS}`, ""].join("\n"),
    { mode: 0o600 },
  );
  return envFile;
}

async function waitReady(st: Status, upstreamKey: string, a: Session): Promise<{ mock_ready_ms: number; first_call: Call }> {
  const t0 = Date.now();
  const target = { functionsUrl: `${st.API_URL}/functions/v1`, publishableKey: st.PUBLISHABLE_KEY };
  for (;;) {
    if (Date.now() - t0 > 180_000) throw new Error(`functions not ready after 180 s - see ${join(SPEC.dir, "functions-serve.log")}`);
    try {
      const r = await fetch(`${st.API_URL}/functions/v1/upstream-mock/profile?latency_ms=0`, { headers: { "x-api-key": upstreamKey, "x-user-id": a.id } });
      await r.text();
      if (r.status === 200) break;
    } catch {
      // gateway not routing to the runtime yet
    }
    await Bun.sleep(1000);
  }
  const mockMs = Date.now() - t0;
  // The first fanout-api call boots its isolate and fetches its npm imports.
  for (;;) {
    const c = await callFanout(target, a.jwt, "refresh=1");
    if (c.status === 200 || Date.now() - t0 > 180_000) return { mock_ready_ms: mockMs, first_call: c };
    await Bun.sleep(1000);
  }
}

const startedAt = new Date();
const upstreamKey = randomHex(24);
let serve: Bun.Subprocess | undefined;
let checks: BffCheck[] = [];
let warmup: { mock_ready_ms: number; first_call_http: number; first_call_ms: number } | null = null;
let exitCode = 0;
try {
  prepareDir(SPEC);
  const t0 = Date.now();
  const st = await startStack(SPEC);
  console.log(`local stack up in ${Date.now() - t0} ms at ${st.API_URL} (workdir ${SPEC.dir})`);
  await applySql(st, ["sql/00-baseline.sql", "sql/50-fanout.sql"]);
  const a = await createUser(st, "bff-a@example.com", randomHex(16));
  const b = await createUser(st, "bff-b@example.com", randomHex(16));
  serve = serveFunctions(SPEC, writeEnv(upstreamKey));
  const ready = await waitReady(st, upstreamKey, a);
  warmup = { mock_ready_ms: ready.mock_ready_ms, first_call_http: ready.first_call.status, first_call_ms: ready.first_call.wall_ms };
  console.log(`functions ready: mock after ${ready.mock_ready_ms} ms; first fanout-api call http ${ready.first_call.status} in ${ready.first_call.wall_ms} ms`);
  checks = await bffChecks({ functionsUrl: `${st.API_URL}/functions/v1`, restUrl: `${st.API_URL}/rest/v1`, publishableKey: st.PUBLISHABLE_KEY, a, b, reps: REPS });
  for (const c of checks) {
    console.log(`${c.pass ? "PASS" : "FAIL"}  L${String(c.n).padStart(2, "0")}  ${c.title}\n      ${c.detail}`);
    if (c.measurements) console.log(`      ${JSON.stringify(c.measurements)}`);
  }
} catch (e) {
  console.error(`ABORTED: ${(e as Error).message}`);
  exitCode = 2;
} finally {
  serve?.kill();
  await serve?.exited;
  if (!process.env.KEEP) {
    await stopStack(SPEC);
    console.log("local stack stopped (supabase stop --no-backup)");
  }
}

const failed = checks.filter((c) => !c.pass).length;
if (failed && !exitCode) exitCode = 1;
mkdirSync(join(KIT, "evidence"), { recursive: true });
const out = join(KIT, "evidence", `bff-local-${startedAt.toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(out, JSON.stringify({ started_at: startedAt.toISOString(), reps: REPS, timeout_ms: TIMEOUT_MS, warmup, checks }, null, 2));
console.log(`\n${checks.length - failed} pass, ${failed} fail${exitCode === 2 ? " (aborted)" : ""} -> ${out}`);
process.exit(exitCode);
