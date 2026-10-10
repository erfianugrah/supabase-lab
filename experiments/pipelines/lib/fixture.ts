/**
 * The shared source project and local destination for every PL module.
 *
 * One Pro-org project (Micro compute, eu-central-1, IPv4 add-on) serves all
 * modules, created by whichever module runs first and deleted by PL99, so a
 * full run pays for one project, not eight. State lives in .run/fixture.json
 * (gitignored) so a later invocation, or a crashed run, can find the project
 * and tear it down.
 *
 * eu-central-1 because the managed service documents that its pipelines run
 * there; the source then sits where the managed pipeline would.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type { Ctx, TestModule } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import { $ } from "bun";
import {
  Duck,
  currentTag,
  RUN_DIR,
  SrcDb,
  destinationDown,
  destinationUp,
  resetSource,
  startPipeline,
  type PipelineOpts,
  rootCert,
  runEnv,
  sleep,
  type Src,
} from "./stack.js";

export const NAME_PREFIX = "pl-";
const STATE = `${RUN_DIR}/fixture.json`;

export interface FixtureState extends Src {
  name: string;
  createdAtMs: number;
  /** Seconds the IPv4 add-on took to resolve; recorded for PL02. */
  ipv4Seconds?: number;
  createStatus?: number;
}

export interface Fixture {
  state: FixtureState;
  db: SrcDb;
  /** True when this call created the project (vs reusing a previous run's). */
  created: boolean;
}

const cache: { f?: Fixture } = {};

async function hasA(host: string): Promise<boolean> {
  const out = (await $`dig +short ${host} A`.quiet().nothrow()).stdout.toString();
  return out.split("\n").some((l) => /^\d+\.\d+\.\d+\.\d+$/.test(l.trim()));
}

export async function waitActive(ctx: Ctx, ref: string, maxMs = 600_000): Promise<string> {
  const t0 = Date.now();
  let status = "";
  while (Date.now() - t0 < maxMs) {
    const r = await mgmt(ctx, "GET", `/projects/${ref}`);
    status = (r.json as { status?: string } | undefined)?.status ?? `http-${r.status}`;
    if (status === "ACTIVE_HEALTHY") return status;
    await sleep(10_000);
  }
  return status;
}

export async function ensureFixture(ctx: Ctx): Promise<Fixture> {
  if (cache.f) return cache.f;
  await mkdir(RUN_DIR, { recursive: true });
  let state: FixtureState;
  let created = false;
  if (existsSync(STATE)) {
    state = JSON.parse(await readFile(STATE, "utf8")) as FixtureState;
  } else {
    const org = ctx.orgs.pro;
    if (!org) throw new Error("PVLAB_ORG_PRO not set (ctx.orgs.pro)");
    const password = `${crypto.randomUUID().replace(/-/g, "")}Aa1!`;
    const name = `${NAME_PREFIX}pl-${Date.now()}`;
    const t0 = Date.now();
    const c = await mgmt(ctx, "POST", "/projects", {
      organization_slug: org,
      name,
      db_pass: password,
      region: "eu-central-1",
      desired_instance_size: "micro",
    });
    const ref = (c.json as { ref?: string; id?: string } | undefined)?.ref ?? "";
    if (c.status !== 201 || !ref) throw new Error(`create failed: HTTP ${c.status} ${c.text.slice(0, 200)}`);
    state = { ref, host: `db.${ref}.supabase.co`, password, name, createdAtMs: t0, createStatus: c.status };
    await writeFile(STATE, JSON.stringify(state));
    created = true;
    const st = await waitActive(ctx, ref);
    if (st !== "ACTIVE_HEALTHY") throw new Error(`project not healthy: ${st}`);
    // Direct 5432 is IPv6-only without the add-on, and a docker container has no IPv6.
    const a = await mgmt(ctx, "PATCH", `/projects/${ref}/billing/addons`, {
      addon_type: "ipv4",
      addon_variant: "ipv4_default",
    });
    if (a.status >= 300) throw new Error(`ipv4 addon: HTTP ${a.status} ${a.text.slice(0, 200)}`);
    const t1 = Date.now();
    while (!(await hasA(state.host))) {
      if (Date.now() - t1 > 900_000) throw new Error("IPv4 record never appeared");
      await sleep(10_000);
    }
    state.ipv4Seconds = Math.round((Date.now() - t1) / 1000);
    await writeFile(STATE, JSON.stringify(state));
  }
  await runEnv();
  await rootCert(state);
  await destinationUp();
  const db = new SrcDb(state, await rootCert(state));
  cache.f = { state, db, created };
  return cache.f;
}

/** Delete the project and the local stack. Safe to call when nothing exists. */
export async function teardownFixture(ctx: Ctx): Promise<{ deleted: boolean; status: number; ref: string }> {
  let ref = "";
  let status = 0;
  let deleted = false;
  if (cache.f) await cache.f.db.close();
  if (existsSync(STATE)) {
    const s = JSON.parse(await readFile(STATE, "utf8")) as FixtureState;
    ref = s.ref;
    if (!s.name.startsWith(NAME_PREFIX)) throw new Error(`refusing to delete ${s.name}: not a ${NAME_PREFIX} project`);
    const r = await mgmt(ctx, "DELETE", `/projects/${s.ref}`);
    status = r.status;
    deleted = r.status < 300 || r.status === 404;
    if (deleted) await rm(STATE);
  }
  // Without docker there is no local stack to take down; the project delete above still ran.
  if (Bun.which("docker")) await destinationDown();
  cache.f = undefined;
  return { deleted, status, ref };
}

/** Drop any previous pipeline from the source, then render, publish and start a fresh one. */
export async function beginPipeline(fx: Fixture, o: PipelineOpts, keepInstall = false): Promise<number> {
  await resetSource(fx.db, keepInstall);
  return startPipeline(fx.state, fx.db, o);
}

/** A DuckDB session on the destination of the pipeline started last. */
export async function openDuck(): Promise<Duck> {
  const d = new Duck(await runEnv(), currentTag());
  await d.start();
  return d;
}

/**
 * Why this module cannot run here, or undefined when it can. The first module
 * to run creates the project, so a missing Pro org matters only while no
 * .run/fixture.json exists; `dig` is used only by that creation step.
 */
export function missingPrerequisite(ctx: Ctx, tools: string[]): string | undefined {
  const missing = tools.filter((t) => !Bun.which(t));
  if (missing.length) return `required tool not on PATH: ${missing.join(", ")}`;
  if (!existsSync(STATE)) {
    if (!ctx.orgs.pro) return "PVLAB_ORG_PRO not set (ctx.orgs.pro) and no .run/fixture.json to reuse";
    if (!Bun.which("dig")) return "required tool not on PATH: dig (needed to see the IPv4 add-on's DNS record)";
  }
  return undefined;
}

/**
 * The harness process does not exit while a socket is open, and every module
 * shares the cached source connection; left open, one finished run kept ~8
 * connections on a 60-connection Micro until the process was killed (six
 * leftover processes exhausted the project). Closing after each module is
 * cheap because the handle reconnects on next use.
 *
 * Also the shared preflight: a module whose prerequisites are absent returns
 * one skip result with the reason instead of throwing. `tools` defaults to
 * docker and duckdb; PL08 does not drive duckdb.
 */
export function withCleanup(mod: TestModule, tools: string[] = ["docker", "duckdb"]): TestModule {
  return {
    ...mod,
    async run(ctx: Ctx) {
      const why = missingPrerequisite(ctx, tools);
      if (why) return [{ id: mod.id, title: mod.title, status: "skip", detail: why }];
      try {
        return await mod.run(ctx);
      } finally {
        await cache.f?.db.close();
      }
    },
  };
}
