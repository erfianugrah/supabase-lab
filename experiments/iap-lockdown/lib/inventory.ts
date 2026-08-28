/**
 * Shared inventory + helpers for experiments/iap-lockdown.
 *
 * The experiment's unit of evidence is the SURFACE ROW: one HTTP surface of
 * the managed tier, probed with a given credential, recording status code and
 * the platform's own error code verbatim. Every Phase A module is "apply (or
 * read) a lever, then take the inventory", so the probes live here once.
 *
 * Fixture the inventory expects on the project (L01 seeds it):
 *   - table public.iap_probe (2 rows, anon SELECT granted, no RLS)
 *   - auth user IAP_USER_EMAIL / IAP_USER_PASSWORD (password grant works)
 *   - public storage bucket "iap-public" holding hello.txt
 *   - edge function "iap-probe-open" deployed with verify_jwt=false
 */
import type { IncomingMessage } from "node:http";
import WebSocket from "ws";
import type { Ctx } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";

export const TABLE = "iap_probe";
export const BUCKET_PUBLIC = "iap-public";
export const EF_OPEN = "iap-probe-open";
export const EF_LOCKED = "iap-probe-locked";
export const IAP_USER_PASSWORD = `${crypto.randomUUID()}Aa1!`;

export interface Probe {
  status: number;
  /** Platform error code parsed from the JSON body (PGRST*, etc), verbatim. */
  code: string;
  ms: number;
}

/** One HTTP probe against the project host. `key` becomes apikey + bearer. */
export async function http(
  url: string,
  opts: {
    method?: string;
    key?: string;
    body?: unknown;
    headers?: Record<string, string>;
    timeoutMs?: number;
  } = {},
): Promise<Probe> {
  const t0 = performance.now();
  try {
    const res = await fetch(url, {
      method: opts.method ?? "GET",
      headers: {
        ...(opts.key ? { apikey: opts.key, Authorization: `Bearer ${opts.key}` } : {}),
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(opts.headers ?? {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
    const text = await res.text();
    let code = "";
    try {
      const j = JSON.parse(text);
      code = String(j.code ?? j.error_code ?? j.error ?? j.message ?? j.msg ?? "").slice(0, 80);
    } catch {
      code = text.trim().slice(0, 60);
    }
    return { status: res.status, code, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    return {
      status: 0,
      code: `ERR:${(e instanceof Error ? e.message : String(e)).slice(0, 80)}`,
      ms: Math.round(performance.now() - t0),
    };
  }
}

/** Management query endpoint - write-capable SQL without DB connectivity. */
export async function sql(ctx: Ctx, query: string): Promise<void> {
  const r = await mgmt(ctx, "POST", `/projects/${ctx.ref}/database/query`, { query });
  if (r.status >= 300) throw new Error(`sql http ${r.status}: ${r.text.slice(0, 300)}`);
}

export async function waitFor(
  fn: () => Promise<boolean>,
  timeoutMs: number,
  pollMs = 3000,
): Promise<{ ok: boolean; elapsedS: number }> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await fn()) return { ok: true, elapsedS: Math.round((Date.now() - t0) / 1000) };
    await Bun.sleep(pollMs);
  }
  return { ok: false, elapsedS: Math.round((Date.now() - t0) / 1000) };
}

export interface ProjectKeys {
  anonJwt: string;
  serviceJwt: string;
  publishable?: { id: string; api_key: string };
  secret?: { id: string; api_key: string };
}

/** New projects carry both key generations; select by name/type explicitly. */
export async function fetchKeys(ctx: Ctx): Promise<ProjectKeys> {
  const r = await mgmt(ctx, "GET", `/projects/${ctx.ref}/api-keys?reveal=true`);
  if (r.status !== 200 || !Array.isArray(r.json)) {
    throw new Error(`api-keys http ${r.status}: ${r.text.slice(0, 200)}`);
  }
  const rows = r.json as { id: string; name: string; type?: string; api_key?: string }[];
  const byName = (n: string) => rows.find((k) => k.name === n)?.api_key ?? "";
  const anonJwt = byName("anon");
  const serviceJwt = byName("service_role");
  if (!anonJwt || !serviceJwt) throw new Error("legacy anon/service_role keys absent");
  return {
    anonJwt,
    serviceJwt,
    publishable: rows
      .filter((k) => k.type === "publishable")
      .map((k) => ({ id: k.id, api_key: k.api_key ?? "" }))[0],
    secret: rows
      .filter((k) => k.type === "secret")
      .map((k) => ({ id: k.id, api_key: k.api_key ?? "" }))[0],
  };
}

/** Seed the fixture the inventory probes. Idempotent-ish; run once in L01. */
export async function seedFixture(ctx: Ctx, keys: ProjectKeys): Promise<{ userEmail: string }> {
  const userEmail = `iap.probe.${Date.now()}@example.com`;
  await sql(ctx, `
create table if not exists public.${TABLE} (
  id bigint generated always as identity primary key,
  note text not null default ''
);
truncate public.${TABLE};
insert into public.${TABLE} (note) values ('probe-a'), ('probe-b');
grant select on public.${TABLE} to anon, authenticated;
  `);

  const admin = await http(`https://${ctx.apiHost}/auth/v1/admin/users`, {
    method: "POST",
    key: keys.serviceJwt,
    body: { email: userEmail, password: IAP_USER_PASSWORD, email_confirm: true },
  });
  if (admin.status >= 300 && admin.status !== 422) {
    throw new Error(`admin create user: HTTP ${admin.status} ${admin.code}`);
  }

  const bucket = await http(`https://${ctx.apiHost}/storage/v1/bucket`, {
    method: "POST",
    key: keys.serviceJwt,
    body: { id: BUCKET_PUBLIC, name: BUCKET_PUBLIC, public: true },
  });
  if (bucket.status >= 300 && !/already.?exists|duplicate/i.test(bucket.code)) {
    throw new Error(`create bucket: HTTP ${bucket.status} ${bucket.code}`);
  }
  const put = await fetch(`https://${ctx.apiHost}/storage/v1/object/${BUCKET_PUBLIC}/hello.txt`, {
    method: "PUT",
    headers: {
      apikey: keys.serviceJwt,
      Authorization: `Bearer ${keys.serviceJwt}`,
      "Content-Type": "text/plain",
      "x-upsert": "true",
    },
    body: "hello-iap-probe\n",
    signal: AbortSignal.timeout(15_000),
  });
  if (put.status >= 300) {
    throw new Error(`upload object: HTTP ${put.status} ${(await put.text()).slice(0, 120)}`);
  }

  const body =
    "Deno.serve(() => new Response(JSON.stringify({ ok: true, fn: 'open' }), { headers: { 'Content-Type': 'application/json' } }))";
  const fn = await mgmt(ctx, "POST", `/projects/${ctx.ref}/functions`, {
    slug: EF_OPEN,
    name: EF_OPEN,
    verify_jwt: false,
    body,
  });
  if (fn.status >= 300 && !/duplicat|already exists/i.test(fn.text)) {
    throw new Error(`deploy ${EF_OPEN}: HTTP ${fn.status} ${fn.text.slice(0, 200)}`);
  }

  // Propagation: REST needs a schema-cache reload for a fresh table, and a
  // fresh EF needs its own settle window (W25 measured ~10.6s). Poll both.
  const ready = await waitFor(async () => {
    const rest = await http(`https://${ctx.apiHost}/rest/v1/${TABLE}?select=id&limit=1`, {
      key: keys.anonJwt,
    });
    const fnProbe = await http(`https://${ctx.apiHost}/functions/v1/${EF_OPEN}`, {
      key: keys.anonJwt,
    });
    return rest.status === 200 && fnProbe.status === 200;
  }, 120_000);
  if (!ready.ok) throw new Error("fixture never became reachable (rest table or open EF)");

  return { userEmail };
}

export interface RealtimeOutcome {
  handshake: boolean;
  handshakeMs: number;
  joinStatus: string;
  detail: string;
}

/** Anon WebSocket handshake + public-channel join. Same shape as T23's. */
export function realtimeJoin(ctx: Ctx, key: string, timeoutMs = 15_000): Promise<RealtimeOutcome> {
  return new Promise((resolve) => {
    const url = `wss://${ctx.apiHost}/realtime/v1/websocket?apikey=${key}&vsn=1.0.0`;
    const t0 = performance.now();
    const ws = new WebSocket(url, { handshakeTimeout: timeoutMs });
    let handshake = false;
    let handshakeMs = 0;
    const finish = (o: Omit<RealtimeOutcome, "handshake" | "handshakeMs">) => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      resolve({ handshake, handshakeMs, ...o });
    };
    const timer = setTimeout(
      () => finish({ joinStatus: "none", detail: `no phx_reply within ${timeoutMs}ms` }),
      timeoutMs,
    );
    ws.on("open", () => {
      handshake = true;
      handshakeMs = Math.round(performance.now() - t0);
      ws.send(
        JSON.stringify({
          topic: "realtime:iap-probe",
          event: "phx_join",
          payload: { config: { broadcast: { self: false }, presence: { key: "" }, private: false } },
          ref: "1",
        }),
      );
    });
    ws.on("message", (raw: Buffer | string) => {
      const text = raw.toString();
      let msg: { event?: string; payload?: { status?: string } } | undefined;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      if (msg?.event !== "phx_reply" && msg?.event !== "phx_error") return;
      finish({ joinStatus: msg.payload?.status ?? msg.event, detail: text.slice(0, 300) });
    });
    ws.on("unexpected-response", (_req: unknown, res: IncomingMessage) =>
      finish({ joinStatus: "upgrade-refused", detail: `HTTP ${res.statusCode} on upgrade` }),
    );
    ws.on("error", (e: Error) => finish({ joinStatus: "error", detail: e.message }));
  });
}

export interface InventoryRow {
  surface: string;
  status: number;
  code: string;
  ms: number;
}

/**
 * The full HTTP-tier inventory with one credential. `userEmail` enables the
 * password-grant row; pass "" to skip it (signup-disabled runs would seed a
 * fresh user each call otherwise).
 */
export async function inventory(
  ctx: Ctx,
  key: string,
  userEmail: string,
): Promise<InventoryRow[]> {
  const base = `https://${ctx.apiHost}`;
  const rows: InventoryRow[] = [];
  const add = async (surface: string, p: Promise<Probe>) => {
    const r = await p;
    rows.push({ surface, status: r.status, code: r.code, ms: r.ms });
  };

  await add("rest_root", http(`${base}/rest/v1/`, { key }));
  await add("rest_table", http(`${base}/rest/v1/${TABLE}?select=id&limit=1`, { key }));
  await add(
    "graphql",
    http(`${base}/graphql/v1`, {
      method: "POST",
      key,
      body: { query: "{ __schema { queryType { name } } }" },
    }),
  );
  await add("auth_health", http(`${base}/auth/v1/health`, { key }));
  if (userEmail) {
    await add(
      "auth_login",
      http(`${base}/auth/v1/token?grant_type=password`, {
        method: "POST",
        key,
        body: { email: userEmail, password: IAP_USER_PASSWORD },
      }),
    );
  }
  await add("storage_buckets", http(`${base}/storage/v1/bucket`, { key }));
  await add("storage_public_object", http(`${base}/storage/v1/object/public/${BUCKET_PUBLIC}/hello.txt`, { key }));
  await add("storage_render", http(`${base}/storage/v1/render/image/public/${BUCKET_PUBLIC}/hello.txt?width=32`, { key }));
  await add("storage_s3", http(`${base}/storage/v1/s3`, { key }));
  await add("auth_admin", http(`${base}/auth/v1/admin/users?page=1&per_page=1`, { key }));
  // Signup probed with a malformed address so the endpoint's posture shows in
  // the error code without creating a real user per inventory run: a live
  // endpoint answers an address-validation error, a disabled one answers
  // signup_disabled regardless of the address.
  await add(
    "auth_signup",
    http(`${base}/auth/v1/signup`, {
      method: "POST",
      key,
      body: { email: "iap-probe-not-an-email", password: "x" },
    }),
  );
  await add("ef_open", http(`${base}/functions/v1/${EF_OPEN}`, { key }));
  await add("host_root", http(`${base}/`, { key }));

  const rt = await realtimeJoin(ctx, key);
  rows.push({
    surface: "realtime_ws",
    status: rt.handshake ? 101 : 0,
    code: `handshake:${rt.handshake ? "ok" : "refused"} join:${rt.joinStatus}`,
    ms: rt.handshakeMs,
  });

  return rows;
}

/** Flatten inventory rows into report measurements: `<surface>_<label>`. */
export function toMeasurements(
  rows: InventoryRow[],
  label: string,
): Record<string, string | number> {
  const m: Record<string, string | number> = {};
  for (const r of rows) {
    m[`${r.surface}_${label}`] = r.code ? `${r.status} ${r.code}` : `${r.status}`;
  }
  return m;
}
