/**
 * No credential on a process command line from any shell script.
 *
 * The Makefile scan (makefile-secrets.test.ts) does not see `*.sh`, and the
 * experiment scripts are where the same leak came back: cipherstash-eql's
 * run-local.sh passed the DB password as `docker run -e PGRST_DB_URI=
 * "postgres://authenticator:$PGPASS@..."`, and sfp-platforms' run-ab.sh handed
 * the PAT to `env SUPABASE_ACCESS_TOKEN="$tok" pvlab ...`. Both put the value
 * in a child's argv, readable by `ps`/`pgrep -fl` for anyone on the box.
 *
 * The rule is the Makefile one: secrets reach children through the
 * ENVIRONMENT or stdin.
 *   - `NAME="$X" docker run -e NAME` (or `export NAME`), never `-e NAME=$X`.
 *   - psql/pgbench read PGPASSWORD; a DSN with a password goes in an env var
 *     (`export URL=...`, `URL=... cmd`), never in an argument.
 *   - curl reads headers from stdin: `printf 'Authorization: Bearer %s\n'
 *     "$TOK" | curl -H @- ...` (printf is a builtin, so no argv entry).
 *   - jq reads `env.NAME` / `$ENV.NAME`, bun/node read `process.env.NAME`.
 *   - `env NAME=$X cmd` is env(1), an external binary: the value is in its
 *     argv until it execs. Export in a subshell instead.
 * Where there is genuinely no alternative, put `# argv-secret-ok: <reason>` on
 * the offending line or on the line above the command.
 *
 * This is a lexer, not a shell parser: it splits commands on unquoted
 * separators, recurses into $(...), <(...) and backticks, skips heredoc bodies
 * and [[ ]], and treats builtins and functions defined in the same file as
 * in-process (their arguments never reach an exec).
 */
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");

export type Offence = { file: string; line: number; form: string; text: string };

type Word = { raw: string; live: string; line: number; redir: boolean };
type Cmd = { words: Word[]; line: number };

export const FORM = {
  dockerEnv: "credential in a docker -e NAME=value argument (set NAME in the env, pass -e NAME)",
  dsn: "password inside a DSN/URL argument (put the URL in an env var, or use PGPASSWORD)",
  header: "credential in a curl -H argument (use printf ... | curl -H @-)",
  env: "credential in an env(1) NAME=value argument (export in a subshell instead)",
  arg: "secret variable expanded into a command argument",
  marker: "argv-secret-ok marker without a reason",
} as const;

/** Variable names that hold a credential. Anon/publishable keys are public by design. */
const SECRET_NAME =
  /^(?!.*(?:anon|publishable))(?:.*(?:secret|passw|token|private_?key|service_?role|api_?key).*|.*pass|.*pw|tok|tok_.*|.*_tok|service|jwt|jwt_.*|.*_jwt)$/i;
/** An env/docker -e name whose value is a credential (a URL/DSN counts only with a password in it). */
const SECRET_ENV_NAME = /^(?!.*(?:anon|publishable))(?=.*(?:secret|pass|token|key|jwt|pw))/i;
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
/** In-process: arguments never reach an exec. */
const BUILTINS = new Set([
  ":", ".", "[", "[[", "alias", "break", "builtin", "case", "cd", "continue", "declare", "echo", "eval", "exit",
  "export", "false", "for", "getopts", "hash", "let", "local", "mapfile", "popd", "printf", "pushd", "read",
  "readarray", "readonly", "return", "select", "set", "shift", "source", "test", "trap", "true", "type",
  "typeset", "ulimit", "umask", "unset", "wait", "esac", "done", "fi", "in",
]);
/** Words that precede the real command word. */
const TRANSPARENT = new Set(["!", "if", "then", "do", "else", "elif", "while", "until", "{", "}", "exec", "command", "time"]);

function secretRefs(live: string): string[] {
  return [...live.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]!).filter((n) => SECRET_NAME.test(n));
}

/** Index just past the `)` that closes a `(` at `open`, honouring quotes and nesting. */
function closeParen(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") { i++; continue; }
    if (c === "'") { const j = src.indexOf("'", i + 1); i = j < 0 ? src.length : j; continue; }
    if (c === '"') {
      for (i++; i < src.length && src[i] !== '"'; i++) {
        if (src[i] === "\\") i++;
        else if (src[i] === "$" && src[i + 1] === "(") i = closeParen(src, i + 1) - 1;
      }
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i + 1;
  }
  return src.length;
}

const lines = (s: string) => s.split("\n").length - 1;

/** Lex `src` (starting at line `line0`) into simple commands, recursing into substitutions. */
function lex(src: string, line0: number, out: Cmd[], markers: Map<number, boolean>): void {
  let line = line0;
  let cur: Word | null = null;
  let words: Word[] = [];
  let redirNext = false;
  const heredocs: { delim: string; strip: boolean }[] = [];
  const word = () => (cur ??= { raw: "", live: "", line, redir: redirNext });
  const endWord = () => {
    if (cur) { words.push(cur); redirNext = false; }
    cur = null;
  };
  const endCmd = () => {
    endWord();
    if (words.length) out.push({ words, line: words[0]!.line });
    words = [];
  };
  const sub = (start: number, end: number, innerFrom: number, innerTo: number) => {
    lex(src.slice(innerFrom, innerTo), line + lines(src.slice(start, innerFrom)), out, markers);
    const text = src.slice(start, end);
    const w = word();
    w.raw += text;
    w.live += " ".repeat(text.length);
    line += lines(text);
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1];
    if (c === "\\") {
      if (next === "\n") { i += 2; line++; continue; }
      const w = word();
      w.raw += src.slice(i, i + 2);
      w.live += "__";
      i += 2;
      continue;
    }
    if (c === "#" && !cur) {
      const eol = src.indexOf("\n", i);
      const comment = src.slice(i, eol < 0 ? src.length : eol);
      const m = comment.match(/argv-secret-ok\b:?\s*(.*)$/);
      if (m) markers.set(line, m[1]!.trim().length > 0);
      i = eol < 0 ? src.length : eol;
      continue;
    }
    if (c === "\n") {
      endCmd();
      i++;
      line++;
      for (const h of heredocs) {
        while (i < src.length) {
          const eol = src.indexOf("\n", i);
          const body = src.slice(i, eol < 0 ? src.length : eol);
          i = eol < 0 ? src.length : eol + 1;
          line++;
          if ((h.strip ? body.replace(/^\t+/, "") : body) === h.delim) break;
        }
      }
      heredocs.length = 0;
      continue;
    }
    if (c === " " || c === "\t") { endWord(); i++; continue; }
    if (c === "[" && next === "[" && !cur && /\s/.test(src[i + 2] ?? "")) {
      const end = src.indexOf("]]", i);
      const stop = end < 0 ? src.length : end + 2;
      line += lines(src.slice(i, stop));
      words.push({ raw: "[[", live: "[[", line, redir: false });
      i = stop;
      continue;
    }
    if (c === "(" && next === "(" && !cur) {
      const end = src.indexOf("))", i);
      const stop = end < 0 ? src.length : end + 2;
      line += lines(src.slice(i, stop));
      i = stop;
      continue;
    }
    if (c === "'") {
      const j = src.indexOf("'", i + 1);
      const stop = j < 0 ? src.length : j + 1;
      const text = src.slice(i, stop);
      const w = word();
      w.raw += text;
      w.live += text.replace(/[^\n]/g, " ");
      line += lines(text);
      i = stop;
      continue;
    }
    if (c === '"') {
      const w = word();
      w.raw += c;
      w.live += c;
      i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === "\\") {
          w.raw += src.slice(i, i + 2);
          w.live += "__";
          if (src[i + 1] === "\n") line++;
          i += 2;
        } else if (src[i] === "$" && src[i + 1] === "(") {
          const end = closeParen(src, i + 1);
          sub(i, end, i + 2, end - 1);
          i = end;
        } else if (src[i] === "`") {
          const j = src.indexOf("`", i + 1);
          const end = j < 0 ? src.length : j + 1;
          sub(i, end, i + 1, end - 1);
          i = end;
        } else {
          if (src[i] === "\n") line++;
          w.raw += src[i];
          w.live += src[i];
          i++;
        }
      }
      w.raw += '"';
      w.live += '"';
      i++;
      continue;
    }
    if ((c === "$" || c === "<" || c === ">") && next === "(" && !(c === "$" && src[i + 2] === "(")) {
      const end = closeParen(src, i + 1);
      sub(i, end, i + 2, end - 1);
      i = end;
      continue;
    }
    if (c === "$" && next === "(") {
      // $(( arithmetic )): no command, no argv
      const end = closeParen(src, i + 1);
      const w = word();
      w.raw += src.slice(i, end);
      w.live += " ".repeat(end - i);
      i = end;
      continue;
    }
    if (c === "`") {
      const j = src.indexOf("`", i + 1);
      const end = j < 0 ? src.length : j + 1;
      sub(i, end, i + 1, end - 1);
      i = end;
      continue;
    }
    if (c === "$" && next === "{") {
      let depth = 0;
      let j = i + 1;
      for (; j < src.length; j++) {
        if (src[j] === "{") depth++;
        else if (src[j] === "}" && --depth === 0) break;
      }
      const text = src.slice(i, j + 1);
      const w = word();
      w.raw += text;
      w.live += text;
      i = j + 1;
      continue;
    }
    if (c === "<" && next === "<" && src[i + 2] === "<") {
      endWord();
      redirNext = true;
      i += 3;
      continue;
    }
    if (c === "<" && next === "<") {
      endWord();
      const m = src.slice(i).match(/^<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/);
      if (m) {
        heredocs.push({ delim: m[3]!, strip: m[1] === "-" });
        i += m[0].length;
      } else i += 2;
      continue;
    }
    if (c === "<" || c === ">" || (c === "&" && next === ">")) {
      // redirection: the operator (and an fd like 2> or >&1) is not an argument
      const pending = cur as Word | null;
      if (pending && /^\d+$/.test(pending.raw)) cur = null;
      endWord();
      let j = i + 1;
      while (j < src.length && /[<>&|]/.test(src[j]!)) j++;
      const fd = src.slice(j).match(/^\d+|^-/);
      if (src[j - 1] === "&" && fd) j += fd[0].length;
      else redirNext = true;
      i = j;
      continue;
    }
    if (c === ";" || c === "&" || c === "|" || c === "(" || c === ")") {
      endCmd();
      i++;
      continue;
    }
    const w = word();
    w.raw += c;
    w.live += c;
    i++;
  }
  endCmd();
}

function dsnPassword(raw: string): boolean {
  for (const m of raw.matchAll(/[a-z][a-z0-9+.-]*:\/\/[^\s:@\/"']+:/g)) {
    const rest = raw.slice(m.index! + m[0].length);
    if (rest.startsWith("$(")) {
      if (rest[closeParen(rest, 1)] === "@") return true;
      continue;
    }
    const pw = rest.match(/^[^@\s"'\/]*/)![0];
    if (pw.includes("$") && rest[pw.length] === "@") return true;
  }
  return false;
}

export function scanShell(file: string, src: string): Offence[] {
  const cmds: Cmd[] = [];
  const markers = new Map<number, boolean>();
  lex(src, 1, cmds, markers);
  const fns = new Set([...src.matchAll(/^\s*(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\)/gm)].map((m) => m[1]!));
  const phys = src.split("\n");
  const out: Offence[] = [];
  for (const [n, ok] of markers) if (!ok) out.push({ file, line: n, form: FORM.marker, text: (phys[n - 1] ?? "").trim().slice(0, 160) });
  const okAt = (n: number) => markers.get(n) === true;
  for (const cmd of cmds) {
    const ws = cmd.words.filter((w) => !w.redir);
    let k = 0;
    for (;;) {
      while (k < ws.length && ASSIGN.test(ws[k]!.raw)) k++;
      if (k < ws.length && TRANSPARENT.has(ws[k]!.raw)) { k++; continue; }
      break;
    }
    const head = ws[k];
    if (!head || BUILTINS.has(head.raw) || fns.has(head.raw)) continue;
    const args = ws.slice(k + 1);
    const add = (w: Word, form: string) => {
      if (okAt(w.line) || okAt(cmd.line) || okAt(cmd.line - 1)) return;
      out.push({ file, line: w.line, form, text: (phys[w.line - 1] ?? "").trim().slice(0, 160) });
    };
    for (let a = 0; a < args.length; a++) {
      const w = args[a]!;
      // -e NAME=value / --env NAME=value / --env=NAME=value / -eNAME=value
      if ((w.raw === "-e" || w.raw === "--env") && args[a + 1] && ASSIGN.test(args[a + 1]!.raw)) {
        const v = args[++a]!;
        if (v.raw.includes("$") && (SECRET_ENV_NAME.test(v.raw.split("=")[0]!) || secretRefs(v.live).length || dsnPassword(v.raw))) {
          add(v, FORM.dockerEnv);
        }
        continue;
      }
      const glued = w.raw.match(/^(?:--env=|-e)([A-Za-z_]\w*)=(.*)$/s);
      if (glued && glued[2]!.includes("$") && (SECRET_ENV_NAME.test(glued[1]!) || secretRefs(w.live).length || dsnPassword(w.raw))) {
        add(w, FORM.dockerEnv);
        continue;
      }
      if (head.raw === "env" && ASSIGN.test(w.raw)) {
        if (w.raw.includes("$") && (SECRET_ENV_NAME.test(w.raw.split("=")[0]!) || secretRefs(w.live).length)) add(w, FORM.env);
        continue;
      }
      if (dsnPassword(w.raw)) { add(w, FORM.dsn); continue; }
      const h = w.raw.match(/(?:Authorization:\s*Bearer|apikey:)\s*\$\{?(\w+)/i);
      if (h && SECRET_NAME.test(h[1]!)) { add(w, FORM.header); continue; }
      if (h) continue; // anon/publishable key header
      if (secretRefs(w.live).length) add(w, FORM.arg);
    }
  }
  return out.sort((x, y) => x.line - y.line);
}

async function shellScripts(): Promise<string[]> {
  const found = await Array.fromAsync(new Bun.Glob("{experiments,harness}/**/*.sh").scan({ cwd: ROOT }));
  return found.filter((f) => !f.includes("node_modules/")).sort();
}

describe("shell scanner", () => {
  const scan = (src: string) => scanShell("t.sh", src).map((o) => `${o.line} ${o.form}`);

  test("flags the run-local.sh forms from the card", () => {
    const src = [
      "PGPASS=probe", // 1
      "JWT_SECRET=$(openssl rand -hex 32)", // 2
      "docker run -d --name eql-probe --network $NET \\", // 3
      '  -e POSTGRES_PASSWORD=$PGPASS -p 54329:5432 "$PG_IMAGE" >/dev/null', // 4
      "psql -h localhost -U supabase_admin -qc \"ALTER ROLE authenticator PASSWORD '$PGPASS'\"", // 5
      "docker run -d --name eql-pgrst -p 54330:3000 \\", // 6
      '  -e PGRST_DB_URI="postgres://authenticator:$PGPASS@eql-probe:5432/postgres" \\', // 7
      "  -e PGRST_DB_SCHEMAS=app -e PGRST_DB_ANON_ROLE=anon \\", // 8
      '  -e PGRST_JWT_SECRET="$JWT_SECRET" "$PGRST_IMAGE" >/dev/null', // 9
      "mkjwt() {", // 10
      "  bun -e '", // 11
      "    const [secret, sub] = process.argv.slice(1);", // 12
      "    console.log(secret, sub);' \"$JWT_SECRET\" \"$1\"", // 13
      "}", // 14
    ].join("\n");
    expect(scan(src)).toEqual([
      `4 ${FORM.dockerEnv}`,
      `5 ${FORM.arg}`,
      `7 ${FORM.dockerEnv}`,
      `9 ${FORM.dockerEnv}`,
      `13 ${FORM.arg}`,
    ]);
  });

  test("flags DSN, header, env(1) and --password forms", () => {
    const src = [
      'psql "postgres://postgres.$REF:$DB_PASSWORD@h:5432/postgres" -c "select 1"', // 1
      "cargo run -- \"postgres://postgres:$(jq -rn 'env.DB_PASS | @uri')@[$ADDR]:5432/postgres\"", // 2
      'curl -s -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" https://x', // 3
      'env SUPABASE_ACCESS_TOKEN="$tok" PVLAB_ORG_SLUGS="$slug" ./pvlab', // 4
      'mysql --password "$DB_PASS" -h h', // 5
      'x=$(curl -s -H "apikey: $SERVICE" https://x | jq .)', // 6
      'timeout 60 pgbench "host=h password=$PW" -c 4', // 7
    ].join("\n");
    expect(scan(src)).toEqual([
      `1 ${FORM.dsn}`,
      `2 ${FORM.dsn}`,
      `3 ${FORM.header}`,
      `4 ${FORM.env}`,
      `5 ${FORM.arg}`,
      `6 ${FORM.header}`,
      `7 ${FORM.arg}`,
    ]);
  });

  test("accepts env, stdin and in-process forms", () => {
    const src = [
      ': "${SUPABASE_ACCESS_TOKEN:?}" "${DB_PASS:?}"',
      'TOK_P="${SUPABASE_ACCESS_TOKEN_PLATFORM:-${SUPABASE_ACCESS_TOKEN:?no token}}"',
      "export PGPASSWORD=$DB_PASS PGSSLMODE=require",
      'export EQL_TEST_DATABASE_URL="postgres://postgres:$(jq -rn \'env.DB_PASS | @uri\')@[$ADDR]:5432/postgres"',
      'PGRST_DB_URI="postgres://authenticator:$PGPASS@db:5432/postgres" PGRST_JWT_SECRET=$JWT_SECRET \\',
      '  docker run -d -e PGRST_DB_URI -e PGRST_DB_SCHEMAS=app -e PGRST_JWT_SECRET "$IMG"',
      "printf 'Authorization: Bearer %s\\napikey: %s\\n' \"$SERVICE\" \"$SERVICE\" | curl -s -H @- https://x",
      'printf "ALTER ROLE authenticator PASSWORD \'%s\';\\n" "$PGPASS" | psql -q -v ON_ERROR_STOP=1',
      "jq -n '{password: env.UPASS, db: $ENV.JQ_DBPW}' > \"$BODY\"",
      'ANON=$(jq -r \'.[0].api_key\' <<<"$KEYS"); T=$(jq -r .t <<<"$SERVICE_TOKEN")',
      'curl -s -H "apikey: $ANON_TMP" https://x',
      "mkuser() { export EMAIL=$1 UPASS=$2; }",
      'mkuser "$UA_EMAIL" "$UA_PASS"',
      '[[ -n $JWT_A && $JWT_A != null && -n $JWT_B ]] || exit 1',
      'if [ -z "$PW" ] || [ -z "${SUPABASE_ACCESS_TOKEN:-}" ]; then exit 1; fi',
      '( cd zk && SUPABASE_ANON_KEY="$ANON" JWT_A=$(mkuser "$UID_A") DATABASE_URL="postgres://p:$DB_PASS@h/db" bun probe.ts ) > log 2>&1',
      "psql <<SQL",
      "ALTER ROLE x PASSWORD '$PGPASS';",
      "SQL",
      "trap 'rm -f \"$TOKEN_FILE\"' EXIT",
      "# curl -H \"Authorization: Bearer $TOK\" is the leak this file forbids",
      'echo "health=$h after $(( $(date +%s) - t0 )) s"',
      'curl -sf "http://127.0.0.1:$PROXY_PORT/x"',
      'docker run -e PGRST_URL="http://$HOST:3000" -e SUPABASE_ANON_KEY="$ANON" img',
      'ssh host "uptime" # argv-secret-ok: no secret, marker is harmless',
      "# argv-secret-ok: vendor CLI has no env or stdin input for this flag",
      'vendor-cli --token "$VENDOR_TOKEN"',
    ].join("\n");
    expect(scan(src)).toEqual([]);
  });

  test("a marker without a reason is an offence and suppresses nothing", () => {
    const src = ["# argv-secret-ok", 'vendor-cli --token "$VENDOR_TOKEN"', 'other --token "$VENDOR_TOKEN"'].join("\n");
    expect(scan(src)).toEqual([`1 ${FORM.marker}`, `2 ${FORM.arg}`, `3 ${FORM.arg}`]);
  });

  test("line numbers survive multi-line single-quoted strings and heredocs", () => {
    const src = [
      "jq -n '", // 1
      "  {a: 1}", // 2
      "' > f", // 3
      "cat <<-EOF", // 4
      "\tbody $PW", // 5
      "\tEOF", // 6
      'curl -H "Authorization: Bearer $TOK" https://x', // 7
    ].join("\n");
    expect(scan(src)).toEqual([`7 ${FORM.header}`]);
  });
});

describe("no shell script puts a credential on a command line", async () => {
  const files = await shellScripts();
  test("there are shell scripts to scan", () => {
    expect(files.length).toBeGreaterThan(10);
  });
  test("every experiments/ and harness/ *.sh", async () => {
    const offences: string[] = [];
    for (const rel of files) {
      const src = await Bun.file(resolve(ROOT, rel)).text();
      for (const o of scanShell(rel, src)) offences.push(`${o.file}:${o.line} [${o.form}] ${o.text}`);
    }
    expect(offences).toEqual([]);
  });
});
