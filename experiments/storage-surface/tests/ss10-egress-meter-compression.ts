/**
 * SS10 - what the egress meter records for a compressed Storage download.
 *
 * SS08d measured an 800,118 B JSON object going over the wire as about
 * 132 KB to a client that sent `Accept-Encoding: gzip`, and as all 800,118 B
 * to one that sent none. It could not see which byte count the usage meter
 * records (work-supabase-lab#201). The Management API does not expose the
 * meter to a PAT (observability-surface OB03c: org usage answered 401), so
 * this module only generates a known, separable load and records the wire
 * bytes; the metered side is read afterwards from per-project daily usage,
 * outside the lab.
 *
 * Two throwaway Pro-org projects in ap-southeast-1, provisioned in parallel:
 * `gz` (every read sends `Accept-Encoding: gzip`) and `plain` (no
 * `Accept-Encoding`). Each gets a public bucket `pub` and the same JSON
 * payload as SS08 under two keys, then:
 *
 *   SS10_setup     refs, storage version, payload sizes, UTC start
 *   SS10u          N uncached reads: a new signed URL per read (SS08: 12 of
 *                  12 MISS), curl without decoding, so `wire` is bytes received
 *   SS10c          N reads of one public URL (HIT after the first)
 *   SS10_summary   per project and arm: reads, cf-cache-status and
 *                  Content-Encoding counts, total wire bytes, UTC end
 *
 * The projects are KEPT on success so their usage can be read once it lands
 * (PVLAB_ENDPOINT_SS10_KEEP=0 deletes them at the end); on any failure they
 * are deleted in `finally`. Delete kept projects with
 * `make ss10-teardown REFS=a,b` after the read. N defaults to 600
 * (PVLAB_ENDPOINT_SS10_N).
 *
 * The 2026-10-21 runs ran this module under the id SS09, before the
 * CDN-expiry SS09 landed; their artifacts carry SS09_* row ids.
 *
 * Every row is `info`. Not settled here: the metered values themselves, the
 * download() path (SS08 shows it serves the same encodings), objects other
 * than one JSON payload, the direct storage host, other regions.
 *
 * DESTRUCTIVE: two projects. Cost: Micro compute until deleted, and about
 * 2 x N x 800 KB (plain) plus 2 x N x 132 KB (gz) on the wire.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { provision, sleep, teardown, type Proj } from "../lib";

const CONCURRENCY = 6;

interface Wire {
  code: number;
  cf: string;
  ce: string;
  bytes: number;
}

/** Bytes as received (curl without --compressed). Config on stdin keeps tokens out of argv. */
async function wire(url: string, headers: Record<string, string>): Promise<Wire> {
  const cfg = [
    `url = "${url}"`,
    ...Object.entries(headers).map(([k, v]) => `header = "${k}: ${v}"`),
    `silent`,
    `output = "/dev/null"`,
    `dump-header = "-"`,
    `max-time = 60`,
    `write-out = "\\n__WIRE__ %{http_code} %{size_download}\\n"`,
  ].join("\n");
  const p = Bun.spawn(["curl", "-K", "-"], { stdin: new Blob([cfg]), stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  const hdr = (k: string) => out.match(new RegExp(`^${k}:\\s*(.*?)\\r?$`, "im"))?.[1] ?? "-";
  const w = out.match(/__WIRE__ (\d+) (\d+)/);
  return { code: Number(w?.[1] ?? 0), cf: hdr("cf-cache-status"), ce: hdr("content-encoding"), bytes: Number(w?.[2] ?? 0) };
}

/** Same generator and target as SS08, so the object is the same 800,118 B. */
function payload(target: number): string {
  const rows: unknown[] = [];
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  let len = 2;
  for (let i = 0; len < target; i++) {
    const row = {
      id: `rec-${i}`,
      kind: ["alpha", "beta", "gamma", "delta"][i % 4],
      score: Math.round(rnd() * 1000) / 10,
      active: rnd() > 0.5,
      createdAt: 1_790_000_000_000 + Math.floor(rnd() * 1e9),
      counts: { a: Math.floor(rnd() * 50), b: Math.floor(rnd() * 20), c: Math.floor(rnd() * 1e6) },
    };
    const s = JSON.stringify(row);
    len += s.length + 1;
    rows.push(row);
  }
  return JSON.stringify({ version: 3, records: rows });
}

async function pool<T>(n: number, f: (i: number) => Promise<T>): Promise<T[]> {
  const out: T[] = new Array(n);
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < n) {
        const i = next++;
        out[i] = await f(i);
      }
    }),
  );
  return out;
}

function tally(rs: Wire[]): Record<string, string | number> {
  const count = (k: (r: Wire) => string) =>
    Object.entries(rs.reduce<Record<string, number>>((a, r) => ((a[k(r)] = (a[k(r)] ?? 0) + 1), a), {}))
      .sort()
      .map(([v, c]) => `${v}:${c}`)
      .join(" ");
  const bytes = rs.reduce((a, r) => a + r.bytes, 0);
  return { reads: rs.length, http: count((r) => String(r.code)), cf: count((r) => r.cf), ce: count((r) => r.ce), wire_bytes_total: bytes, wire_bytes_mean: Math.round(bytes / Math.max(rs.length, 1)) };
}

const mod: TestModule = {
  id: "SS10",
  title: "egress meter vs wire bytes: the same JSON downloads with and without Accept-Encoding, on two kept projects",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const org = ctx.orgs.pro ?? "";
    if (!org) return [{ id: "SS10", title: "SS10", status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    if (!Bun.which("curl")) return [{ id: "SS10", title: "SS10", status: "skip", detail: "curl not on PATH" }];
    const N = Number(ctx.endpoints["ss10_n"] ?? "600") || 600;
    const keep = (ctx.endpoints["ss10_keep"] ?? "1") !== "0";
    const out: TestResult[] = [];
    const arms = [
      { role: "gz", headers: { "Accept-Encoding": "gzip" } as Record<string, string> },
      { role: "plain", headers: {} as Record<string, string> },
    ];
    const refs: Record<string, string> = {};
    const projs: Record<string, Proj> = {};
    let ok = false;
    try {
      // allSettled, not all: a failed provision must not orphan the other
      // project before its ref is recorded for teardown.
      const prov = await Promise.allSettled(
        arms.map(async (a) => {
          try {
            const pr = await provision(ctx, org, `ss10${a.role}`);
            projs[a.role] = pr;
            refs[a.role] = pr.ref;
          } catch (e) {
            refs[a.role] = (e as { ref?: string }).ref ?? refs[a.role] ?? "";
            throw e;
          }
        }),
      );
      const bad = prov.find((r) => r.status === "rejected");
      if (bad) throw (bad as PromiseRejectedResult).reason;
      const body = payload(800_000);
      const setup: Record<string, string | number> = { json_bytes: body.length, reads_per_arm: N, start_utc: new Date().toISOString() };
      for (const a of arms) {
        const p = projs[a.role]!;
        const rest = `${p.apiBase}/storage/v1`;
        const svc = { apikey: p.service, Authorization: `Bearer ${p.service}` };
        setup[`${a.role}_ref`] = p.ref;
        setup[`${a.role}_accept_encoding`] = a.headers["Accept-Encoding"] ?? "none";
        setup[`${a.role}_storage_version`] = (await fetch(`${rest}/version`).then((r) => r.text()).catch(() => "")).slice(0, 40) || "unknown";
        const b = await fetch(`${rest}/bucket`, { method: "POST", headers: { ...svc, "content-type": "application/json" }, body: JSON.stringify({ id: "pub", name: "pub", public: true }) });
        setup[`${a.role}_bucket`] = b.status;
        for (const key of ["ss10/uncached.json", "ss10/cached.json"]) {
          const u = await fetch(`${rest}/object/pub/${key}`, {
            method: "POST",
            headers: { ...svc, "content-type": "application/json", "cache-control": "max-age=3600", "x-upsert": "true" },
            body,
          });
          if (u.status !== 200) throw new Error(`${a.role} upload ${key}: HTTP ${u.status} ${(await u.text()).slice(0, 120)}`);
        }
      }
      out.push({ id: "SS10_setup", title: "two projects, one public bucket each, the SS08 JSON payload under two keys", status: "info", detail: `gz ${refs.gz}, plain ${refs.plain}`, measurements: setup });

      const results: Record<string, Record<string, Wire[]>> = {};
      const distinct: Record<string, number> = {};
      await Promise.all(
        arms.map(async (a) => {
          const p = projs[a.role]!;
          const rest = `${p.apiBase}/storage/v1`;
          const svc = { apikey: p.service, Authorization: `Bearer ${p.service}`, "content-type": "application/json" };
          // Uncached: a new signed URL for every read. expiresIn differs per
          // read: tokens signed in the same second with the same expiry came
          // out identical in the first smoke run (3 of 5 reads HIT/REVALIDATED).
          const urls = new Set<string>();
          const u = await pool(N, async (i) => {
            const s = await fetch(`${rest}/object/sign/pub/ss10/uncached.json`, { method: "POST", headers: svc, body: JSON.stringify({ expiresIn: 3600 + i }) });
            const j = (await s.json().catch(() => ({}))) as { signedURL?: string };
            if (!j.signedURL) return { code: s.status, cf: "sign-failed", ce: "-", bytes: 0 };
            urls.add(j.signedURL);
            return wire(`${rest}${j.signedURL}`, a.headers);
          });
          distinct[a.role] = urls.size;
          await sleep(2000);
          // Cached: one public URL, read N times.
          const pubUrl = `${rest}/object/public/pub/ss10/cached.json`;
          const c = await pool(N, () => wire(pubUrl, a.headers));
          results[a.role] = { u, c };
        }),
      );
      const end = new Date().toISOString();
      for (const [rid, arm, title] of [
        ["SS10u", "u", "uncached reads (new signed URL per read)"],
        ["SS10c", "c", "repeat reads of one public URL"],
      ] as const) {
        const m: Record<string, string | number> = {};
        for (const a of arms) for (const [k, v] of Object.entries(tally(results[a.role]?.[arm] ?? []))) m[`${a.role}_${k}`] = v;
        if (arm === "u") for (const a of arms) m[`${a.role}_distinct_signed_urls`] = distinct[a.role] ?? 0;
        out.push({ id: rid, title, status: "info", detail: `wire bytes gz ${m.gz_wire_bytes_total}, plain ${m.plain_wire_bytes_total}`, measurements: m });
      }
      out.push({
        id: "SS10_summary",
        title: "load window and kept projects (read their metered egress for this UTC day)",
        status: "info",
        detail: keep ? `kept: gz ${refs.gz}, plain ${refs.plain}` : "deleted at the end (PVLAB_ENDPOINT_SS10_KEEP=0)",
        measurements: { start_utc: setup.start_utc ?? "", end_utc: end, gz_ref: refs.gz ?? "", plain_ref: refs.plain ?? "", kept: keep ? "yes" : "no" },
      });
      ok = true;
    } catch (e) {
      out.push({ id: "SS10", title: "SS10 aborted", status: "fail", detail: `threw: ${(e as Error).message}` });
    } finally {
      if (!ok || !keep) {
        for (const [role, ref] of Object.entries(refs)) {
          if (!ref) continue;
          const del = await teardown(ctx, ref);
          out.push({ id: `SS10_teardown_${role}`, title: `project ${role} deleted`, status: del >= 200 && del < 300 ? "info" : "fail", detail: `DELETE HTTP ${del}` });
        }
      }
    }
    return out;
  },
};

export default mod;
