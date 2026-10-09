/**
 * Kit orchestration over the Management API - no psql needed.
 *
 *   bun scripts/kit.ts schema <ref> <sql files...>   apply SQL files in order
 *   bun scripts/kit.ts seed <ref> [--app]            departments, users, and
 *                                                    (with --app) example rows
 *   bun scripts/kit.ts env <ref>                     write app/.env.production
 *   bun scripts/kit.ts embed <ref>                   real gte-small embeddings
 *                                                    for kb_chunks (needs the
 *                                                    agent function deployed)
 *
 * Users are created through the Auth admin API so the signup trigger in
 * 00-baseline.sql runs exactly as it would for a real user; department and
 * role go in app_metadata, which only the secret key can write. Passwords are
 * generated per run and written to evidence/ (gitignored), never printed.
 *
 * The PAT comes from SUPABASE_ACCESS_TOKEN in the environment.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DEPARTMENTS_SQL, KB_SQL, kbText, newPassword, REQUESTS_SQL, USERS } from "../lib/seed";

const API = "https://api.supabase.com/v1";
const TOK = process.env.SUPABASE_ACCESS_TOKEN ?? "";
if (!TOK) throw new Error("no SUPABASE_ACCESS_TOKEN in the environment");

async function mgmt(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOK}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function sql(ref: string, query: string): Promise<unknown> {
  // Fresh projects answer healthy before the first write succeeds (AGENTS.md,
  // "ACTIVE_HEALTHY is not readiness"), so retry a few times before failing.
  for (let attempt = 1; ; attempt++) {
    const r = await mgmt("POST", `/projects/${ref}/database/query`, { query });
    const text = await r.text();
    if (r.ok) return text ? JSON.parse(text) : [];
    if (attempt >= 5 || (r.status < 500 && r.status !== 429)) {
      throw new Error(`sql http ${r.status}: ${text.slice(0, 400)}`);
    }
    await Bun.sleep(5_000 * attempt);
  }
}

async function secretKey(ref: string): Promise<string> {
  const r = await mgmt("GET", `/projects/${ref}/api-keys?reveal=true`);
  if (!r.ok) throw new Error(`api-keys http ${r.status}`);
  const keys = (await r.json()) as { name?: string; type?: string; api_key?: string }[];
  const k = keys.find((x) => x.type === "secret") ?? keys.find((x) => x.name === "service_role");
  if (!k?.api_key) throw new Error("no secret or service_role key returned");
  return k.api_key;
}

const lit = (s: string) => `'${s.replaceAll("'", "''")}'`;

async function schema(ref: string, files: string[]): Promise<void> {
  for (const f of files) {
    await sql(ref, readFileSync(f, "utf8"));
    console.log(`applied ${f}`);
  }
}

async function seed(ref: string, withApp: boolean): Promise<void> {
  await sql(ref, DEPARTMENTS_SQL);

  const key = await secretKey(ref);
  const creds: Record<string, string> = {};
  for (const u of USERS) {
    const password = newPassword();
    const r = await fetch(`https://${ref}.supabase.co/auth/v1/admin/users`, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        email: u.email,
        password,
        email_confirm: true,
        app_metadata: { department: u.department, role: u.role },
        user_metadata: { display_name: u.name },
      }),
    });
    if (r.ok) {
      creds[u.email] = password;
      console.log(`user ${u.email} created (${u.department}, ${u.role})`);
    } else if (r.status === 422) {
      console.log(`user ${u.email} already exists - kept, password unchanged`);
    } else {
      throw new Error(`create ${u.email}: http ${r.status} ${(await r.text()).slice(0, 300)}`);
    }
  }
  if (Object.keys(creds).length > 0) {
    mkdirSync("evidence", { recursive: true });
    const out = `evidence/users-${ref}.json`;
    writeFileSync(out, JSON.stringify(creds, null, 2), { mode: 0o600 });
    console.log(`passwords written to ${out}`);
  }

  if (!withApp) return;

  // Example rows and knowledge-base rows (placeholder vectors): lib/seed.ts.
  await sql(ref, REQUESTS_SQL);
  await sql(ref, KB_SQL);
  console.log("example rows seeded");
}

// Replace every knowledge-base embedding with a real gte-small vector. The
// vectors come from the agent Edge Function's `embed` mode (pure compute, no
// table access), called as a seeded user; the rows are written here as the
// table owner through the Management API, because users have no update grant
// on kb_chunks. Idempotent: re-running rewrites the same vectors.
async function embedKb(ref: string): Promise<void> {
  const creds = JSON.parse(readFileSync(`evidence/users-${ref}.json`, "utf8")) as Record<string, string>;
  const email = Object.keys(creds)[0];
  if (!email) throw new Error(`no users in evidence/users-${ref}.json - run make seed-ready`);
  const r = await mgmt("GET", `/projects/${ref}/api-keys?reveal=true`);
  const pub = ((await r.json()) as { type?: string; api_key?: string }[]).find((k) => k.type === "publishable")?.api_key;
  if (!pub) throw new Error("no publishable key returned");

  const tok = await fetch(`https://${ref}.supabase.co/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: pub, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: creds[email] }),
  });
  if (!tok.ok) throw new Error(`sign-in as ${email}: http ${tok.status}`);
  const jwt = ((await tok.json()) as { access_token: string }).access_token;

  const rows = (await sql(ref, "select id, title, content from public.kb_chunks order by title")) as {
    id: string;
    title: string;
    content: string;
  }[];
  for (let i = 0; i < rows.length; i += 16) {
    const batch = rows.slice(i, i + 16);
    const res = await fetch(`https://${ref}.supabase.co/functions/v1/agent`, {
      method: "POST",
      headers: { apikey: pub, Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "embed", texts: batch.map((b) => kbText(b.title, b.content)) }),
    });
    if (!res.ok) throw new Error(`embed: http ${res.status} ${(await res.text()).slice(0, 300)}`);
    const { dims, vectors } = (await res.json()) as { dims: number; vectors: number[][] };
    if (dims !== 384) throw new Error(`expected 384 dims, got ${dims}`);
    const values = batch.map((b, j) => `(${lit(b.id)}::uuid, ${lit(JSON.stringify(vectors[j]))})`).join(", ");
    await sql(
      ref,
      `update public.kb_chunks k set embedding = v.e::extensions.vector
         from (values ${values}) as v(id, e) where k.id = v.id`,
    );
  }
  console.log(`embedded ${rows.length} kb_chunks rows with gte-small`);
}

// The app's build-time env: NEXT_PUBLIC_* values are inlined by `next build`,
// so they are written to app/.env.production (gitignored by app/.gitignore)
// rather than passed at deploy time. `next dev` does not read .env.production,
// so the same values go to app/.env.development.local for `make app-dev`
// (without it every page 500s, 2026-10-09). Publishable key only - never the secret.
async function env(ref: string): Promise<void> {
  const r = await mgmt("GET", `/projects/${ref}/api-keys?reveal=true`);
  if (!r.ok) throw new Error(`api-keys http ${r.status}`);
  const keys = (await r.json()) as { type?: string; api_key?: string }[];
  const pub = keys.find((k) => k.type === "publishable")?.api_key;
  if (!pub) throw new Error("no publishable key returned");
  const body = `NEXT_PUBLIC_SUPABASE_URL=https://${ref}.supabase.co\nNEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${pub}\n`;
  writeFileSync("app/.env.production", body);
  writeFileSync("app/.env.development.local", body);
  console.log(`app/.env.production and app/.env.development.local written for ${ref}`);
}

const [cmd, ref, ...rest] = process.argv.slice(2);
if (!ref) throw new Error("usage: kit.ts <schema|seed|env|embed> <ref> [...]");
if (cmd === "schema") await schema(ref, rest);
else if (cmd === "seed") await seed(ref, rest.includes("--app"));
else if (cmd === "env") await env(ref);
else if (cmd === "embed") await embedKb(ref);
else throw new Error(`unknown command ${cmd}`);
