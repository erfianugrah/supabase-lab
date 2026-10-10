/**
 * Local resolver rig for HP07, all in Docker on one user-defined network:
 *
 *   hp-nx       dnsmasq answering NXDOMAIN for supabase.co and everything under it
 *   hp-unbound  a full recursive Unbound; `nxdomain(true)` adds a zone forward
 *               for supabase.co. to hp-nx, which Unbound applies to CNAME
 *               targets as well as to direct queries
 *   app run     a Bun container whose only resolver is hp-unbound
 *
 * Only containers and the network named `hp-*` are touched.
 */
import { parseDig, run, type DigResult } from "./net";

const DIR = `${import.meta.dir}/../resolver`;
export const NET = "hp-dns";
const docker = (...a: string[]) => run(["docker", ...a], 120_000);

export async function ipOf(name: string): Promise<string> {
  const r = await docker("inspect", "-f", `{{(index .NetworkSettings.Networks "${NET}").IPAddress}}`, name);
  return r.out.trim();
}

export async function up(): Promise<{ unbound: string; nx: string }> {
  await down();
  await docker("network", "create", NET);
  await docker("run", "-d", "--name", "hp-nx", "--network", NET, "-v", `${DIR}:/r:ro`, "alpine", "sh", "/r/start-nx.sh");
  await docker("run", "-d", "--name", "hp-unbound", "--network", NET, "-v", `${DIR}/unbound.conf:/etc/unbound/hp.conf:ro`, "-v", `${DIR}:/r:ro`, "alpine", "sh", "/r/start-unbound.sh");
  // apk add then start: wait until Unbound answers a query for a name outside supabase.co.
  for (let i = 0; i < 40; i++) {
    const ub = await ipOf("hp-unbound");
    const nx = await ipOf("hp-nx");
    if (ub && nx) {
      const q = await digIn("example.com", "A");
      if (q.rcode === "NOERROR" && q.answers.length) return { unbound: ub, nx };
    }
    await Bun.sleep(3_000);
  }
  throw new Error("resolver rig did not come up");
}

/** dig inside the Unbound container against Unbound itself (container IPs are not routable from the host). */
export async function digIn(name: string, type: string): Promise<DigResult> {
  const r = await docker("exec", "hp-unbound", "dig", "@127.0.0.1", "+time=8", "+tries=1", "+noall", "+answer", "+comments", "+stats", name, type);
  return parseDig(r.out);
}

export async function down(): Promise<void> {
  await docker("rm", "-f", "hp-nx", "hp-unbound");
  await docker("network", "rm", NET);
}

const ctl = (...a: string[]) => docker("exec", "hp-unbound", "unbound-control", "-c", "/etc/unbound/hp.conf", ...a);

/** Make supabase.co. NXDOMAIN for this resolver (forward to hp-nx), or restore recursion. */
export async function nxdomain(on: boolean, nxIp: string): Promise<string> {
  const r = on ? await ctl("forward_add", "supabase.co.", nxIp) : await ctl("forward_remove", "supabase.co.");
  return (r.out + r.err).trim();
}

export async function flush(...names: string[]): Promise<void> {
  for (const n of names) await ctl("flush", n);
  await ctl("flush_zone", "supabase.co.");
}

/** Everything the app sees. One JSON object per line on stdout. */
export async function runApp(env: Record<string, string>, dnsIp: string | undefined, appPath: string, nodeModules: string): Promise<{ lines: unknown[]; err: string; code: number }> {
  const args = ["run", "--rm", "--network", NET];
  if (dnsIp) args.push("--dns", dnsIp);
  for (const [k, v] of Object.entries(env)) args.push("-e", `${k}=${v}`);
  args.push("-v", `${appPath}:/work/app.ts:ro`, "-v", `${nodeModules}:/work/node_modules:ro`, "-w", "/work", "oven/bun:alpine", "bun", "/work/app.ts");
  const r = await docker(...args);
  const lines: unknown[] = [];
  for (const l of r.out.split("\n")) {
    try {
      lines.push(JSON.parse(l));
    } catch {
      // not a result line
    }
  }
  return { lines, err: r.err.trim().slice(-300), code: r.code };
}
