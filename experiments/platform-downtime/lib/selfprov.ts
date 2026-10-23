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
const REGION = "ap-southeast-1";
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
    const waitMs = ONLY.includes("D01") ? healthyAt + WINDOW_S * 1000 - Date.now() : 0;
    if (waitMs > 0) {
      log(`waiting ${Math.round(waitMs / 1000)}s for the post-create restart window`);
      await sleep(waitMs);
    }
    for (let pass = 1; pass <= PASSES; pass++) {
      log(`pass ${pass}/${PASSES}: ${ONLY}`);
      const proc = Bun.spawn(
        ["bun", "harness/src/run.ts", "--where", "local", "--experiment", "platform-downtime", "--only", ONLY, "--destructive", "--out", `${OUT}/pass${pass}`],
        {
          env: { ...process.env, PVLAB_REF: ref, SUPABASE_ANON_KEY: anon, DB_PASSWORD: dbPass },
          stdout: "inherit",
          stderr: "inherit",
        },
      );
      const rc = await proc.exited;
      log(`pass ${pass} exited ${rc}`);
      if (rc !== 0) code = rc;
      // Let addon changes settle before the next pass's restart.
      if (pass < PASSES) await sleep(120_000);
    }
  } catch (e) {
    console.error(`selfprov: ${e instanceof Error ? e.message : String(e)}`);
    code = 1;
  } finally {
    if (ref) {
      const info = await api("GET", `/projects/${ref}`);
      const n = String((info.json as { name?: string } | undefined)?.name ?? "");
      if (n.startsWith(PREFIX)) {
        const d = await api("DELETE", `/projects/${ref}`);
        log(`delete ${n}: HTTP ${d.status}`);
      } else {
        log(`NOT deleting ${ref}: name '${n}' lacks prefix ${PREFIX}`);
      }
    }
  }
  return code;
}

process.exit(await main());

export {};
