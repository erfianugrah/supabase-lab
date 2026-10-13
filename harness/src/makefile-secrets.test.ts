/**
 * No credential on a process command line from any Makefile.
 *
 * make runs each recipe line as `/bin/sh -c '<expanded line>'`, so a
 * make-level `$(TOK)` / `$(PW)` in a recipe puts the VALUE in that shell's
 * argv for the life of the line - visible to `ps`/`pgrep -fl` for anyone on
 * the box. On 2026-10-13 a `pgrep -fl` during a live batch printed the PAT and
 * the DB password from platform-downtime's probe line into an agent
 * transcript (both rotated). `tofu plan -var="supabase_access_token=..."`
 * does the same to tofu's argv, and `curl -H "Authorization: Bearer $$X"`
 * or a DSN with the password in it does it to curl/psql/docker even when the
 * shell only holds a variable reference.
 *
 * The rule this enforces: secrets reach children through the ENVIRONMENT.
 *   - `<target>: export NAME := $(TOK)` (or a global `export NAME = $(TOK)`)
 *     and the recipe reads `$$NAME`; tofu gets `TF_VAR_<name>`.
 *   - curl reads the auth header from stdin: `printf 'Authorization: Bearer
 *     %s\n' "$$SUPABASE_ACCESS_TOKEN" | curl -H @- ...` (printf is a shell
 *     builtin, so the value is never an argv entry).
 *   - psql/pgbench/docker get PGPASSWORD (or `-e NAME` with NAME set in the
 *     shell env) instead of a password inside a DSN argument.
 * A side effect worth having: `make -n <target>` prints `$SUPABASE_ACCESS_TOKEN`
 * instead of the value, so a dry run is safe to show.
 */
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");

/**
 * Make variables that hold a credential wherever they are defined - including
 * when they are only ever passed on the make command line (privatelink-aws's
 * DBPW has no definition in its Makefile).
 */
const FIXED_SECRET_VARS = [
  "TOK",
  "FILE_TOK",
  "PW",
  "DBPW",
  "SUPABASE_ACCESS_TOKEN",
  "DB_PASSWORD",
  "PVLAB_DB_PASSWORD",
  "PGPASSWORD",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_SECRET_KEY",
  "STRIPE_SECRET_KEY",
  "AWS_SECRET_ACCESS_KEY",
  "TF_VAR_supabase_access_token",
  "TF_VAR_db_password",
];
/** secrets.tfvars keys whose value is a credential (supabase_org_id is not). */
const SECRET_KEYS = /\^(supabase_access_token|db_password|aws_secret_access_key)\b/;

const NAME = String.raw`[A-Za-z_][A-Za-z0-9_]*`;
const ASSIGN = new RegExp(String.raw`^(?:(?<target>[^\t:=#]+):\s*)?(?<exp>export\s+)?(?<lhs>${NAME})\s*(?:\?|:|\+)?=\s*(?<rhs>.*)$`);

export type Offence = { file: string; line: number; form: string; text: string };

/** Physical lines -> logical lines (backslash continuations joined), keeping the first line number. */
function logicalLines(src: string): { n: number; text: string }[] {
  const out: { n: number; text: string }[] = [];
  const phys = src.split("\n");
  for (let i = 0; i < phys.length; i++) {
    const start = i;
    let text = phys[i] ?? "";
    while (text.endsWith("\\") && i + 1 < phys.length) {
      i++;
      text = `${text.slice(0, -1)} ${(phys[i] ?? "").trimStart()}`;
    }
    out.push({ n: start + 1, text });
  }
  return out;
}

// A make-level reference; `$$NAME` / `$${NAME}` is the shell's and is fine.
const refOf = (v: string) => new RegExp(String.raw`(?<!\$)\$[({]${v}[)}]`);

/**
 * A definition line that only SELECTS a secret (reads it from secrets.tfvars or
 * the CLI's token file, picks env-over-file) or EXPORTS one secret var into the
 * environment. These are the only places a secret make-variable may appear.
 */
function isSecretSource(rhs: string, secret: Set<string>): boolean {
  const r = rhs.trim();
  if (/^\$\(shell grep -E '\^\w+' \$\(ROOT\)\/secrets\.tfvars 2>\/dev\/null \| cut -d'"' -f2\)$/.test(r)) return SECRET_KEYS.test(r);
  if (/^\$\(shell cat \$\(HOME\)\/\.supabase\/access-token 2>\/dev\/null\)$/.test(r)) return true;
  const sel = r.match(new RegExp(String.raw`^\$\(if \$\((${NAME})\),\$\((${NAME})\),\$\((${NAME})\)\)$`));
  if (sel) return sel.slice(1).every((v) => secret.has(v!));
  // $(or $(ENV),<file read>): env wins, else the secrets.tfvars line
  const or = r.match(new RegExp(String.raw`^\$\(or \$\((${NAME})\),(.*)\)$`));
  if (or) return secret.has(or[1]!) && isSecretSource(or[2]!, secret);
  const one = r.match(new RegExp(String.raw`^\$\((${NAME})\)$`));
  return !!one && secret.has(one[1]!);
}

export function scanMakefile(file: string, src: string): Offence[] {
  const lines = logicalLines(src);
  // Fixpoint: a var defined only from secret sources is itself secret.
  const secret = new Set(FIXED_SECRET_VARS);
  for (let changed = true; changed; ) {
    changed = false;
    for (const { text } of lines) {
      if (text.startsWith("\t")) continue;
      const m = text.match(ASSIGN);
      if (m?.groups && !secret.has(m.groups.lhs!) && isSecretSource(m.groups.rhs!, secret)) {
        secret.add(m.groups.lhs!);
        changed = true;
      }
    }
  }
  const out: Offence[] = [];
  const add = (n: number, form: string, text: string) => out.push({ file, line: n, form, text: text.trim().slice(0, 160) });
  for (const { n, text } of lines) {
    if (/^\s*#/.test(text)) continue;
    const recipe = text.startsWith("\t");
    const m = recipe ? null : text.match(ASSIGN);
    const allowedDef = !!m?.groups && secret.has(m.groups.lhs!) && isSecretSource(m.groups.rhs!, secret);
    const used = [...secret].filter((v) => refOf(v).test(text));
    if (used.length && !allowedDef) {
      add(n, recipe ? "secret make-var expanded into a recipe (sh -c argv)" : "secret make-var outside an export/selection line", text);
    }
    if (/-var=?["']?\w*(token|password|secret)\w*=/i.test(text)) add(n, "tofu -var with a secret (use TF_VAR_)", text);
    // A password inside a URL/DSN argument: scheme://user:$X@host. Exempt only
    // an UPPERCASE env-prefix assignment (`NAME="postgres://u:$$PW@h" docker run
    // -e NAME`), which the shell hands to the child as environment; a
    // lowercase shell var is assumed to end up in an argument later.
    for (const d of text.matchAll(/[a-z][a-z0-9+.-]*:\/\/[^\s:@\/"']+:[^@\s"']*\$[^@\s"']*@/g)) {
      const before = text.slice(0, d.index);
      if (/(^|[\s;@])[A-Z_][A-Z0-9_]*=["']?$/.test(before) && !/-(e|-env)\s+[A-Z_][A-Z0-9_]*=["']?$/.test(before)) continue;
      add(n, "password inside a DSN/URL argument (use PGPASSWORD)", text);
    }
    if (recipe) {
      for (const h of text.matchAll(/(?:Authorization:\s*Bearer|apikey:)\s*\$\$?[({]?(\w+)/g)) {
        if (!/^(anon|pub|publishable|SUPABASE_ANON_KEY)$/i.test(h[1]!)) add(n, "credential in a curl -H argument (use -H @-)", text);
      }
      if (/(?:^|[^\w-])-(?:e|-env)\s+["']?\w*(SECRET|PASSWORD|TOKEN|SERVICE_ROLE|JWT_KEYS|KEY)\w*=["']?\$/i.test(text)) {
        add(n, "credential in a docker -e NAME=value argument (set NAME in the env, pass -e NAME)", text);
      }
    }
  }
  return out;
}

async function makefiles(): Promise<string[]> {
  const found = await Array.fromAsync(new Bun.Glob("experiments/*/Makefile").scan({ cwd: ROOT }));
  return ["Makefile", ...found.sort()];
}

describe("scanner", () => {
  const scan = (src: string) => scanMakefile("t", src).map((o) => o.form);
  test("flags the incident form", () => {
    const src = [
      "PW := $(shell grep -E '^db_password' $(ROOT)/secrets.tfvars 2>/dev/null | cut -d'\"' -f2)",
      "probe:",
      '\tPVLAB_REF="$(REF)" DB_PASSWORD="$(PW)" bun run.ts',
    ].join("\n");
    expect(scan(src)).toEqual(["secret make-var expanded into a recipe (sh -c argv)"]);
  });
  test("flags -var, DSN password, Bearer and docker -e", () => {
    const src = [
      "apply:",
      '\ttofu plan -var="supabase_access_token=$$T" -out=tfplan',
      '\tpsql "postgres://postgres.$(REF):$$DB_PASSWORD@h:5432/postgres"',
      '\tcurl -H "Authorization: Bearer $$SUPABASE_ACCESS_TOKEN" https://x',
      '\tdocker run -e GOTRUE_JWT_SECRET="$$jwt" img',
    ].join("\n");
    expect(scan(src)).toEqual([
      "tofu -var with a secret (use TF_VAR_)",
      "password inside a DSN/URL argument (use PGPASSWORD)",
      "credential in a curl -H argument (use -H @-)",
      "credential in a docker -e NAME=value argument (set NAME in the env, pass -e NAME)",
    ]);
  });
  test("accepts the env-based forms", () => {
    const src = [
      "FILE_TOK := $(shell grep -E '^supabase_access_token' $(ROOT)/secrets.tfvars 2>/dev/null | cut -d'\"' -f2)",
      "TOK := $(if $(SUPABASE_ACCESS_TOKEN),$(SUPABASE_ACCESS_TOKEN),$(FILE_TOK))",
      "ORG := $(shell grep -E '^supabase_org_id' $(ROOT)/secrets.tfvars 2>/dev/null | cut -d'\"' -f2)",
      "probe apply: export SUPABASE_ACCESS_TOKEN := $(TOK)",
      "apply: export TF_VAR_supabase_access_token := $(TOK)",
      "apply:",
      "\ttofu plan $(VARS) -out=tfplan",
      "probe:",
      '\t@test -n "$$SUPABASE_ACCESS_TOKEN" || exit 1',
      "\t@printf 'Authorization: Bearer %s\\n' \"$$SUPABASE_ACCESS_TOKEN\" | curl -s -H @- -H \"apikey: $$anon\" https://x/$(ORG)",
      '\tGOTRUE_DB_DATABASE_URL="postgres://u:$$DB_PASSWORD@h/db" docker run -e GOTRUE_DB_DATABASE_URL img',
    ].join("\n");
    expect(scan(src)).toEqual([]);
  });
});

describe("no Makefile puts a credential on a command line", async () => {
  const files = await makefiles();
  test("there are Makefiles to scan", () => {
    expect(files.length).toBeGreaterThan(20);
  });
  test("every Makefile", async () => {
    const offences: string[] = [];
    for (const rel of files) {
      const src = await Bun.file(resolve(ROOT, rel)).text();
      for (const o of scanMakefile(rel, src)) offences.push(`${o.file}:${o.line} [${o.form}] ${o.text}`);
    }
    expect(offences).toEqual([]);
  });
});
