/**
 * Kit orchestration over the Management API - no psql needed.
 *
 *   bun scripts/kit.ts schema <ref> <sql files...>   apply SQL files in order
 *   bun scripts/kit.ts seed <ref> [--app]            departments, users, and
 *                                                    (with --app) example rows
 *   bun scripts/kit.ts env <ref>                     write app/.env.production
 *
 * Users are created through the Auth admin API so the signup trigger in
 * 00-baseline.sql runs exactly as it would for a real user; department and
 * role go in app_metadata, which only the secret key can write. Passwords are
 * generated per run and written to evidence/ (gitignored), never printed.
 *
 * The PAT comes from SUPABASE_ACCESS_TOKEN in the environment.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const API = "https://api.supabase.com/v1";
const TOK = process.env.SUPABASE_ACCESS_TOKEN ?? "";
if (!TOK) throw new Error("no SUPABASE_ACCESS_TOKEN in the environment");

const DEPARTMENTS = ["Sales", "Marketing"];
const USERS = [
  { email: "alice@example.com", name: "Alice", department: "Sales", role: "employee" },
  { email: "bob@example.com", name: "Bob", department: "Sales", role: "manager" },
  { email: "carol@example.com", name: "Carol", department: "Marketing", role: "employee" },
  { email: "dave@example.com", name: "Dave", department: "Marketing", role: "manager" },
];

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
  await sql(
    ref,
    `insert into public.departments (name) values ${DEPARTMENTS.map((d) => `(${lit(d)})`).join(", ")}
     on conflict (name) do nothing`,
  );

  const key = await secretKey(ref);
  const creds: Record<string, string> = {};
  for (const u of USERS) {
    const password = `${crypto.randomUUID()}Aa1!`;
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

  // Example rows, inserted as postgres (the table owner) with explicit ids.
  await sql(
    ref,
    `insert into public.purchase_requests (department_id, requester_id, item, vendor, amount, justification)
     select p.department_id, p.id, v.item, v.vendor, v.amount, v.why
       from public.profiles p
       join auth.users u on u.id = p.id
       join (values
         ('alice@example.com', 'Conference booth kit', 'Acme Displays', 1800.00, 'Trade show next quarter'),
         ('alice@example.com', 'CRM seat add-on', 'Acme Software', 240.00, 'New hire'),
         ('carol@example.com', 'Stock photo licence', 'Acme Media', 420.00, 'Campaign assets')
       ) as v(email, item, vendor, amount, why) on v.email = u.email
      where not exists (select 1 from public.purchase_requests)`,
  );

  // Knowledge-base rows with placeholder embeddings: enough for the RLS
  // checks. Real embeddings come from the agent's Edge Function (gte-small).
  await sql(
    ref,
    `insert into public.kb_chunks (department_id, title, content, embedding)
     select d.id, v.title, v.content,
            (select array_agg(random()::real) from generate_series(1, 384))::extensions.vector
       from (values
         (null, 'Purchasing limits', 'Requests above 2,000 need a second approver.'),
         ('Sales', 'Sales events budget', 'Trade show spend is capped per quarter.'),
         ('Marketing', 'Marketing licences', 'Stock media must use the approved vendors.')
       ) as v(dept, title, content)
       left join public.departments d on d.name = v.dept
      where not exists (select 1 from public.kb_chunks)`,
  );
  console.log("example rows seeded");
}

// The app's build-time env: NEXT_PUBLIC_* values are inlined by `next build`,
// so they are written to app/.env.production (gitignored by app/.gitignore)
// rather than passed at deploy time. Publishable key only - never the secret.
async function env(ref: string): Promise<void> {
  const r = await mgmt("GET", `/projects/${ref}/api-keys?reveal=true`);
  if (!r.ok) throw new Error(`api-keys http ${r.status}`);
  const keys = (await r.json()) as { type?: string; api_key?: string }[];
  const pub = keys.find((k) => k.type === "publishable")?.api_key;
  if (!pub) throw new Error("no publishable key returned");
  writeFileSync(
    "app/.env.production",
    `NEXT_PUBLIC_SUPABASE_URL=https://${ref}.supabase.co\nNEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${pub}\n`,
  );
  console.log(`app/.env.production written for ${ref}`);
}

const [cmd, ref, ...rest] = process.argv.slice(2);
if (!ref) throw new Error("usage: kit.ts <schema|seed|env> <ref> [...]");
if (cmd === "schema") await schema(ref, rest);
else if (cmd === "seed") await seed(ref, rest.includes("--app"));
else if (cmd === "env") await env(ref);
else throw new Error(`unknown command ${cmd}`);
