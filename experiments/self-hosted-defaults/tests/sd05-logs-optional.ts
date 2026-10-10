/**
 * SD05 - analytics (Logflare) and Vector exist only in docker-compose.logs.yml.
 *
 * The self-hosted docker CHANGELOG (release 0.5.0, 2026-06-03) removed logs and
 * analytics from the default docker-compose.yml and added
 * docker-compose.logs.yml as the opt-in. The override also carries the one
 * thing that makes Vector heavier than a container: a read-only bind mount of
 * the Docker socket.
 *
 *   SD05a  default stack: no analytics or vector service in the resolved
 *          model, no such container running, no Logflare or Vector image,
 *          no service mounting the Docker socket, and Studio's
 *          ENABLED_FEATURES_LOGS_ALL is "false".
 *   SD05b  with the override layered on (`docker compose -f docker-compose.yml
 *          -f docker-compose.logs.yml up -d --wait`): the resolved model gains
 *          exactly analytics and vector; both containers reach healthy; Studio
 *          is recreated with ENABLED_FEATURES_LOGS_ALL "true"; the only
 *          service mounting the Docker socket is vector. The wall time from
 *          the up command to every healthcheck passing is recorded.
 *   SD05c  one request for the logs API through the gateway: Envoy has no
 *          analytics route, so /analytics/v1/health falls through to the
 *          dashboard route and its basic-auth gate.
 *
 * Destructive (it changes the stack: later modules read the override as
 * applied). Local vantage; needs `make stack up`.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { activeLayers, compose, envOf, healthOf, http, inspect, rigOf, runningContainers, waitFor, type Layer, type Rig } from "../lib/rig";

const ID = "SD05";

type Model = { services: Record<string, any> };
const modelOf = async (rig: Rig, layers: Layer[]): Promise<Model> => JSON.parse((await compose(rig, layers, ["config", "--format", "json"])).out) as Model;
const socketMounters = (m: Model): string[] =>
  Object.entries(m.services)
    .filter(([, v]) => (v.volumes ?? []).some((x: any) => String(x.source ?? "").includes("docker.sock") || String(x.target ?? "").includes("docker.sock")))
    .map(([k]) => k)
    .sort();

const mod: TestModule = {
  id: ID,
  title: "Analytics and Vector come only from docker-compose.logs.yml",
  where: "local",
  requires: [],
  destructive: true,

  async run(ctx: Ctx): Promise<TestResult[]> {
    const r = rigOf(ctx);
    if ("skip" in r) return [{ id: ID, title: this.title, status: "skip", detail: r.skip }];
    const rig = r.rig;
    const out: TestResult[] = [];

    // a - default stack
    const base = await modelOf(rig, []);
    const baseNames = Object.keys(base.services).sort();
    const baseImages = Object.values(base.services).map((v: any) => String(v.image ?? ""));
    const already = await activeLayers();
    const running0 = (await runningContainers()).map((c) => c.name);
    const studio0 = envOf(await inspect("supabase-studio"));
    const flag0 = studio0.ENABLED_FEATURES_LOGS_ALL ?? "unset";
    const okA =
      !baseNames.includes("analytics") &&
      !baseNames.includes("vector") &&
      !baseImages.some((i) => /logflare|vector/.test(i)) &&
      socketMounters(base).length === 0 &&
      !already.includes("logs") &&
      !running0.some((n) => /analytics|vector/.test(n)) &&
      flag0 === "false";
    out.push({
      id: `${ID}a`,
      title: "default stack: no analytics, no vector, no Docker-socket mount, Studio logs feature off",
      status: okA ? "pass" : "fail",
      detail:
        `model services: ${baseNames.join(", ")}; running analytics/vector containers: ${running0.filter((n) => /analytics|vector/.test(n)).length}; ` +
        `services mounting the Docker socket: ${socketMounters(base).length}; Studio ENABLED_FEATURES_LOGS_ALL=${flag0}`,
      measurements: {
        default_services: baseNames.length,
        default_has_analytics: baseNames.includes("analytics") ? "yes" : "no",
        default_has_vector: baseNames.includes("vector") ? "yes" : "no",
        default_docker_socket_mounters: socketMounters(base).length,
        studio_logs_flag_default: flag0,
      },
    });

    // b - with the override
    const withLogs = await modelOf(rig, ["logs"]);
    const added = Object.keys(withLogs.services).filter((s) => !baseNames.includes(s)).sort();
    const t0 = Date.now();
    const up = await compose(rig, ["logs"], ["up", "-d", "--wait"]);
    const seconds = Math.round((Date.now() - t0) / 1000);
    const healthy = await waitFor(async () => (await healthOf("supabase-analytics")) === "healthy" && (await healthOf("supabase-vector")) === "healthy", 120_000, 3000);
    const studio1 = envOf(await inspect("supabase-studio"));
    const flag1 = studio1.ENABLED_FEATURES_LOGS_ALL ?? "unset";
    const mounters = socketMounters(withLogs);
    const aH = await healthOf("supabase-analytics");
    const vH = await healthOf("supabase-vector");
    out.push({
      id: `${ID}b`,
      title: "with docker-compose.logs.yml: exactly analytics and vector are added, both healthy, Studio flag on",
      status: up.code === 0 && healthy && added.join(",") === "analytics,vector" && flag1 === "true" && mounters.join(",") === "vector" ? "pass" : "fail",
      detail:
        `services added by the override: ${added.join(", ")}; up exit ${up.code} after ${seconds} s; analytics ${aH}, vector ${vH}; ` +
        `Studio ENABLED_FEATURES_LOGS_ALL=${flag1}; Docker-socket mounters: ${mounters.join(", ")}` +
        (up.code === 0 ? "" : `; stderr tail: ${up.err.slice(-300)}`),
      measurements: {
        override_adds: added.join(","),
        up_wall_seconds: seconds,
        analytics_health: aH,
        vector_health: vH,
        studio_logs_flag_with_override: flag1,
        docker_socket_mounters_with_override: mounters.join(","),
        analytics_image: String(withLogs.services["analytics"]?.image ?? "none"),
        vector_image: String(withLogs.services["vector"]?.image ?? "none"),
      },
    });

    // c - gateway
    const sk = rig.env.SUPABASE_SECRET_KEY ?? "";
    const a = await http(rig, "/analytics/v1/health", { headers: { apikey: sk } });
    out.push({
      id: `${ID}c`,
      title: "gateway has no analytics route: /analytics/v1/health reaches the dashboard gate",
      status: a.status === 401 && /username|password/i.test(a.body) ? "pass" : "fail",
      detail: `GET /analytics/v1/health with the secret key -> ${a.status}, body "${a.body.slice(0, 80)}"`,
      measurements: { analytics_path_status: a.status, analytics_path_body: a.body.slice(0, 80) },
    });
    return out;
  },
};
export default mod;
