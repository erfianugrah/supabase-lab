/**
 * Deploy the Worker bundle to Cloudflare Workers (workers.dev) and tear it
 * down again. Opt-in: the module only calls this when CLOUDFLARE_WORKERS_TOKEN
 * (a token with Workers Scripts edit) and CLOUDFLARE_ACCOUNT_ID are in the
 * environment, and `wrangler` is on PATH. The token is handed to wrangler as
 * CLOUDFLARE_API_TOKEN for the child process only and is never written to a
 * file or printed; the Worker's bindings (keys, JWKS) go in as secrets through
 * `wrangler secret bulk` on stdin, not into wrangler.toml.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { sleep } from "./er";

const API = "https://api.cloudflare.com/client/v4";

export interface CfAuth {
  token: string;
  account: string;
}

export interface CfWorker {
  name: string;
  baseUrl: string;
  /** Seconds from the start of the deploy command to the first 200 from the workers.dev URL that reports the secret binding present. */
  readyAfterS: number;
  stop(): Promise<{ deleteStatus: number }>;
}

export function cfAuthFromEnv(): CfAuth | undefined {
  const token = process.env.CLOUDFLARE_WORKERS_TOKEN;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  return token && account ? { token, account } : undefined;
}

export async function wranglerAvailable(): Promise<boolean> {
  try {
    return (await $`wrangler --version`.quiet().nothrow()).exitCode === 0;
  } catch {
    return false;
  }
}

async function cf(auth: CfAuth, method: string, path: string): Promise<{ status: number; json: any }> {
  const r = await fetch(`${API}${path}`, { method, headers: { Authorization: `Bearer ${auth.token}` }, signal: AbortSignal.timeout(30_000) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

/** Names of the Worker scripts on the account (used to prove a teardown). */
export async function listScripts(auth: CfAuth): Promise<string[]> {
  const r = await cf(auth, "GET", `/accounts/${auth.account}/workers/scripts`);
  return ((r.json?.result ?? []) as { id: string }[]).map((s) => s.id);
}

export async function deleteScript(auth: CfAuth, name: string): Promise<number> {
  let st = 0;
  for (let i = 0; i < 4; i++) {
    st = (await cf(auth, "DELETE", `/accounts/${auth.account}/workers/scripts/${name}?force=true`).catch(() => ({ status: 0 }))).status;
    if ((st >= 200 && st < 300) || st === 404) return st;
    await sleep(5_000);
  }
  return st;
}

export async function deployWorker(experimentDir: string, auth: CfAuth, vars: Record<string, string>, name: string): Promise<CfWorker> {
  const dir = await mkdtemp(join(tmpdir(), "er-cf-"));
  const env = { ...process.env, CLOUDFLARE_API_TOKEN: auth.token, CLOUDFLARE_ACCOUNT_ID: auth.account, WRANGLER_SEND_METRICS: "false", CI: "1" } as Record<string, string>;
  let deployed = false;
  const stop = async () => {
    const deleteStatus = deployed ? await deleteScript(auth, name) : 404;
    await rm(dir, { recursive: true, force: true });
    return { deleteStatus };
  };
  try {
    const built = await $`bun build ${join(experimentDir, "worker/index.ts")} --outfile ${join(dir, "worker.mjs")} --target browser --format esm`.quiet().nothrow();
    if (built.exitCode !== 0) throw new Error(`bun build failed: ${built.stderr.toString().slice(0, 300)}`);
    await writeFile(join(dir, "wrangler.toml"), `name = "${name}"\nmain = "worker.mjs"\ncompatibility_date = "2026-09-01"\ncompatibility_flags = ["nodejs_compat"]\nworkers_dev = true\n`);
    const t0 = Date.now();
    deployed = true; // from here a partial deploy must still be deleted
    const dep = await $`wrangler deploy`.cwd(dir).env(env).quiet().nothrow();
    if (dep.exitCode !== 0) throw new Error(`wrangler deploy failed: ${(dep.stderr.toString() + dep.stdout.toString()).slice(0, 400)}`);
    const sec = await $`wrangler secret bulk < ${new Response(JSON.stringify(vars))}`.cwd(dir).env(env).quiet().nothrow();
    if (sec.exitCode !== 0) throw new Error(`wrangler secret bulk failed: ${(sec.stderr.toString() + sec.stdout.toString()).slice(0, 400)}`);
    const sub = (await cf(auth, "GET", `/accounts/${auth.account}/workers/subdomain`)).json?.result?.subdomain as string | undefined;
    if (!sub) throw new Error("workers.dev subdomain not found for the account");
    const baseUrl = `https://${name}.${sub}.workers.dev`;
    while (Date.now() - t0 < 180_000) {
      const r = await fetch(`${baseUrl}/?mode=_runtime`, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
      if (r?.status === 200 && (await r.text()).includes(`"binding_has_url":true`)) return { name, baseUrl, readyAfterS: Math.round((Date.now() - t0) / 1000), stop };
      await sleep(3_000);
    }
    throw new Error("deployed Worker did not answer 200 within 180 s");
  } catch (e) {
    await stop();
    throw e;
  }
}
