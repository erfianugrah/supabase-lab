/**
 * A Linux container with the Supabase CLI and no container engine in it (see
 * ../Dockerfile.nodocker): the vantage CL20-CL22 need, because the question is
 * what the experimental stack backend does when Docker is not there.
 *
 * Nothing mounts the host's Docker socket and the image has no docker or podman
 * binary, so "Docker is unreachable" holds by construction; CL20 also asserts
 * it from inside. Scripts are piped to `bash -s` over stdin so no quoting layer
 * sits between the module and the shell.
 */
import { join } from "node:path";
import { run, type RunResult } from "./cli";

export const IMAGE = process.env.PVLAB_BOX_IMAGE ?? "pvlab-cli-nodocker:2.120.0";

export async function ensureImage(): Promise<{ built: boolean; ms: number }> {
  const have = await run(["docker", "image", "inspect", IMAGE, "--format", "{{.Id}}"], { timeoutMs: 20_000 });
  if (have.code === 0) return { built: false, ms: 0 };
  const dir = join(import.meta.dir, "..");
  const b = await run(["docker", "build", "-f", join(dir, "Dockerfile.nodocker"), "-t", IMAGE, dir], { timeoutMs: 900_000 });
  if (b.code !== 0) throw new Error(`image build failed: ${b.all.slice(-300)}`);
  return { built: true, ms: b.ms };
}

export class Box {
  private constructor(readonly name: string) {}

  static async create(tag: string): Promise<Box> {
    const name = `pvlab-cli-box-${tag}-${Date.now()}`;
    const r = await run(["docker", "run", "-d", "--name", name, "--hostname", "cl-box", "--label", "pvlab-cli=1", IMAGE, "sleep", "infinity"], { timeoutMs: 60_000 });
    if (r.code !== 0) throw new Error(`docker run failed: ${r.all.slice(-200)}`);
    return new Box(name);
  }

  /** Run a bash script as the unprivileged user; env vars are set for the whole script. */
  async sh(script: string, o: { env?: Record<string, string>; cwd?: string; timeoutMs?: number } = {}): Promise<RunResult> {
    // The script goes to a file and runs with stdin closed: a CLI that reads stdin
    // (migration up, db reset prompts) would otherwise swallow the rest of a piped script.
    const put = await run(["docker", "exec", "-i", this.name, "sh", "-c", "cat > /tmp/run.sh"], { stdin: script, timeoutMs: 30_000 });
    if (put.code !== 0) throw new Error(`could not stage script: ${put.all.slice(-200)}`);
    const envArgs = Object.entries(o.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    return run(["docker", "exec", "-w", o.cwd ?? "/home/dev", ...envArgs, this.name, "bash", "-c", "bash /tmp/run.sh </dev/null"], { timeoutMs: o.timeoutMs ?? 600_000 });
  }

  async destroy(): Promise<void> {
    await run(["docker", "rm", "-f", this.name], { timeoutMs: 60_000 });
  }
}

/** Environment every in-box CLI call starts from (git identity for the worktree setup, no telemetry). */
export const BOX_ENV = {
  GIT_AUTHOR_NAME: "lab",
  GIT_AUTHOR_EMAIL: ["lab", "example.invalid"].join("@"),
  GIT_COMMITTER_NAME: "lab",
  GIT_COMMITTER_EMAIL: ["lab", "example.invalid"].join("@"),
};

/** Seconds as a float from two `date +%s.%N` stamps printed by a script. */
export function stampMs(out: string, a: string, b: string): number {
  const get = (k: string) => Number(out.match(new RegExp(`${k}=(\\d+\\.\\d+)`))?.[1] ?? NaN);
  return Math.round((get(b) - get(a)) * 1000);
}

/** Parse `supabase stack status --output-format json`. */
export interface StackStatus {
  identity?: { id?: string; name?: string; project_root?: string; branch_context?: string };
  runtime?: string;
  lifecycle?: string;
  readiness?: string;
  services?: Array<{ service: string; state: string; lifecycle: string; health: string | null; endpoints?: Record<string, { port?: number; url?: string }> }>;
}

export function parseStatus(s: string): StackStatus {
  try {
    return JSON.parse(s) as StackStatus;
  } catch {
    return {};
  }
}

export function portsOf(st: StackStatus): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of st.services ?? []) for (const [k, e] of Object.entries(s.endpoints ?? {})) if (e.port) out[`${s.service}.${k}`] = e.port;
  return out;
}
