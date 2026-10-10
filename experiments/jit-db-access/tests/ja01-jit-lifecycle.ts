/**
 * JA01 - temporary token-based database access ("JIT"): grant a role with an
 * expiry, log in with the caller's PAT as the Postgres password, and measure
 * expiry, revocation, network scoping and log attribution.
 *
 * Public sources (docs claims, not measurements):
 *   https://supabase.com/changelog/46346-feature-preview-temporary-token-based-database-access
 *   https://supabase.com/docs/guides/platform/temporary-access
 *
 * Project and run: ONE self-provisioned Pro-org project, Postgres 17, region
 * ap-southeast-1, smallest compute. Vantage: the local orchestrator (a laptop
 * with IPv4 and, through a tunnel, IPv6). Every row is on that one project.
 * The key under test is the caller's Management API PAT (the same token
 * authenticates the control-plane calls and is the Postgres password).
 * Deleted in `finally`; `PVLAB_PEER_JIT=<ref>` reuses a project instead and
 * does not delete it (debugging only).
 *
 *   JA01a  create: Postgres version (docs floor 17.6.1.081), seconds to healthy.
 *   JA01b  gates before enabling: GET /jit-access state and reason, PUT enabled
 *          without SSL enforcement, then PUT /ssl-enforcement.
 *   JA01c  enable: PUT /jit-access {state:"enabled"} and the read-back.
 *   JA01d  grant API shape: PUT /database/jit with the OpenAPI key `roles`
 *          vs the docs key `user_roles`; replace-or-merge across two PUTs;
 *          list/read routes; POST /database/jit (authorize check).
 *   JA01e  connection matrix with the PAT as password: shared pooler 6543 and
 *          5432 with options=-c jit=true, the docs host (aws-1) vs the host the
 *          pooler config returns (aws-0), the pooler WITHOUT the option, direct
 *          5432 over IPv6, the dedicated pooler (db host :6543), and an
 *          unmapped role. Direct DNS records (A/AAAA) are recorded.
 *   JA01f  what a session sees: current_user, session_user, pg_stat_activity
 *          for the PAT-authenticated backend; a least-privilege custom role.
 *   JA01g  expiry: one grant per unit convention (postgres: epoch seconds;
 *          ja_reader: epoch milliseconds, as the docs example), polled every
 *          5 s on fresh connections, plus two HELD sessions across expiry.
 *   JA01h  extension: PUT a later expiry for the role that expired; seconds
 *          until a fresh connection works again.
 *   JA01i  revocation: DELETE /database/jit/{user_id}, then PUT /jit-access
 *          disabled and enabled again; new-connection refusal time, held
 *          sessions, whether the mapping is retained.
 *   JA01j  allowed_networks: documentation-range CIDR (refuse), the vantage
 *          IPv4/32 (pooler vs direct), then plus the vantage IPv6/128.
 *   JA01k  postgres_logs / supavisor_logs attribution with log_connections on:
 *          what a JIT login records, and whether the user id, email or a token
 *          appears in any log row.
 *   JA01l  not run: revoking project membership (needs a second human) and
 *          revoking the PAT itself (it is the lab's only token).
 *
 * Failed logins: ten failed auths through the pooler have banned the vantage
 * before (AGENTS.md S18), so refusals are probed once per path per phase and
 * `POST /network-bans/retrieve` is read after each phase; a ban would make a
 * refusal uninterpretable and is lifted with DELETE /network-bans.
 *
 * Not settled: other roles beyond postgres and a custom login role, branch
 * scoping (branches_only), the invite flow for non-members, a Free/Team org,
 * IPv4-only direct (no A record without the IPv4 add-on; not bought).
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { logsQuery, sql } from "../../../harness/src/platform.js";
import {
  api,
  callerUserId,
  hasIpv6Route,
  hasPsql,
  Held,
  BREAKER,
  keysOf,
  kindOf,
  nowS,
  psql,
  resolveDirect,
  Scrub,
  sleep,
  type Target,
  vantageV4,
  waitHealthy,
} from "../lib/ja.js";

const IDS = ["JA01a", "JA01b", "JA01c", "JA01d", "JA01e", "JA01f", "JA01g", "JA01h", "JA01i", "JA01j", "JA01k", "JA01l"] as const;
const ORG_REQ = "pro";

interface RoleGrant {
  role: string;
  expires_at?: number;
  allowed_networks?: { allowed_cidrs?: { cidr: string }[]; allowed_cidrs_v6?: { cidr: string }[] };
}

const mod: TestModule = {
  id: "JA01",
  title: "Temporary token-based database access: grant, connect, expiry, revocation, networks, logs",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const results: TestResult[] = [];
    const push = (r: TestResult) => results.push(r);
    const has = (id: string) => results.some((r) => r.id === id);
    const scrub = new Scrub();
    scrub.add(ctx.pat, "<pat>");
    const org = ctx.orgs[ORG_REQ] ?? "";
    const reuse = ctx.peers.jit ?? "";
    let ref = "";
    const nonce = Math.random().toString(36).slice(2, 8);
    const app = (p: string) => `ja${nonce}-${p}`;
    const heldAll: Held[] = [];

    if (!org && !reuse) {
      for (const id of IDS) push({ id, title: id, status: "skip", detail: "needs PVLAB_ORG_PRO (or PVLAB_PEER_JIT=<ref>)" });
      return results;
    }

    // Tool prerequisites are checked before anything billable is created.
    if (!hasPsql()) {
      for (const id of IDS) push({ id, title: id, status: "skip", detail: "psql not on PATH (every row logs in with the PAT as the Postgres password through psql)" });
      return results;
    }
    if (!(await hasIpv6Route())) {
      for (const id of IDS) push({ id, title: id, status: "skip", detail: "no IPv6 route from this vantage (the direct hostname is AAAA-only without the IPv4 add-on, so the direct-path rows cannot run; the pooler-only rows are skipped with them rather than split out)" });
      return results;
    }

    try {
      const uid = await callerUserId(ctx);
      scrub.add(uid, "<user-id>");
      if (!uid) throw new Error("x-gotrue-id header absent: cannot name the caller's user id");
      const vantage4 = await vantageV4();
      scrub.add(vantage4, "<vantage-ip>");

      /* ---------------- JA01a: create ---------------- */
      const t0 = Date.now();
      if (reuse) {
        ref = reuse;
      } else {
        const create = await api(ctx, "POST", "/projects", {
          organization_slug: org,
          name: `ja-ja01-${t0.toString(36)}`,
          db_pass: `${crypto.randomUUID()}Aa1!`,
          region: "ap-southeast-1",
        });
        ref = String((create.json as { ref?: string } | undefined)?.ref ?? "");
        if (!ref) {
          push({ id: "JA01a", title: "JA01a: create", status: "fail", detail: `create HTTP ${create.status}: ${scrub.text(create.text).slice(0, 200)}` });
          throw new Error("no ref");
        }
      }
      scrub.add(ref, "<ref>");
      const health = await waitHealthy(ctx, ref);
      const provisionS = Math.round((Date.now() - t0) / 1000);
      const proj = await api(ctx, "GET", `/projects/${ref}`);
      const db = ((proj.json ?? {}) as { database?: { version?: string; postgres_engine?: string } }).database ?? {};
      const ver = String(db.version ?? "");
      // docs floor 17.6.1.081; compare the first three numeric parts
      const [vMaj = 0, vMin = 0, vPat = 0] = ver.split(".").map((x) => Number(x));
      const floorOk = vMaj > 17 || (vMaj === 17 && (vMin > 6 || (vMin === 6 && vPat >= 1)));
      push({
        id: "JA01a",
        title: "JA01a: Pro project on Postgres 17",
        status: health === "ACTIVE_HEALTHY" && floorOk ? "pass" : "fail",
        detail: `status ${health}; Postgres ${ver} (docs floor 17.6.1.081: ${floorOk ? "met" : "NOT met"})`,
        measurements: { provision_s: provisionS, postgres_version: ver, postgres_engine: String(db.postgres_engine ?? ""), reused: reuse ? 1 : 0 },
      });
      if (health !== "ACTIVE_HEALTHY") throw new Error(`not healthy: ${health}`);

      /* ---------------- JA01b: gates before enabling ---------------- */
      const g0 = await api(ctx, "GET", `/projects/${ref}/jit-access`);
      const sslBefore = await api(ctx, "GET", `/projects/${ref}/ssl-enforcement`);
      const putEarly = await api(ctx, "PUT", `/projects/${ref}/jit-access`, { state: "enabled" });
      const listEarly = await api(ctx, "GET", `/projects/${ref}/database/jit/list`);
      const tSsl = Date.now();
      const sslPut = await api(ctx, "PUT", `/projects/${ref}/ssl-enforcement`, { requestedConfig: { database: true } });
      const sslPutS = Math.round((Date.now() - tSsl) / 1000);
      const g1 = await api(ctx, "GET", `/projects/${ref}/jit-access`);
      const sslOnBefore = (sslBefore.json as { currentConfig?: { database?: boolean } } | undefined)?.currentConfig?.database;
      push({
        id: "JA01b",
        title: "JA01b: gates before enabling (SSL enforcement)",
        status: "info",
        detail: `fresh project: ssl database=${String(sslOnBefore)}; GET jit-access ${g0.status} ${scrub.text(g0.text).slice(0, 120)}; PUT enabled before enforcement -> ${putEarly.status} ${scrub.text(putEarly.text).slice(0, 120)}; GET database/jit/list -> ${listEarly.status}; PUT ssl-enforcement -> ${sslPut.status} (${sslPutS}s); GET jit-access after -> ${scrub.text(g1.text).slice(0, 100)}`,
        measurements: {
          ssl_enforced_at_create: String(sslOnBefore),
          get_before_status: g0.status,
          get_before_state: String((g0.json as { state?: string } | undefined)?.state ?? ""),
          get_before_reason: String((g0.json as { unavailableReason?: string } | undefined)?.unavailableReason ?? ""),
          put_enabled_early_status: putEarly.status,
          list_early_status: listEarly.status,
          ssl_put_status: sslPut.status,
          get_after_ssl_state: String((g1.json as { state?: string } | undefined)?.state ?? ""),
        },
      });

      /* ---------------- JA01c: enable ---------------- */
      const en = await api(ctx, "PUT", `/projects/${ref}/jit-access`, { state: "enabled" });
      const g2 = await api(ctx, "GET", `/projects/${ref}/jit-access`);
      const state2 = String((g2.json as { state?: string } | undefined)?.state ?? "");
      push({
        id: "JA01c",
        title: "JA01c: enable temporary access",
        status: en.status === 200 && state2 === "enabled" ? "pass" : "fail",
        detail: `PUT jit-access enabled -> ${en.status} ${scrub.text(en.text).slice(0, 100)}; read-back state=${state2}`,
        measurements: { put_status: en.status, readback_state: state2 },
      });
      if (state2 !== "enabled") throw new Error("temporary access did not enable");

      // custom least-privilege role for JA01d/f/g (LOGIN, no password)
      const mk = await sql({ ...ctx, ref }, "create role ja_reader login; grant usage on schema public to ja_reader; grant select on all tables in schema public to ja_reader;");
      ctx.log(`ja_reader create: HTTP ${mk.status}${mk.error ? ` ${mk.error}` : ""}`);

      /* ---------------- connection targets ---------------- */
      const poolCfg = await api(ctx, "GET", `/projects/${ref}/config/database/pooler`);
      const poolHost = String(((poolCfg.json as { db_host?: string }[] | undefined) ?? [])[0]?.db_host ?? "");
      const docsHost = poolHost.replace(/^aws-0-/, "aws-1-");
      const dns = await resolveDirect(ref);
      const dhost = `db.${ref}.supabase.co`;
      const T = {
        pool6543: (role: string): Target => ({ name: "pooler_6543_jit", host: poolHost, port: 6543, user: `${role}.${ref}`, options: "-c jit=true" }),
        pool5432: (role: string): Target => ({ name: "pooler_5432_jit", host: poolHost, port: 5432, user: `${role}.${ref}`, options: "-c jit=true" }),
        poolDocs: (role: string): Target => ({ name: "pooler_docs_host_5432_jit", host: docsHost, port: 5432, user: `${role}.${ref}`, options: "-c jit=true" }),
        poolNoJit: (role: string): Target => ({ name: "pooler_5432_no_option", host: poolHost, port: 5432, user: `${role}.${ref}` }),
        direct: (role: string): Target => ({ name: "direct_5432", host: dhost, hostaddr: dns.v6[0], port: 5432, user: role }),
        dedicated: (role: string): Target => ({ name: "dedicated_pooler_6543", host: dhost, hostaddr: dns.v6[0], port: 6543, user: role }),
      };
      scrub.add(dns.v6[0], "<direct-ipv6>");
      const pat = ctx.pat ?? "";

      const bansCheck = async (): Promise<{ banned: number; lifted: number }> => {
        const r = await api(ctx, "POST", `/projects/${ref}/network-bans/retrieve`);
        const n = ((r.json as { banned_ipv4_addresses?: string[] } | undefined)?.banned_ipv4_addresses ?? []).length;
        let lifted = 0;
        if (n > 0) {
          const d = await api(ctx, "DELETE", `/projects/${ref}/network-bans`, { ipv4_addresses: [], requester_ip: true });
          lifted = d.status;
        }
        return { banned: n, lifted };
      };
      const grantPut = (roles: RoleGrant[], key: "roles" | "user_roles" = "roles") =>
        api(ctx, "PUT", `/projects/${ref}/database/jit`, { user_id: uid, [key]: roles });
      const listRoles = async (): Promise<{ status: number; roles: Array<{ role: string; expires_at?: number }>; items: number; itemKeys: string }> => {
        const l = await api(ctx, "GET", `/projects/${ref}/database/jit/list`);
        const items = ((l.json as { items?: Array<{ user_id?: string; user_roles?: Array<{ role: string; expires_at?: number }> }> } | undefined)?.items ?? []);
        const mine = items.find((i) => i.user_id === uid);
        return { status: l.status, roles: mine?.user_roles ?? [], items: items.length, itemKeys: keysOf(items[0]) };
      };
      /** Retry a fresh connection every 2 s until it works; seconds taken, or -1. */
      const connectWithin = async (t: Target, sqlText: string, maxS: number, pw = pat, appName = "jitprobe") => {
        const s0 = Date.now();
        let last = { ok: false, out: "", raw: "", ms: 0 };
        const kinds: string[] = [];
        while ((Date.now() - s0) / 1000 < maxS) {
          last = psql(scrub, t, pw, sqlText, appName);
          if (last.ok) return { s: Math.round((Date.now() - s0) / 100) / 10, r: last, kinds };
          const k = kindOf(last.out);
          if (!kinds.includes(k)) kinds.push(k);
          // an open circuit breaker is not retried every 2 s: each failure would extend it
          await sleep(k === BREAKER ? 30_000 : 2000);
        }
        return { s: -1, r: last, kinds };
      };
      /**
       * One refused login, classified. If the pooler's circuit breaker answered
       * instead of the JIT check, wait and ask again so the recorded kind is the
       * real one; `maskedS` is the time that took.
       */
      const refusal = async (t: Target, appName: string) => {
        const s0 = Date.now();
        let r = psql(scrub, t, pat, "select 1", appName);
        const firstKind = r.ok ? "ok" : kindOf(r.out);
        while (!r.ok && kindOf(r.out) === BREAKER && Date.now() - s0 < 420_000) {
          await sleep(45_000);
          r = psql(scrub, t, pat, "select 1", appName);
        }
        return { r, firstKind, kind: r.ok ? "ok" : kindOf(r.out), maskedS: Math.round((Date.now() - s0) / 1000) };
      };

      /* ---------------- JA01d: grant API shape ---------------- */
      const e1 = nowS() + 900;
      const putA = await grantPut([{ role: "postgres", expires_at: e1 }], "roles");
      const putB = await grantPut([{ role: "postgres", expires_at: e1 }], "user_roles");
      const keysA = keysOf(putA.json);
      const afterB = await listRoles();
      // replace vs merge: PUT ja_reader alone, read back which roles remain
      const putC = await grantPut([{ role: "ja_reader", expires_at: e1 }], "roles");
      const afterC = await listRoles();
      const getJit = await api(ctx, "GET", `/projects/${ref}/database/jit`);
      const post = await api(ctx, "POST", `/projects/${ref}/database/jit`, { role: "postgres", rhost: vantage4 || "203.0.113.10" });
      const merged = afterC.roles.map((r) => r.role).sort().join("+");
      push({
        id: "JA01d",
        title: "JA01d: grant API shape (roles vs user_roles, replace vs merge, read routes)",
        status: putA.status === 200 ? "pass" : "fail",
        detail: `PUT database/jit with body key roles -> ${putA.status} (response keys ${keysA}); with docs key user_roles -> ${putB.status} ${putB.status >= 300 ? scrub.text(putB.text).slice(0, 120) : ""}; after that PUT the list shows [${afterB.roles.map((r) => r.role).join(",")}]; then PUT [ja_reader] alone -> ${putC.status}, list shows [${merged}] (${merged === "ja_reader" ? "PUT replaces the user's role set" : "PUT merges"}). GET database/jit -> ${getJit.status}; POST database/jit {role,rhost} -> ${post.status} ${scrub.text(post.text).slice(0, 100)}`,
        measurements: {
          put_roles_key_status: putA.status,
          put_user_roles_key_status: putB.status,
          put_response_keys: keysA,
          list_status: afterC.status,
          list_item_keys: afterC.itemKeys,
          roles_after_second_put: merged,
          get_database_jit_status: getJit.status,
          post_database_jit_status: post.status,
          post_response_keys: keysOf(post.json),
        },
      });

      /* ---------------- JA01e: connection matrix ---------------- */
      const e2 = nowS() + 1800;
      const tGrant = Date.now();
      const put2 = await grantPut(
        [
          { role: "postgres", expires_at: e2 },
          { role: "ja_reader", expires_at: e2 },
        ],
        "roles",
      );
      const q = "select current_user || '/' || session_user";
      const first = await connectWithin(T.pool6543("postgres"), q, 60, pat, app("pool6543"));
      const grantToConnectS = first.s;
      const rows: Array<{ t: Target; role: string; expectOk: boolean | null; ap: string }> = [
        { t: T.pool5432("postgres"), role: "postgres", expectOk: true, ap: app("pool5432") },
        { t: T.poolDocs("postgres"), role: "postgres", expectOk: null, ap: app("pooldocs") },
        { t: T.direct("postgres"), role: "postgres", expectOk: true, ap: app("direct") },
        { t: T.poolNoJit("postgres"), role: "postgres", expectOk: false, ap: app("nojit") },
        { t: T.dedicated("postgres"), role: "postgres", expectOk: false, ap: app("dedicated") },
        { t: { ...T.pool5432("supabase_admin"), name: "pooler_5432_jit_unmapped_role" }, role: "supabase_admin", expectOk: false, ap: app("unmapped") },
      ];
      const matrix: Record<string, string> = { pooler_6543_jit: first.r.ok ? `ok ${first.r.out}` : `refused ${first.r.out.slice(0, 150)}` };
      const matrixKinds: Record<string, string> = { pooler_6543_jit: first.r.ok ? "ok" : kindOf(first.r.out) };
      let matrixOk = first.r.ok;
      for (const row of rows) {
        const r = psql(scrub, row.t, pat, q, row.ap);
        matrix[row.t.name] = r.ok ? `ok ${r.out}` : `refused ${r.out.slice(0, 150)}`;
        matrixKinds[row.t.name] = r.ok ? "ok" : kindOf(r.out);
        if (row.expectOk !== null && r.ok !== row.expectOk) matrixOk = false;
      }
      push({
        id: "JA01e",
        title: "JA01e: connection matrix with the PAT as the Postgres password",
        status: matrixOk ? "pass" : "fail",
        detail: `PUT grant -> ${put2.status}; first pooler login ${grantToConnectS} s after the PUT returned. ` + Object.entries(matrix).map(([k, v]) => `${k}: ${v}`).join("; "),
        measurements: {
          grant_status: put2.status,
          grant_to_first_login_s: grantToConnectS,
          ...Object.fromEntries(Object.entries(matrixKinds).map(([k, v]) => [k, v])),
          direct_dns_aaaa: dns.v6.length,
          direct_dns_a: dns.v4.length,
          pooler_host_family: poolHost.replace(/^aws-(\d+)-.*/, "aws-$1"),
          docs_host_family: docsHost.replace(/^aws-(\d+)-.*/, "aws-$1"),
        },
        evidence: Object.entries(matrix).map(([k, v]) => `${k}: ${v}`).join("\n"),
      });
      const ban1 = await bansCheck();

      /* ---------------- JA01f: what a session sees ---------------- */
      const who = (t: Target) =>
        psql(scrub, t, pat, "select current_user, session_user, (select usename from pg_stat_activity where pid=pg_backend_pid()), (select application_name from pg_stat_activity where pid=pg_backend_pid()), (select rolsuper from pg_roles where rolname=current_user)", app("who"));
      const wPool = who(T.pool5432("postgres"));
      const wDirect = who(T.direct("postgres"));
      const wRead = who(T.pool5432("ja_reader"));
      const ddl = psql(scrub, T.pool5432("ja_reader"), pat, "create table public.ja_denied(i int)", app("ddl"));
      const clientV6 = psql(scrub, T.direct("postgres"), pat, "select inet_client_addr()", app("addr"));
      const v6Seen = clientV6.ok ? clientV6.raw.replace(/\/\d+$/, "") : "";
      scrub.add(v6Seen, "<client-ipv6>");
      push({
        id: "JA01f",
        title: "JA01f: identity inside a PAT-authenticated session",
        status: wPool.ok && wDirect.ok && wRead.ok && !ddl.ok ? "pass" : "fail",
        detail: `pooler as postgres: ${wPool.out}; direct as postgres: ${wDirect.out}; pooler as ja_reader: ${wRead.out}; ja_reader CREATE TABLE: ${ddl.ok ? "ALLOWED" : ddl.out.slice(0, 80)}`,
        measurements: {
          pooler_postgres: wPool.out,
          direct_postgres: wDirect.out,
          pooler_custom_role: wRead.out,
          custom_role_create_table: ddl.ok ? "allowed" : "denied",
        },
      });
      // a failed JA01f read (no v6) must not abort the later phases
      const clientV6Safe = /:/.test(v6Seen) ? v6Seen : "";

      /* ---------------- JA01g: expiry ---------------- */
      const EXP_S = 75;
      const WINDOW_AFTER_S = 70;
      const WATCH_TO_S = 300;
      const tg = nowS();
      const expSec = tg + EXP_S;
      const expMs = (tg + EXP_S) * 1000;
      const putE = await grantPut(
        [
          { role: "postgres", expires_at: expSec },
          { role: "ja_reader", expires_at: expMs },
        ],
        "roles",
      );
      const stored = await listRoles();
      const storedPg = stored.roles.find((r) => r.role === "postgres")?.expires_at;
      const storedRd = stored.roles.find((r) => r.role === "ja_reader")?.expires_at;
      const okPg = await connectWithin(T.pool5432("postgres"), "select 1", 420, pat, app("exp-open-pool"));
      const okDirect = psql(scrub, T.direct("postgres"), pat, "select 1", app("exp-open-direct"));
      const okRd = psql(scrub, T.pool5432("ja_reader"), pat, "select 1", app("exp-open-rd"));
      // the clock starts from the PUT: a breaker wait above would eat into the expiry window
      const expLeftS = expSec - nowS();
      const heldPool = new Held(T.pool5432("postgres"), pat, app("held-exp-pool"));
      const heldDirect = new Held(T.direct("postgres"), pat, app("held-exp-direct"));
      // a session for the role whose expires_at was written in milliseconds
      const heldRd = new Held(T.direct("ja_reader"), pat, app("held-exp-rd"));
      heldAll.push(heldPool, heldDirect, heldRd);
      await sleep(2500);
      const heldPoolOk0 = await heldPool.ping();
      const heldDirectOk0 = await heldDirect.ping();
      const heldRdOk0 = await heldRd.ping();
      type Probe = { name: string; t: Target; refusedAt: number; msg: string; kind: string; firstKind: string };
      const probes: Probe[] = [
        { name: "pg_pooler_seconds", t: T.pool5432("postgres"), refusedAt: -1, msg: "", kind: "", firstKind: "" },
        { name: "pg_direct_seconds", t: T.direct("postgres"), refusedAt: -1, msg: "", kind: "", firstKind: "" },
        // direct path: it has no circuit breaker, so a refusal here is the JIT check
        { name: "rd_direct_millis", t: T.direct("ja_reader"), refusedAt: -1, msg: "", kind: "", firstKind: "" },
      ];
      // A stall of the orchestrator itself (run 3 of this module lost ~225 s here) would
      // read as a platform event: every loop records its largest gap between iterations.
      let stallMaxS = 0;
      let lastTick = Date.now();
      const tick = () => {
        const n = Date.now();
        stallMaxS = Math.max(stallMaxS, Math.round((n - lastTick) / 1000));
        lastTick = n;
      };
      while (nowS() < expSec + WINDOW_AFTER_S && probes.some((p) => p.refusedAt < 0)) {
        tick();
        // probe only from 3 s before expiry so that no refused login is spent early
        if (nowS() >= expSec - 3) {
          for (const p of probes) {
            if (p.refusedAt >= 0) continue;
            const r = psql(scrub, p.t, pat, "select 1", app(`exp-${p.name}`));
            if (!r.ok) {
              p.refusedAt = nowS();
              p.firstKind = kindOf(r.out);
              p.msg = r.out.slice(0, 160);
              p.kind = p.firstKind;
            }
          }
        }
        await sleep(500);
      }
      // a breaker answer is not the expiry check: ask again once it has cleared
      let breakerWaitS = 0;
      for (const p of probes) {
        if (p.firstKind === BREAKER) {
          const rr = await refusal(p.t, app(`exp-re-${p.name}`));
          p.kind = rr.kind;
          p.msg = rr.r.out.slice(0, 160);
          breakerWaitS += rr.maskedS;
        }
      }
      const ban2 = await bansCheck();
      const heldPoolAfter = await heldPool.ping();
      const heldDirectAfter = await heldDirect.ping();
      const heldRdAfter = await heldRd.ping();
      // keep watching the held sessions: does the platform ever close the session of an expired grant?
      const watchEnd = expSec + WATCH_TO_S;
      const died: Record<string, number> = { pooler_postgres: heldPoolAfter ? -1 : nowS() - expSec, direct_postgres: heldDirectAfter ? -1 : nowS() - expSec, direct_ja_reader_ms: heldRdAfter ? -1 : nowS() - expSec };
      const holders: Array<[string, Held]> = [["pooler_postgres", heldPool], ["direct_postgres", heldDirect], ["direct_ja_reader_ms", heldRd]];
      while (nowS() < watchEnd && Object.values(died).some((v) => v < 0)) {
        tick();
        for (const [name, h] of holders) {
          if (died[name]! < 0 && !(await h.ping(4000))) died[name] = nowS() - expSec;
        }
        await sleep(5000);
      }
      const diedTxt = (k: string) => (died[k]! < 0 ? `alive at expiry+${WATCH_TO_S}s` : `closed at expiry+${died[k]}s`);
      const rel = (p: Probe) => (p.refusedAt < 0 ? `not refused within expiry+${WINDOW_AFTER_S}s` : `refused ${p.refusedAt - expSec >= 0 ? "+" : ""}${p.refusedAt - expSec}s`);
      push({
        id: "JA01g",
        title: "JA01g: expiry of a granted role (seconds vs milliseconds unit; open sessions)",
        status: stallMaxS > 20 ? "fail" : probes[0]!.refusedAt >= 0 && heldPoolOk0 ? "pass" : "fail",
        detail: `grants: postgres expires_at=now+${EXP_S}s in epoch SECONDS, ja_reader the same instant in epoch MILLISECONDS; stored back as ${storedPg} / ${storedRd}. Logins before expiry (the pooler login took ${okPg.s} s; ${expLeftS} s were left of ${EXP_S}): pooler ${okPg.r.ok ? "ok" : "FAIL"}, direct ${okDirect.ok ? "ok" : "FAIL"}, ja_reader pooler ${okRd.ok ? "ok" : "FAIL"}. First refusal vs expires_at: ${probes.map((p) => `${p.name} ${rel(p)} [${p.kind || "-"}]`).join("; ")}. Held sessions (open before expiry: pooler ${heldPoolOk0}, direct ${heldDirectOk0}, ja_reader direct ${heldRdOk0}) pinged every 5 s after the probe window: pooler postgres ${diedTxt("pooler_postgres")}; direct postgres ${diedTxt("direct_postgres")}; direct ja_reader (ms grant) ${diedTxt("direct_ja_reader_ms")}. Largest gap between watch-loop iterations ${stallMaxS} s. Bans after phase: ${ban2.banned}`,
        measurements: {
          put_status: putE.status,
          expires_in_s: EXP_S,
          pre_expiry_login_pooler: okPg.r.ok ? "ok" : "refused",
          pre_expiry_login_direct: okDirect.ok ? "ok" : "refused",
          pre_expiry_login_ja_reader: okRd.ok ? "ok" : "refused",
          pg_pooler_refused_after_expiry_s: probes[0]!.refusedAt < 0 ? "never" : probes[0]!.refusedAt - expSec,
          pg_direct_refused_after_expiry_s: probes[1]!.refusedAt < 0 ? "never" : probes[1]!.refusedAt - expSec,
          ja_reader_ms_direct_refused_after_expiry_s: probes[2]!.refusedAt < 0 ? "never" : probes[2]!.refusedAt - expSec,
          refusal_kind_pooler: probes[0]!.kind,
          refusal_first_kind_pooler: probes[0]!.firstKind,
          refusal_kind_direct: probes[1]!.kind,
          refusal_kind_ja_reader_direct: probes[2]!.kind,
          breaker_wait_s: breakerWaitS,
          refusal_text_pooler: probes[0]!.msg,
          refusal_text_direct: probes[1]!.msg,
          refusal_text_ja_reader_direct: probes[2]!.msg,
          held_pooler_alive_before: String(heldPoolOk0),
          held_direct_alive_before: String(heldDirectOk0),
          held_ja_reader_alive_before: String(heldRdOk0),
          held_pooler_after_70s: String(heldPoolAfter),
          held_direct_after_70s: String(heldDirectAfter),
          held_pooler_closed_after_expiry_s: died.pooler_postgres! < 0 ? "alive" : died.pooler_postgres!,
          held_direct_closed_after_expiry_s: died.direct_postgres! < 0 ? "alive" : died.direct_postgres!,
          held_ja_reader_closed_after_expiry_s: died.direct_ja_reader_ms! < 0 ? "alive" : died.direct_ja_reader_ms!,
          watch_window_s: WATCH_TO_S,
          stall_max_gap_s: stallMaxS,
          bans_after: ban2.banned,
        },
      });
      heldPool.close();
      heldDirect.close();
      heldRd.close();

      /* ---------------- JA01h: extension after expiry ---------------- */
      const e3 = nowS() + 1200;
      const tExt = Date.now();
      const putX = await grantPut(
        [
          { role: "postgres", expires_at: e3 },
          { role: "ja_reader", expires_at: e3 },
        ],
        "roles",
      );
      const backDirect = await connectWithin(T.direct("postgres"), "select 1", 60, pat, app("ext-direct"));
      const back = await connectWithin(T.pool5432("postgres"), "select 1", 420, pat, app("ext-pool"));
      push({
        id: "JA01h",
        title: "JA01h: extending an expired grant",
        status: backDirect.s >= 0 && back.s >= 0 ? "pass" : "fail",
        detail: `PUT later expires_at -> ${putX.status}; fresh direct login works ${backDirect.s} s later, pooler ${back.s} s later (-1 = never within the wait; refusal kinds seen on the pooler before it worked: [${back.kinds.join(",")}]); total ${Math.round((Date.now() - tExt) / 1000)} s`,
        measurements: { put_status: putX.status, extension_to_pooler_login_s: back.s, extension_to_direct_login_s: backDirect.s, pooler_kinds_before_success: back.kinds.join(",") },
      });

      /* ---------------- JA01i: revocation ---------------- */
      const revoke = async (label: string, doRevoke: () => Promise<{ status: number; text: string }>, restore: () => Promise<void>) => {
        // a held pooler session needs a pooler that is answering: wait out a breaker first
        const pre = await connectWithin(T.pool5432("postgres"), "select 1", 420, pat, app(`pre-${label}`));
        const hp = new Held(T.pool5432("postgres"), pat, app(`held-${label}-pool`));
        const hd = new Held(T.direct("postgres"), pat, app(`held-${label}-direct`));
        heldAll.push(hp, hd);
        await sleep(2500);
        const before = [await hp.ping(), await hd.ping()];
        const tr = Date.now();
        const rr = await doRevoke();
        const apiS = Math.round((Date.now() - tr) / 100) / 10;
        let poolRef = -1;
        let directRef = -1;
        let poolMsg = "";
        let directMsg = "";
        let poolFirstKind = "";
        let poolKind = "";
        let directKind = "";
        let breakerWaitS = 0;
        while ((Date.now() - tr) / 1000 < 45 && (poolRef < 0 || directRef < 0)) {
          if (poolRef < 0) {
            const r = psql(scrub, T.pool5432("postgres"), pat, "select 1", app(`rev-${label}-pool`));
            if (!r.ok) {
              poolRef = Math.round((Date.now() - tr) / 100) / 10;
              poolMsg = r.out.slice(0, 160);
              poolFirstKind = kindOf(r.out);
              poolKind = poolFirstKind;
            }
          }
          if (directRef < 0) {
            const r = psql(scrub, T.direct("postgres"), pat, "select 1", app(`rev-${label}-direct`));
            if (!r.ok) {
              directRef = Math.round((Date.now() - tr) / 100) / 10;
              directMsg = r.out.slice(0, 160);
              directKind = kindOf(r.out);
            }
          }
          if (poolRef < 0 || directRef < 0) await sleep(2000);
        }
        if (poolFirstKind === BREAKER) {
          const rr = await refusal(T.pool5432("postgres"), app(`rev-re-${label}-pool`));
          poolKind = rr.kind;
          poolMsg = rr.r.out.slice(0, 160);
          breakerWaitS = rr.maskedS;
        }
        await sleep(15_000);
        const after = [await hp.ping(), await hd.ping()];
        const bans = await bansCheck();
        hp.close();
        hd.close();
        const listedBeforeRestore = await listRoles();
        const tRestore = Date.now();
        await restore();
        const restored = await connectWithin(T.pool5432("postgres"), "select 1", 420, pat, app(`rest-${label}`));
        return { listedBeforeRestore: listedBeforeRestore.roles.map((r) => r.role).join(",") || "none", preS: pre.s, poolFirstKind, poolKind, directKind, breakerWaitS, before, after, apiS, apiStatus: rr.status, apiText: rr.text, poolRef, directRef, poolMsg, directMsg, bans, restoredS: restored.s, restoreTotalS: Math.round((Date.now() - tRestore) / 1000) };
      };
      const del = await revoke(
        "delete",
        () => api(ctx, "DELETE", `/projects/${ref}/database/jit/${uid}`),
        async () => {
          await grantPut([{ role: "postgres", expires_at: nowS() + 1200 }], "roles");
        },
      );
      const dis = await revoke(
        "disable",
        () => api(ctx, "PUT", `/projects/${ref}/jit-access`, { state: "disabled" }),
        async () => {
          await api(ctx, "PUT", `/projects/${ref}/jit-access`, { state: "enabled" });
        },
      );
      const fmt = (x: number) => (x < 0 ? "not refused within 45 s" : `${x} s`);
      push({
        id: "JA01i",
        title: "JA01i: revocation by deleting the mapping and by disabling temporary access",
        status: del.poolRef >= 0 && del.directRef >= 0 ? "pass" : "fail",
        detail: `DELETE database/jit/{user_id} -> ${del.apiStatus} (${del.apiS} s); first refusal pooler ${fmt(del.poolRef)}, direct ${fmt(del.directRef)}; held sessions alive before/after ${del.before.join("/")} -> ${del.after.join("/")} (pooler, direct); re-grant then fresh login ${del.restoredS} s. PUT jit-access disabled -> ${dis.apiStatus} (${dis.apiS} s); first refusal pooler ${fmt(dis.poolRef)}, direct ${fmt(dis.directRef)}; held sessions ${dis.before.join("/")} -> ${dis.after.join("/")}; PUT enabled then fresh login ${dis.restoredS} s. Mapping listed after the refusals and before any restore step: after DELETE [${del.listedBeforeRestore}], after disable [${dis.listedBeforeRestore}] (the disable step restores only by PUT enabled, so a login that works again shows the mapping survived). Bans: ${del.bans.banned}/${dis.bans.banned}. Refusal kinds (pooler/direct): delete ${del.poolKind}/${del.directKind}, disable ${dis.poolKind}/${dis.directKind}. Refusal text: ${del.poolMsg} | ${del.directMsg}`,
        measurements: {
          delete_status: del.apiStatus,
          delete_pooler_refused_s: del.poolRef,
          delete_direct_refused_s: del.directRef,
          delete_pre_login_s: del.preS,
          delete_pooler_refusal_kind: del.poolKind,
          delete_pooler_first_kind: del.poolFirstKind,
          delete_direct_refusal_kind: del.directKind,
          delete_breaker_wait_s: del.breakerWaitS,
          delete_held_pooler_before: String(del.before[0]),
          delete_held_direct_before: String(del.before[1]),
          delete_held_pooler_after: String(del.after[0]),
          delete_held_direct_after: String(del.after[1]),
          delete_regrant_login_s: del.restoredS,
          disable_status: dis.apiStatus,
          disable_pooler_refused_s: dis.poolRef,
          disable_direct_refused_s: dis.directRef,
          disable_pre_login_s: dis.preS,
          disable_pooler_refusal_kind: dis.poolKind,
          disable_pooler_first_kind: dis.poolFirstKind,
          disable_direct_refusal_kind: dis.directKind,
          disable_breaker_wait_s: dis.breakerWaitS,
          disable_held_pooler_before: String(dis.before[0]),
          disable_held_direct_before: String(dis.before[1]),
          disable_held_pooler_after: String(dis.after[0]),
          disable_held_direct_after: String(dis.after[1]),
          disable_reenable_login_s: dis.restoredS,
          roles_listed_after_delete: del.listedBeforeRestore,
          roles_listed_after_disable: dis.listedBeforeRestore,
          bans_after: del.bans.banned + dis.bans.banned,
        },
        evidence: `delete refusal: ${del.poolMsg} | ${del.directMsg}\ndisable refusal: ${dis.poolMsg} | ${dis.directMsg}`,
      });

      /* ---------------- JA01j: allowed_networks ---------------- */
      const netTry = async (cidrs: string[], cidrs6: string[], label: string, probePooler = true, expectPoolerOk = false) => {
        const roles: RoleGrant[] = [
          {
            role: "postgres",
            expires_at: nowS() + 1200,
            allowed_networks: { allowed_cidrs: cidrs.map((cidr) => ({ cidr })), ...(cidrs6.length ? { allowed_cidrs_v6: cidrs6.map((cidr) => ({ cidr })) } : {}) },
          },
        ];
        const p = await grantPut(roles, "roles");
        await sleep(3000);
        // The pooler's view of a grant lags the API by a few seconds (JA01i), so a login that
        // should now be ALLOWED is retried for up to 30 s; one that should be refused is asked once.
        let a: { ok: boolean; out: string; raw: string; ms: number } = { ok: false, out: "not probed", raw: "", ms: 0 };
        let poolKind = "not probed";
        let poolMasked = 0;
        if (probePooler && expectPoolerOk) {
          const c = await connectWithin(T.pool5432("postgres"), "select inet_client_addr()", 30, pat, app(`net-${label}-pool`));
          a = c.r;
          poolKind = c.r.ok ? "ok" : kindOf(c.r.out);
          poolMasked = c.s;
        } else if (probePooler) {
          const rp = await refusal(T.pool5432("postgres"), app(`net-${label}-pool`));
          a = rp.r;
          poolKind = rp.kind;
          poolMasked = rp.maskedS;
        }
        const b = psql(scrub, T.direct("postgres"), pat, "select inet_client_addr()", app(`net-${label}-direct`));
        return { put: p.status, pool: a, direct: b, poolKind, poolMasked };
      };
      const n1 = await netTry(["192.0.2.0/24"], [], "doc");
      const n2 = vantage4 ? await netTry([`${vantage4}/32`], [], "v4") : null;
      const n3 = vantage4 && clientV6Safe ? await netTry([`${vantage4}/32`], [`${clientV6Safe}/128`], "v4v6", false) : null;
      // The pooler verdict for the vantage-IPv4-only grant differed between runs of this module
      // (refused in three, allowed in one), so it is asked repeatedly: 3 trials against the
      // documentation range, 4 against the vantage /32, 8 s apart, stopping if the breaker answers.
      const trials = async (cidrs: string[], n: number, label: string): Promise<string> => {
        await grantPut([{ role: "postgres", expires_at: nowS() + 1200, allowed_networks: { allowed_cidrs: cidrs.map((cidr) => ({ cidr })) } }], "roles");
        await sleep(6000);
        const out: string[] = [];
        for (let i = 0; i < n; i++) {
          const r = psql(scrub, T.pool5432("postgres"), pat, "select inet_client_addr()", app(`trial-${label}-${i}`));
          const k = r.ok ? (r.raw.includes(":") ? "ok-v6" : "ok-v4") : kindOf(r.out);
          out.push(k);
          if (k === BREAKER) break;
          if (i < n - 1) await sleep(8000);
        }
        return out.join(",");
      };
      const trialDoc = await trials(["192.0.2.0/24"], 3, "doc");
      const trialV4 = vantage4 ? await trials([`${vantage4}/32`], 4, "v4") : "not run";
      // every IPv6 address, to see which address the pooler path is judged on
      const n4 = vantage4 ? await netTry([`${vantage4}/32`], ["::/0"], "v6any", true, true) : null;
      const poolerSeen = n4?.pool.ok ? n4.pool.raw.replace(/\/\d+$/, "") : "";
      scrub.add(poolerSeen, "<pooler-ipv6>");
      const poolerSeenFamily = poolerSeen ? (poolerSeen.includes(":") ? "ipv6" : "ipv4") : "unknown";
      const ban3 = await bansCheck();
      const res = (r: { ok: boolean; out?: string } | undefined) => (r ? (r.ok ? "ok" : r.out === "not probed" ? "not probed" : "refused") : "not run");
      push({
        id: "JA01j",
        title: "JA01j: allowed_networks on a granted role",
        status: n1.pool.ok === false && n1.direct.ok === false ? "pass" : "fail",
        detail: `documentation-range /24 only: PUT ${n1.put}, pooler ${res(n1.pool)}, direct ${res(n1.direct)}. Vantage IPv4 /32 only: PUT ${n2?.put ?? "-"}, pooler ${res(n2?.pool)}, direct ${res(n2?.direct)} (direct arrives from an IPv6 address). Vantage IPv4 /32 plus allowed_cidrs_v6 of the address the database saw for the direct session: PUT ${n3?.put ?? "-"}, pooler ${res(n3?.pool)}, direct ${res(n3?.direct)}. Vantage IPv4 /32 plus allowed_cidrs_v6 ::/0: PUT ${n4?.put ?? "-"}, pooler ${res(n4?.pool)}, direct ${res(n4?.direct)}; the address the database sees on a pooler session is ${poolerSeenFamily} (the pooler's, not the vantage's). Repeated pooler trials (8 s apart; ok-v4/ok-v6 = login worked and the database saw that address family; password = refused): documentation range [${trialDoc}]; vantage IPv4 /32 only [${trialV4}]. Bans after phase: ${ban3.banned}. Refusal text pooler: ${n1.pool.ok ? "-" : n1.pool.out.slice(0, 140)}; direct: ${n1.direct.ok ? "-" : n1.direct.out.slice(0, 140)}`,
        measurements: {
          doc_range_pooler: res(n1.pool),
          doc_range_direct: res(n1.direct),
          doc_range_pooler_trials: trialDoc,
          v4_only_pooler_trials: trialV4,
          doc_range_pooler_kind: n1.poolKind,
          v4_only_pooler_kind: n2?.poolKind ?? "not run",
          v6_any_pooler_kind: n4?.poolKind ?? "not run",
          v6_any_pooler_login_s: n4?.poolMasked ?? -1,
          v4_only_pooler: res(n2?.pool),
          v4_only_direct: res(n2?.direct),
          v4_plus_v6_pooler: res(n3?.pool),
          v4_plus_v6_direct: res(n3?.direct),
          v6_any_pooler: res(n4?.pool),
          v6_any_direct: res(n4?.direct),
          pooler_session_client_addr_family: poolerSeenFamily,
          bans_after: ban3.banned,
        },
      });
      // leave the project's mapping open for the log phase
      await grantPut([{ role: "postgres", expires_at: nowS() + 1200 }], "roles");
      await sleep(3000);

      /* ---------------- JA01k: logs ---------------- */
      const cfg = await api(ctx, "PUT", `/projects/${ref}/config/database/postgres`, { log_connections: true });
      await sleep(20_000);
      const lm = `ja${nonce}-log`;
      await connectWithin(T.pool5432("postgres"), "select 1", 420, pat, `-lpool`);
      const logTargets: Target[] = [T.pool5432("postgres"), T.direct("postgres"), T.dedicated("postgres"), T.poolNoJit("postgres")].slice(1);
      const logNames = ["ldirect", "ldedicated", "lnojit"];
      logTargets.forEach((t, i) => psql(scrub, t, pat, "select 1", `${lm}-${logNames[i]}`));
      const lag0 = Date.now();
      const email = await (async () => {
        const l = await api(ctx, "GET", `/projects/${ref}/database/jit/list`);
        const it = ((l.json as { items?: Array<{ primary_email?: string }> } | undefined)?.items ?? [])[0];
        return it?.primary_email ?? "";
      })();
      scrub.add(email, "<email>");
      type LogRow = { timestamp?: string; source?: string; event_message?: string; attrs?: string };
      let rowsFound: LogRow[] = [];
      let lagS = -1;
      let lastErr = "";
      while (Date.now() - lag0 < 420_000) {
        const r = await logsQuery({ ...ctx, ref }, `select timestamp, source, event_message, toString(log_attributes) as attrs from logs where event_message like '%${lm}%' or toString(log_attributes) like '%${lm}%' order by timestamp asc limit 100`, 1);
        lastErr = r.error;
        rowsFound = r.rows as LogRow[];
        const srcs = new Set(rowsFound.map((x) => String(x.source)));
        if (srcs.has("postgres_logs") && srcs.has("supavisor_logs")) {
          lagS = Math.round((Date.now() - lag0) / 1000);
          break;
        }
        await sleep(30_000);
      }
      await sleep(10_000);
      const conn = await logsQuery({ ...ctx, ref }, "select timestamp, event_message from logs where source = 'postgres_logs' and (event_message like 'connection authenticated%' or event_message like 'connection authorized%') order by timestamp asc limit 100", 1);
      await sleep(10_000);
      const idHits = await logsQuery(
        { ...ctx, ref },
        `select source, timestamp, event_message, toString(log_attributes) as attrs from logs where event_message like '%${uid}%' or toString(log_attributes) like '%${uid}%'${email ? ` or event_message like '%${email}%' or toString(log_attributes) like '%${email}%'` : ""} order by timestamp asc limit 8`,
        1,
      );
      const idSources = [...new Set((idHits.rows as LogRow[]).map((x) => String(x.source)))];
      const idSample = (idHits.rows as LogRow[]).slice(0, 3).map((x) => `${String(x.source)}: ${scrub.text(`${String(x.event_message ?? "")} ## ${String(x.attrs ?? "")}`).slice(0, 220)}`);
      await sleep(10_000);
      const tokHits = await logsQuery({ ...ctx, ref }, "select source, count(*) as n from logs where event_message like '%sbp_%' or toString(log_attributes) like '%sbp_%' group by source", 1);
      await sleep(10_000);
      const shut = await logsQuery({ ...ctx, ref }, "select timestamp, event_message from logs where source = 'postgres_logs' and event_message like 'received fast shutdown request%' order by timestamp asc limit 10", 1);
      const sslDeltas = (shut.rows as Array<{ timestamp?: string }>).map((x) => Math.round((Date.parse(`${String(x.timestamp)}Z`) - tSsl) / 1000));
      await sleep(10_000);
      const term = await logsQuery({ ...ctx, ref }, "select timestamp, event_message from logs where source = 'postgres_logs' and (event_message like 'terminating%' or event_message like '%administrator command%' or event_message like '%expire%' or event_message like '%JIT%' or event_message like '%jit%') order by timestamp asc limit 20", 1);
      const termLines = (term.rows as Array<{ timestamp?: string; event_message?: string }>).map((x) => `${String(x.timestamp)} ${scrub.text(String(x.event_message ?? "")).slice(0, 120)}`);
      const bySource = (s: string) => rowsFound.filter((x) => x.source === s);
      const pgLines = bySource("postgres_logs");
      const svLines = bySource("supavisor_logs");
      const svUsers = [...new Set(svLines.map((x) => /'user':'([^']*)'/.exec(String(x.attrs))?.[1]).filter(Boolean))].map((u) => scrub.text(String(u)));
      const svPeers = svLines.some((x) => /'peer_ip':'[^']+'/.test(String(x.attrs)));
      const methods = [...new Set((conn.rows as LogRow[]).map((x) => /method=([a-z0-9-]+)/.exec(String(x.event_message))?.[1]).filter(Boolean))];
      const identities = [...new Set((conn.rows as LogRow[]).map((x) => /identity="([^"]*)"/.exec(String(x.event_message))?.[1]).filter(Boolean))].map((u) => scrub.text(String(u)));
      const authorizedApps = [...new Set((conn.rows as LogRow[]).map((x) => /application_name=(\S+)/.exec(String(x.event_message))?.[1]).filter(Boolean))].map((a) => scrub.text(String(a)).replace(lm, "<marker>").replace(`ja${nonce}`, "<marker>"));
      const hitCount = (r: { rows: unknown[] }) => (r.rows as Array<{ n?: number | string }>).reduce((a, x) => a + Number(x.n ?? 0), 0);
      const idN = idHits.rows.length;
      const tokN = hitCount(tokHits);
      const lineOf = (x: LogRow) => scrub.text(String(x.event_message ?? "")).replace(new RegExp(lm, "g"), "<marker>").slice(0, 160);
      push({
        id: "JA01k",
        title: "JA01k: what the logs record for a PAT login (postgres_logs, supavisor_logs)",
        status: "info",
        detail: `log_connections PUT -> ${cfg.status}. Four marked logins (pooler jit, direct, dedicated pooler, pooler without option); marker rows found after ${lagS < 0 ? "420+ (not all sources appeared)" : lagS} s: postgres_logs ${pgLines.length}, supavisor_logs ${svLines.length}. Postgres connection lines carry method(s) [${methods.join(",")}] and identity [${identities.join(",")}]; application_name values on 'connection authorized' lines: [${authorizedApps.join(",")}]. supavisor_logs 'user' attribute values [${svUsers.join(",")}], peer_ip present: ${svPeers}. Rows (any source) containing the caller's user id or email: ${idN} (sources [${idSources.join(",")}]); rows containing 'sbp_': ${tokN}. 'received fast shutdown request' rows in the last hour: ${sslDeltas.length}, seconds relative to the PUT ssl-enforcement call: [${sslDeltas.join(",")}]. ${lastErr ? `last logs error: ${lastErr.slice(0, 80)}` : ""}`,
        measurements: {
          log_connections_put_status: cfg.status,
          marker_lag_s: lagS,
          postgres_logs_marker_rows: pgLines.length,
          supavisor_logs_marker_rows: svLines.length,
          postgres_auth_methods: methods.join(","),
          postgres_identity_values: identities.join(","),
          supavisor_user_values: svUsers.join(","),
          supavisor_peer_ip_present: String(svPeers),
          user_id_or_email_rows: idN,
          user_id_or_email_sources: idSources.join(","),
          token_prefix_rows: tokN,
          terminate_or_expire_rows: termLines.length,
          shutdown_rows_last_hour: sslDeltas.length,
          shutdown_vs_ssl_put_s: sslDeltas.join(","),
        },
        evidence: [...termLines.map((x) => `terminate/expire row: ${x}`), ...idSample.map((x) => `id/email hit -> ${x}`), ...pgLines.map((x) => `postgres_logs: ${lineOf(x)}`), ...(conn.rows as LogRow[]).slice(0, 12).map((x) => `postgres_logs: ${lineOf(x)}`)].join("\n").slice(0, 2500),
      });

      /* ---------------- JA01l: not run ---------------- */
      push({
        id: "JA01l",
        title: "JA01l: membership removal and PAT revocation (not run)",
        status: "skip",
        detail: "Removing the project member needs a second human user whose PAT is the Postgres password and an owner to remove them; revoking the PAT itself would revoke the only token this run holds (token creation is not on the /v1 API). The changelog claim that revoking project access immediately revokes database login is therefore doc-cited-not-tested here.",
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      for (const id of IDS) if (!has(id)) push({ id, title: id, status: "skip", detail: `not reached: ${scrub.text(msg).slice(0, 200)}` });
    } finally {
      for (const h of heldAll) h.close();
      if (ref && !reuse) {
        const d = await api(ctx, "DELETE", `/projects/${ref}`).catch(() => null);
        ctx.log(`delete project: HTTP ${d?.status ?? "error"}`);
      }
    }
    for (const id of IDS) if (!has(id)) push({ id, title: id, status: "skip", detail: "row never produced" });
    return results;
  },
};
export default mod;
