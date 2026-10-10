/**
 * SD01 - the default API gateway is Envoy: no Kong, no :8443.
 *
 * The self-hosting changelog for self-hosted/v0.8.0 (2026-08-11) says Envoy
 * replaced Kong as the default and Kong is an opt-in override. The comment in
 * docker-compose.kong.yml says the override "re-adds an HTTPS listener on
 * 8443", so the default has none. Those are statements about compose files.
 * This module asks the running stack:
 *
 *   SD01a  the resolved compose model: a service named api-gw on an Envoy
 *          image, no service or image with "kong" in it.
 *   SD01b  the running containers: one gateway container, Envoy, and its
 *          published ports.
 *   SD01c  the wire: the `server` response header, a TCP connect to host 8443
 *          (and 8001, Kong's admin port), and the dashboard's basic-auth gate
 *          that Envoy now enforces at the root path.
 *   SD01d  the compatibility aliases: the compose file gives the Envoy
 *          container the network aliases `envoy` and `kong`, so a hostname
 *          that still says "kong" keeps resolving - to Envoy.
 *
 * Read-only against the default (no override) stack. SD07 is the control that
 * shows SD01c's 8443 probe can see a Kong listener when one exists.
 *
 * Local vantage; needs `make stack up`. Self-skips without it.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { compose, http, inspect, basic, rigOf, runningContainers, scrub, tcpOpen } from "../lib/rig";

const ID = "SD01";

const mod: TestModule = {
  id: ID,
  title: "Default API gateway is Envoy: no Kong service, no :8443",
  where: "local",
  requires: [],

  async run(ctx: Ctx): Promise<TestResult[]> {
    const r = rigOf(ctx);
    if ("skip" in r) return [{ id: ID, title: this.title, status: "skip", detail: r.skip }];
    const rig = r.rig;
    const out: TestResult[] = [];

    // a - compose model
    const cfg = await compose(rig, [], ["config", "--format", "json"]);
    const model = JSON.parse(cfg.out) as { services: Record<string, any> };
    const services = Object.keys(model.services).sort();
    const images = Object.fromEntries(Object.entries(model.services).map(([k, v]) => [k, String(v.image ?? "")]));
    const kongServices = services.filter((s) => /kong/i.test(s) || /kong/i.test(images[s] ?? ""));
    const gw = model.services["api-gw"];
    out.push({
      id: `${ID}a`,
      title: "compose model: api-gw on Envoy, nothing Kong",
      status: gw && /envoyproxy\/envoy/.test(String(gw.image)) && kongServices.length === 0 ? "pass" : "fail",
      detail: `api-gw image ${gw?.image ?? "absent"}; ${services.length} services; services or images matching "kong": ${kongServices.length}`,
      measurements: {
        gateway_service: gw ? "api-gw" : "absent",
        gateway_image: String(gw?.image ?? "absent"),
        services_total: services.length,
        kong_matches: kongServices.length,
        gateway_published_ports: JSON.stringify((gw?.ports ?? []).map((p: any) => `${p.published}:${p.target}`)),
      },
      evidence: `services: ${services.join(", ")}`,
    });

    // b - running containers
    const running = await runningContainers();
    const gwc = running.filter((c) => /envoy|kong/i.test(c.name) || /envoy|kong/i.test(c.image));
    const envoy = gwc.find((c) => /envoyproxy\/envoy/.test(c.image));
    const kong = gwc.filter((c) => /kong/i.test(c.image) || /kong/i.test(c.name));
    out.push({
      id: `${ID}b`,
      title: "running containers: one Envoy gateway, no Kong container",
      status: envoy && gwc.length === 1 && kong.length === 0 ? "pass" : "fail",
      detail: `gateway-like containers: ${gwc.map((c) => `${c.name} (${c.image}) ${c.ports}`).join("; ") || "none"}`,
      measurements: {
        gateway_container: envoy?.name ?? "none",
        gateway_container_image: envoy?.image ?? "none",
        gateway_container_ports: envoy?.ports ?? "none",
        kong_containers: kong.length,
        running_total: running.length,
      },
    });

    // c - the wire
    const health = await http(rig, "/auth/v1/health", { headers: { apikey: rig.env.SUPABASE_PUBLISHABLE_KEY ?? "" } });
    const open8443 = await tcpOpen("127.0.0.1", 8443);
    const open8001 = await tcpOpen("127.0.0.1", 8001);
    const root = await http(rig, "/");
    const rootAuthed = await http(rig, "/", { headers: basic(rig) });
    out.push({
      id: `${ID}c`,
      title: "wire: server header, host :8443 and :8001 closed, basic-auth gate at /",
      status: /envoy/i.test(health.headers["server"] ?? "") && !open8443 && !open8001 && root.status === 401 && rootAuthed.status < 400 ? "pass" : "fail",
      detail:
        `GET /auth/v1/health -> ${health.status}, server: ${health.headers["server"] ?? "none"}; ` +
        `TCP 127.0.0.1:8443 ${open8443 ? "accepted" : "refused"}, :8001 ${open8001 ? "accepted" : "refused"}; ` +
        `GET / without credentials -> ${root.status}, with the dashboard credentials -> ${rootAuthed.status} (location ${rootAuthed.headers["location"] ?? "none"})`,
      measurements: {
        server_header: health.headers["server"] ?? "none",
        health_status: health.status,
        tcp_8443: open8443 ? "accepted" : "refused",
        tcp_8001: open8001 ? "accepted" : "refused",
        root_no_credentials: root.status,
        root_with_credentials: rootAuthed.status,
        root_redirect: rootAuthed.headers["location"] ?? "none",
      },
      evidence: scrub(rig, root.body.slice(0, 120)),
    });

    // d - compat aliases
    const info = await inspect(envoy?.name ?? "supabase-envoy");
    const aliases = Object.values((info?.NetworkSettings?.Networks ?? {}) as Record<string, any>).flatMap((n: any) => n.Aliases ?? []) as string[];
    out.push({
      id: `${ID}d`,
      title: "network aliases on the Envoy container include envoy and kong",
      status: aliases.includes("envoy") && aliases.includes("kong") ? "pass" : "fail",
      detail: `aliases on ${envoy?.name ?? "supabase-envoy"}: ${aliases.join(", ") || "none"}`,
      measurements: {
        alias_envoy: aliases.includes("envoy") ? "yes" : "no",
        alias_kong: aliases.includes("kong") ? "yes" : "no",
      },
    });
    return out;
  },
};
export default mod;
