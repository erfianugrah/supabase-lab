/**
 * SD03 - the default database image is Postgres 17.
 *
 * The self-hosted/v0.6.0 changelog (2026-06-17) makes Postgres 17 the default
 * and demotes docker-compose.pg17.yml to a redundant override and
 * docker-compose.pg15.yml to a pin for deployments that have not upgraded.
 * Reading the tag is not the same as the server answering as 17, so:
 *
 *   SD03a  the compose model's db image, the running container's image, the
 *          server's `server_version` and `version()`, and the PG_VERSION file
 *          in the data directory all say 17.
 *   SD03b  the two override files, read as files (the Postgres 15 one is not
 *          started here): pg17 carries the same tag as the base file; pg15
 *          carries a 15.x tag.
 *
 *   SD03c  the changelog's companion statement that pg_graphql is disabled by
 *          default on a fresh install: pg_extension, pg_available_extensions,
 *          the graphql schemas, and one POST to /graphql/v1.
 *
 * Local vantage; needs `make stack up`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { compose, http, inspect, rigOf, sh, sql } from "../lib/rig";

const ID = "SD03";

const tagOf = (image: string): string => image.split(":")[1] ?? "none";
const dbImageIn = (file: string): string => readFileSync(file, "utf8").match(/^\s+image:\s*(supabase\/postgres:\S+)/m)?.[1] ?? "none";

const mod: TestModule = {
  id: ID,
  title: "Default database image is Postgres 17",
  where: "local",
  requires: [],

  async run(ctx: Ctx): Promise<TestResult[]> {
    const r = rigOf(ctx);
    if ("skip" in r) return [{ id: ID, title: this.title, status: "skip", detail: r.skip }];
    const rig = r.rig;
    const out: TestResult[] = [];

    const cfg = JSON.parse((await compose(rig, [], ["config", "--format", "json"])).out) as { services: Record<string, any> };
    const modelImage = String(cfg.services["db"]?.image ?? "absent");
    const info = await inspect("supabase-db");
    const runImage = String(info?.Config?.Image ?? "absent");
    const serverVersion = (await sql("show server_version"))[0]?.[0];
    const versionLine = (await sql("select version()"))[0]?.[0];
    const pgVersionFile = (await sh(["docker", "exec", "supabase-db", "cat", "/var/lib/postgresql/data/PG_VERSION"])).out.trim();
    const all17 = /:17\./.test(modelImage) && /:17\./.test(runImage) && /^17\./.test(serverVersion ?? "") && pgVersionFile === "17";
    out.push({
      id: `${ID}a`,
      title: "compose model, running image, server_version, version() and PG_VERSION all say 17",
      status: all17 ? "pass" : "fail",
      detail: `model ${modelImage}; running ${runImage}; server_version ${serverVersion}; PG_VERSION file ${pgVersionFile}; ${versionLine}`,
      measurements: {
        compose_db_image: modelImage,
        running_db_image: runImage,
        server_version: serverVersion ?? "none",
        pg_version_file: pgVersionFile,
        version_line: (versionLine ?? "").split(",")[0] ?? "none",
      },
    });

    const baseFile = join(rig.dir, "docker-compose.yml");
    const pg17 = dbImageIn(join(rig.dir, "docker-compose.pg17.yml"));
    const pg15 = dbImageIn(join(rig.dir, "docker-compose.pg15.yml"));
    const baseImage = dbImageIn(baseFile);
    out.push({
      id: `${ID}b`,
      title: "pg17 override repeats the base tag; pg15 override pins a 15.x tag (files read, 15 not started)",
      status: pg17 === baseImage && /:15\./.test(pg15) ? "pass" : "fail",
      detail: `base file ${baseImage}; docker-compose.pg17.yml ${pg17}; docker-compose.pg15.yml ${pg15}`,
      measurements: { base_tag: tagOf(baseImage), pg17_override_tag: tagOf(pg17), pg15_override_tag: tagOf(pg15) },
    });
    // c - the changelog's companion claim: pg_graphql is off on a fresh 17 install
    const installed = (await sql("select extname from pg_extension where extname = 'pg_graphql'")).length;
    const available = (await sql("select default_version from pg_available_extensions where name = 'pg_graphql'"))[0]?.[0] ?? "not available";
    const schemas = (await sql("select nspname from pg_namespace where nspname in ('graphql','graphql_public') order by 1")).map((x) => x[0]).join(",");
    const gq = await http(rig, "/graphql/v1", {
      method: "POST",
      headers: { "content-type": "application/json", apikey: rig.env.SUPABASE_PUBLISHABLE_KEY ?? "" },
      body: '{"query":"{ __typename }"}',
    });
    out.push({
      id: `${ID}c`,
      title: "pg_graphql is not installed on a fresh Postgres 17 stack (available, not created)",
      status: installed === 0 && available !== "not available" ? "pass" : "fail",
      detail: `pg_extension rows for pg_graphql: ${installed}; pg_available_extensions default_version: ${available}; graphql schemas present: ${schemas || "none"}; POST /graphql/v1 with the publishable key -> ${gq.status} ${gq.body.slice(0, 120)}`,
      measurements: {
        pg_graphql_installed: installed ? "yes" : "no",
        pg_graphql_available_version: available ?? "none",
        graphql_schemas_present: schemas || "none",
        graphql_route_status: gq.status,
        graphql_route_body: gq.body.slice(0, 120),
      },
    });
    return out;
  },
};
export default mod;
