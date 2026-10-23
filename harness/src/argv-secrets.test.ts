/**
 * No database password on a child process's command line from TS harness code.
 *
 * The TypeScript twin of makefile-secrets.test.ts. A test module or lib that
 * spawns psql / pgbench / pg_dump / the supabase CLI / docker with the password
 * inside an argument puts the value in that child's argv for the life of the
 * process, where `ps` and `pgrep -fl` show it to anyone on the box. The forms
 * found on 2026-10-23 (card 178):
 *   - a `postgres://user:${pw}@host` DSN handed to psql/pgbench as an argument
 *     (`$\`psql ${url} ...\``, `spawnSync("psql", [dsn, ...])`);
 *   - `supabase db push --db-url <dsn with password>`, `sbperf bench --db-url`;
 *   - a shell command string with `PGPASSWORD='${pw}' psql ...` run through
 *     `execSync` / `bash -c` / `aws ssm send-command --parameters` (the string
 *     is the shell's or aws's argv even though the password ends up in env);
 *   - `docker run -e POSTGRES_PASSWORD=${pw}` and `supabase link -p "$PW"`.
 *
 * The rule: the password reaches the child through its ENVIRONMENT. Build the
 * DSN without the password and pass `{ ...process.env, PGPASSWORD: pw }` (psql,
 * pgbench, pg_dump, and the supabase CLI's `--db-url`: the CLI resolves a
 * missing password from PGPASSWORD, in libpq order); docker gets `-e NAME` with NAME
 * set in the client's env; tools that take a whole connection string from env
 * (`DATABASE_URL`, `PG_ANALYSER_DB_URL`) get it there. A password used only
 * in-process (`new Client({ connectionString })`, fetch bodies) is fine.
 *
 * The scan is line-based and heuristic, like its Makefile twin: it follows a
 * password-bearing DSN by NAME (a const, or a function that returns one, and
 * consts derived from either) into argv-shaped places - an interpolation in a
 * template literal, an element of an argv array, the value after a `--flag`.
 * Where a CLI has no other way in (`supabase projects create --db-password` has
 * no env or stdin path as of CLI 2.121.0), mark the line with an
 * `argv-secret-ok: <reason>` comment on it or the line above; the reason is the
 * review record.
 */
import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");

export type Offence = { file: string; line: number; form: string; text: string };

/** scheme://user:${expr}@ - a password interpolated into a URL's userinfo. */
const DSN_PW = /[a-z][a-z0-9+.-]*:\/\/[^\s:@/"'`]*:\$\{[^}]+\}@/;
const DECL = /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\b[^=]*=(?!=)\s*(.*)$/;
const FN = /(?:function\s+(\w+)\s*\(|(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::[^=]+)?=>)/;
const ALLOW = /argv-secret-ok:/;
/** Commands a shell-string or docker -e form is about to run. */
const CMD_WORDS = /\b(psql|pg_dump|pg_restore|pgbench|pg_basebackup|supabase|docker)\b/;

/** Drop line comments and the part of the line that sets a child's ENV. */
function argvPart(text: string): string {
  let t = text.replace(/(^|[^:"'`])\/\/.*$/, "$1");
  for (const cut of [/\.env\(/, /\benv:\s*[{\w]/]) {
    const m = cut.exec(t);
    if (m) t = t.slice(0, m.index);
  }
  return t;
}

const isComment = (text: string) => /^\s*(\*|\/\*|\/\/)/.test(text);

export function scanSource(file: string, src: string): Offence[] {
  const lines = src.split("\n");
  // Pass 1: names that hold or return a password-bearing DSN (fixpoint over
  // `const x = name(...)` / `` const x = `${name}?...` `` derivations).
  const names = new Set<string>();
  let fn = "";
  for (const text of lines) {
    if (isComment(text)) continue;
    const f = FN.exec(text);
    if (f) fn = f[1] ?? f[2] ?? fn;
    if (!DSN_PW.test(text)) continue;
    const d = DECL.exec(text);
    // `const x = \`...\`` or `const f = (..) => \`...\``: x / f hold or return the DSN.
    // `const r = call(\`...\`)` holds the call's result, not the DSN.
    if (d && /^(?:`|(?:async\s*)?(?:\([^)]*\)|\w+)\s*(?::[^=]+)?=>\s*`)/.test(d[2]!.trim())) names.add(d[1]!);
    else if (/^\s*return\s*`/.test(text) && fn) names.add(fn);
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const text of lines) {
      const d = DECL.exec(text);
      if (!d || names.has(d[1]!) || isComment(text)) continue;
      const rhs = argvPart(d[2]!);
      if ([...names].some((n) => new RegExp(String.raw`^(?:(?:await\s+)?${n}\b|\`\$\{\s*${n}\b)`).test(rhs.trim()))) {
        names.add(d[1]!);
        changed = true;
      }
    }
  }

  const out: Offence[] = [];
  const add = (i: number, form: string) => {
    const text = lines[i]!;
    if (ALLOW.test(text) || (i > 0 && ALLOW.test(lines[i - 1]!))) return;
    out.push({ file, line: i + 1, form, text: text.trim().slice(0, 160) });
  };
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!;
    if (isComment(text)) continue;
    const t = argvPart(text);
    const decl = DECL.exec(text);
    const declName = decl?.[1];
    const forms = new Set<string>();
    for (const n of names) {
      if (n === declName) continue; // the definition itself
      // the name itself, not a property (`t.client.url`) or an object key (`url: x`)
      const ref = String.raw`(?<![.\w])${n}\b(?!\s*:)`;
      // an interpolation in a template literal, except a URL extension of the
      // DSN (`${base}?sslmode=...`), which is a derivation, not a command line
      if (new RegExp(String.raw`\$\{[^}]*${ref}`).test(t.replace(new RegExp(String.raw`\`\$\{${n}\}[?&/]`, "g"), "`")) && !(decl && names.has(declName!))) {
        forms.add("password DSN interpolated into a command string (PGPASSWORD in env, DSN without the password)");
      }
      // an element of an argv-style array (one that also holds a string literal)
      for (const arr of t.matchAll(/\[([^\]]*)\]/g)) {
        if (/["'`]/.test(arr[1]!) && new RegExp(ref).test(arr[1]!)) {
          forms.add("password DSN as an argv element (PGPASSWORD in env, DSN without the password)");
        }
      }
      if (new RegExp(String.raw`["'\`]--[\w-]+["'\`]\s*,\s*${ref}`).test(t)) {
        forms.add("password DSN as a --flag value (PGPASSWORD in env, DSN without the password)");
      }
    }
    // an inline DSN with the password passed straight to a call: f(`...://u:${pw}@...`)
    if (/\w\(\s*`[^`]*:\/\/[^\s:@/"'`]*:\$\{[^}]+\}@/.test(t) && !/new\s+\w+\(/.test(t)) {
      forms.add("password DSN passed inline to a call (PGPASSWORD in env, DSN without the password)");
    }
    // NAME=${secret} in a command string or a docker -e argument
    if (/\b[A-Z_]*(PASSWORD|SECRET|TOKEN)[A-Z_]*=['"]?\$\{/.test(t) && (CMD_WORDS.test(t) || /["']-e["']\s*,/.test(t) || /\$`/.test(t))) {
      forms.add("secret as NAME=${value} on a command line (set NAME in the child env; docker -e NAME)");
    }
    // a password flag with a value: "--db-password", x / --password ${x} / -p "$PW"
    if (/["'](?:--db-password|--password)["']\s*,\s*[^\s"'\]]/.test(t)) forms.add("password flag with a value in argv");
    if (/(?:--db-password|--password)[ =]['"]?\$/.test(t)) forms.add("password flag with a value in argv");
    if (/\s-p\s+["']?\$\{?\w*(PASSWORD|PASS|PW)\b/i.test(t)) forms.add("password flag with a value in argv");
    for (const f of forms) add(i, f);
  }
  return out;
}

async function sources(): Promise<string[]> {
  const ls = await $`git -C ${ROOT} ls-files -- ${"harness/*.ts"} ${"experiments/*.ts"} ${"experiments/*.mjs"}`.quiet().text();
  return ls
    .split("\n")
    .filter((f) => f && !f.includes("node_modules/") && !/\.test\.ts$/.test(f));
}

describe("scanner", () => {
  const scan = (src: string) => scanSource("t", src).map((o) => o.form);
  test("flags the shapes found in the 2026-10-23 sweep", () => {
    const src = [
      "export function poolerUrl(ctx: Ctx): string {",
      "  return `postgresql://postgres.${ctx.ref}:${encodeURIComponent(ctx.dbPassword)}@${host}:6543/postgres`;",
      "}",
      "const p = await $`psql ${poolerUrl(ctx)} -qAt -c ${sql}`.quiet();",
      "const url = `postgres://u:${encodeURIComponent(pw)}@h:5432/postgres`;",
      'const r = await sh(["supabase", "db", "push", "--db-url", url, "--yes"]);',
      "const conn = connString(t);",
      "function connString(t: T) {",
      "  return `postgres://${t.user}:${t.pw}@${t.host}/postgres`;",
      "}",
      'const args = ["bench", "--db-url", conn, "--json"];',
      'const cmd = `PGPASSWORD=\'${ctx.dbPassword}\' psql "host=${h}" -tAc \'select 1\'`;',
      '"docker", "exec", "-e", `PGPASSWORD=${pw}`, container,',
      'await cli(["projects", "create", name, "--db-password", dbPassword(), "--yes"]);',
      'await sh(`supabase link --project-ref ${ref} -p "$SUPABASE_DB_PASSWORD"`, ctx);',
      'const r = psqlAttempt(`postgres://postgres.${ref}:${encodeURIComponent(dbPw)}@${pooler}:5432/postgres`);',
    ].join("\n");
    expect(scan(src)).toEqual([
      "password DSN interpolated into a command string (PGPASSWORD in env, DSN without the password)",
      "password DSN as an argv element (PGPASSWORD in env, DSN without the password)",
      "password DSN as a --flag value (PGPASSWORD in env, DSN without the password)",
      "password DSN as an argv element (PGPASSWORD in env, DSN without the password)",
      "password DSN as a --flag value (PGPASSWORD in env, DSN without the password)",
      "secret as NAME=${value} on a command line (set NAME in the child env; docker -e NAME)",
      "secret as NAME=${value} on a command line (set NAME in the child env; docker -e NAME)",
      "password flag with a value in argv",
      "password flag with a value in argv",
      "password DSN passed inline to a call (PGPASSWORD in env, DSN without the password)",
    ]);
  });
  test("accepts env, in-process and marked forms", () => {
    const src = [
      "const dsn = (port: number) => `postgres://postgres:${pw}@127.0.0.1:${port}/postgres`;",
      "const c = new Client({ connectionString: dsn(5432) });",
      "const url = (t: T, pw: string) => `postgres://${t.user}:${encodeURIComponent(pw)}@${t.host}/postgres`;",
      "const env = { ...process.env, DATABASE_URL: url(t, pw) };",
      "await $`bunx prisma db push`.cwd(DIR).env({ ...env, DATABASE_URL: url(t, pw) }).quiet();",
      "const p = await $`psql ${conninfo} -c ${sql}`.env({ ...process.env, PGPASSWORD: pw }).quiet();",
      'const r = spawnSync("psql", ["-X", conninfo(t), "-c", sql], { env: { ...process.env, PGPASSWORD: password } });',
      "const base = `postgres://${u}:${encodeURIComponent(p.password)}@127.0.0.1:1/postgres`;",
      "const urlFor = (d: string) => (d === 'prisma' ? `${base}?pgbouncer=true` : base);",
      'const proc = Bun.spawn(["node", "probe.mjs"], { env: { ...process.env, PROXY_URL: urlFor(d) } });',
      "// argv-secret-ok: the CLI has no env path for this flag",
      'await cli(["projects", "create", name, "--db-password", dbPassword(), "--yes"]);',
      "const proc = Bun.spawn(cmd, { stdin: new Blob([`ATTACH 'dbname=x password=${e.PW}'`]) });",
      'Bun.write(f, `PL_CATALOG_PASSWORD=${rand()}\\n`);',
      'await $`psql "$DB_URL" -c ${q}`.env({ ...process.env, PGPASSWORD: "postgres" });',
    ].join("\n");
    expect(scan(src)).toEqual([]);
  });
});

describe("no TS harness or test module puts a DB password on a command line", async () => {
  const files = await sources();
  test("there are sources to scan", () => {
    expect(files.length).toBeGreaterThan(100);
  });
  test("every source", async () => {
    const offences: string[] = [];
    for (const rel of files) {
      const src = await Bun.file(resolve(ROOT, rel)).text();
      for (const o of scanSource(rel, src)) offences.push(`${o.file}:${o.line} [${o.form}] ${o.text}`);
    }
    expect(offences).toEqual([]);
  });
});
