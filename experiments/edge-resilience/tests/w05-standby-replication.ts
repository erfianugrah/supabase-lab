/**
 * W05 - standby replication + token portability (the HA gate).
 *
 * Measures whether a managed->managed warm standby is possible and what
 * cutover costs: logical replication (publication on primary, subscription
 * on standby via the primary's DIRECT host), initial sync + lag, and
 * session survival via TPA-OIDC registration of the primary's issuer on
 * the standby (X02 token-portability mechanism in the DR context).
 *
 * Hard-won mechanics encoded here (do not regress):
 * - CREATE SUBSCRIPTION must be its OWN single-statement query: the
 *   Management query endpoint runs multi-statement strings in one
 *   transaction, and Postgres rejects CREATE SUBSCRIPTION inside a
 *   transaction block (the query endpoint then 400s).
 * - Standby REST reads need the STANDBY's publishable key
 *   (ctx.endpoints["standby_anon"]), never the primary's key.
 * - Verbatim errors matter: capture the query endpoint's response body,
 *   not just its status.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { mgmt } from "../../../harness/src/mgmt";

const mod: TestModule = {
  id: "W05",
  title: "standby replication + token portability (the HA gate)",
  where: "local",
  requires: ["pat", "anon-key", "peer"],
  destructive: true,

  async run(ctx: Ctx): Promise<TestResult> {
    const primary = ctx.ref;
    const standby = ctx.peers["standby"];
    const standbyAnon = ctx.endpoints["standby_anon"];
    const dbPw = ctx.dbPassword;
    const measurements: Record<string, string | number> = {};

    if (!standby || !standbyAnon || !dbPw) {
      return {
        id: "W05",
        title: this.title,
        status: "skip",
        detail: `missing peer/endpoints: standby=${standby ?? "absent"}, standby_anon=${standbyAnon ? "set" : "absent"}, dbPassword=${dbPw ? "set" : "absent"}`,
      };
    }

    // runSql: verbatim error capture - the response body IS the finding.
    const runSql = async (ref: string, query: string) => {
      const res = await mgmt(ctx, "POST", `/projects/${ref}/database/query`, { query });
      if (res.status >= 300) throw new Error(`HTTP ${res.status}: ${res.text.slice(0, 400)}`);
      return res;
    };

    const listTpa = async (ref: string) => {
      const r = await mgmt(ctx, "GET", `/projects/${ref}/config/auth/third-party-auth`);
      return Array.isArray(r.json) ? (r.json as Record<string, unknown>[]) : [];
    };

    const cleanup = async () => {
      // Subscription first, then publication, then TPA. (User deletion
      // happens in the run's inner finally.) Plain DROP is fine for a healthy
      // subscription; the wedged-subscription recovery (disable -> slot_name=
      // none -> drop) is the W09/W14 pattern. Best-effort throughout.
      await runSql(standby, `DROP SUBSCRIPTION IF EXISTS w05_sub`).catch(() => {});
      await runSql(primary, `DROP PUBLICATION IF EXISTS w05_pub`).catch(() => {});
      // Dropping the subscription on the standby leaves its replication slot
      // behind on the primary, where it pins WAL. Drop it too.
      await runSql(primary, `SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name = 'w05_sub'`).catch(() => {});
      const tpas = await listTpa(standby).catch(() => [] as Record<string, unknown>[]);
      for (const t of tpas) {
        if (typeof t.id === "string") {
          await mgmt(ctx, "DELETE", `/projects/${standby}/config/auth/third-party-auth/${t.id}`).catch(() => {});
        }
      }
    };

    try {
      // 1+2. Seed both sides (apply-both-sides DDL discipline).
      await runSql(primary, `DROP TABLE IF EXISTS public.w_repl; CREATE TABLE public.w_repl(id serial primary key, val text); INSERT INTO public.w_repl (val) VALUES ('r1'), ('r2'), ('r3')`);
      await runSql(primary, `DROP PUBLICATION IF EXISTS w05_pub`);
      await runSql(primary, `CREATE PUBLICATION w05_pub FOR TABLE public.w_repl`);
      await runSql(standby, `DROP SUBSCRIPTION IF EXISTS w05_sub`);
      await runSql(standby, `DROP TABLE IF EXISTS public.w_repl; CREATE TABLE public.w_repl(id serial primary key, val text)`);
      await runSql(standby, `CREATE TABLE IF NOT EXISTS public.w_probe(id int primary key); INSERT INTO public.w_probe VALUES (1) ON CONFLICT DO NOTHING`);
      measurements["ddl_applied_both_sides"] = "true";

      // 3. Gate A (direct host): single-statement CREATE SUBSCRIPTION.
      const directConn = `host=db.${primary}.supabase.co port=5432 dbname=postgres user=postgres password=${dbPw} sslmode=require connect_timeout=15`;
      let gateAOk = false;
      try {
        await runSql(standby, `CREATE SUBSCRIPTION w05_sub CONNECTION '${directConn}' PUBLICATION w05_pub`);
        gateAOk = true;
        measurements["gateA_ok"] = "true";
      } catch (e: any) {
        measurements["gateA_ok"] = "false";
        measurements["gateA_error"] = e.message;
      }

      // 4. Gate B (pooler): expected to fail - the pooler cannot stream WAL.
      // Only attempted when A succeeded (needs a subscription slot-free
      // standby); the verbatim error is the evidence.
      if (gateAOk) {
        await runSql(standby, `DROP SUBSCRIPTION IF EXISTS w05_sub`).catch(() => {});
        const poolerConn = `host=aws-0-ap-southeast-2.pooler.supabase.com port=5432 dbname=postgres user=postgres password=${dbPw} sslmode=require connect_timeout=15`;
        try {
          await runSql(standby, `CREATE SUBSCRIPTION w05_sub CONNECTION '${poolerConn}' PUBLICATION w05_pub`);
          measurements["gateB_unexpected_success"] = "true";
          await runSql(standby, `DROP SUBSCRIPTION IF EXISTS w05_sub`).catch(() => {});
        } catch (e: any) {
          measurements["gateB_error"] = e.message;
        }
        // Re-establish gate A for the rest of the drill.
        await runSql(standby, `CREATE SUBSCRIPTION w05_sub CONNECTION '${directConn}' PUBLICATION w05_pub`);
      }

      if (!gateAOk) {
        // Clean negative finding - both outcomes recorded verbatim.
        return {
          id: "W05",
          title: this.title,
          status: "pass",
          detail: `managed->managed replication blocked: ${measurements["gateA_error"]}`,
          measurements,
        };
      }

      // 5. Initial sync + replication lag (standby reads use STANDBY key).
      const standbyHeaders = { apikey: standbyAnon, Authorization: `Bearer ${standbyAnon}` };
      const syncStart = Date.now();
      let rowsSynced = 0;
      while (Date.now() - syncStart < 120_000) {
        const res = await fetch(`https://${standby}.supabase.co/rest/v1/w_repl?select=id`, {
          headers: standbyHeaders,
          signal: AbortSignal.timeout(30_000),
        });
        if (res.ok) {
          const data = (await res.json()) as unknown[];
          rowsSynced = data.length;
          if (rowsSynced >= 3) break;
        }
        await new Promise((r) => setTimeout(r, 3000));
      }
      measurements["initial_sync_ms"] = rowsSynced >= 3 ? Date.now() - syncStart : -1;
      measurements["initial_sync_rows"] = rowsSynced;

      const canaryVal = `canary-${Math.random().toString(36).slice(2, 8)}`;
      await runSql(primary, `INSERT INTO public.w_repl (val) VALUES ('${canaryVal}')`);
      const lagStart = Date.now();
      let lagMs = -1;
      while (Date.now() - lagStart < 60_000) {
        const res = await fetch(
          `https://${standby}.supabase.co/rest/v1/w_repl?select=val&val=eq.${canaryVal}`,
          { headers: standbyHeaders, signal: AbortSignal.timeout(30_000) },
        );
        if (res.ok) {
          const data = (await res.json()) as unknown[];
          if (data.length > 0) {
            lagMs = Date.now() - lagStart;
            break;
          }
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      measurements["replication_lag_ms"] = lagMs;

      // 6. Token portability: primary OIDC issuer as TPA on standby.
      // Idempotent: sweep any pre-existing registration for the same URL
      // (leftovers from manual drills or crashed runs block creation).
      const issuerUrl = `https://${primary}.supabase.co/auth/v1`;
      for (const t of await listTpa(standby).catch(() => [] as Record<string, unknown>[])) {
        if (t.oidc_issuer_url === issuerUrl && typeof t.id === "string") {
          await mgmt(ctx, "DELETE", `/projects/${standby}/config/auth/third-party-auth/${t.id}`).catch(() => {});
        }
      }
      const tpaCreate = await mgmt(ctx, "POST", `/projects/${standby}/config/auth/third-party-auth`, {
        oidc_issuer_url: issuerUrl,
      });
      if (tpaCreate.status >= 300) throw new Error(`TPA create failed: HTTP ${tpaCreate.status}: ${tpaCreate.text.slice(0, 300)}`);
      const t0 = Date.now();
      let resolved = false;
      while (Date.now() - t0 < 120_000) {
        const tpas = await listTpa(standby);
        const found = tpas.find((t) => t.oidc_issuer_url === issuerUrl);
        if (found?.resolved_jwks != null) {
          resolved = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 5000));
      }
      measurements["tpa_resolve_ms"] = Date.now() - t0;
      if (!resolved) throw new Error("TPA never resolved on standby");

      const email = `w05-${Math.random().toString(36).slice(2, 8)}@example.com`;
      const password = `W05-${Math.random().toString(36).slice(2, 10)}!`;
      const createRes = await fetch(`https://${ctx.apiHost}/auth/v1/admin/users`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: ctx.serviceKey!, Authorization: `Bearer ${ctx.serviceKey!}` },
        body: JSON.stringify({ email, password, email_confirm: true }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!createRes.ok) throw new Error(`admin create failed: HTTP ${createRes.status}`);
      const user = (await createRes.json()) as { id: string };
      try {
        const tokenRes = await fetch(`https://${ctx.apiHost}/auth/v1/token?grant_type=password`, {
          method: "POST",
          headers: { "Content-Type": "application/json", apikey: ctx.anonKey! },
          body: JSON.stringify({ email, password }),
          signal: AbortSignal.timeout(30_000),
        });
        if (!tokenRes.ok) throw new Error(`password grant failed: HTTP ${tokenRes.status}`);
        const { access_token } = (await tokenRes.json()) as { access_token: string };

        // JWKS trust lags TPA resolution (W01 finding: ~30s cold path).
        // Poll the probe - PGRST301 means PostgREST has not loaded the kid yet.
        const probeStart = Date.now();
        let attempts = 0;
        let lastStatus = 0;
        let lastBody = "";
        while (Date.now() - probeStart < 120_000) {
          attempts++;
          const probeRes = await fetch(`https://${standby}.supabase.co/rest/v1/w_probe?select=id`, {
            headers: { apikey: standbyAnon, Authorization: `Bearer ${access_token}` },
            signal: AbortSignal.timeout(30_000),
          });
          lastStatus = probeRes.status;
          if (probeRes.status === 200) break;
          lastBody = (await probeRes.text()).slice(0, 200);
          await new Promise((r) => setTimeout(r, 3000));
        }
        measurements["portability_status"] = lastStatus;
        measurements["portability_attempts"] = attempts;
        measurements["portability_warmup_ms"] = Date.now() - probeStart;
        if (lastStatus !== 200) {
          throw new Error(`portability probe failed after ${attempts} attempts: HTTP ${lastStatus}: ${lastBody}`);
        }
      } finally {
        await fetch(`https://${ctx.apiHost}/auth/v1/admin/users/${user.id}`, {
          method: "DELETE",
          headers: { apikey: ctx.serviceKey!, Authorization: `Bearer ${ctx.serviceKey!}` },
        }).catch(() => {});
      }

      const pass =
        measurements["gateA_ok"] === "true" &&
        (measurements["initial_sync_ms"] as number) >= 0 &&
        (measurements["replication_lag_ms"] as number) >= 0 &&
        measurements["portability_status"] === 200;

      return {
        id: "W05",
        title: this.title,
        status: pass ? "pass" : "fail",
        detail: pass
          ? `managed->managed standby works: sync ${measurements["initial_sync_ms"]}ms, lag ${measurements["replication_lag_ms"]}ms, sessions portable via TPA`
          : `see measurements`,
        measurements,
      };
    } catch (e: any) {
      return { id: "W05", title: this.title, status: "fail", detail: e.message, measurements };
    } finally {
      await cleanup();
    }
  },
};
export default mod;
