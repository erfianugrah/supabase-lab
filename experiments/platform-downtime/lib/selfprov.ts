/**
 * Self-provisioning wrapper for the D modules (added 2026-10-23, #204).
 *
 * The D modules read their project from the environment (PVLAB_REF,
 * SUPABASE_ANON_KEY, DB_PASSWORD), which the tofu path in this directory
 * fills from state. This wrapper fills it instead from a throwaway project it
 * creates on the Pro org, runs the modules PD_PASSES times against it, and
 * deletes it in `finally`. Orchestration only: the measurement is the modules.
 *
 *   SUPABASE_ACCESS_TOKEN  PAT (env only)
 *   PVLAB_ORG_PRO          Pro org slug (env only, never committed)
 *   PD_SIZE                create size, default micro (medium for a Medium <-> Large pair)
 *   PD_ONLY                modules, default D01,D02,D03,D04
 *   PD_PASSES              default 2
 *   PD_OUT                 evidence dir, relative to the repo root
 *   PD_EXPERIMENT          report label and module set, default platform-downtime
 *                          (medium-serverless reuses this wrapper since #208)
 *   PD_REGION              default ap-southeast-1
 *   PD_PLAN                one `--only` per pass, `;`-separated, each with an
 *                          optional `@<s>`: start that pass no earlier than <s>
 *                          seconds after the create call. Overrides PD_ONLY x
 *                          PD_PASSES. `MS02;MS07;MS07@3600` = IPv4 add-on, then
 *                          a resize pair, then another pair an hour in.
 *   PD_GAP_S               pause between passes, default 120
 *
 * Before each pass it writes `<out>/pass<n>/project.json` (no ref): pass, modules,
 * project age since the create call and since ACTIVE_HEALTHY, compute variant,
 * database size, Postgres version. Before deleting it removes any IPv4 add-on
 * a module left on (MS02 does), so the paid add-on never outlives the run.
 *
 * The first restart waits WINDOW_S after ACTIVE_HEALTHY: lifecycle-ops LO05f
 * measured a restart refused with HTTP 400 inside the first ten minutes after
 * create. Only projects named `pd-...` are ever deleted.
 */
const API = "https://api.supabase.com/v1";
const PAT = process.env.SUPABASE_ACCESS_TOKEN ?? "";
const ORG = process.env.PVLAB_ORG_PRO ?? "";
const SIZE = process.env.PD_SIZE || "micro";
const ONLY = process.env.PD_ONLY || "D01,D02,D03,D04";
const PASSES = Number(process.env.PD_PASSES || "2");
const OUT = process.env.PD_OUT || `experiments/platform-downtime/evidence/selfprov-${Date.now()}`;
const REGION = process.env.PD_REGION || "ap-southeast-1";
const EXPERIMENT = process.env.PD_EXPERIMENT || "platform-downtime";
const GAP_S = Number(process.env.PD_GAP_S || "120");
/** `MS02;MS07@3600` -> [{only: "MS02", minAgeS: 0}, {only: "MS07", minAgeS: 3600}]. */
export function parsePlan(plan: string | undefined, only: string, passes: number): { only: string; minAgeS: number }[] {
  if (!plan) return Array.from({ length: passes }, () => ({ only, minAgeS: 0 }));
  return plan
    .split(";")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const [o, a] = x.split("@");
      return { only: (o ?? "").trim(), minAgeS: a ? Number(a) : 0 };
    });
}
const WINDOW_S = 690;
const PREFIX = "pd-";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (m: string) => console.log(`[selfprov ${new Date().toISOString().slice(11, 19)}] ${m}`);

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown; text: string }> {
  for (let i = 0; ; i++) {
    const r = await fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${PAT}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    }).catch((e) => ({ status: 0, text: async () => String(e) }) as unknown as Response);
    const text = await r.text();
    const throttled = r.status === 429 || (r.status === 403 && text.includes("<html"));
    if (throttled && i < 5) {
      await sleep(15_000 * (i + 1));
      continue;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: r.status, json, text };
  }
}

async function projectFacts(ref: string, createdAt: number, healthyAt: number): Promise<Record<string, unknown>> {
  const ad = await api("GET", `/projects/${ref}/billing/addons`);
  const sel = ((ad.json as { selected_addons?: { type: string; variant?: { id?: string } }[] } | undefined)?.selected_addons ?? []);
  const q = await api("POST", `/projects/${ref}/database/query`, {
    query: "select pg_database_size('postgres')::bigint as db_bytes, current_setting('server_version') as server_version, pg_postmaster_start_time() as postmaster_start",
  });
  const row = (Array.isArray(q.json) ? (q.json as Record<string, unknown>[])[0] : undefined) ?? {};
  const info = await api("GET", `/projects/${ref}`);
  const now = Date.now();
  return {
    region: REGION,
    size_at_create: SIZE,
    compute_variant: sel.find((a) => a.type === "compute_instance")?.variant?.id ?? "none (micro)",
    addons: sel.map((a) => `${a.type}:${a.variant?.id ?? "?"}`),
    age_since_create_s: Math.round((now - createdAt) / 1000),
    age_since_healthy_s: Math.round((now - healthyAt) / 1000),
    db_bytes: row.db_bytes ?? `query HTTP ${q.status}`,
    server_version: row.server_version ?? "?",
    postmaster_start: row.postmaster_start ?? "?",
    image_version: (info.json as { database?: { version?: string } } | undefined)?.database?.version ?? "?",
    // The platform's own created_at: on 2026-10-23 a Medium create came back
    // ACTIVE_HEALTHY in 10 s with postmaster_start about 39 hours earlier
    // (and, on another, created_at about 6 hours earlier), so "age since the
    // create call" is not the instance's age.
    platform_created_at: (info.json as { created_at?: string } | undefined)?.created_at ?? "?",
    at: new Date(now).toISOString(),
  };
}

async function removeIpv4(ref: string): Promise<void> {
  const ad = await api("GET", `/projects/${ref}/billing/addons`);
  const sel = ((ad.json as { selected_addons?: { type: string; variant?: { id?: string } }[] } | undefined)?.selected_addons ?? []);
  for (const a of sel.filter((x) => x.type === "ipv4")) {
    const v = a.variant?.id ?? "ipv4_default";
    let d = await api("DELETE", `/projects/${ref}/billing/addons/${v}`);
    for (let i = 0; d.status === 429 && i < 5; i++) {
      await sleep(65_000);
      d = await api("DELETE", `/projects/${ref}/billing/addons/${v}`);
    }
    log(`remove add-on ${v}: HTTP ${d.status}`);
  }
}

async function projectStatus(ref: string): Promise<string> {
  const r = await api("GET", `/projects/${ref}`);
  return r.status === 200 ? String((r.json as { status?: string }).status ?? "?") : `HTTP ${r.status}`;
}

async function main(): Promise<number> {
  if (!PAT || !ORG) {
    console.error("SUPABASE_ACCESS_TOKEN and PVLAB_ORG_PRO are required");
    return 2;
  }
  const name = `${PREFIX}${SIZE}-${Date.now().toString(36)}`;
  const dbPass = `${crypto.randomUUID().replace(/-/g, "")}Aa1!`;
  let ref = "";
  let code = 0;
  try {
    const c = await api("POST", "/projects", {
      organization_slug: ORG,
      name,
      db_pass: dbPass,
      region_selection: { type: "specific", code: REGION },
      desired_instance_size: SIZE,
    });
    ref = String((c.json as { ref?: string } | undefined)?.ref ?? "");
    if (c.status >= 300 || !ref) throw new Error(`create HTTP ${c.status}: ${c.text.slice(0, 200)}`);
    log(`created ${name} (${SIZE}, ${REGION})`);
    const t0 = Date.now();
    const createdAt = t0;
    let s = "";
    while (s !== "ACTIVE_HEALTHY" && Date.now() - t0 < 900_000) {
      await sleep(10_000);
      s = await projectStatus(ref);
    }
    if (s !== "ACTIVE_HEALTHY") throw new Error(`never ACTIVE_HEALTHY (last ${s})`);
    const healthyAt = Date.now();
    log(`ACTIVE_HEALTHY after ${Math.round((healthyAt - t0) / 1000)}s`);
    const keys = await api("GET", `/projects/${ref}/api-keys`);
    const anon = ((keys.json as { name?: string; api_key?: string }[]) ?? []).find((k) => k.name === "anon")?.api_key ?? "";
    if (!anon) throw new Error(`anon key not readable (HTTP ${keys.status})`);
    // Only a restart is refused inside the post-create window; resize-only runs start at once.
    const plan = parsePlan(process.env.PD_PLAN, ONLY, PASSES);
    const waitMs = plan.some((p) => p.only.includes("D01")) ? healthyAt + WINDOW_S * 1000 - Date.now() : 0;
    if (waitMs > 0) {
      log(`waiting ${Math.round(waitMs / 1000)}s for the post-create restart window`);
      await sleep(waitMs);
    }
    for (let pass = 1; pass <= plan.length; pass++) {
      const step = plan[pass - 1] as { only: string; minAgeS: number };
      const ageWait = createdAt + step.minAgeS * 1000 - Date.now();
      if (ageWait > 0) {
        log(`pass ${pass}: waiting ${Math.round(ageWait / 1000)}s until the project is ${step.minAgeS}s old`);
        await sleep(ageWait);
      }
      const facts: Record<string, unknown> = { pass, modules: step.only, ...(await projectFacts(ref, createdAt, healthyAt)) };
      await Bun.write(`${OUT}/pass${pass}/project.json`, `${JSON.stringify(facts, null, 2)}\n`);
      log(`pass ${pass}/${plan.length}: ${step.only} (age ${facts.age_since_create_s}s, ${facts.compute_variant}, db ${facts.db_bytes} bytes)`);
      const proc = Bun.spawn(
        ["bun", "harness/src/run.ts", "--where", "local", "--experiment", EXPERIMENT, "--only", step.only, "--destructive", "--out", `${OUT}/pass${pass}`],
        {
          env: { ...process.env, PVLAB_REF: ref, SUPABASE_ANON_KEY: anon, DB_PASSWORD: dbPass, AWS_REGION: REGION },
          stdout: "inherit",
          stderr: "inherit",
        },
      );
      const rc = await proc.exited;
      log(`pass ${pass} exited ${rc}`);
      if (rc !== 0) code = rc;
      // Let addon changes settle before the next pass's restart.
      if (pass < plan.length) await sleep(GAP_S * 1000);
    }
  } catch (e) {
    console.error(`selfprov: ${e instanceof Error ? e.message : String(e)}`);
    code = 1;
  } finally {
    if (ref) {
      const info = await api("GET", `/projects/${ref}`);
      const n = String((info.json as { name?: string } | undefined)?.name ?? "");
      if (n.startsWith(PREFIX)) {
        await removeIpv4(ref).catch((e) => log(`remove ipv4 add-on: ${e instanceof Error ? e.message : String(e)}`));
        const d = await api("DELETE", `/projects/${ref}`);
        log(`delete ${n}: HTTP ${d.status}`);
      } else {
        log(`NOT deleting ${ref}: name '${n}' lacks prefix ${PREFIX}`);
      }
    }
  }
  return code;
}

if (import.meta.main) process.exit(await main());

export {};
