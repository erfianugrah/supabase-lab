/**
 * SD08 - what Envoy does with sb_ keys when the opaque-key variables are empty.
 *
 * .env.example ships SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY,
 * ANON_KEY_ASYMMETRIC and SERVICE_ROLE_KEY_ASYMMETRIC empty; `make stack` fills
 * them by running utils/add-new-auth-keys.sh, as the self-hosting guide does.
 * volumes/api/envoy/docker-entrypoint.sh prints "Envoy running in legacy API
 * key mode (sb_ keys disabled)" when any of the four is empty, and the Lua
 * gate accepts an opaque key only when all four are set. SD02 measured the
 * keys-set state. This module measures the other side of that condition, so
 * "sb_ keys pass through Envoy" is stated with its precondition:
 *
 *   SD08a  the four variables emptied in .env and only the gateway container
 *          recreated (`up -d --no-deps api-gw`): Envoy's startup line, then
 *          the same requests with the previously valid publishable and secret
 *          keys and with the legacy anon and service_role keys.
 *   SD08b  .env restored and the gateway recreated again: the opaque keys work
 *          as in SD02.
 *
 * Destructive (rewrites .env in place and restores it in a finally block).
 * Local vantage; needs `make stack up`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { activeLayers, compose, healthOf, http, reload, rigOf, sh, waitFor, type Rig } from "../lib/rig";

const ID = "SD08";
const BLANK = ["SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SECRET_KEY", "ANON_KEY_ASYMMETRIC", "SERVICE_ROLE_KEY_ASYMMETRIC"];

async function statuses(rig: Rig, keys: Record<string, string>): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [name, k] of Object.entries(keys)) {
    const s = await http(rig, "/auth/v1/settings", { headers: { apikey: k } });
    const o = await http(rig, "/rest/v1/", { headers: { apikey: k } });
    out[name] = `settings ${s.status}; openapi ${o.status}`;
  }
  return out;
}

const mod: TestModule = {
  id: ID,
  title: "With the opaque-key variables empty, Envoy runs in legacy API key mode and rejects sb_ keys",
  where: "local",
  requires: [],
  destructive: true,

  async run(ctx: Ctx): Promise<TestResult[]> {
    const r = rigOf(ctx);
    if ("skip" in r) return [{ id: ID, title: this.title, status: "skip", detail: r.skip }];
    const rig = r.rig;
    const out: TestResult[] = [];
    const envFile = join(rig.dir, ".env");
    const original = readFileSync(envFile, "utf8");
    const keys = {
      publishable: rig.env.SUPABASE_PUBLISHABLE_KEY ?? "",
      secret: rig.env.SUPABASE_SECRET_KEY ?? "",
      legacy_anon: rig.env.ANON_KEY ?? "",
      legacy_service: rig.env.SERVICE_ROLE_KEY ?? "",
    };
    const layers = await activeLayers();
    const gwLog = async (): Promise<string> => {
      const l = await sh(["docker", "logs", "--tail", "300", "supabase-envoy"]);
      return (l.out + l.err).split("\n").filter((x) => /legacy API key mode|sb_ key translation enabled/.test(x)).slice(-1)[0] ?? "no mode line found";
    };

    try {
      // a - emptied
      const blanked = original
        .split("\n")
        .map((l) => (BLANK.some((k) => l.startsWith(`${k}=`)) ? `${l.split("=")[0]}=` : l))
        .join("\n");
      writeFileSync(envFile, blanked);
      const up = await compose(rig, layers, ["up", "-d", "--no-deps", "--wait", "api-gw"]);
      await waitFor(async () => (await healthOf("supabase-envoy")) === "healthy", 60_000, 2000);
      const line = await gwLog();
      const s = await statuses(rig, keys);
      const sbRejected = /^settings 401; openapi 401/.test(s.publishable ?? "") && /^settings 401; openapi 401/.test(s.secret ?? "");
      const legacyOk = /^settings 200/.test(s.legacy_anon ?? "") && /^settings 200; openapi 200/.test(s.legacy_service ?? "");
      out.push({
        id: `${ID}a`,
        title: "keys empty: startup line says legacy mode; publishable and secret sb_ keys get 401; legacy keys still work",
        status: up.code === 0 && /legacy API key mode/.test(line) && sbRejected && legacyOk ? "pass" : "fail",
        detail: `up exit ${up.code}; Envoy log: "${line}"; publishable key: ${s.publishable}; secret key: ${s.secret}; legacy anon: ${s.legacy_anon}; legacy service_role: ${s.legacy_service}`,
        measurements: {
          envoy_mode_line: line,
          publishable_key: s.publishable ?? "none",
          secret_key: s.secret ?? "none",
          legacy_anon_key: s.legacy_anon ?? "none",
          legacy_service_role_key: s.legacy_service ?? "none",
        },
      });
    } finally {
      // b - restored
      writeFileSync(envFile, original);
      reload(rig);
      const up = await compose(rig, layers, ["up", "-d", "--no-deps", "--wait", "api-gw"]);
      await waitFor(async () => (await healthOf("supabase-envoy")) === "healthy", 60_000, 2000);
      const line = await gwLog();
      const s = await statuses(rig, keys);
      const ok = /^settings 200/.test(s.publishable ?? "") && /^settings 200; openapi 200/.test(s.secret ?? "");
      out.push({
        id: `${ID}b`,
        title: ".env restored: startup line says key translation enabled; sb_ keys pass again",
        status: up.code === 0 && /translation enabled/.test(line) && ok ? "pass" : "fail",
        detail: `up exit ${up.code}; Envoy log: "${line}"; publishable key: ${s.publishable}; secret key: ${s.secret}`,
        measurements: { envoy_mode_line_restored: line, publishable_key_restored: s.publishable ?? "none", secret_key_restored: s.secret ?? "none" },
      });
    }
    return out;
  },
};
export default mod;
