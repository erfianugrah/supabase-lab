/**
 * SD07 - negative control for SD01: the :8443 and server-header probes can
 * see Kong when Kong is the gateway.
 *
 * SD01c reports host port 8443 refused and `server: envoy`. Both are absences,
 * and an absence only means something if the probe can see the presence. The
 * Kong override (docker-compose.kong.yml, "Kong re-adds an HTTPS listener on
 * 8443") is the deliberate way to put Kong back, so this module swaps it in,
 * runs the same probes, and swaps it out.
 *
 *   SD07a  with the Kong override: a container with a Kong image is the
 *          gateway, host 8443 accepts a TCP connection, HTTPS on 8443 answers
 *          /auth/v1/health, and the plain port 8000 answers with a Kong
 *          server header. The same opaque keys are sent through Kong for
 *          comparison with SD02b (recorded, not asserted).
 *   SD07b  override removed again: Envoy is back as the gateway, 8443 is
 *          refused, the server header says envoy.
 *
 * Destructive (replaces the gateway container twice). Run it last; it leaves
 * the stack as it found it. Local vantage; needs `make stack up`.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { activeLayers, compose, http, rigOf, runningContainers, tcpOpen, waitFor, type Layer, type Rig } from "../lib/rig";

const ID = "SD07";

async function viaTls(rig: Rig, path: string, apikey: string): Promise<{ status: number; server: string }> {
  try {
    const r = await fetch(`https://127.0.0.1:8443${path}`, { headers: { apikey }, tls: { rejectUnauthorized: false }, signal: AbortSignal.timeout(15_000) } as RequestInit);
    return { status: r.status, server: r.headers.get("server") ?? "none" };
  } catch (e) {
    return { status: -1, server: `error: ${e instanceof Error ? e.message.slice(0, 80) : String(e)}` };
  }
}

const mod: TestModule = {
  id: ID,
  title: "Control: with the Kong override the :8443 and server-header probes see Kong",
  where: "local",
  requires: [],
  destructive: true,

  async run(ctx: Ctx): Promise<TestResult[]> {
    const r = rigOf(ctx);
    if ("skip" in r) return [{ id: ID, title: this.title, status: "skip", detail: r.skip }];
    const rig = r.rig;
    const out: TestResult[] = [];
    const pk = rig.env.SUPABASE_PUBLISHABLE_KEY ?? "";
    const sk = rig.env.SUPABASE_SECRET_KEY ?? "";
    const others = (await activeLayers()).filter((l) => l !== "kong");
    const withKong: Layer[] = [...others, "kong"];

    try {
      // a - Kong in
      const t0 = Date.now();
      const up = await compose(rig, withKong, ["up", "-d", "--wait", "api-gw"]);
      const seconds = Math.round((Date.now() - t0) / 1000);
      await waitFor(async () => (await tcpOpen("127.0.0.1", 8443)) || up.code !== 0, 60_000, 2000);
      const gwc = (await runningContainers()).filter((c) => /kong|envoy/i.test(c.image));
      const open8443 = await tcpOpen("127.0.0.1", 8443);
      const tls = await viaTls(rig, "/auth/v1/health", pk);
      const plain = await http(rig, "/auth/v1/health", { headers: { apikey: pk } });
      const openapiPk = await http(rig, "/rest/v1/", { headers: { apikey: pk } });
      const openapiSk = await http(rig, "/rest/v1/", { headers: { apikey: sk } });
      const noKey = await http(rig, "/auth/v1/health");
      out.push({
        id: `${ID}a`,
        title: "Kong override: Kong container is the gateway and host :8443 accepts",
        status: up.code === 0 && gwc.length === 1 && /kong/i.test(gwc[0]!.image) && open8443 && tls.status > 0 ? "pass" : "fail",
        detail:
          `up exit ${up.code} after ${seconds} s; gateway containers: ${gwc.map((c) => `${c.name} (${c.image}) ${c.ports}`).join("; ")}; ` +
          `TCP 8443 ${open8443 ? "accepted" : "refused"}; HTTPS 8443 /auth/v1/health -> ${tls.status} server ${tls.server}; plain 8000 -> ${plain.status} server ${plain.headers["server"] ?? "none"}`,
        measurements: {
          gateway_image_with_override: gwc[0]?.image ?? "none",
          gateway_ports_with_override: gwc[0]?.ports ?? "none",
          tcp_8443_with_override: open8443 ? "accepted" : "refused",
          https_8443_health_status: tls.status,
          server_header_8443: tls.server,
          server_header_8000: plain.headers["server"] ?? "none",
          kong_publishable_settings_health: plain.status,
          kong_publishable_openapi: openapiPk.status,
          kong_secret_openapi: openapiSk.status,
          kong_no_key_health: noKey.status,
          up_wall_seconds: seconds,
        },
      });
    } finally {
      // b - Kong out
      const t1 = Date.now();
      const back = await compose(rig, others, ["up", "-d", "--wait", "api-gw"]);
      const seconds = Math.round((Date.now() - t1) / 1000);
      await waitFor(async () => !(await tcpOpen("127.0.0.1", 8443)), 30_000, 1000);
      const gwc = (await runningContainers()).filter((c) => /kong|envoy/i.test(c.image));
      const open8443 = await tcpOpen("127.0.0.1", 8443);
      const plain = await http(rig, "/auth/v1/health", { headers: { apikey: pk } });
      out.push({
        id: `${ID}b`,
        title: "override removed: Envoy is back, :8443 refused",
        status: back.code === 0 && gwc.length === 1 && /envoy/i.test(gwc[0]!.image) && !open8443 && /envoy/.test(plain.headers["server"] ?? "") ? "pass" : "fail",
        detail: `up exit ${back.code} after ${seconds} s; gateway containers: ${gwc.map((c) => `${c.name} (${c.image})`).join("; ")}; TCP 8443 ${open8443 ? "accepted" : "refused"}; server header ${plain.headers["server"] ?? "none"}`,
        measurements: {
          gateway_image_restored: gwc[0]?.image ?? "none",
          tcp_8443_restored: open8443 ? "accepted" : "refused",
          server_header_restored: plain.headers["server"] ?? "none",
        },
      });
    }
    return out;
  },
};
export default mod;
