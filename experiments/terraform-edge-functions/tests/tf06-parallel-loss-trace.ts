/**
 * TF06 - why a 24-wide apply leaves 3 to 5 of 24 functions listed (TF01a,
 * TF04, TF05): observe the loss instead of inferring it from counts.
 *
 * TF01 recorded what tofu reported and what the listing held 10 s and 70 s
 * later. Three readings fit those counts and none was observed:
 *
 *   (a) the deploy endpoint answers 201 for every slug, and under concurrency
 *       a later write replaces an earlier one (a slug is listed, then not);
 *   (b) the endpoint never records some slugs, or answers something other
 *       than a usable 201 that the provider drops (a slug is never listed);
 *   (c) the provider sends fewer deploys than it reports, or retries.
 *
 * What this module records, per round (fresh slugs, fresh state):
 *
 *   - every request the provider sends, through a recording reverse proxy on
 *     127.0.0.1 (SUPABASE_API_ENDPOINT, provider 1.11.0 accepts http): start
 *     and end time, method, path, status, the rate-limit remaining header,
 *     and for function responses the body's id, slug and version. Ids are
 *     mapped to ordinals (#1, #2, ...) so the artifact carries no identifier
 *     and two slugs sharing a row would show the same ordinal;
 *   - a side poller, started before the apply, that reads
 *     GET /v1/projects/{ref}/functions and GET /functions/{slug} (round
 *     robin) on two loops aiming at one request per 250 ms each, stopping at
 *     a rate-limit floor so it never starves the provider's own calls;
 *   - TF_LOG=DEBUG (provider TRACE) to a file outside the repo; only line
 *     counts and Create-call timing are extracted into the artifact;
 *   - after the apply: a re-plan through the proxy on a full rate-limit
 *     window (what the provider's refresh reads), then per-slug GET of all
 *     24, an invocation of all 24 checking that each body carries its own
 *     slug's tag (a shared bundle would serve another slug's), and a listing
 *     about 5 minutes after the apply started.
 *
 * Rounds come from TF06_ROUNDS (default "tofu,tofu,api"): "api" sends the
 * same 24 multipart deploys from this process, all in flight, through the
 * same proxy, so the endpoint's behaviour is read without the provider.
 *
 * Self-provisioning like TF01: one throwaway Pro-org project named tf-*,
 * deleted in `finally`. PVLAB_REF_LOG, if set, gets the created ref appended
 * (a file outside git, for the operator's cleanup check). PVLAB_TF_LOG_DIR
 * sets where the raw TF_LOG files go (default: the OS temp dir).
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mgmt, mgmtBase } from "../../../harness/src/mgmt";
import { fetchKeys } from "../../../harness/src/platform";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { deleteFunction, deployViaApi, invoke, tinySource } from "../../edge-function-limits/lib/ef";
import { counts, init, type Stage, stage, type TofuRun, tofu, version } from "../lib/tofu";

const N = 24;
/** One entry per round: "tofu" applies through the provider, "api" posts the same 24 deploys itself, all in flight. */
const ROUND_KINDS = (process.env.TF06_ROUNDS ?? "tofu,tofu,api").split(",").map((x) => x.trim());
const TICK_MS = 250;
/** Poller pauses while x-ratelimit-remaining is at or below this. */
const FLOOR = 30;
/** Poll this long after the apply returns. */
const TAIL_MS = 20_000;
const LATE_READ_AT_MS = 300_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const s2 = (ms: number) => (ms / 1000).toFixed(2);

const hist = (xs: (number | string)[]) => {
  const m = new Map<string, number>();
  for (const x of xs) m.set(String(x), (m.get(String(x)) ?? 0) + 1);
  return [...m.entries()]
    .sort(([a], [b]) => a.localeCompare(b, "en"))
    .map(([k, v]) => `${k}:${v}`)
    .join("|");
};
const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)] ?? 0;
};

interface Budget {
  remaining?: number;
  resetS?: number;
}

interface Wire {
  t0: number;
  t1: number;
  method: string;
  path: string;
  status: number;
  remaining?: number;
  slug?: string;
  id?: string;
  version?: number;
  bodySlug?: string;
  err?: string;
}

interface ListSnap {
  t: number;
  status: number;
  fns: Map<string, { version?: number; id?: string }>;
}

interface SlugRead {
  t: number;
  slug: string;
  status: number;
  version?: number;
  id?: string;
}

/** Ids become ordinals in order of first sight, shared by the proxy and the poller. */
class Ordinals {
  private m = new Map<string, number>();
  of(id?: string): string {
    if (!id) return "-";
    if (!this.m.has(id)) this.m.set(id, this.m.size + 1);
    return `#${this.m.get(id)}`;
  }
}

function noteBudget(b: Budget, h: Headers) {
  const rem = h.get("x-ratelimit-remaining");
  const rst = h.get("x-ratelimit-reset");
  if (rem !== null && rem !== "") b.remaining = Number(rem);
  if (rst !== null && rst !== "") b.resetS = Number(rst);
}

async function rawGet(ctx: Ctx, b: Budget, path: string): Promise<{ status: number; json?: unknown }> {
  try {
    const res = await fetch(`${mgmtBase(ctx)}${path}`, {
      headers: { Authorization: `Bearer ${ctx.pat}` },
      signal: AbortSignal.timeout(15_000),
    });
    noteBudget(b, res.headers);
    if (res.status === 429) b.remaining = 0;
    const text = await res.text();
    try {
      return { status: res.status, json: JSON.parse(text) };
    } catch {
      return { status: res.status };
    }
  } catch {
    return { status: 0 };
  }
}

/** Wait until the token has at least `min` requests left in its window. */
async function waitBudget(ctx: Ctx, b: Budget, min: number): Promise<number> {
  const t0 = Date.now();
  await rawGet(ctx, b, `/projects/${ctx.ref}`);
  for (let i = 0; i < 6 && (b.remaining ?? 120) < min; i++) {
    await sleep(((b.resetS ?? 60) + 3) * 1000);
    await rawGet(ctx, b, `/projects/${ctx.ref}`);
  }
  return Date.now() - t0;
}

const fnRow = (j: unknown): { slug?: string; id?: string; version?: number } => {
  const o = (j ?? {}) as Record<string, unknown>;
  return {
    slug: typeof o.slug === "string" ? o.slug : undefined,
    id: typeof o.id === "string" ? o.id : undefined,
    version: typeof o.version === "number" ? o.version : undefined,
  };
};

/** Reverse proxy that forwards to the Management API and records each exchange (no headers kept). */
function startProxy(upstream: string, ref: string, wire: Wire[], b: Budget, clock: () => number) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 255,
    async fetch(req) {
      const u = new URL(req.url);
      const t0 = clock();
      const headers = new Headers(req.headers);
      headers.delete("host");
      headers.delete("accept-encoding");
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
      const path = u.pathname.split(ref).join("{ref}");
      const slug = u.searchParams.get("slug") ?? /\/functions\/([^/]+)$/.exec(u.pathname)?.[1];
      let res: Response;
      try {
        res = await fetch(`${upstream}${u.pathname}${u.search}`, {
          method: req.method,
          headers,
          body,
          redirect: "manual",
          signal: AbortSignal.timeout(180_000),
        });
      } catch (e) {
        wire.push({ t0, t1: clock(), method: req.method, path, status: 0, slug, err: String(e).slice(0, 120) });
        return new Response("proxy: upstream error", { status: 502 });
      }
      const buf = await res.arrayBuffer();
      const t1 = clock();
      noteBudget(b, res.headers);
      const w: Wire = { t0, t1, method: req.method, path, status: res.status, slug, remaining: b.remaining };
      if (path.includes("/functions")) {
        try {
          const r = fnRow(JSON.parse(new TextDecoder().decode(buf)));
          w.id = r.id;
          w.version = r.version;
          w.bodySlug = r.slug;
        } catch {
          /* not JSON */
        }
      }
      wire.push(w);
      const out = new Headers(res.headers);
      for (const h of ["content-encoding", "content-length", "transfer-encoding", "connection"]) out.delete(h);
      return new Response(buf, { status: res.status, headers: out });
    },
  });
}

/** Two loops, one per read kind, each aiming at one request per TICK_MS. */
async function poll(
  ctx: Ctx,
  b: Budget,
  slugs: string[],
  clock: () => number,
  done: () => boolean,
): Promise<{ snaps: ListSnap[]; reads: SlugRead[]; paused: number }> {
  const want = new Set(slugs);
  const snaps: ListSnap[] = [];
  const reads: SlugRead[] = [];
  let paused = 0;
  const loop = async (step: () => Promise<void>) => {
    while (!done()) {
      const t = performance.now();
      if ((b.remaining ?? 120) > FLOOR) await step();
      else paused++;
      await sleep(Math.max(0, TICK_MS - (performance.now() - t)));
    }
  };
  let i = 0;
  await Promise.all([
    loop(async () => {
      const t = clock();
      const r = await rawGet(ctx, b, `/projects/${ctx.ref}/functions`);
      const fns = new Map<string, { version?: number; id?: string }>();
      if (Array.isArray(r.json))
        for (const row of r.json) {
          const f = fnRow(row);
          if (f.slug && want.has(f.slug)) fns.set(f.slug, { version: f.version, id: f.id });
        }
      snaps.push({ t, status: r.status, fns });
    }),
    loop(async () => {
      const slug = slugs[i++ % slugs.length] ?? "";
      const t = clock();
      const r = await rawGet(ctx, b, `/projects/${ctx.ref}/functions/${slug}`);
      const f = fnRow(r.json);
      reads.push({ t, slug, status: r.status, version: f.version, id: f.id });
    }),
  ]);
  return { snaps, reads, paused };
}

/** Max number of [t0, t1) intervals open at once. */
function maxOverlap(iv: { t0: number; t1: number }[]): number {
  const ev = iv.flatMap((x) => [
    [x.t0, 1],
    [x.t1, -1],
  ]) as [number, number][];
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0;
  let max = 0;
  for (const [, d] of ev) max = Math.max(max, (cur += d));
  return max;
}

/** TF_LOG: line counts by kind and Create-call overlap from the framework's Calling/Called lines. */
async function tfLogSummary(path: string): Promise<Record<string, number | string>> {
  let text = "";
  try {
    text = await readFile(path, "utf8");
  } catch {
    return { tflog_lines: 0 };
  }
  const lines = text.split("\n");
  const c = (re: RegExp) => lines.filter((l) => re.test(l)).length;
  const starts = new Map<string, number>();
  const iv: { t0: number; t1: number }[] = [];
  for (const l of lines) {
    const ts = Date.parse((l.split(" ")[0] ?? "").replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
    const id = /tf_req_id=([0-9a-f-]{36})/.exec(l)?.[1];
    if (!id || Number.isNaN(ts) || !/tf_rpc=ApplyResourceChange/.test(l)) continue;
    if (/Calling provider defined Resource Create/.test(l)) starts.set(id, ts);
    else if (/Called provider defined Resource Create/.test(l) && starts.has(id)) iv.push({ t0: starts.get(id) ?? ts, t1: ts });
  }
  return {
    tflog_lines: lines.length,
    tflog_create_calls: c(/Calling provider defined Resource Create/),
    tflog_create_returns: c(/Called provider defined Resource Create/),
    tflog_create_max_overlap: maxOverlap(iv),
    tflog_create_ms_median: median(iv.map((x) => x.t1 - x.t0)),
    tflog_read_calls: c(/Calling provider defined Resource Read/),
    tflog_not_found_lines: c(/edge function not found/),
    tflog_http_method_lines: c(/\b(GET|POST|PUT|PATCH|DELETE) \/v1\//),
    tflog_retry_lines: c(/retrying|retry attempt/i),
    tflog_error_lines: c(/\[ERROR\]/),
  };
}

const mod: TestModule = {
  id: "TF06",
  title: "24-wide apply: per-slug reads over time and the provider's wire trace",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(base: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];
    const pat = base.pat ?? "";
    const org = base.orgs.pro ?? "";
    if (!org) return [{ id: "TF06", title: this.title, status: "skip", detail: "no PVLAB_ORG_PRO" }];
    if ((await version(import.meta.dir)).tofu === "absent") return [{ id: "TF06", title: this.title, status: "skip", detail: "tofu not on PATH" }];
    const logDir = process.env.PVLAB_TF_LOG_DIR ?? join(tmpdir(), "pvlab-tf-log");
    await mkdir(logDir, { recursive: true });

    let ref = "";
    let ctx: Ctx = base;
    const stages: Stage[] = [];
    let teardown = "";
    const b: Budget = {};

    try {
      const c = await mgmt(base, "POST", "/projects", {
        organization_slug: org,
        name: `tf-${Date.now()}`,
        db_pass: `${crypto.randomUUID()}Aa1!`,
        region_selection: { type: "specific", code: "ap-southeast-1" },
        desired_instance_size: "micro",
      });
      ref = ((c.json ?? {}) as { ref?: string; id?: string }).ref ?? ((c.json ?? {}) as { id?: string }).id ?? "";
      if (!ref) return [{ id: "TF06", title: this.title, status: "fail", detail: `project create HTTP ${c.status}: ${c.text.slice(0, 200)}` }];
      if (process.env.PVLAB_REF_LOG) await appendFile(process.env.PVLAB_REF_LOG, `${ref} TF06 created ${new Date().toISOString()}\n`);
      let st = "";
      for (let i = 0; i < 90 && st !== "ACTIVE_HEALTHY"; i++) {
        await sleep(10_000);
        st = ((await mgmt(base, "GET", `/projects/${ref}`)).json as { status?: string } | undefined)?.status ?? "";
      }
      if (st !== "ACTIVE_HEALTHY") throw new Error(`project never healthy (last status ${st || "?"})`);
      ctx = { ...base, ref, apiHost: `${ref}.${base.apiHostSuffix ?? "supabase.co"}` };
      ctx = { ...ctx, anonKey: (await fetchKeys(ctx)).anon };
      const upstream = mgmtBase(ctx).replace(/\/v1$/, "");

      for (let round = 1; round <= ROUND_KINDS.length; round++) {
        const kind = ROUND_KINDS[round - 1] === "api" ? "api" : "tofu";
        const rowA = `TF06${String.fromCharCode(96 + 2 * round - 1)}`; // a, c, e
        const rowB = `TF06${String.fromCharCode(96 + 2 * round)}`; // b, d, f
        const P = `pvlab-tf-r${round}-`;
        const slugs = Array.from({ length: N }, (_, i) => `${P}${String(i).padStart(2, "0")}`);
        const ids = new Ordinals();
        const wire: Wire[] = [];
        let T0 = performance.now();
        const clock = () => performance.now() - T0;
        const proxy = startProxy(upstream, ref, wire, b, clock);
        const env = (phase: string) => ({
          SUPABASE_API_ENDPOINT: `http://127.0.0.1:${proxy.port}`,
          TF_LOG: "DEBUG",
          TF_LOG_PROVIDER: "TRACE",
          TF_LOG_PATH: join(logDir, `${Date.now()}-r${round}-${phase}.log`),
        });
        try {
          const s = await stage({ project_ref: ref, slugs }, (slug) => tinySource(`r${round}:${slug}:`));
          stages.push(s);
          const ini = await init(s.dir, pat);
          if (ini.exitCode !== 0) throw new Error(`tofu init failed: ${(ini.stderr || ini.stdout).slice(-300)}`);
          const ver = await version(s.dir);
          const waitedMs = await waitBudget(ctx, b, 110);
          const budgetBefore = b.remaining ?? -1;

          // ---- apply at 24 with the poller running ----
          let applyEnd = Number.POSITIVE_INFINITY;
          T0 = performance.now();
          const poller = poll(ctx, b, slugs, clock, () => clock() > applyEnd + TAIL_MS);
          await sleep(1_000); // poller baseline before the first deploy
          const applyEnv = env("apply");
          const tApply0 = clock();
          let ap: TofuRun | undefined;
          if (kind === "tofu") {
            ap = await tofu(s.dir, ["apply", "-auto-approve", "-input=false", "-no-color", `-parallelism=${N}`], pat, 900_000, applyEnv);
          } else {
            // The same multipart shape, sent by this process through the same proxy.
            const pctx: Ctx = { ...ctx, mgmtBase: `http://127.0.0.1:${proxy.port}/v1` };
            await Promise.all(
              slugs.map((slug) =>
                deployViaApi(pctx, slug, [{ name: "index.ts", content: tinySource(`r${round}:${slug}:`) }], { entrypoint_path: "index.ts", name: slug }, 120_000),
              ),
            );
          }
          applyEnd = clock();
          const pr = await poller;
          const ac = ap ? counts(ap) : undefined;
          const applyLog = ap ? await tfLogSummary(applyEnv.TF_LOG_PATH) : {};

          // ---- the provider's wire, apply phase ----
          const posts = wire.filter((w) => w.method === "POST" && w.path.endsWith("/functions/deploy"));
          const postBySlug = new Map<string, Wire[]>();
          for (const w of posts) postBySlug.set(w.slug ?? "?", [...(postBySlug.get(w.slug ?? "?") ?? []), w]);
          const otherApplyCalls = wire.filter((w) => !posts.includes(w));
          const created201 = posts.filter((w) => w.status === 201);
          const distinctIds = new Set(created201.map((w) => w.id).filter(Boolean)).size;
          const bodySlugMismatch = created201.filter((w) => w.bodySlug !== w.slug).length;
          for (const w of created201) ids.of(w.id);

          // ---- the poller, per slug ----
          const okSnaps = pr.snaps.filter((x) => x.status === 200);
          const lastSnap = okSnaps[okSnaps.length - 1];
          const per = slugs.map((slug) => {
            const seen = okSnaps.filter((x) => x.fns.has(slug));
            let vanished = 0;
            for (let k = 1; k < okSnaps.length; k++) if (okSnaps[k - 1]?.fns.has(slug) && !okSnaps[k]?.fns.has(slug)) vanished++;
            const rd = pr.reads.filter((x) => x.slug === slug);
            const listIds = new Set(seen.map((x) => x.fns.get(slug)?.id).filter(Boolean));
            const post = postBySlug.get(slug)?.[0];
            return {
              slug,
              post,
              everListed: seen.length > 0,
              firstListed: seen[0]?.t,
              lastListed: seen[seen.length - 1]?.t,
              listedAtEnd: Boolean(lastSnap?.fns.has(slug)),
              vanished,
              listIdOther: [...listIds].filter((x) => x !== post?.id).map((x) => ids.of(x)),
              reads: rd,
              everGet200: rd.some((x) => x.status === 200),
            };
          });
          const listedAtEnd = per.filter((p) => p.listedAtEnd).length;
          const everListed = per.filter((p) => p.everListed).length;
          const vanishedSlugs = per.filter((p) => p.vanished > 0).length;
          const series = okSnaps.map((x) => `${s2(x.t)}:${x.fns.size}`).join(" ");
          // Membership, printed only when the listed set changes.
          const members: string[] = [];
          let prevKey = "";
          for (const x of okSnaps) {
            const key = [...x.fns.keys()].map((k) => k.slice(P.length)).sort().join(",");
            if (key !== prevKey) members.push(`${s2(x.t)}:{${key}}`);
            prevKey = key;
          }
          const peak = Math.max(0, ...okSnaps.map((x) => x.fns.size));
          const gaps = (xs: number[]) => xs.slice(1).map((t, k) => t - (xs[k] ?? t));
          const listGapMs = Math.round(median(gaps(pr.snaps.map((x) => x.t))));
          const readGapMs = Math.round(median(gaps(pr.reads.map((x) => x.t))));
          const firstPost0 = Math.min(...posts.map((w) => w.t0));
          const lastPost1 = Math.max(...posts.map((w) => w.t1));
          const firstListedAt = Math.min(...per.map((p) => p.firstListed ?? Number.POSITIVE_INFINITY));

          const timeline = per
            .map((p) => {
              const w = p.post;
              const postTxt = w ? `POST ${w.status} ${s2(w.t0)}-${s2(w.t1)} id${ids.of(w.id)} v${w.version ?? "-"}${(postBySlug.get(p.slug)?.length ?? 0) > 1 ? ` x${postBySlug.get(p.slug)?.length}` : ""}` : "no POST";
              const lst = p.everListed ? `listed ${s2(p.firstListed ?? 0)}..${s2(p.lastListed ?? 0)}${p.vanished ? ` vanished x${p.vanished}` : ""}${p.listedAtEnd ? " at-end" : " gone-at-end"}` : "never listed";
              const rd = p.reads.map((x) => `${x.status}@${s2(x.t)}`).join(",");
              return `${p.slug.slice(P.length - 3)} | ${postTxt} | ${lst}${p.listIdOther.length ? ` other-id ${p.listIdOther.join(",")}` : ""} | by-slug ${rd || "-"}`;
            })
            .join("\n");
          const wireTxt = wire
            .map((w) => `${s2(w.t0)}-${s2(w.t1)} ${w.method} ${w.path}${w.slug && !w.path.endsWith(w.slug) ? `?slug=${w.slug}` : ""} ${w.status}${w.remaining !== undefined ? ` rem=${w.remaining}` : ""}${w.id ? ` id${ids.of(w.id)} v${w.version}` : ""}${w.err ? ` err=${w.err}` : ""}`)
            .join("\n");

          out.push({
            id: rowA,
            title:
              kind === "tofu"
                ? `round ${round}: ${N} functions at -parallelism=${N} through a recording proxy, listing and per-slug reads every ~${TICK_MS} ms`
                : `round ${round}: the same ${N} deploys sent by the module itself, all in flight, through the proxy, same reads`,
            status: listedAtEnd === N ? "pass" : "fail",
            detail:
              (ap && ac ? `tofu exit ${ap.exitCode}, reported ${ac.created} created, ${ac.errors} error(s), apply ${s2(applyEnd - tApply0)} s; ` : `no provider; deploys took ${s2(applyEnd - tApply0)} s; `) +
              `client sent ${posts.length} deploy POSTs (${hist(posts.map((w) => w.status))}), max ${Math.max(0, ...[...postBySlug.values()].map((x) => x.length))} per slug, ${maxOverlap(posts)} in flight at most, ` +
              `${distinctIds} distinct ids in ${created201.length} 201 bodies, ${bodySlugMismatch} body slug mismatches, ${otherApplyCalls.length} other calls; ` +
              `listing: ${okSnaps.length} reads (median gap ${listGapMs} ms), peak ${peak}/${N}, ${everListed}/${N} ever listed, ${listedAtEnd}/${N} at the last read (+${s2((lastSnap?.t ?? 0) - applyEnd)} s after the apply), ${vanishedSlugs} slugs listed then unlisted; ` +
              `per-slug GET: ${pr.reads.length} reads (median gap ${readGapMs} ms), ${per.filter((p) => p.everGet200).length}/${N} slugs ever 200`,
            measurements: {
              tofu_version: ver.tofu,
              provider_version: ver.provider,
              round,
              kind,
              budget_wait_ms: waitedMs,
              ratelimit_remaining_before: budgetBefore,
              apply_exit: ap?.exitCode ?? "n/a",
              apply_ms: Math.round(applyEnd - tApply0),
              reported_created: ac?.created ?? "n/a",
              error_blocks: ac?.errors ?? "n/a",
              deploy_posts: posts.length,
              deploy_status_histogram: hist(posts.map((w) => w.status)),
              deploy_posts_max_per_slug: Math.max(0, ...[...postBySlug.values()].map((x) => x.length)),
              deploy_max_in_flight: maxOverlap(posts),
              deploy_first_start_s: s2(firstPost0),
              deploy_last_end_s: s2(lastPost1),
              deploy_ms_median: Math.round(median(posts.map((w) => w.t1 - w.t0))),
              distinct_ids_in_201: distinctIds,
              body_slug_mismatch: bodySlugMismatch,
              other_provider_calls_in_apply: otherApplyCalls.length,
              other_provider_calls_hist: hist(otherApplyCalls.map((w) => `${w.method}:${w.status}`)) || "none",
              list_reads: okSnaps.length,
              list_reads_non200: pr.snaps.length - okSnaps.length,
              list_gap_ms_median: listGapMs,
              list_peak: peak,
              ever_listed: everListed,
              listed_at_last_read: listedAtEnd,
              listed_then_unlisted_slugs: vanishedSlugs,
              listed_id_differs_from_201_slugs: per.filter((p) => p.listIdOther.length > 0).length,
              first_listed_s: Number.isFinite(firstListedAt) ? s2(firstListedAt) : "never",
              slug_reads: pr.reads.length,
              slug_reads_hist: hist(pr.reads.map((x) => x.status)),
              slug_read_gap_ms_median: readGapMs,
              slugs_ever_get_200: per.filter((p) => p.everGet200).length,
              never_listed_but_get_200: per.filter((p) => !p.everListed && p.everGet200).length,
              poller_paused_ticks: pr.paused,
              ...applyLog,
            },
            evidence: `listing count over time (s since poller start: listed):\n${series}\n\nlisted set, at each change:\n${members.join(" ")}\n\nper slug (times in s since poller start; apply ran ${s2(tApply0)}-${s2(applyEnd)}):\n${timeline}\n\nclient wire (deploy phase):\n${wireTxt}`,
          });

          // ---- after: the provider's refresh first (on a full rate-limit window), then per-slug GET and invoke of all ----
          const wireBefore = wire.length;
          await waitBudget(ctx, b, 110);
          const planEnv = env("plan");
          const pl = kind === "tofu" ? await tofu(s.dir, ["plan", "-detailed-exitcode", "-input=false", "-no-color", "-parallelism=1"], pat, 600_000, planEnv) : undefined;
          const plc = pl ? counts(pl) : undefined;
          const planWire = wire.slice(wireBefore);
          const planLog = pl ? await tfLogSummary(planEnv.TF_LOG_PATH) : {};
          const refreshGets = planWire.filter((w) => w.method === "GET" && /\/functions\/[^/]+$/.test(w.path));
          const notFound = new Set(refreshGets.filter((w) => w.status === 404).map((w) => w.slug));
          await waitBudget(ctx, b, 40);
          const tAfter = clock();
          const after = new Map<string, { get: number; inv: number; own: boolean; served: string }>();
          for (const slug of slugs) {
            const g = await rawGet(ctx, b, `/projects/${ref}/functions/${slug}`);
            const inv = await invoke(ctx, slug, { timeoutMs: 20_000 });
            const served = /r\d:(pvlab-tf-r\d-\d\d):/.exec(inv.text)?.[1] ?? "";
            after.set(slug, { get: g.status, inv: inv.status, own: served === slug, served: served ? served.slice(P.length - 3) : "-" });
          }
          const listedNow = new Set(
            ((await rawGet(ctx, b, `/projects/${ref}/functions`)).json as { slug?: string }[] | undefined)?.map((x) => x.slug ?? "") ?? [],
          );
          const neverButGetNow = per.filter((p) => !p.everListed && after.get(p.slug)?.get === 200).length;
          const wait = LATE_READ_AT_MS - clock();
          if (wait > 0) await sleep(wait);
          const tLate = clock();
          const late = new Set(
            ((await rawGet(ctx, b, `/projects/${ref}/functions`)).json as { slug?: string }[] | undefined)?.map((x) => x.slug ?? "") ?? [],
          );
          const lateListed = slugs.filter((x) => late.has(x)).length;
          const gainedLate = slugs.filter((x) => late.has(x) && !per.find((p) => p.slug === x)?.listedAtEnd).length;
          const planWireTxt = planWire.map((w) => `${s2(w.t0)}-${s2(w.t1)} ${w.method} ${w.path} ${w.status}${w.id ? ` id${ids.of(w.id)} v${w.version}` : ""}`).join("\n") || "(no re-plan in this round)";
          const afterTxt = slugs
            .map((x) => `${x.slice(P.length - 3)} GET ${after.get(x)?.get} invoke ${after.get(x)?.inv} body-of ${after.get(x)?.served} refresh ${notFound.has(x) ? "404" : "200"} late ${late.has(x) ? "listed" : "unlisted"}`)
            .join("\n");
          out.push({
            id: rowB,
            title: `round ${round}: after the deploys - ${kind === "tofu" ? "the provider's refresh, " : ""}per-slug GET and invoke of all ${N}, and the listing at +${LATE_READ_AT_MS / 60_000} min`,
            status: lateListed === N ? "pass" : "fail",
            detail:
              (pl && plc
                ? `re-plan exit ${pl.exitCode} (${plc.planned ? `${plc.planned.add} add / ${plc.planned.change} change` : "no plan line"}), refresh sent ${refreshGets.length} GET /functions/{slug} (${hist(refreshGets.map((w) => w.status))}); `
                : "no re-plan (no provider in this round); ") +
              `at +${s2(tAfter - applyEnd)} s: GET /functions/{slug} ${hist([...after.values()].map((x) => x.get))}, invoke ${hist([...after.values()].map((x) => x.inv))}, ${[...after.values()].filter((x) => x.own).length}/${N} bodies carry their own slug's tag; ` +
              `listing ${slugs.filter((x) => listedNow.has(x)).length}/${N}; ` +
              `listing at +${s2(tLate - tApply0)} s after the apply started: ${lateListed}/${N} (${gainedLate} not listed at the end of the poll)`,
            measurements: {
              round,
              after_s: s2(tAfter - applyEnd),
              get_by_slug_hist: hist([...after.values()].map((x) => x.get)),
              invoke_hist: hist([...after.values()].map((x) => x.inv)),
              invoke_own_body: [...after.values()].filter((x) => x.own).length,
              never_listed_get_200_now: neverButGetNow,
              never_listed_invoke_200: per.filter((p) => !p.everListed && after.get(p.slug)?.inv === 200).length,
              listed_after: slugs.filter((x) => listedNow.has(x)).length,
              plan_exit: pl?.exitCode ?? "n/a",
              plan_add: plc?.planned?.add ?? "n/a",
              plan_change: plc?.planned?.change ?? "n/a",
              plan_errors: plc?.errors ?? "n/a",
              refresh_gets: refreshGets.length,
              refresh_hist: hist(refreshGets.map((w) => w.status)),
              refresh_404_equals_unlisted: !pl ? "n/a" : [...notFound].every((x) => !listedNow.has(x ?? "")) && notFound.size === slugs.filter((x) => !listedNow.has(x)).length ? 1 : 0,
              deleted_outside_notes: plc?.deletedOutside ?? "n/a",
              late_read_s_after_apply_start: s2(tLate - tApply0),
              late_listed: lateListed,
              late_gained: gainedLate,
              ...Object.fromEntries(Object.entries(planLog).map(([k, v]) => [`plan_${k}`, v])),
            },
            evidence: `per slug after the apply:\n${afterTxt}\n\nprovider wire (re-plan):\n${planWireTxt}`,
          });

          // ---- clean the round: delete what the API lists for this prefix ----
          for (const x of slugs) if (late.has(x)) await deleteFunction(ctx, x);
        } finally {
          proxy.stop(true);
        }
      }
    } catch (e) {
      out.push({ id: "TF06", title: this.title, status: "fail", detail: `threw: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      try {
        if (ref) {
          const d = await mgmt(base, "DELETE", `/projects/${ref}`);
          teardown = `project delete HTTP ${d.status}`;
          for (let i = 0; i < 30; i++) {
            await sleep(10_000);
            const all = await mgmt(base, "GET", "/projects");
            const rows = Array.isArray(all.json) ? (all.json as { id?: string; ref?: string }[]) : [];
            if (all.status === 200 && !rows.some((p) => (p.ref ?? p.id) === ref)) {
              teardown += "; gone from GET /projects";
              break;
            }
          }
        }
      } catch (e) {
        teardown = `cleanup threw: ${e instanceof Error ? e.message : String(e)}`;
      }
      for (const s of stages) await s.cleanup().catch(() => undefined);
      out.push({
        id: "TF06z",
        title: "cleanup: project",
        status: ref && teardown.includes("gone") ? "pass" : "fail",
        detail: teardown || "no project created",
      });
    }
    return out;
  },
};
export default mod;
