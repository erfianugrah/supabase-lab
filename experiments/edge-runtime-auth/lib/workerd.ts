/**
 * Run the Worker bundle on workerd (the Cloudflare Workers runtime) inside a
 * container. This is NOT a Cloudflare deployment: it is the same runtime
 * binary, run locally, with the Worker's env bindings supplied from a
 * .dev.vars file. The bundle itself is built here with `bun build`.
 */
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { sleep } from "./er";

export const IMAGE = "er-wrangler:local";

export interface Workerd {
  baseUrl: string;
  container: string;
  stop(): Promise<void>;
  /** Container log tail, secrets are never printed by wrangler dev. */
  logTail(): Promise<string>;
}

export async function ensureImage(experimentDir: string): Promise<void> {
  const have = (await $`docker image inspect ${IMAGE}`.quiet().nothrow()).exitCode === 0;
  if (!have) await $`docker build -t ${IMAGE} ${join(experimentDir, "worker")}`.quiet();
}

export async function startWorkerd(experimentDir: string, vars: Record<string, string>, label: string): Promise<Workerd> {
  await ensureImage(experimentDir);
  const dir = await mkdtemp(join(tmpdir(), "er-worker-"));
  const out = join(dir, "worker.mjs");
  const built = await $`bun build ${join(experimentDir, "worker/index.ts")} --outfile ${out} --target browser --format esm`.quiet().nothrow();
  if (built.exitCode !== 0) {
    await rm(dir, { recursive: true, force: true });
    throw new Error(`bun build failed: ${built.stderr.toString().slice(0, 300)}`);
  }
  await writeFile(
    join(dir, "wrangler.toml"),
    `name = "er-worker"\nmain = "worker.mjs"\ncompatibility_date = "2026-09-01"\ncompatibility_flags = ["nodejs_compat"]\n`,
  );
  const devVars = join(dir, ".dev.vars");
  await writeFile(devVars, Object.entries(vars).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
  await chmod(devVars, 0o600);
  const container = `${label}-${Date.now()}`;
  const run = await $`docker run -d --name ${container} -p 127.0.0.1::8787 -v ${dir}:/app ${IMAGE}`.quiet().nothrow();
  if (run.exitCode !== 0) {
    await rm(dir, { recursive: true, force: true });
    throw new Error(`docker run failed: ${run.stderr.toString().slice(0, 300)}`);
  }
  const stop = async () => {
    await $`docker rm -f ${container}`.quiet().nothrow();
    await rm(dir, { recursive: true, force: true });
  };
  try {
    const portLine = (await $`docker port ${container} 8787/tcp`.quiet().text()).trim().split("\n")[0] ?? "";
    const port = portLine.split(":").pop();
    const baseUrl = `http://127.0.0.1:${port}`;
    const t0 = Date.now();
    while (Date.now() - t0 < 120_000) {
      const r = await fetch(`${baseUrl}/?mode=_runtime`, { signal: AbortSignal.timeout(5_000) }).catch(() => null);
      if (r?.status === 200) {
        return {
          baseUrl,
          container,
          stop,
          logTail: async () => (await $`docker logs --tail 20 ${container}`.quiet().nothrow()).stdout.toString() + (await $`docker logs --tail 20 ${container}`.quiet().nothrow()).stderr.toString(),
        };
      }
      await sleep(2_000);
    }
    const tail = (await $`docker logs --tail 30 ${container}`.quiet().nothrow()).stderr.toString();
    throw new Error(`workerd not ready in 120 s: ${tail.slice(0, 400)}`);
  } catch (e) {
    await stop();
    throw e;
  }
}
