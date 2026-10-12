/**
 * CK13 - Which service versions is each target running, read live, and (for
 * the self-hosted stack) which image tags did the pinned compose files ask for?
 *
 * SIDE: each target, live:
 *   auth      GET /auth/v1/health -> `version`
 *   rest      GET /rest/v1/ with the service key -> OpenAPI `info.version` (PostgREST)
 *   storage   GET /storage/v1/version
 *   postgres  `show server_version` as postgres
 * self-hosted only, from the running containers of the compose project:
 *   image.<service>  image tag per compose service
 *
 * The gap (managed live vs self-hosted pinned) is computed by
 * scripts/parity.ts across the onprem and managed artifacts and printed next
 * to every CK12 difference. Status `info`.
 *
 * Not settled: versions of components that answer no version endpoint on the
 * managed platform (gateway, pooler, Realtime).
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { errMsg, http, jsonOr, loadRun, row, scrub, sh, sqlRows } from "../lib/ckrun";

const mod: TestModule = {
  id: "CK13",
  title: "Service versions per target (live), image tags (self-hosted)",
  where: "local",
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const l = loadRun(ctx);
    if ("skip" in l) return [{ id: "CK13", title: this.title, status: "skip", detail: l.skip }];
    const out: TestResult[] = [];
    for (const t of l.targets) {
      const m: Record<string, string | number> = { kind: t.kind };
      try {
        const a = await http(`${t.client.url}/auth/v1/health`, { headers: { apikey: t.client.anonKey } });
        m["live.auth"] = String(jsonOr(a.body)?.version ?? `HTTP ${a.status}`);
        const r = await http(`${t.client.url}/rest/v1/`, { headers: { apikey: t.serviceKey, authorization: `Bearer ${t.serviceKey}` } });
        m["live.rest"] = String(jsonOr(r.body)?.info?.version ?? `HTTP ${r.status}`).split(" ")[0]!;
        const s = await http(`${t.client.url}/storage/v1/version`, { headers: { apikey: t.client.anonKey } });
        m["live.storage"] = s.status === 200 ? s.body.trim().replace(/^"|"$/g, "") : `HTTP ${s.status}`;
        const pg = await sqlRows(ctx, t, "select current_setting('server_version') as v");
        m["live.postgres"] = String(pg[0]?.v ?? "");
        if (t.kind === "compose") {
          const ps = await sh(["docker", "ps", "--filter", `label=com.docker.compose.project=${t.compose!.project}`, "--format", '{{.Label "com.docker.compose.service"}}\t{{.Image}}']);
          for (const line of ps.out.trim().split("\n").filter(Boolean).sort()) {
            const [svc, img] = line.split("\t");
            m[`image.${svc}`] = img ?? "";
          }
        }
        out.push(row("CK13", t, this.title, "info", `auth ${m["live.auth"]}, rest ${m["live.rest"]}, storage ${m["live.storage"]}, postgres ${m["live.postgres"]}`, m));
      } catch (e) {
        out.push(row("CK13", t, this.title, "fail", `threw: ${scrub(l, errMsg(e))}`, m));
      }
    }
    return out;
  },
};
export default mod;
