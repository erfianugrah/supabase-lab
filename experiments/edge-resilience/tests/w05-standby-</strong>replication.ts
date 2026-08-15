import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { mgmt } from "../../../harness/src/mgmt";

const mod: TestModule = {
  id: "W05",
  title: "standby replication + token portability",
  where: "local",
  requires: ["pat", "anon-key", "peer"],
  destructive: true,

  async run(ctx): Promise<TestResult | TestResult[]> {
    const standby = ctx.peers.standby;
    const standbyAnon = ctx.endpoints.standby_anon;
    if (!standby || !standbyAnon) {
      return {
        id: "W05",
        title: "standby replication + token portability",
        status: "skip",
        detail: "PVLAB_PEER_STANDBY or PVLAB_ENDPOINT_STANDBY_ANON not set",
      };
    }

    const results: TestResult[] = [];
    const measurements: Record<string, number | string> = {};
    const primaryRef = ctx.ref;
    const dbPw = ctx.dbPassword;

    let adminUserId: string | undefined;
    let adminEmailVar: string | undefined;
    let adminPasswordVar: string | undefined;

    const query = async (ref: string, sql: string) => {
      return await mgmt(ctx, "POST", `/v1/projects/${ref}/database/query`, { query: sql });
    };

    const listTpa = async (ref:string) => {
      const r = await mgmt(ctx, "GET", `/v1/projects/${ref}/config/auth/third-party-auth`);
      return (r.json as Record<string, unknown>[]) || [];
    };

    try {
      const seedSql = `
        DROP PUBLICATION IF EXISTS w05_pub ON DATABASE;
        DROP TABLE IF EXISTS public.w_repl;
        CREATE TABLE public.w_repl(id serial primary key, val text, updated_at timestamptz default now());
        INSERT INTO public.w_repl (val) VALUES ('row1'), ('row2'), ('row3');
        CREATE PUBLICATION w05_pub FOR TABLE public.w_repl;
      `;
      const seedRes = await query(primaryRef, seedSql);
      if (seedRes.status >= 300) {
        throw new Error(`Seed primary failed: HTTP ${seedRes.status} ${seedRes.text.slice(0, 100)}`);
      }

      const standbySql = `
        DROP TABLE IF EXISTS public.w_repl;
        CREATE TABLE public.w_repl(id serial primary key, val text, updated_at timestamptz default now());
      `;
      const standbySeedRes = await query(standby, standbySql);
      if (standbySeedRes.status >= 300) {
        throw new Error(`Seed standby failed: HTTP ${standbySeedRes.status} ${standbySeedRes.text.slice(0, 100)}`);
      }

      let gateA_ok = false;
      let gateA_error = "";
      const gateAConn = `host=db.${primaryRef}.supabase.co port=5432 dbname=postgres user=postgres password=${dbPw} sslmode=require connect_timeout=15`;

      try {
        const resA = await query(standby, `CREATE SUBSCRIPTION w05_sub CONNECTION '${gateAConn}' PUBLICATION w05_pub`);
        if (resA.status >= 300) {
          gateA_error = `HTTP ${resA.status} ${resA.text.slice(0, 100)}`;
        } else {
          gateA_ok = true;
        }
      } catch (e: any) {
        gateA_error = e.message;
      }
      measurements["gateA_ok"] = String(gateA_ok);
      if (gateA_error) measurements["gateA_error"] = gateA_error;

      let gateB_error = "";
      const specGateBConn = `host=aws-0-ap-southeast-2.pooler.supabase.com port=5432 dbname=postgres user=postgres password=${dbPw} sslmode=require connect_timeout=15`;

      try {
        const resB = await query(standby, `CREATE SUBSCRIPTION w05_sub_pooler CONNECTION '${specGateBConn}' PUBLICATION w05_pub`);
        if (resB.status >= 300) {
          gateB_error = `HTTP ${resB.status} ${resB.text.slice(0, 100)}`;
        }
      } catch (e: any) {
        gateB_error = e.message;
      }
      if (gateB_error) measurements["gateB_error"] = gateB_error;

      if (gateA_ok) {
        const syncStart = Date.now();
        const standbyRestUrl = `https://${standby}.supabase.co/rest/v1/w_repl?select=id`;
        let rowsFound = 0;
        while (Date.now() - syncStart < 120_000) {
          const check = await fetch(standbyRestUrl, {
            headers: { apikey: ctx.anonKey!, Authorization: `Bearer ${ctx.anonKey}` },
          });
          if (check.ok) {
            const data = (await check.json()) as any[];
            if (data.length >= 3) {
              rowsFound = data.length;
              break;
            }
          }
          await new Promise((r) => setTimeout(r, 5000));
        }
        measurements["initial_sync_rows"] = String(rowsFound);
        if (rowsFound < 3) {
          throw new Error(`Initial sync failed: only found ${rowsFound} rows`);
        }

        const canarySqlCorrect = `INSERT INTO public.w_repl (val) VALUES ('canary')`;
        await query(primaryRef, canarySqlCorrect);
        const lagStart = Date.now();
        let lagDetected = false;
        while (Date.now() - lagStart < 30_000) {
          const check = await fetch(standbyRestUrl, {
            headers: { apikey: ctx.anonKey!, Authorization: `Bearer ${ctx.anonKey}` },
          });
          if (check.ok) {
            const data = (await check.json()) as any[];
            if (data.some((r: any) => r.val === 'canary')) {
              lagDetected = true;
              break;
            }
          }
          await new enoughPromise((r) => setTimeout(r, 2000));
        }
        measurements["replication_lag_ms"] = String(Date.now() - lagStart);
        if (!lagDetected) throw new Error("Replication lag never cleared");
      } else {
        if (!gateB_error) {
          throw new Error("Gate A failed but Gate B succeeded - not a clean negative finding");
        }
        measurements["status"] = "negative_finding";
        results.push({
          id: "W05-negative",
          title: "Standby replication blocked (clean negative)",
          status: "pass",
          detail: `managed->managed replication blocked: ${gateA_error}`,
          measurements,
        });
        return results;
      }

      const hubIssuer = `https://${primaryRef}.supabase.co/auth/v1`;
      const tpaCreateRes = await mgmt(
        ctx,
        "POST",
        `/v1/projects/${standby}/config/auth/third-party-auth`,
        { oidc_issuer_url: hubIssuer },
      );

      if (tpaCreateRes.status >= 300) {
        throw new Error(`TPA creation on standby failed: HTTP ${tpaCreateRes.status}`);
      }

      const tpaId = (tpaCreateRes.json as any)?.id;
      if (!tpaId) throw new Error("TPA ID missing in response");

      const pollStart = Date.now();
      let resolved = false;
      while (Date.now() - pollStart < 90_000) {
        const list = await listTpa(standby);
        if (list.some((t: any) => t.id === tpaId && (t.resolved_jwks || t.resolved_at))) {
          resolved = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 5000));
      }
      if (!resolved) throw new Error("TPA resolution timed out");
      measurements["tpa_resolved_ms"] = String(Date.now() - pollStart);

      const email = `w05-${Math.random().toString(36).slice(2)}@example.com`;
      const password = `W05-${Math.random().toString(36).slice(2)}!`;
      adminEmailVar = email;
      adminPasswordVar = password;
      const userRes = await mgmt(ctx, "POST", `/v1/projects/${primaryRef}/auth/v1/admin/users`, {
        email,
        password,
        email_confirm: true,
      });
      if (userRes.status >= 300) throw new Error(`User creation failed: ${userRes.text}`);
      const userId = (userRes.json as any)?.id;
      if (!userId) throw new Error("User ID missing in response");
      adminUserId = userId;

      const tokenRes = await mgmt(ctx, "POST", `/v1/projects/${primaryRef}/auth/v1/token?grant_type=password`, {
        email,
        password,
      });
      if (tokenRes.status >= 300) throw new Error(`Token grant failed: ${tokenRes.text}`);
      const accessToken = (tokenRes.json as any)?.access_token;
      if (!accessToken) throw new Error("No access token received");

      const standbyRestUrl = `https://${standby}.supabase.co/rest/v1/w_repl?select=id`;
      const portRes = await fetch(standbyRestUrl, {
        headers: {
          apikey: ctx.anonKey!,
          Authorization: `Bearer ${accessToken}`,
        },
        signal: AbortSignal.timeout(30000),
      });
      measurements["portability_status"] = portRes.status === 200 ? "pass" : `fail(${portRes.status})`;
      if (portRes.status !== 200) {
        throw new Error(`Token portability failed: HTTP ${portRes.status}`);
      }

      results.push({
        id: "W05",
        title: this.title,
        status: "pass",
        detail: "Replication and token portability both verified",
        measurements,
      });

    } catch (e: any) {
      results.push({
        id: "W05",
        title: this.title,
        status: "fail",
        detail: e.message,
        measurements,
      });
    } finally {
      await query(standby, `DROP SUBSCRIPTION IF EXISTS w05_sub`).catch(() => {});
      await query(standby, `DROP SUBSCRIPTION IF EXISTS w05_sub_pooler`).catch(() => {});
      await query(primaryRef, `DROP PUBLICATION IF EXISTS w05_pub`).catch(() => {});
      const list = await listTpa(standby).catch(() => []);
      for (const t of list) {
        if (t.id) {
          await mgmt(ctx, "DELETE", `/v1/projects/${standby}/config/auth/third-party-auth/${t.id}`).catch(() => {});
        }
      }
      if (adminUserId) {
        await mgmt(ctx, "DELETE", `/v1/projects/${primaryRef}/auth/v1/admin/users/${adminUserId}`, {}, 60000).catch(() => {});
      }
    }
  },
};
export default mod;
