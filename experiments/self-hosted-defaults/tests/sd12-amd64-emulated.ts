/**
 * SD12 - the default services from their linux/amd64 images, EMULATED on an
 * arm64 Docker host. This is not a native amd64 measurement: every number here
 * includes the emulation layer of the engine (Rosetta or QEMU binfmt), so it
 * bounds nothing about a real amd64 machine except "the images start and
 * answer". It exists because the 2026-10-10 run measured arm64 only.
 *
 * Start the stack with `make amd64-layer pull up LAYERS=amd64` (images by amd64
 * manifest digest, so no tag on the engine moves; Studio and imgproxy stay
 * native by default), and once without the layer as the native comparison on
 * the same engine; `make pull` and `make up` append their wall times to the
 * stack's .timing file, which this module reads.
 *
 *   SD12a  engine architecture, and per service: image architecture, health,
 *          restart count; `uname -m` and version() in the database.
 *   SD12b  pull and `up --wait` wall time from .timing (the most recent pair).
 *   SD12c  one CPU-bound query in the database, three runs, server-side time.
 *
 * Read-only on the stack. Local vantage.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { cname, inspect, rigOf, sh, sql } from "../lib/rig";

const ID = "SD12";
const SERVICES = ["supabase-studio", "supabase-envoy", "supabase-auth", "supabase-rest", "realtime-dev.supabase-realtime", "supabase-storage", "supabase-imgproxy", "supabase-meta", "supabase-edge-functions", "supabase-db", "supabase-pooler"];

const mod: TestModule = {
  id: ID,
  title: "Default services from linux/amd64 images under emulation (or the native comparison run)",
  where: "local",
  requires: [],

  async run(ctx: Ctx): Promise<TestResult[]> {
    const r = rigOf(ctx);
    if ("skip" in r) return [{ id: ID, title: this.title, status: "skip", detail: r.skip }];
    const rig = r.rig;
    const engine = (await sh(["docker", "version", "--format", "{{.Server.Arch}} {{.Server.Version}}"])).out.trim();
    const driver = (await sh(["docker", "info", "--format", "{{.Driver}}"])).out.trim();
    const per: Record<string, string> = {};
    const arches = new Set<string>();
    let healthy = 0;
    for (const s of SERVICES) {
      const i = await inspect(s);
      if (!i) {
        per[s] = "absent";
        continue;
      }
      const arch = (await sh(["docker", "image", "inspect", "-f", "{{.Architecture}}", String(i.Image)])).out.trim();
      arches.add(arch);
      const h = String(i.State?.Health?.Status ?? i.State?.Status ?? "none");
      if (h === "healthy") healthy++;
      per[s] = `${arch}; ${h}; restarts ${i.RestartCount ?? "?"}`;
    }
    const uname = (await sh(["docker", "exec", cname("supabase-db"), "uname", "-m"])).out.trim();
    const version = (await sql("select version()"))[0]?.[0] ?? "";
    const nAmd = Object.values(per).filter((v) => v.startsWith("amd64;")).length;
    const mode = nAmd > 0 && /arm64|aarch64/.test(engine) ? `emulated amd64 (${nAmd} of ${SERVICES.length} services)` : `native ${[...arches].join(",")}`;
    const out: TestResult[] = [];
    out.push({
      id: `${ID}a`,
      title: `${mode}: engine ${engine}; every default service's image architecture, health and restart count`,
      status: healthy === SERVICES.length ? "pass" : "fail",
      detail: `mode ${mode}; engine ${engine}, storage driver ${driver}; healthy ${healthy} of ${SERVICES.length}; db uname -m ${uname}; ${version}; ${Object.entries(per).map(([k, v]) => `${k}: ${v}`).join(" | ")}`,
      measurements: { mode, engine, storage_driver: driver, amd64_services: nAmd, healthy_of_11: healthy, db_uname_m: uname, db_version: version.slice(0, 80), ...per },
    });

    const tf = join(rig.dir, ".timing");
    const lines = existsSync(tf) ? readFileSync(tf, "utf8").split("\n").filter(Boolean) : [];
    const last = (k: string) => [...lines].reverse().find((l) => l.startsWith(`${k}=`)) ?? "";
    const pull = last("pull_ms");
    const up = last("up_ms");
    const num = (l: string, k: string) => Number(l.match(new RegExp(`${k}=(\\d+)`))?.[1] ?? NaN);
    out.push({
      id: `${ID}b`,
      title: `${mode}: image pull and \`docker compose up -d --wait\` wall time (from .timing)`,
      status: up ? "info" : "skip",
      detail: `pull: ${pull || "not recorded"}; up: ${up || "not recorded"}`,
      measurements: { mode, pull_ms: num(pull, "pull_ms"), pull_exit: num(pull, "pull_exit"), up_ms: num(up, "up_ms"), up_exit: num(up, "up_exit"), layers: up.match(/layers=(\S*)/)?.[1] ?? "" },
    });

    const runs: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t = await sql("explain (analyze, format json) select sum(x::numeric * x::numeric) from generate_series(1, 3000000) x");
      const plan = JSON.parse(t.map((row) => row.join("\t")).join("\n"));
      runs.push(Math.round(Number(plan?.[0]?.["Execution Time"] ?? NaN)));
    }
    out.push({
      id: `${ID}c`,
      title: `${mode}: sum of squares over 3,000,000 numerics in the database, 3 runs, EXPLAIN ANALYZE execution time in ms`,
      status: "info",
      detail: `runs ms: ${runs.join(", ")}`,
      measurements: { mode, run1_ms: runs[0]!, run2_ms: runs[1]!, run3_ms: runs[2]! },
    });
    return out;
  },
};
export default mod;
