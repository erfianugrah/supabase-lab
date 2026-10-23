/**
 * SD11 - the Postgres 15 -> 17 data-directory upgrade the self-hosting guide
 * describes (apps/docs/content/guides/self-hosting/postgres-upgrade-17.mdx and
 * docker/utils/upgrade-pg17.sh at the pin), on a stack that started on PG 15.
 *
 * Starting point: `make stack up-pg15 SLOT=...` - the pinned docker/ tree with
 * `sh run.sh config add pg15` (the guide's way to select the PG 15 override,
 * which writes COMPOSE_FILE into .env) and `sh run.sh start`. The PG 15
 * cluster is therefore created by the pin's init scripts on the pg15
 * override's image, not by an older release of the stack.
 *
 *   SD11a  seed and snapshot: a 200,000-row table and a 50,000-row child table
 *          (enum, numeric, jsonb, uuid, timestamptz, FK, index), a
 *          materialized view, an RLS table read through the gateway, an auth
 *          user, a Vault secret, a pg_cron job. Exact row counts for every
 *          table outside pg_catalog/information_schema, and an md5 over the
 *          sorted row text of the seeded tables.
 *   SD11b  the guide's backups (`cp -a` of the data directory, the pgsodium
 *          key through `docker compose run --rm db cat`), then
 *          `bash utils/upgrade-pg17.sh --yes` as root. Wall time per phase
 *          from the script's own "==>" headings.
 *   SD11c  after: image, server_version and PG_VERSION; the same counts and
 *          checksums; Vault decrypts; the cron job and extension versions;
 *          the pre-upgrade user signs in; REST with both sb_ keys; every
 *          container's health.
 *   SD11d  the next `sh run.sh start` with .env still naming the pg15
 *          override (the script and the guide do not touch COMPOSE_FILE):
 *          what the database does, then `sh run.sh config remove pg15` and
 *          start again.
 *   SD11e  the guide's rollback block, run as written, then the PG 15
 *          snapshot again.
 *
 * Deviations from the guide, all forced by this machine and recorded in the
 * result: (1) root is a `docker:29-dind` container used only as a shell with
 * the Docker socket and the stack directory mounted at the same path (sudo
 * needs a password; bash and curl are added with apk), with TMPDIR set inside
 * the stack directory so the script's staging bind mounts resolve on the
 * Docker host; (2) the script runs from a copy with two lines changed: the
 * database container name (the SLOT stack has no fixed container names) and
 * the db-config volume lookup, narrowed to this compose project because the
 * upstream `grep -E '^db-config$|_db-config$' | head -n 1` takes the first
 * matching volume on the engine, which on a machine with a second stack can be
 * the other stack's volume. Both diffs are in the evidence.
 *
 * Where the stack runs from: by default the host copy, which Docker Desktop
 * for Mac bind-mounts into the containers over virtiofs; after `make vmfs-up`
 * a copy inside an anonymous Docker volume on the engine VM's ext4, so every
 * bind mount the script makes lands on a Linux filesystem (the separating run
 * for a failure seen only on the host copy). SD11b records which.
 *
 * Destructive and slow (image pulls, a ~1 GB binary tarball). Local vantage.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { cname, http, inspect, jsonOr, projectName, reload, rigOf, scrub, sh, sql, waitFor, type Rig } from "../lib/rig";

const ID = "SD11";
const RUNNER_IMAGE = "docker:29-dind";
const SERVICES = ["supabase-studio", "supabase-envoy", "supabase-auth", "supabase-rest", "realtime-dev.supabase-realtime", "supabase-storage", "supabase-imgproxy", "supabase-meta", "supabase-edge-functions", "supabase-db", "supabase-pooler"];
/**
 * Checksummed sets. The auth rows leave out the columns a sign-in rewrites
 * (last_sign_in_at, updated_at), because the module itself signs the user in
 * before and after each step.
 */
const CHECKSUMMED: Record<string, string> = {
  "sd11.t_big": "select * from sd11.t_big",
  "sd11.t_child": "select * from sd11.t_child",
  "sd11.mv": "select * from sd11.mv",
  "public.sd11_rls": "select * from public.sd11_rls",
  "auth.users(id,email,password hash,created_at,metadata)": "select id, email, encrypted_password, created_at, raw_app_meta_data, raw_user_meta_data from auth.users",
  "auth.identities(id,user_id,provider,identity_data,created_at)": "select id, user_id, provider, identity_data, created_at from auth.identities",
  "vault.secrets": "select * from vault.secrets",
  "cron.job": "select * from cron.job",
  "storage.buckets": "select * from storage.buckets",
};
const SEEDED = Object.keys(CHECKSUMMED);

const SEED_SQL = `
drop schema if exists sd11 cascade;
create schema sd11;
create type sd11.mood as enum ('a', 'b', 'c');
create table sd11.t_big (id bigint primary key, txt text not null, num numeric(12,3), js jsonb, ts timestamptz, u uuid, m sd11.mood);
insert into sd11.t_big
  select i, md5(i::text), (i * 1.5)::numeric(12,3), jsonb_build_object('i', i, 'h', md5((i * 7)::text)),
         timestamptz '2026-01-01 00:00:00+00' + i * interval '1 second', md5(i::text)::uuid, (array['a','b','c'])[1 + i % 3]::sd11.mood
  from generate_series(1, 200000) i;
create index t_big_txt on sd11.t_big (txt);
create table sd11.t_child (id bigserial primary key, big_id bigint not null references sd11.t_big(id), note text);
insert into sd11.t_child (big_id, note) select (i % 200000) + 1, repeat('x', i % 50) from generate_series(1, 50000) i;
create materialized view sd11.mv as select m, count(*) as n, sum(num) as s from sd11.t_big group by m;
create function sd11.twice(x int) returns int language sql immutable as 'select x * 2';
drop table if exists public.sd11_rls;
create table public.sd11_rls (id int primary key, v text);
insert into public.sd11_rls select i, 'v' || i from generate_series(1, 100) i;
alter table public.sd11_rls enable row level security;
create policy sd11_anon on public.sd11_rls for select to anon using (id <= 10);
grant select on public.sd11_rls to anon, authenticated, service_role;
create extension if not exists pg_cron;
select cron.schedule('sd11', '*/5 * * * *', 'select 1');
delete from vault.secrets where name = 'sd11';
select vault.create_secret('sd11-synthetic-value', 'sd11');
notify pgrst, 'reload schema';
`;

interface Snap {
  server: string;
  image: string;
  pgVersionFile: string;
  counts: Record<string, string>;
  sums: Record<string, string>;
  extensions: Record<string, string>;
  vault: string;
  cron: string;
  seq: string;
}

async function snapshot(): Promise<Snap> {
  const counts: Record<string, string> = {};
  for (const [t, n] of await sql(
    `select schemaname || '.' || tablename, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', schemaname, tablename), false, true, '')))[1]::text
     from pg_tables where schemaname not in ('pg_catalog', 'information_schema') order by 1`,
  ))
    counts[t!] = n ?? "";
  const sums: Record<string, string> = {};
  for (const t of SEEDED) {
    const r = await sql(`select count(*) || ' rows md5 ' || md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from (${CHECKSUMMED[t]}) x`).catch((e) => [[`error ${String(e).slice(0, 120)}`]]);
    sums[t] = r[0]?.[0] ?? "";
  }
  const extensions: Record<string, string> = {};
  for (const [n, v] of await sql("select extname, extversion from pg_extension order by 1")) extensions[n!] = v ?? "";
  const vault = (await sql("select coalesce((select decrypted_secret from vault.decrypted_secrets where name = 'sd11'), 'absent')").catch((e) => [[`error ${String(e).slice(0, 120)}`]]))[0]?.[0] ?? "";
  const cron = (await sql("select coalesce((select jobname || ' ' || schedule || ' active=' || active from cron.job where jobname = 'sd11'), 'absent')").catch((e) => [[`error ${String(e).slice(0, 120)}`]]))[0]?.[0] ?? "";
  const seq = (await sql("select last_value::text from sd11.t_child_id_seq").catch(() => [["absent"]]))[0]?.[0] ?? "";
  const server = (await sql("show server_version"))[0]?.[0] ?? "";
  const image = String((await inspect("supabase-db"))?.Config?.Image ?? "unknown");
  const pgVersionFile = (await sh(["docker", "exec", cname("supabase-db"), "cat", "/var/lib/postgresql/data/PG_VERSION"])).out.trim();
  return { server, image, pgVersionFile, counts, sums, extensions, vault, cron, seq };
}

function diffCounts(a: Record<string, string>, b: Record<string, string>): string[] {
  const keys = Array.from(new Set([...Object.keys(a), ...Object.keys(b)])).sort();
  return keys.filter((k) => a[k] !== b[k]).map((k) => `${k} ${a[k] ?? "absent"} -> ${b[k] ?? "absent"}`);
}

function diffMap(a: Record<string, string>, b: Record<string, string>): string[] {
  return diffCounts(a, b);
}

/** Run a shell command as root in the runner container, stamping each output line with elapsed seconds. */
interface Exec {
  /** Where the stack is run from (the host copy, or a VM-local copy). */
  dir: string;
  /** The runner's mount that makes `dir` exist at the same path for the engine. */
  mount: string;
}

/**
 * The stack's run directory. Default: the host copy (on Docker Desktop for Mac
 * a virtiofs bind mount). With PVLAB_ENDPOINT_EXEC_DIR / _EXEC_MOUNT
 * (`make vmfs-up`), a copy inside an anonymous Docker volume, so the bind
 * mounts the script creates land on the engine VM's ext4 instead.
 */
function execOf(ctx: Ctx, rig: Rig): Exec {
  const dir = ctx.endpoints["exec_dir"] || rig.dir;
  return { dir, mount: ctx.endpoints["exec_mount"] || `${rig.dir}:${rig.dir}` };
}

async function asRoot(rig: Rig, x: Exec, cmd: string, timeoutMs = 3_600_000): Promise<{ code: number; log: string[]; ms: number }> {
  const t0 = Date.now();
  const p = Bun.spawn(
    [
      "docker", "run", "--rm", "--name", `sd11-runner-${projectName()}`,
      "-v", "/var/run/docker.sock:/var/run/docker.sock",
      "-v", x.mount, "-v", `${rig.dir}:/hoststack:ro`, "-w", x.dir,
      "-e", `TMPDIR=${x.dir}/volumes/db/.upgrade-tmp`,
      "--entrypoint", "sh", RUNNER_IMAGE,
      "-c", `apk add --no-cache bash curl >/dev/null 2>&1 && mkdir -p "$TMPDIR" && ${cmd}`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const log: string[] = [];
  const pump = async (s: ReadableStream<Uint8Array>) => {
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of s) {
      buf += dec.decode(chunk);
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        log.push(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${scrub(rig, buf.slice(0, i))}`);
        buf = buf.slice(i + 1);
      }
    }
    if (buf) log.push(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${scrub(rig, buf)}`);
  };
  const timer = setTimeout(() => p.kill(), timeoutMs);
  await Promise.all([pump(p.stdout), pump(p.stderr)]);
  const code = await p.exited;
  clearTimeout(timer);
  return { code, log, ms: Date.now() - t0 };
}

/** One command in the run directory as root; its output without the time stamps. */
async function rootText(rig: Rig, x: Exec, cmd: string): Promise<string> {
  const r = await asRoot(rig, x, cmd, 300_000);
  return r.log.map((l) => l.replace(/^\[[\d.]+s\] /, "")).join("\n").trim();
}

/** Seconds between successive "==>" headings of the script. */
function phases(log: string[]): Record<string, string> {
  const marks = log.map((l) => l.match(/^\[([\d.]+)s\] ==> (.*)$/)).filter(Boolean) as RegExpMatchArray[];
  const end = Number(log.at(-1)?.match(/^\[([\d.]+)s\]/)?.[1] ?? 0);
  const out: Record<string, string> = {};
  marks.forEach((m, i) => {
    const t = Number(m[1]);
    const next = i + 1 < marks.length ? Number(marks[i + 1]![1]) : end;
    const name = m[2]!.replace(/\s+/g, " ").slice(0, 60);
    out[`${String(i + 1).padStart(2, "0")} ${name}`] = `${(next - t).toFixed(1)} s`;
  });
  return out;
}

async function allHealth(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const s of SERVICES) {
    const i = await inspect(s);
    out[s] = String(i?.State?.Health?.Status ?? i?.State?.Status ?? "absent");
  }
  return out;
}

async function waitHealthy(maxMs: number): Promise<Record<string, string>> {
  await waitFor(async () => Object.values(await allHealth()).every((v) => v === "healthy"), maxMs, 5000);
  return allHealth();
}

async function gatewayChecks(rig: Rig, user: { email: string; password: string; id: string } | null): Promise<Record<string, string>> {
  const P = rig.env.SUPABASE_PUBLISHABLE_KEY ?? "";
  const S = rig.env.SUPABASE_SECRET_KEY ?? "";
  const rows = async (k: string) => {
    const r = await http(rig, "/rest/v1/sd11_rls?select=id", { headers: { apikey: k } });
    const j = jsonOr(r.body);
    return `${r.status} ${Array.isArray(j) ? `${j.length} rows` : scrub(rig, r.body.slice(0, 120))}`;
  };
  const out: Record<string, string> = { rest_publishable: await rows(P), rest_secret: await rows(S) };
  if (user) {
    const g = await http(rig, "/auth/v1/token?grant_type=password", { method: "POST", headers: { apikey: P, "content-type": "application/json" }, body: JSON.stringify({ email: user.email, password: user.password }) });
    const j = jsonOr(g.body);
    out.password_grant_pre_upgrade_user = `${g.status} ${j?.user?.id === user.id ? "same user id" : scrub(rig, g.body.slice(0, 120))}`;
  }
  const gq = await http(rig, "/graphql/v1", { method: "POST", headers: { apikey: P, "content-type": "application/json" }, body: JSON.stringify({ query: "{ __typename }" }) });
  out.graphql = `${gq.status} ${scrub(rig, gq.body.slice(0, 120))}`;
  return out;
}

const mod: TestModule = {
  id: ID,
  title: "Postgres 15 -> 17 data-directory upgrade with utils/upgrade-pg17.sh",
  where: "local",
  requires: [],
  destructive: true,

  async run(ctx: Ctx): Promise<TestResult[]> {
    const r = rigOf(ctx);
    if ("skip" in r) return [{ id: ID, title: this.title, status: "skip", detail: r.skip }];
    const rig = r.rig;
    const img0 = String((await inspect("supabase-db"))?.Config?.Image ?? "");
    if (!/^supabase\/postgres:15\./.test(img0)) return [{ id: ID, title: this.title, status: "skip", detail: `database image is ${img0 || "absent"}, not 15.x (start with \`make stack up-pg15 SLOT=...\`)` }];
    const out: TestResult[] = [];
    const S = rig.env.SUPABASE_SECRET_KEY ?? "";
    const x = execOf(ctx, rig);
    const vmfs = x.dir !== rig.dir;

    // a - seed and snapshot
    await sql(SEED_SQL);
    const email = `sd11-${Date.now()}@example.com`;
    const password = `pw-${crypto.randomUUID()}`;
    const cu = await http(rig, "/auth/v1/admin/users", { method: "POST", headers: { apikey: S, "content-type": "application/json" }, body: JSON.stringify({ email, password, email_confirm: true }) });
    const user = cu.status === 200 && jsonOr(cu.body)?.id ? { email, password, id: String(jsonOr(cu.body).id) } : null;
    await new Promise((res) => setTimeout(res, 1500));
    const gwPre = await gatewayChecks(rig, user);
    const pre = await snapshot();
    const dataMb = (await rootText(rig, x, "du -sm ./volumes/db/data | cut -f1; df -T ./volumes/db/data | tail -1 | awk '{print $2}'")).replace("\n", " MB on ");
    out.push({
      id: `${ID}a`,
      title: "PG 15 stack seeded and snapshotted",
      status: /^15\./.test(pre.server) && pre.vault === "sd11-synthetic-value" && /^sd11 /.test(pre.cron) && user ? "pass" : "fail",
      detail: `image ${pre.image}; server_version ${pre.server}; PG_VERSION ${pre.pgVersionFile}; data dir ${dataMb}; ${Object.keys(pre.counts).length} tables counted; seeded: ${SEEDED.map((t) => `${t} ${pre.sums[t]}`).join("; ")}; vault ${pre.vault === "sd11-synthetic-value" ? "decrypts" : pre.vault}; cron ${pre.cron}; extensions ${Object.entries(pre.extensions).map(([k, v]) => `${k} ${v}`).join(", ")}; gateway ${JSON.stringify(gwPre)}`,
      measurements: { image_pre: pre.image, server_version_pre: pre.server, data_dir_mb_pre: dataMb, tables_counted_pre: Object.keys(pre.counts).length, ...Object.fromEntries(SEEDED.map((t) => [`pre ${t}`, pre.sums[t]!])), extensions_pre: Object.entries(pre.extensions).map(([k, v]) => `${k}=${v}`).join(","), ...Object.fromEntries(Object.entries(gwPre).map(([k, v]) => [`pre ${k}`, v])) },
      evidence: JSON.stringify(pre.counts),
    });

    // b - backups as the guide shows them, then the script as root
    const orig = readFileSync(join(rig.dir, "utils", "upgrade-pg17.sh"), "utf8");
    const project = projectName();
    const patched = orig
      // Function replacers: a replacement string would read `$'` in the new text as a pattern.
      .replace('DB_CONTAINER="supabase-db"', () => `DB_CONTAINER="${cname("supabase-db")}"`)
      .replace(`| grep -E '^db-config$|_db-config$' | head -n 1)`, () => `| grep -E '^${project}_db-config$' | head -n 1)`);
    const changed = orig.split("\n").map((l, i) => [l, patched.split("\n")[i]!] as const).filter(([a, b]) => a !== b).map(([a, b]) => `- ${a.trim()}\n+ ${b.trim()}`);
    writeFileSync(join(rig.dir, "utils", "upgrade-pg17.sd11.sh"), patched);
    // An earlier attempt's manual backup is removed first (not a guide step), so cp -a does not nest a copy inside it.
    const backup = await asRoot(
      rig,
      x,
      `${vmfs ? "cp /hoststack/utils/upgrade-pg17.sd11.sh utils/ && " : ""}rm -rf ./volumes/db/data-manual-backup ./pgsodium_root.key.backup && cp -a ./volumes/db/data ./volumes/db/data-manual-backup && docker compose run --rm db cat /etc/postgresql-custom/pgsodium_root.key > ./pgsodium_root.key.backup && wc -c < ./pgsodium_root.key.backup`,
      600_000,
    );
    const up = await asRoot(rig, x, "bash utils/upgrade-pg17.sd11.sh --yes");
    const ph = phases(up.log);
    out.push({
      id: `${ID}b`,
      title: "utils/upgrade-pg17.sh --yes as root: exit status and wall time per phase",
      status: up.code === 0 ? "pass" : "fail",
      detail: `run directory on ${vmfs ? "the engine VM's filesystem (docker volume)" : "the host copy (bind mount)"}; guide backups exit ${backup.code} (pgsodium key backup ${backup.log.at(-1)?.replace(/^\[[\d.]+s\] /, "") ?? "?"} bytes); script exit ${up.code}; total ${(up.ms / 1000).toFixed(1)} s; phases: ${Object.entries(ph).map(([k, v]) => `${k} ${v}`).join("; ")}; lines changed in the script copy: ${changed.length}`,
      measurements: { run_directory: vmfs ? "engine VM volume" : "host bind mount", script_exit: up.code, script_total_s: Number((up.ms / 1000).toFixed(1)), lines_changed_in_script_copy: changed.length, runner_image: RUNNER_IMAGE, ...ph },
      evidence: `script copy diff:\n${changed.join("\n")}\n\nbackup log:\n${backup.log.join("\n")}\n\nupgrade log:\n${up.log.join("\n")}`.slice(0, 60_000),
    });
    if (up.code !== 0) return out;

    // c - after
    reload(rig);
    const health = await waitHealthy(300_000);
    const post = await snapshot();
    const gwPost = await gatewayChecks(rig, user);
    const seededDiff = SEEDED.filter((t) => pre.sums[t] !== post.sums[t]).map((t) => `${t}: ${pre.sums[t]} -> ${post.sums[t]}`);
    const countDiff = diffCounts(pre.counts, post.counts);
    const extDiff = diffMap(pre.extensions, post.extensions);
    const fileText = await rootText(
      rig,
      x,
      "for f in data.bak.pg15 pgsodium_root.key.bak.pg15; do test -e ./volumes/db/$f && echo $f present || echo $f absent; done; ls ./volumes/db | grep pg17_upgrade_bin_ | while read t; do echo tarball $t $(du -m ./volumes/db/$t | cut -f1) MB; done; grep '^COMPOSE_FILE=' .env || echo COMPOSE_FILE unset",
    );
    const files = Object.fromEntries(fileText.split("\n").filter(Boolean).map((l, i) => [`file_${i + 1}`, l]));
    const allHealthy = Object.values(health).every((v) => v === "healthy");
    const tablesOk = seededDiff.length === 0;
    out.push({
      id: `${ID}c`,
      title: "after the upgrade: PG 17 on the PG 15 data; seeded tables identical; Vault, cron, auth user, REST with sb_ keys; container health",
      status: /^17\./.test(post.server) && post.pgVersionFile === "17" && tablesOk && post.vault === "sd11-synthetic-value" && /^sd11 /.test(post.cron) && allHealthy ? "pass" : "fail",
      detail: `image ${post.image}; server_version ${post.server}; PG_VERSION ${post.pgVersionFile}; seeded tables differing: ${seededDiff.join("; ") || "none"}; row counts differing (of ${Object.keys(post.counts).length} tables): ${countDiff.join("; ") || "none"}; extensions changed: ${extDiff.join("; ") || "none"}; vault ${post.vault === "sd11-synthetic-value" ? "decrypts to the same value" : post.vault}; cron ${post.cron}; sequence ${pre.seq} -> ${post.seq}; health ${JSON.stringify(health)}; gateway ${JSON.stringify(gwPost)}; files ${JSON.stringify(files)}`,
      measurements: {
        image_post: post.image,
        server_version_post: post.server,
        pg_version_file_post: post.pgVersionFile,
        seeded_tables_differing: seededDiff.length,
        row_count_differences: countDiff.length,
        extensions_changed: extDiff.join(", ") || "none",
        containers_healthy: `${Object.values(health).filter((v) => v === "healthy").length} of ${SERVICES.length}`,
        ...Object.fromEntries(Object.entries(gwPost).map(([k, v]) => [`post ${k}`, v])),
        ...files,
      },
      evidence: `count diffs:\n${countDiff.join("\n")}\n\nextension diffs:\n${extDiff.join("\n")}\n\npost counts:\n${JSON.stringify(post.counts)}`,
    });

    // d - next start with the pg15 override still in COMPOSE_FILE
    const start1 = await asRoot(rig, x, "docker compose up -d --wait --wait-timeout 180; echo exit=$?", 600_000);
    await new Promise((res) => setTimeout(res, 5000));
    const dbImg1 = String((await inspect("supabase-db"))?.Config?.Image ?? "");
    const dbLog1 = (await sh(["docker", "logs", "--tail", "40", cname("supabase-db")])).err + (await sh(["docker", "logs", "--tail", "40", cname("supabase-db")])).out;
    const fatal1 = dbLog1.split("\n").filter((l) => /FATAL|DETAIL|incompatible|permission|initdb/i.test(l)).slice(-6).map((l) => scrub(rig, l.trim()));
    const fix = await asRoot(rig, x, "sh run.sh config remove pg15 && docker compose up -d --wait --wait-timeout 300; echo exit=$?", 900_000);
    reload(rig);
    const health2 = await waitHealthy(300_000);
    const post2 = await snapshot();
    const seededDiff2 = SEEDED.filter((t) => post.sums[t] !== post2.sums[t]).map((t) => `${t}: ${post.sums[t]} -> ${post2.sums[t]}`);
    out.push({
      id: `${ID}d`,
      title: "the next `sh run.sh start` with COMPOSE_FILE still naming the pg15 override, then `config remove pg15` and start",
      status: "info",
      detail: `start with pg15 in COMPOSE_FILE: ${start1.log.filter((l) => /exit=|Error|error|unhealthy/i.test(l)).slice(-3).join(" / ")}; db image then ${dbImg1}; db log: ${fatal1.join(" / ") || "no FATAL lines"}; after config remove pg15: ${fix.log.filter((l) => /exit=|Error|error|unhealthy/i.test(l)).slice(-2).join(" / ")}; server_version ${post2.server}; seeded tables differing from SD11c: ${seededDiff2.join("; ") || "none"}; health ${JSON.stringify(health2)}`,
      measurements: { db_image_with_stale_compose_file: dbImg1, db_log_with_stale_compose_file: fatal1.join(" / ") || "none", server_version_after_fix: post2.server, seeded_tables_differing_after_fix: seededDiff2.length, containers_healthy_after_fix: `${Object.values(health2).filter((v) => v === "healthy").length} of ${SERVICES.length}` },
      evidence: `start with stale COMPOSE_FILE:\n${start1.log.join("\n")}\n\ndb log tail:\n${scrub(rig, dbLog1)}\n\nfix:\n${fix.log.join("\n")}`.slice(0, 40_000),
    });

    // e - the guide's rollback block, as written
    const rb = await asRoot(
      rig,
      x,
      "docker compose down && rm -rf ./volumes/db/data && mv ./volumes/db/data.bak.pg15 ./volumes/db/data && sh run.sh config add pg15 && docker compose run --rm db chown -R postgres:postgres /etc/postgresql-custom/ && sh run.sh start; echo exit=$?",
      1_200_000,
    );
    reload(rig);
    const health3 = await waitHealthy(300_000);
    const back = await snapshot();
    const seededDiff3 = SEEDED.filter((t) => pre.sums[t] !== back.sums[t]).map((t) => `${t}: ${pre.sums[t]} -> ${back.sums[t]}`);
    const gwBack = await gatewayChecks(rig, user);
    out.push({
      id: `${ID}e`,
      title: "the guide's rollback block: back on PG 15 with the pre-upgrade data",
      status: /^15\./.test(back.server) && seededDiff3.length === 0 && Object.values(health3).every((v) => v === "healthy") ? "pass" : "fail",
      detail: `rollback ${rb.log.filter((l) => /exit=/.test(l)).at(-1) ?? "no exit line"} in ${(rb.ms / 1000).toFixed(1)} s; image ${back.image}; server_version ${back.server}; seeded tables differing from SD11a: ${seededDiff3.join("; ") || "none"}; vault ${back.vault === "sd11-synthetic-value" ? "decrypts" : back.vault}; health ${JSON.stringify(health3)}; gateway ${JSON.stringify(gwBack)}`,
      measurements: { rollback_s: Number((rb.ms / 1000).toFixed(1)), image_after_rollback: back.image, server_version_after_rollback: back.server, seeded_tables_differing_from_pre: seededDiff3.length, containers_healthy_after_rollback: `${Object.values(health3).filter((v) => v === "healthy").length} of ${SERVICES.length}` },
      evidence: rb.log.join("\n").slice(0, 30_000),
    });
    return out;
  },
};

export default mod;
