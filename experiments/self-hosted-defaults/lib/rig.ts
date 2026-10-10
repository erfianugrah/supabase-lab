/**
 * The local self-hosted rig: supabase/supabase `docker/` copied to work/stack
 * by `make stack` and started with `make up`. Everything here talks to that
 * stack through its published gateway port, `docker exec`, or `docker compose`
 * - nothing reaches a managed project.
 *
 * Secrets. `make stack` runs the upstream key scripts, which write the
 * database password, the legacy HS256 secret, the legacy API keys, the
 * asymmetric key pair, the two opaque API keys and the dashboard password into
 * work/stack/.env (gitignored). Tests read them from there, use them in
 * requests, and never put them in a result: every string that reaches
 * `evidence` or `detail` goes through `scrub`, which replaces any .env value
 * that looks like a secret with its key name.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "../../../harness/src/types";

export interface Rig {
  dir: string;
  gw: string;
  env: Record<string, string>;
}

const SECRET_KEY_RE = /(PASSWORD|SECRET|KEY|TOKEN|JWT|JWKS)/i;

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    let v = m[2] ?? "";
    if (/^".*"$/.test(v) || /^'.*'$/.test(v)) v = v.slice(1, -1);
    out[m[1]!] = v;
  }
  return out;
}

/** The rig described by the run's endpoints, or null with a reason. */
export function rigOf(ctx: Ctx): { rig: Rig } | { skip: string } {
  const dir = ctx.endpoints["stack_dir"] ?? "";
  const gw = ctx.endpoints["gw"] ?? "";
  if (!dir || !gw) return { skip: "PVLAB_ENDPOINT_STACK_DIR / PVLAB_ENDPOINT_GW not set (run `make stack up`, then `make probe`)" };
  if (!existsSync(join(dir, ".env"))) return { skip: `no .env in ${dir} (run \`make stack\`)` };
  if (!Bun.which("docker")) return { skip: "docker binary not found on PATH (the modules call docker compose, ps, inspect and exec)" };
  return { rig: { dir, gw, env: parseEnv(readFileSync(join(dir, ".env"), "utf8")) } };
}

/** Replace every secret-looking .env value in `text` with `<KEY>`. */
export function scrub(rig: Rig, text: string): string {
  let out = text;
  const pairs = Object.entries(rig.env)
    .filter(([k, v]) => SECRET_KEY_RE.test(k) && v.length >= 8)
    .sort((a, b) => b[1].length - a[1].length);
  for (const [k, v] of pairs) out = out.split(v).join(`<${k}>`);
  return out;
}

/** Re-read .env after a step appended to it. */
export function reload(rig: Rig): void {
  rig.env = parseEnv(readFileSync(join(rig.dir, ".env"), "utf8"));
}

export function appendEnv(rig: Rig, key: string, value: string): void {
  // Replace an existing line so a re-run does not stack duplicates.
  const f = join(rig.dir, ".env");
  const kept = readFileSync(f, "utf8").split("\n").filter((l) => !l.startsWith(`${key}=`));
  writeFileSync(f, `${kept.join("\n").replace(/\n+$/, "")}\n${key}=${value}\n`);
  reload(rig);
}

export interface Resp {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** One HTTP request to the gateway. Never follows redirects; never throws on a status. */
export async function http(
  rig: Rig,
  path: string,
  o: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number } = {},
): Promise<Resp> {
  const r = await fetch(`${rig.gw}${path}`, {
    method: o.method ?? "GET",
    headers: o.headers,
    body: o.body,
    redirect: "manual",
    signal: AbortSignal.timeout(o.timeoutMs ?? 30_000),
  });
  const headers: Record<string, string> = {};
  r.headers.forEach((v, k) => (headers[k] = v));
  return { status: r.status, headers, body: await r.text() };
}

export const basic = (rig: Rig): Record<string, string> => ({
  authorization: `Basic ${Buffer.from(`${rig.env.DASHBOARD_USERNAME}:${rig.env.DASHBOARD_PASSWORD}`).toString("base64")}`,
});

/** The three compose layers this experiment stacks; every call names the same set it started with. */
export type Layer = "logs" | "saml" | "kong";
const LAYER_FILE: Record<Layer, string> = {
  logs: "docker-compose.logs.yml",
  saml: "", // resolved against this experiment's compose/ dir
  kong: "docker-compose.kong.yml",
};

export function files(rig: Rig, layers: Layer[]): string[] {
  const f = ["-f", "docker-compose.yml"];
  for (const l of layers) {
    f.push("-f", l === "saml" ? join(import.meta.dir, "..", "compose", "docker-compose.saml.yml") : LAYER_FILE[l]);
  }
  return f;
}

/** `docker compose` in the rig dir. Returns stdout; stderr is kept on failure. */
export async function compose(rig: Rig, layers: Layer[], args: string[], timeoutMs = 600_000): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(["docker", "compose", ...files(rig, layers), ...args], {
    cwd: rig.dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => p.kill(), timeoutMs);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  clearTimeout(timer);
  return { code, out, err };
}

export async function sh(cmd: string[]): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out, err };
}

/** Names of running containers in the stack's compose project. */
export async function runningContainers(): Promise<{ name: string; image: string; ports: string }[]> {
  const r = await sh(["docker", "ps", "--filter", "label=com.docker.compose.project=supabase", "--format", "{{.Names}}\t{{.Image}}\t{{.Ports}}"]);
  return r.out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [name, image, ports] = l.split("\t");
      return { name: name ?? "", image: image ?? "", ports: ports ?? "" };
    });
}

/** `docker inspect` of one container, parsed. */
export async function inspect(name: string): Promise<any | null> {
  const r = await sh(["docker", "inspect", name]);
  if (r.code !== 0) return null;
  try {
    return JSON.parse(r.out)[0];
  } catch {
    return null;
  }
}

/** Env of a container as a map (used only for named, non-secret keys). */
export function envOf(info: any): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kv of (info?.Config?.Env ?? []) as string[]) {
    const i = kv.indexOf("=");
    if (i > 0) out[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return out;
}

/** psql as supabase_admin over the container's unix socket. Rows as arrays of text. */
export async function sql(query: string, user = "supabase_admin"): Promise<string[][]> {
  const r = await sh(["docker", "exec", "supabase-db", "psql", "-U", user, "-d", "postgres", "-At", "-F", "\t", "-c", query]);
  if (r.code !== 0) throw new Error(`psql: ${r.err.trim().slice(0, 300)}`);
  return r.out
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split("\t"));
}

/** Does a TCP connect to host:port succeed within `ms`? */
export async function tcpOpen(host: string, port: number, ms = 3000): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (v: boolean) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    Bun.connect({
      hostname: host,
      port,
      socket: {
        open(s) {
          s.end();
          finish(true);
        },
        error() {
          finish(false);
        },
        connectError() {
          finish(false);
        },
        data() {},
      },
    }).catch(() => finish(false));
    setTimeout(() => finish(false), ms);
  });
}

/**
 * The layers currently applied to the running stack, read from the containers
 * rather than remembered, so a module that runs alone on a stack another
 * module changed still passes the right -f set (compose recreates any service
 * whose resolved config differs from what the files say).
 */
export async function activeLayers(): Promise<Layer[]> {
  const names = (await runningContainers()).map((c) => c.name);
  const layers: Layer[] = [];
  if (names.includes("supabase-analytics")) layers.push("logs");
  const auth = await inspect("supabase-auth");
  if (envOf(auth).GOTRUE_SAML_ENABLED === "true") layers.push("saml");
  if (names.includes("supabase-kong")) layers.push("kong");
  return layers;
}

/** Health status of a container's healthcheck, or "none". */
export async function healthOf(name: string): Promise<string> {
  const i = await inspect(name);
  return String(i?.State?.Health?.Status ?? (i?.State?.Running ? "running" : "none"));
}

export const sleep =(ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function waitFor(f: () => Promise<boolean>, maxMs: number, everyMs = 2000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    if (await f().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return false;
}

export function b64urlJson(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
}

export function jwtParts(jwt: string): { header: Record<string, unknown>; payload: Record<string, unknown> } | null {
  const p = jwt.split(".");
  if (p.length !== 3) return null;
  try {
    return { header: b64urlJson(p[0]!), payload: b64urlJson(p[1]!) };
  } catch {
    return null;
  }
}

export const jsonOr = (s: string): any => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

