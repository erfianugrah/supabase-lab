/**
 * RR01 - cross-region read replica: where the API load balancer sends a GET,
 * how stale a replica read is after a write, and what the replica's conflict
 * cancellation does to a long query.
 *
 * One throwaway Pro-org project (primary: ap-northeast-1, Small, `pitr_7` for
 * the physical-backup prerequisite) plus one replica in ap-southeast-1. The
 * vantage is the machine running the module (Singapore), so the replica is
 * the NEAR database and the primary the far one: a GET that the load balancer
 * sends to the replica is a routing decision this vantage can see. Eight more
 * vantages come from an Edge Function invoked with `x-region`.
 *
 * Which node served a request is read from the response body of
 * `public.rr_whoami()` (`pg_is_in_recovery()` and the postmaster start time),
 * called as a GET (supabase-js `rpc(..., { get: true })`), so the answer comes
 * from the database that ran the function. The load balancer's own record of
 * the choice is read from `edge_logs` afterwards (RR01o).
 *
 *   RR01a  create the primary (Small), seconds to ACTIVE_HEALTHY
 *   RR01b  `pitr_7` add-on, schema and `rr_whoami`
 *   RR01c  baseline before any replica: GET rr_whoami on the primary's own
 *          endpoint, latency from this vantage
 *   RR01d  `read-replicas/setup`: HTTP status, seconds until the pooler
 *          config lists a READ_REPLICA, seconds until it answers
 *          `pg_is_in_recovery() = true`
 *   RR01e  the replica's own REST host and the load balancer's host: which
 *          candidates resolve and answer (the Management API returns neither)
 *   RR01f  GET rr_whoami through the load balancer from this vantage, n GETs:
 *          which node served each, against the direct-endpoint latencies
 *   RR01g  non-GET through the load balancer: POST rpc/rr_whoami and a POST
 *          insert, which node served
 *   RR01h0 deploy the probe Edge Function
 *   RR01h1..h8  the same GET from Edge Functions invoked with x-region
 *          ap-northeast-1, ap-southeast-1, ap-southeast-2, ap-south-1,
 *          eu-west-1, us-east-1, us-west-1, sa-east-1
 *   RR01i  read-your-writes on the replica's own endpoint: insert on the
 *          primary, then GET the row from the replica until it appears
 *   RR01j  read-your-writes through the load balancer: POST then GET, which
 *          node served the GET and whether it had the row
 *   RR01k  replication delay per insert from the two database clocks
 *   RR01l  `max_standby_streaming_delay`, `max_standby_archive_delay`,
 *          `hot_standby_feedback` on both nodes
 *   RR01m1..m3  long replica query (pg_sleep inside a repeatable-read
 *          transaction) against primary UPDATE + VACUUM: cancelled? after how
 *          long? and when does a row written on the primary after the
 *          conflicting command become visible on the replica
 *   RR01n1..n3  the same against a primary ACCESS EXCLUSIVE lock
 *   RR01o  what edge_logs records about each load balancer GET (cf colo,
 *          chosen region, redirect identifier)
 *   RR01p  teardown: replica removed, project deleted
 *
 * Pass means the platform did what the docs say at the boundary probed; a
 * fail is a measured disagreement. Quote the verbatim error text in `detail`.
 *
 * Not settled: one primary region and one replica region; routing from more
 * than nine vantages; behaviour above Small compute; the routing rule itself
 * (RR01o shows the inputs the load balancer logs, not its algorithm);
 * behaviour under load (every figure here is a light, single-client probe).
 *
 * DESTRUCTIVE and BILLABLE: Small primary + Small replica + `pitr_7` for the
 * hours the run takes. The project is named rr-<ts> and is deleted in
 * `finally`. Env: PVLAB_RR_KEEP=1 skips teardown, PVLAB_PEER_RR_PRIMARY=<ref>
 * reuses a project (with DB_PASSWORD, else the password is reset), and
 * PVLAB_RR_PHASES=a,b,... limits phases (see the Makefile).
 */
import { fetchKeys, logsQuery, sql } from "../../../harness/src/platform";
import { mgmt } from "../../../harness/src/mgmt";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import {
  PREFIX,
  applyAddon,
  connectSession,
  deployProbeFn,
  errText,
  findLoadBalancer,
  forRef,
  invokeProbeFn,
  nodeKey,
  pct,
  poolerConfig,
  resolves,
  round,
  selectedAddons,
  sessionClient,
  sleep,
  tally,
  waitProjectHealthy,
  whoami,
  type PoolerEntry,
  type Sample,
} from "../lib/rr";

const PRIMARY_REGION = "ap-northeast-1";
const REPLICA_REGION = "ap-southeast-1";
const N_ROUTE = Number(process.env.PVLAB_RR_N ?? 40);
const N_RYW = Number(process.env.PVLAB_RR_RYW_N ?? 30);
const CONFLICT_MAX_S = Number(process.env.PVLAB_RR_CONFLICT_MAX_S ?? 100);
const EDGE_REGIONS = ["ap-northeast-1", "ap-southeast-1", "ap-southeast-2", "ap-south-1", "eu-west-1", "us-east-1", "us-west-1", "sa-east-1"];
const EDGE_N = 10;
const CONFLICT_REPS =Number(process.env.PVLAB_RR_CONFLICT_REPS ?? 3);
const phases = new Set((process.env.PVLAB_RR_PHASES ?? "").split(",").map((s) => s.trim()).filter(Boolean));
const want = (p: string) => phases.size === 0 || phases.has(p);

const SCHEMA = `
create table if not exists public.rr_marker (
  id bigserial primary key,
  tag text not null,
  written_at timestamptz not null default clock_timestamp()
);
create table if not exists public.rr_conflict (id int primary key, v int not null, pad text not null);
insert into public.rr_conflict select g, 0, repeat('x', 200) from generate_series(1, 50000) g on conflict do nothing;
grant select on public.rr_marker, public.rr_conflict to anon;
grant all on public.rr_marker, public.rr_conflict to service_role;
grant usage, select on sequence public.rr_marker_id_seq to service_role;
create or replace function public.rr_whoami() returns json language sql stable as $$
  select json_build_object(
    'in_recovery', pg_is_in_recovery(),
    'addr', inet_server_addr()::text,
    'pm', extract(epoch from pg_postmaster_start_time())::bigint,
    'max_id', (select coalesce(max(id), 0) from public.rr_marker),
    'now', clock_timestamp())
$$;
grant execute on function public.rr_whoami() to anon, service_role;
notify pgrst, 'reload schema';
`;

interface Writer {
  id: number;
  status: number;
  ms: number;
  err?: string;
}

async function insertMarker(base: string, svc: string, tag: string): Promise<Writer> {
  const t0 = performance.now();
  try {
    const res = await fetch(`${base}/rest/v1/rr_marker`, {
      method: "POST",
      headers: { apikey: svc, Authorization: `Bearer ${svc}`, "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify({ tag }),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    const id = (JSON.parse(text) as { id?: number }[])[0]?.id ?? 0;
    return { id, status: res.status, ms: performance.now() - t0, ...(id ? {} : { err: text.slice(0, 160) }) };
  } catch (e) {
    return { id: 0, status: 0, ms: performance.now() - t0, err: errText(e) };
  }
}

async function readMarker(base: string, anon: string, id: number): Promise<{ found: boolean; ms: number; status: number }> {
  const t0 = performance.now();
  try {
    const res = await fetch(`${base}/rest/v1/rr_marker?id=eq.${id}&select=id`, {
      headers: { apikey: anon, Authorization: `Bearer ${anon}` },
      signal: AbortSignal.timeout(20_000),
    });
    const rows = (await res.json()) as unknown[];
    return { found: Array.isArray(rows) && rows.length > 0, ms: performance.now() - t0, status: res.status };
  } catch {
    return { found: false, ms: performance.now() - t0, status: 0 };
  }
}

const num = (xs: number[], p: number) => round(pct(xs, p));

const mod: TestModule = {
  id: "RR01",
  title: "Cross-region read replica: load balancer routing, read-your-writes gap, standby conflict cancellation",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];
    const push = (r: TestResult) => {
      out.push(r);
      ctx.log(`${r.id} ${r.status}${r.detail ? `: ${r.detail.slice(0, 200)}` : ""}`);
    };
    const org = ctx.orgs.pro;
    if (!org) return [{ id: "RR01", title: this.title, status: "skip", detail: "PVLAB_ORG_PRO not set" }];

    const reuse = ctx.peers.rr_primary ?? "";
    const keep = process.env.PVLAB_RR_KEEP === "1";
    const dbPass = reuse && ctx.dbPassword ? ctx.dbPassword : `${crypto.randomUUID().replace(/-/g, "")}Aa1!`;
    if (reuse && !ctx.dbPassword) {
      // A reused project's password is unknown to this process: set one.
      const pw = await mgmt(ctx, "PATCH", `/projects/${reuse}/database/password`, { password: dbPass });
      ctx.log(`reuse: database password reset, HTTP ${pw.status}; waiting 60 s for the poolers to pick it up`);
      await sleep(60_000);
    }
    let ref = reuse;
    let replicaId = "";
    let removedReplica = false;
    let deleted = false;
    const t00 = Date.now();

    try {
      /* ---- RR01a: create ---- */
      if (!ref) {
        const name = `${PREFIX}${Date.now()}`;
        const create = await mgmt(ctx, "POST", "/projects", {
          organization_slug: org,
          name,
          db_pass: dbPass,
          region_selection: { type: "specific", code: PRIMARY_REGION },
          desired_instance_size: "small",
        });
        ref = String((create.json as { ref?: string; id?: string } | undefined)?.ref ?? (create.json as { id?: string } | undefined)?.id ?? "");
        if (create.status !== 201 || !ref) {
          push({ id: "RR01a", title: "create primary (Small, ap-northeast-1)", status: "fail", detail: `HTTP ${create.status}: ${create.text.slice(0, 300)}` });
          return out;
        }
        ctx.log(`primary created (${name}); waiting healthy`);
        const h = await waitProjectHealthy(ctx, ref);
        push({
          id: "RR01a",
          title: "create primary (Small, ap-northeast-1)",
          status: h.status === "ACTIVE_HEALTHY" ? "pass" : "fail",
          detail: `create HTTP ${create.status}; ${h.status} after ${h.waitedS}s`,
          measurements: { create_http: create.status, healthy_after_s: h.waitedS, size_requested: "small", region: PRIMARY_REGION },
        });
        if (h.status !== "ACTIVE_HEALTHY") return out;
      } else {
        push({ id: "RR01a", title: "reuse an existing primary", status: "info", detail: "PVLAB_PEER_RR_PRIMARY set; create skipped" });
      }
      const pctx = forRef(ctx, ref);
      const primaryBase = `https://${ref}.supabase.co`;

      /* ---- RR01b: pitr_7, schema, keys ---- */
      const have = await selectedAddons(pctx, ref);
      let pitr = { status: 0, text: "already selected" };
      if (!have.includes("pitr_7")) pitr = await applyAddon(pctx, ref, "pitr", "pitr_7");
      const ddl = await sql(pctx, SCHEMA);
      // api-keys answers 403 for a short while after create (run 1, 2026-10-10).
      let keys: Awaited<ReturnType<typeof fetchKeys>> | undefined;
      let keysErr = "";
      for (let i = 0; i < 18 && !keys; i++) {
        try {
          keys = await fetchKeys(pctx);
        } catch (e) {
          keysErr = errText(e);
          await sleep(10_000);
        }
      }
      if (!keys) {
        push({ id: "RR01b", title: "api keys", status: "fail", detail: keysErr });
        return out;
      }
      push({
        id: "RR01b",
        title: "pitr_7 add-on, schema (rr_marker, rr_conflict, rr_whoami)",
        status: pitr.status < 300 && ddl.status < 300 ? "pass" : "fail",
        detail: `pitr_7 ${pitr.status || "already"}; schema HTTP ${ddl.status}${ddl.error ? ` ${ddl.error}` : ""}; add-ons before [${have.join(",")}]`,
        measurements: { pitr_http: pitr.status || "already selected", schema_http: ddl.status },
      });
      if (ddl.status >= 300) return out;
      await sleep(8000); // PostgREST schema cache reload

      /* ---- RR01c: baseline ---- */
      const base: Sample[] = [];
      for (let i = 0; i < 12; i++) base.push(await whoami(primaryBase, keys.anon, { keepHeaders: i === 0 }));
      push({
        id: "RR01c",
        title: "baseline: GET rr_whoami on the primary's own endpoint, before any replica",
        status: base.every((s) => s.node && !s.node.in_recovery) ? "pass" : "fail",
        detail: `nodes ${JSON.stringify(tally(base))}; headers sample ${JSON.stringify(Object.keys(base[0]?.headers ?? {}))}`,
        measurements: { n: base.length, p50_ms: num(base.slice(1).map((s) => s.ms), 50), min_ms: num(base.map((s) => s.ms), 0), in_recovery: String(base[0]?.node?.in_recovery) },
        evidence: JSON.stringify(base[0]?.headers ?? {}),
      });

      /* ---- RR01d: replica setup ---- */
      let replica: PoolerEntry | undefined;
      let primaryEntry: PoolerEntry | undefined;
      const existing = (await poolerConfig(pctx, ref)).find((e) => e.database_type === "READ_REPLICA");
      if (existing) {
        replica = existing;
        push({ id: "RR01d", title: "read replica (pre-existing, reuse)", status: "info", detail: existing.identifier });
      } else if (want("replica") || phases.size === 0) {
        const t1 = Date.now();
        let setup = await mgmt(pctx, "POST", `/projects/${ref}/read-replicas/setup`, { read_replica_region: REPLICA_REGION });
        const attempts = [`0s HTTP ${setup.status} ${setup.text.slice(0, 160)}`];
        while (setup.status >= 300 && setup.status !== 402 && Date.now() - t1 < 12 * 60_000) {
          await sleep(30_000);
          setup = await mgmt(pctx, "POST", `/projects/${ref}/read-replicas/setup`, { read_replica_region: REPLICA_REGION });
          attempts.push(`${Math.round((Date.now() - t1) / 1000)}s HTTP ${setup.status} ${setup.text.slice(0, 160)}`);
        }
        const acceptedS = Math.round((Date.now() - t1) / 1000);
        let appearedS: number | string = "never";
        let servedS: number | string = "never";
        let lastErr = "";
        let recovery = "";
        if (setup.status < 300) {
          const t2 = Date.now();
          while (Date.now() - t2 < 30 * 60_000) {
            const cfg = await poolerConfig(pctx, ref).catch(() => []);
            replica = cfg.find((e) => e.database_type === "READ_REPLICA");
            if (replica && appearedS === "never") appearedS = Math.round((Date.now() - t2) / 1000);
            if (replica) {
              const c = sessionClient(replica, dbPass);
              try {
                await c.connect();
                const r = await c.query<{ rec: boolean }>("select pg_is_in_recovery() as rec");
                recovery = String(r.rows[0]?.rec);
                servedS = Math.round((Date.now() - t2) / 1000);
                break;
              } catch (e) {
                lastErr = errText(e);
              } finally {
                await c.end().catch(() => {});
              }
            }
            await sleep(15_000);
          }
        }
        push({
          id: "RR01d",
          title: `read-replicas/setup ${REPLICA_REGION} on a ${PRIMARY_REGION} Small primary`,
          status: servedS !== "never" ? "pass" : "fail",
          detail: `setup ${attempts[attempts.length - 1]}; entry after ${appearedS}s, served after ${servedS}s${lastErr ? ` (last error ${lastErr})` : ""}`,
          measurements: { setup_http: setup.status, setup_attempts: attempts.length, setup_accepted_after_s: acceptedS, entry_appeared_s: appearedS, served_s: servedS, pg_is_in_recovery: recovery },
          evidence: attempts.join("\n"),
        });
        if (!replica || servedS === "never") return out;
      }
      if (!replica) return out;
      replicaId = replica.identifier;
      primaryEntry = (await poolerConfig(pctx, ref)).find((e) => e.database_type === "PRIMARY");

      /* ---- RR01e: hostnames ---- */
      const suffix = "supabase.co";
      const replicaBase = `https://${replicaId}.${suffix}`;
      let replicaProbe: Sample = await whoami(replicaBase, keys.anon, { keepHeaders: true });
      for (let i = 0; i < 12 && !replicaProbe.node; i++) {
        await sleep(10_000);
        replicaProbe = await whoami(replicaBase, keys.anon, { keepHeaders: true });
      }
      const lb = await findLoadBalancer(pctx, ref, keys.anon);
      const primaryIps = await resolves(`${ref}.${suffix}`);
      const replicaIps = await resolves(`${replicaId}.${suffix}`);
      const lbHost = lb.url ? new URL(lb.url).hostname : "";
      const lbIps = lbHost ? await resolves(lbHost) : [];
      push({
        id: "RR01e",
        title: "replica REST host and load balancer host",
        status: replicaProbe.node?.in_recovery ? (lb.url ? "pass" : "info") : "fail",
        detail: `replica host <identifier>.${suffix}: HTTP ${replicaProbe.status} in_recovery=${replicaProbe.node?.in_recovery}; platform route /platform/projects/{ref}/load-balancers with the PAT: HTTP ${lb.platformStatus} ${lb.platformBody.slice(0, 120)}; hostname candidates ${lb.tried.join(",") || "none"}; load balancer ${lb.url ? "found" : "NOT found"}`,
        measurements: {
          replica_rest_http: replicaProbe.status,
          replica_in_recovery: String(replicaProbe.node?.in_recovery),
          platform_lb_route_http: lb.platformStatus,
          lb_found: String(Boolean(lb.url)),
          lb_host_shape: lb.url ? lb.url.replace(ref, "<ref>").replace(/^https:\/\//, "") : "",
          primary_ips: primaryIps.length,
          replica_ips: replicaIps.length,
          lb_ips: lbIps.length,
          lb_ip_overlap_primary: String(lbIps.some((a) => primaryIps.includes(a))),
          lb_ip_overlap_replica: String(lbIps.some((a) => replicaIps.includes(a))),
        },
        evidence: `replica headers: ${JSON.stringify(replicaProbe.headers ?? {})}`,
      });

      const lbBase = lb.url ?? "";
      const targets = [
        { name: "primary", url: primaryBase },
        { name: "replica", url: replicaBase },
        ...(lbBase ? [{ name: "lb", url: lbBase }] : []),
      ];

      /* ---- RR01f: routing from this vantage ---- */
      if (want("routing")) {
        const bySrc: Record<string, Sample[]> = { primary: [], replica: [], lb: [] };
        for (let i = 0; i < N_ROUTE; i++) {
          for (const t of targets) bySrc[t.name]!.push(await whoami(t.url, keys.anon, { keepHeaders: i === 0 && t.name === "lb" }));
          await sleep(250);
        }
        const lbS = bySrc.lb!;
        const stat = (k: string) => num((bySrc[k] ?? []).slice(1).map((s) => s.ms), 50);
        push({
          id: "RR01f",
          title: "GET rr_whoami through the load balancer from this vantage (Singapore)",
          status: lbBase ? "info" : "skip",
          detail: lbBase
            ? `load balancer served ${JSON.stringify(tally(lbS))}; p50 ms: primary ${stat("primary")}, replica ${stat("replica")}, lb ${stat("lb")}`
            : "load balancer host not found, see RR01e",
          measurements: lbBase
            ? {
                n_per_target: N_ROUTE,
                lb_served: JSON.stringify(tally(lbS)),
                lb_replica_share: round(lbS.filter((s) => s.node?.in_recovery).length / lbS.length, 2),
                direct_primary_p50_ms: stat("primary"),
                direct_replica_p50_ms: stat("replica"),
                lb_p50_ms: stat("lb"),
                direct_primary_node: nodeKey(bySrc.primary![0]?.node),
                direct_replica_node: nodeKey(bySrc.replica![0]?.node),
              }
            : { n_per_target: N_ROUTE, direct_primary_p50_ms: stat("primary"), direct_replica_p50_ms: stat("replica") },
          evidence: `lb response headers: ${JSON.stringify(lbS[0]?.headers ?? {})}`,
        });
      }

      /* ---- RR01g: non-GET through the load balancer ---- */
      if (want("methods") && lbBase) {
        const post = await whoami(lbBase, keys.anon, { method: "POST" });
        const ins = await insertMarker(lbBase, keys.service, "lb-post");
        const viaPrimary = await readMarker(primaryBase, keys.anon, ins.id);
        push({
          id: "RR01g",
          title: "non-GET through the load balancer",
          status: post.node && !post.node.in_recovery ? "pass" : "fail",
          detail: `POST rpc/rr_whoami (stable function, no get:true): HTTP ${post.status}, served by ${nodeKey(post.node)}${post.err ? ` (${post.err})` : ""}; POST insert HTTP ${ins.status}, row id ${ins.id}, readable on the primary: ${viaPrimary.found}`,
          measurements: { post_rpc_http: post.status, post_rpc_node: nodeKey(post.node), post_insert_http: ins.status, post_insert_row_on_primary: String(viaPrimary.found) },
        });
      }

      /* ---- RR01h: Edge Function vantages ---- */
      if (want("edge") && lbBase) {
        const dep = await deployProbeFn(pctx, ref);
        await sleep(15_000);
        push({ id: "RR01h0", title: "deploy the probe Edge Function", status: dep.status < 300 ? "pass" : "fail", detail: `deploy HTTP ${dep.status} ${dep.status < 300 ? "" : dep.text}`, measurements: { deploy_http: dep.status } });
        for (const [ri, region] of EDGE_REGIONS.entries()) {
          let v = await invokeProbeFn(ref, keys.anon, region, targets, EDGE_N);
          if (v.status !== 200) {
            await sleep(10_000);
            v = await invokeProbeFn(ref, keys.anon, region, targets, EDGE_N);
          }
          const m: Record<string, string> = { region_requested: region, region_header: v.servedRegion, region_reported: v.reportedRegion, status: String(v.status) };
          for (const [k, t] of Object.entries(v.targets)) {
            m[`${k}_p50_ms`] = String(t.p50);
            m[`${k}_served`] = JSON.stringify(t.tally);
          }
          push({
            id: `RR01h${ri + 1}`,
            title: `GET rr_whoami through the load balancer from an Edge Function invoked with x-region ${region}`,
            status: "info",
            detail: `region header ${v.servedRegion || "-"}, env ${v.reportedRegion || "-"}: lb served ${JSON.stringify(v.targets.lb?.tally ?? {})}; p50 ms primary ${m.primary_p50_ms}, replica ${m.replica_p50_ms}, lb ${m.lb_p50_ms}${v.err ? ` ERR ${v.err}` : ""}`,
            measurements: m,
          });
        }
      }

      /* ---- RR01i: read-your-writes, replica endpoint ---- */
      if (want("ryw")) {
        const rows: { stale: boolean; polls: number; visibleMs: number; postMs: number; readMs: number }[] = [];
        for (let i = 0; i < N_RYW; i++) {
          const w = await insertMarker(primaryBase, keys.service, `ryw-${i}`);
          const tPost = performance.now();
          if (!w.id) {
            ctx.log(`insert failed: ${w.err}`);
            continue;
          }
          let polls = 0;
          let readMs = 0;
          let visible = false;
          while (performance.now() - tPost < 15_000) {
            polls++;
            const r = await readMarker(replicaBase, keys.anon, w.id);
            readMs = r.ms;
            if (r.found) {
              visible = true;
              break;
            }
          }
          rows.push({ stale: polls > 1 || !visible, polls, visibleMs: visible ? performance.now() - tPost : NaN, postMs: w.ms, readMs });
          await sleep(500);
        }
        const vis = rows.map((r) => r.visibleMs).filter((x) => !Number.isNaN(x));
        const staleN = rows.filter((r) => r.stale).length;
        push({
          id: "RR01i",
          title: "read-your-writes: insert on the primary's endpoint, GET from the replica's endpoint",
          status: "info",
          detail: `${staleN} of ${rows.length} first reads missed the row; time from POST response to the first read that saw it: p50 ${num(vis, 50)} ms, p95 ${num(vis, 95)} ms, max ${num(vis, 100)} ms; one read round trip p50 ${num(rows.map((r) => r.readMs), 50)} ms`,
          measurements: {
            n: rows.length,
            first_read_stale: staleN,
            max_polls: Math.max(...rows.map((r) => r.polls)),
            visible_p50_ms: num(vis, 50),
            visible_p95_ms: num(vis, 95),
            visible_max_ms: num(vis, 100),
            read_rtt_p50_ms: num(rows.map((r) => r.readMs), 50),
            post_p50_ms: num(rows.map((r) => r.postMs), 50),
          },
        });
      }

      /* ---- RR01j: read-your-writes, load balancer ---- */
      if (want("ryw") && lbBase) {
        const rows: { firstNode: string; firstSawRow: boolean; polls: number }[] = [];
        for (let i = 0; i < N_RYW; i++) {
          const w = await insertMarker(lbBase, keys.service, `rywlb-${i}`);
          if (!w.id) continue;
          let polls = 0;
          let firstNode = "";
          let firstSaw = false;
          const t0 = performance.now();
          while (performance.now() - t0 < 15_000) {
            polls++;
            const s = await whoami(lbBase, keys.anon);
            if (polls === 1) {
              firstNode = nodeKey(s.node);
              firstSaw = (s.node?.max_id ?? 0) >= w.id;
            }
            if ((s.node?.max_id ?? 0) >= w.id) break;
          }
          rows.push({ firstNode, firstSawRow: firstSaw, polls });
          await sleep(500);
        }
        const nodes: Record<string, number> = {};
        for (const r of rows) nodes[r.firstNode] = (nodes[r.firstNode] ?? 0) + 1;
        push({
          id: "RR01j",
          title: "read-your-writes through the load balancer: POST then GET rr_whoami",
          status: "info",
          detail: `first GET served by ${JSON.stringify(nodes)}; first GET already saw the row in ${rows.filter((r) => r.firstSawRow).length} of ${rows.length}`,
          measurements: { n: rows.length, first_get_nodes: JSON.stringify(nodes), first_get_saw_row: rows.filter((r) => r.firstSawRow).length, max_polls: Math.max(...rows.map((r) => r.polls)) },
        });
      }

      // The pooler can refuse the password for a while after it was set; wait it out once.
      let pgReady = "n/a";
      if ((want("lag") || want("conflict")) && primaryEntry) {
        const t0 = Date.now();
        try {
          for (const e of [primaryEntry, replica]) await (await connectSession(e, dbPass)).end();
          pgReady = `${Math.round((Date.now() - t0) / 1000)}s`;
        } catch (e) {
          pgReady = `failed: ${errText(e)}`;
          push({ id: "RR01k0", title: "session-mode pooler connections to the primary and the replica", status: "fail", detail: pgReady });
        }
        ctx.log(`pg ready: ${pgReady}`);
      }

      /* ---- RR01k: apparent replay lag under a write stream ---- */
      if (want("lag") && primaryEntry) {
        const pc = sessionClient(primaryEntry, dbPass);
        const rc = sessionClient(replica, dbPass);
        try {
          await pc.connect();
          await rc.connect();
          const upper: number[] = [];
          const lower: number[] = [];
          const polls: number[] = [];
          const pollMs: number[] = [];
          for (let i = 0; i < 40; i++) {
            const w = await pc.query<{ id: string; w: number }>("insert into public.rr_marker(tag) values ('lag') returning id, extract(epoch from written_at) * 1000 as w");
            const id = w.rows[0]!.id;
            const wMs = Number(w.rows[0]!.w);
            let lastMiss = NaN;
            let n = 0;
            for (let k = 0; k < 400; k++) {
              n++;
              const t0 = performance.now();
              const r = await rc.query<{ now_ms: number; c: string }>("select extract(epoch from clock_timestamp()) * 1000 as now_ms, (select count(*) from public.rr_marker where id = $1)::text as c", [id]);
              pollMs.push(performance.now() - t0);
              const nowMs = Number(r.rows[0]!.now_ms);
              if (r.rows[0]!.c === "1") {
                upper.push(nowMs - wMs);
                if (!Number.isNaN(lastMiss)) lower.push(lastMiss);
                break;
              }
              lastMiss = nowMs - wMs;
            }
            polls.push(n);
            await sleep(200);
          }
          push({
            id: "RR01k",
            title: "replication delay per insert: replica clock_timestamp() at the first poll that sees the row, minus the primary's written_at",
            status: "info",
            detail: `first-seen delay p50 ${num(upper, 50)} ms, p95 ${num(upper, 95)} ms, max ${num(upper, 100)} ms over ${upper.length} inserts; last-miss delay p50 ${num(lower, 50)} ms; poll round trip p50 ${num(pollMs, 50)} ms; the two clocks are on different hosts, so skew is inside these figures`,
            measurements: {
              inserts: upper.length,
              seen_p50_ms: num(upper, 50),
              seen_p95_ms: num(upper, 95),
              seen_max_ms: num(upper, 100),
              last_miss_p50_ms: num(lower, 50),
              polls_max: Math.max(...polls),
              poll_rtt_p50_ms: num(pollMs, 50),
            },
          });
        } catch (e) {
          push({ id: "RR01k", title: "replication delay per insert", status: "fail", detail: errText(e) });
        } finally {
          await pc.end().catch(() => {});
          await rc.end().catch(() => {});
        }
      }

      /* ---- RR01l: standby settings ---- */
      if (want("conflict") && primaryEntry) {
        const q = "select name, setting, unit, source from pg_settings where name in ('max_standby_streaming_delay','max_standby_archive_delay','hot_standby_feedback','wal_receiver_status_interval','hot_standby','max_wal_senders','recovery_min_apply_delay','statement_timeout')";
        const res: Record<string, Record<string, string>> = {};
        for (const [label, entry] of [["primary", primaryEntry], ["replica", replica]] as const) {
          const c = sessionClient(entry, dbPass);
          try {
            await c.connect();
            const r = await c.query<{ name: string; setting: string; unit: string | null; source: string }>(q);
            res[label] = Object.fromEntries(r.rows.map((x) => [x.name, `${x.setting}${x.unit ?? ""} (${x.source})`]));
          } catch (e) {
            res[label] = { error: errText(e) };
          } finally {
            await c.end().catch(() => {});
          }
        }
        const m: Record<string, string> = { session_pooler_auth_wait: pgReady };
        for (const [label, kv] of Object.entries(res)) for (const [k, v] of Object.entries(kv)) m[`${label}_${k}`] = v;
        push({
          id: "RR01l",
          title: "standby settings on the primary and the replica (pg_settings)",
          status: "info",
          detail: `replica max_standby_streaming_delay ${res.replica?.max_standby_streaming_delay ?? "?"}, hot_standby_feedback ${res.replica?.hot_standby_feedback ?? "?"}`,
          measurements: m,
        });

        /* ---- RR01m / RR01n: conflict cancellation ---- */
        const jobs = (["vacuum", "lock"] as const).flatMap((k) => Array.from({ length: CONFLICT_REPS }, (_, i) => [k, i + 1] as const));
        for (const [kind, rep] of jobs) {
          const id = `${kind === "vacuum" ? "RR01m" : "RR01n"}${rep}`;
          const title =
            kind === "vacuum"
              ? "replica query (repeatable read, pg_sleep) vs primary UPDATE of every row then VACUUM"
              : "replica query (repeatable read, pg_sleep) vs primary LOCK TABLE ... ACCESS EXCLUSIVE";
          const pc = sessionClient(primaryEntry, dbPass);
          const rc = sessionClient(replica, dbPass);
          const mc = sessionClient(replica, dbPass); // monitor connection, holds no snapshot
          try {
            await pc.connect();
            await rc.connect();
            await mc.connect();
            const before = await mc.query<{ confl_snapshot: string; confl_lock: string }>("select confl_snapshot::text, confl_lock::text from pg_stat_database_conflicts where datname = 'postgres'");
            await rc.query("begin isolation level repeatable read");
            const cnt = await rc.query<{ c: string }>("select count(*)::text as c from public.rr_conflict");
            const tReplicaStart = Date.now();
            let cancelled: { atMs: number; msg: string; code: string; detail: string } | undefined;
            const longQ = rc
              .query(`select pg_sleep(${CONFLICT_MAX_S})`)
              .then(() => undefined)
              .catch((e: unknown) => {
                cancelled = { atMs: Date.now(), msg: errText(e), code: String((e as { code?: string }).code ?? ""), detail: String((e as { detail?: string }).detail ?? "") };
              });
            await sleep(3000);
            const tPrimary = Date.now();
            if (kind === "vacuum") {
              await pc.query("update public.rr_conflict set v = v + 1");
              await pc.query("vacuum public.rr_conflict");
            } else {
              await pc.query("begin");
              await pc.query("lock table public.rr_conflict in access exclusive mode");
              await pc.query("commit");
            }
            const tPrimaryDone = Date.now();
            const lagSamples: string[] = [];
            let cancelS: number | string = "not cancelled";
            // A row written on the primary AFTER the conflicting command sits behind it in the WAL:
            // how long until a read on the replica's endpoint sees it is the read-your-writes gap during a stall.
            const stall = await insertMarker(primaryBase, keys.service, `stall-${id}`);
            const tIns = Date.now();
            let stallVisibleS: number | string = "not visible";
            const pollStall = async () => {
              if (stallVisibleS === "not visible" && stall.id && (await readMarker(replicaBase, keys.anon, stall.id)).found) stallVisibleS = round((Date.now() - tIns) / 1000, 1);
            };
            for (let i = 0; (Date.now() - tPrimaryDone) / 1000 < CONFLICT_MAX_S; i++) {
              if (cancelled) break;
              await pollStall();
              if (i % 5 === 0) {
                const lsnR = await mc.query<{ lsn: string }>("select pg_last_wal_replay_lsn()::text as lsn").catch(() => undefined);
                const curP = await pc.query<{ d: string }>("select pg_wal_lsn_diff(pg_current_wal_lsn(), $1::pg_lsn)::text as d", [lsnR?.rows[0]?.lsn ?? "0/0"]).catch(() => undefined);
                lagSamples.push(`${Math.round((Date.now() - tPrimary) / 1000)}s:${curP?.rows[0]?.d ?? "?"}B`);
              }
              await sleep(700);
            }
            for (let i = 0; i < 40 && stallVisibleS === "not visible"; i++) {
              await pollStall();
              await sleep(500);
            }
            if (!cancelled) await rc.query("select pg_cancel_backend(pg_backend_pid())").catch(() => {});
            await longQ;
            const after = await mc.query<{ confl_snapshot: string; confl_lock: string }>("select confl_snapshot::text, confl_lock::text from pg_stat_database_conflicts where datname = 'postgres'").catch(() => undefined);
            const c = cancelled as { atMs: number; msg: string; code: string; detail: string } | undefined;
            if (c) cancelS = round((c.atMs - tPrimary) / 1000, 1);
            push({
              id,
              title,
              status: "info",
              detail: c
                ? `replica statement cancelled ${cancelS} s after the primary command started (primary command took ${round((tPrimaryDone - tPrimary) / 1000, 1)} s): SQLSTATE ${c.code} "${c.msg}"`
                : `replica statement NOT cancelled within ${CONFLICT_MAX_S} s of the primary command`,
              measurements: {
                rows_seen_by_replica_snapshot: cnt.rows[0]?.c ?? "?",
                replica_query_started_s_before_primary: round((tPrimary - tReplicaStart) / 1000, 1),
                primary_command_s: round((tPrimaryDone - tPrimary) / 1000, 1),
                cancelled: String(Boolean(c)),
                cancel_after_primary_start_s: cancelS,
                row_written_after_conflict_visible_on_replica_s: stallVisibleS,
                row_written_after_conflict_primary_post_ms: round(stall.ms, 0),
                sqlstate: c?.code ?? "",
                confl_snapshot_before: before.rows[0]?.confl_snapshot ?? "?",
                confl_snapshot_after: after?.rows[0]?.confl_snapshot ?? "?",
                confl_lock_before: before.rows[0]?.confl_lock ?? "?",
                confl_lock_after: after?.rows[0]?.confl_lock ?? "?",
              },
              evidence: `${c?.msg ?? ""}${c?.detail ? ` DETAIL: ${c.detail}` : ""}\nreplay lag bytes (primary current LSN minus replica replay LSN) by seconds after primary start: ${lagSamples.join(" ")}`,
            });
          } catch (e) {
            push({ id, title, status: "fail", detail: errText(e) });
          } finally {
            await pc.end().catch(() => {});
            await rc.end().catch(() => {});
            await mc.end().catch(() => {});
          }
          await sleep(5000);
        }
      }

      /* ---- RR01o: does edge_logs carry the redirect identifier ---- */
      if (want("logs") && lbBase) {
        // Aggregated, so no client address or raw attribute map reaches the artifact.
        const LB_Q =
          "select log_attributes['request.method'] as method, log_attributes['request.cf.colo'] as colo, " +
          "log_attributes['load_balancer_geo_aware_info.available_supabase_regions'] as available, " +
          "log_attributes['load_balancer_geo_aware_info.chosen_supabase_region'] as chosen, " +
          "log_attributes['load_balancer_redirect_identifier'] as redirect, " +
          "log_attributes['request.headers.user_agent'] as ua, count(*) as n " +
          "from logs where source = 'edge_logs' and log_attributes['request.path'] = '/rest/v1/rpc/rr_whoami' " +
          "and log_attributes['request.host'] like '%-all.%' group by method, colo, available, chosen, redirect, ua order by n desc limit 60";
        const wantRows = (want("routing") ? N_ROUTE : 0) + (want("edge") ? EDGE_REGIONS.length * EDGE_N : 0);
        const t0 = Date.now();
        let rows: Record<string, unknown>[] = [];
        let lastErr = "";
        let total = 0;
        while (Date.now() - t0 < 7 * 60_000) {
          await sleep(45_000);
          const q = await logsQuery(pctx, LB_Q, 1);
          if (q.error) lastErr = q.error;
          if (q.rows.length) {
            rows = q.rows as Record<string, unknown>[];
            total = rows.reduce((a, r) => a + Number(r.n ?? 0), 0);
            if (total >= wantRows) break;
          }
        }
        const shape = (v: unknown) => String(v ?? "").replace(/[a-z]{20}/g, "<ref>");
        const lines = rows.map((r) => `${String(r.ua ?? "").split(/[\s/]/)[0]} ${r.method} colo=${r.colo ?? "-"} available=${r.available || "-"} chosen=${r.chosen || "-"} redirect=${shape(r.redirect) || "-"} n=${r.n}`);
        const geoRows = rows.filter((r) => r.chosen);
        push({
          id: "RR01o",
          title: "edge_logs rows for load balancer GETs: geo-aware fields and redirect identifier",
          status: "info",
          detail: `${total} load balancer rows in ${rows.length} groups after ${Math.round((Date.now() - t0) / 1000)} s; ${geoRows.length} groups carry load_balancer_geo_aware_info.chosen_supabase_region${lastErr ? `; last endpoint error ${lastErr.slice(0, 80)}` : ""}`,
          measurements: {
            rows: total,
            groups: rows.length,
            rows_with_chosen_region: geoRows.reduce((a, r) => a + Number(r.n ?? 0), 0),
            rows_with_redirect_identifier: rows.filter((r) => r.redirect).reduce((a, r) => a + Number(r.n ?? 0), 0),
          },
          evidence: lines.join("\n"),
        });
      }
    } catch (e) {
      push({ id: "RR01x", title: "module aborted", status: "fail", detail: errText(e) });
    } finally {
      /* ---- RR01p: teardown ---- */
      if (ref && !keep && !reuse) {
        const pctx = forRef(ctx, ref);
        let rm = { status: 0, text: "no replica" };
        let goneS: number | string = "n/a";
        if (replicaId) {
          const r = await mgmt(pctx, "POST", `/projects/${ref}/read-replicas/remove`, { database_identifier: replicaId }).catch(() => null);
          rm = { status: r?.status ?? 0, text: r?.text.slice(0, 160) ?? "" };
          const t0 = Date.now();
          while (Date.now() - t0 < 10 * 60_000) {
            const cfg = await poolerConfig(pctx, ref).catch(() => null);
            if (cfg && !cfg.some((e) => e.database_type === "READ_REPLICA")) {
              goneS = Math.round((Date.now() - t0) / 1000);
              break;
            }
            await sleep(15_000);
          }
          removedReplica = goneS !== "n/a";
        }
        const del = await mgmt(pctx, "DELETE", `/projects/${ref}`).catch(() => null);
        deleted = (del?.status ?? 0) < 300;
        push({
          id: "RR01p",
          title: "teardown: replica removed, project deleted",
          status: deleted ? "pass" : "fail",
          detail: `replica remove HTTP ${rm.status}, gone from pooler config after ${goneS}s; project DELETE HTTP ${del?.status ?? 0}; run took ${Math.round((Date.now() - t00) / 60000)} min`,
          measurements: { replica_remove_http: rm.status, replica_gone_s: goneS, project_delete_http: del?.status ?? 0, run_min: Math.round((Date.now() - t00) / 60000) },
        });
      } else if (ref) {
        ctx.log(`project ${ref} LEFT RUNNING (keep/reuse) - delete it by hand`);
      }
      void removedReplica;
      void deleted;
    }
    return out;
  },
};
export default mod;
