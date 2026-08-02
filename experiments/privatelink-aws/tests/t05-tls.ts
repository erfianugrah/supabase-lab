/**
 * T05/T06/T04 - TLS behaviour through the endpoint.
 *
 * The customer's chosen design is verify-full via a private hosted zone, so
 * this proves that plus the fallbacks, and keeps the negative control: the
 * endpoint IP is not in the certificate, and verify-full against it must fail.
 *
 * The CA chain is extracted from the endpoint itself (openssl STARTTLS). That
 * is trust-on-first-use and fine for a lab; production guidance is the CA
 * download from the dashboard.
 */
import { $ } from "bun";
import { Client } from "pg";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";

const CA = "/tmp/pvlab-ca.crt";

async function extractChain(ctx: Ctx): Promise<{ count: number; subject: string }> {
  const raw = await $`openssl s_client -starttls postgres -connect ${ctx.phzHost}:5432 -showcerts < /dev/null`
    .quiet()
    .nothrow()
    .text();
  const pems = raw.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
  await Bun.write(CA, pems.join("\n"));
  const subject = await $`openssl x509 -noout -subject -in ${CA}`.quiet().nothrow().text();
  return { count: pems.length, subject: subject.trim() };
}

async function tryConnect(opts: {
  host: string;
  hostaddr?: string;
  ssl: Record<string, unknown>;
  password: string;
}): Promise<string | null> {
  const client = new Client({
    host: opts.hostaddr ?? opts.host,
    port: 5432,
    user: "postgres",
    database: "postgres",
    password: opts.password,
    // node-postgres verifies against `servername` when set, which is how the
    // host/hostaddr split is expressed here.
    ssl: { servername: opts.host, ...opts.ssl },
    connectionTimeoutMillis: 8000,
  });
  try {
    await client.connect();
    await client.query("select 1");
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  } finally {
    await client.end().catch(() => {});
  }
}

const mod: TestModule = {
  id: "T05",
  title: "TLS modes through the endpoint",
  where: "runner",
  requires: ["db", "openssl"],
  async run(ctx) {
    const results: TestResult[] = [];
    const { count, subject } = await extractChain(ctx);
    const ca = await Bun.file(CA).text();

    results.push({
      id: "T05a",
      title: "certificate presented on the endpoint",
      status: count > 0 ? "pass" : "fail",
      detail: count > 0 ? `${count}-certificate chain, ${subject}` : "no certificates extracted",
      measurements: { chain_certs: count },
      evidence: subject,
    });

    const verifyFull = await tryConnect({
      host: ctx.phzHost,
      ssl: { ca, rejectUnauthorized: true },
      password: ctx.dbPassword,
    });
    results.push({
      id: "T05",
      title: "verify-full via the PHZ name",
      status: verifyFull === null ? "pass" : "fail",
      detail: verifyFull ?? "full verification succeeded against the private hosted zone name",
    });

    const verifyCa = await tryConnect({
      host: ctx.phzHost,
      ssl: { ca, rejectUnauthorized: true, checkServerIdentity: () => undefined },
      password: ctx.dbPassword,
    });
    results.push({
      id: "T06",
      title: "verify-ca (chain checked, hostname not)",
      status: verifyCa === null ? "pass" : "fail",
      detail: verifyCa ?? "chain verified without hostname check",
    });

    const ip = ctx.endpointIps[0];
    if (ip) {
      const split = await tryConnect({
        host: ctx.phzHost,
        hostaddr: ip,
        ssl: { ca, rejectUnauthorized: true },
        password: ctx.dbPassword,
      });
      results.push({
        id: "T04b",
        title: "verify-full with host/hostaddr split (no DNS dependency)",
        status: split === null ? "pass" : "fail",
        detail: split ?? `verified as ${ctx.phzHost} while connecting to ${ip}`,
      });

      const rawIp = await tryConnect({
        host: ip,
        ssl: { ca, rejectUnauthorized: true },
        password: ctx.dbPassword,
      });
      results.push({
        id: "T04c",
        title: "verify-full against the raw endpoint IP (negative control)",
        // Failing here is the CORRECT outcome - the IP is not in the cert.
        status: rawIp === null ? "fail" : "pass",
        detail:
          rawIp === null
            ? "unexpectedly succeeded - the IP appears to be in the certificate"
            : `rejected as designed: ${rawIp.slice(0, 120)}`,
      });
    }

    return results;
  },
};
export default mod;
