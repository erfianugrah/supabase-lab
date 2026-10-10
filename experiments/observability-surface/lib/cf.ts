/**
 * Cloudflare REST helpers for OB04: upload the sink Worker (with its Durable
 * Object binding and a secret) as a `ob-surface-` script, switch on its
 * workers.dev route, and delete it afterwards. Credentials come from the
 * environment of the run (`CLOUDFLARE_EMAIL`, `CLOUDFLARE_API_KEY`,
 * `CLOUDFLARE_ACCOUNT_ID`); a scoped API token that is limited to zone DNS
 * answers "Authentication error" on the Workers endpoints, which is why the
 * global key pair is the pattern here.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const BASE = "https://api.cloudflare.com/client/v4";

export interface CfEnv {
  email: string;
  key: string;
  account: string;
}

export function cfEnv(): CfEnv | null {
  const email = process.env.CLOUDFLARE_EMAIL ?? "";
  const key = process.env.CLOUDFLARE_API_KEY ?? "";
  const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
  return email && key && account ? { email, key, account } : null;
}

async function cf(env: CfEnv, method: string, path: string, body?: BodyInit, headers: Record<string, string> = {}) {
  const res = await fetch(`${BASE}/accounts/${env.account}${path}`, {
    method,
    headers: { "X-Auth-Email": env.email, "X-Auth-Key": env.key, ...headers },
    body,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let json: { success?: boolean; errors?: unknown; result?: unknown } = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json, text };
}

export async function accountSubdomain(env: CfEnv): Promise<string> {
  const r = await cf(env, "GET", "/workers/subdomain");
  return String((r.json.result as { subdomain?: string } | undefined)?.subdomain ?? "");
}

/** Upload the sink as `name` with the OB_KEY secret and the Durable Object binding; returns its workers.dev URL. */
export async function deploySink(env: CfEnv, name: string, secret: string): Promise<{ url: string; status: number; detail: string }> {
  const code = readFileSync(resolve(import.meta.dir, "../worker/sink.js"), "utf8");
  const metadata = {
    main_module: "sink.js",
    compatibility_date: "2026-10-01",
    bindings: [
      { type: "durable_object_namespace", name: "STORE", class_name: "Store" },
      { type: "secret_text", name: "OB_KEY", text: secret },
    ],
    migrations: { new_tag: "v1", new_sqlite_classes: ["Store"] },
  };
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  form.append("sink.js", new Blob([code], { type: "application/javascript+module" }), "sink.js");
  const up = await cf(env, "PUT", `/workers/scripts/${name}`, form);
  if (up.status >= 300) return { url: "", status: up.status, detail: up.text.slice(0, 400) };
  const sub = await cf(env, "POST", `/workers/scripts/${name}/subdomain`, JSON.stringify({ enabled: true }), { "Content-Type": "application/json" });
  const host = await accountSubdomain(env);
  return { url: `https://${name}.${host}.workers.dev`, status: sub.status, detail: sub.status >= 300 ? sub.text.slice(0, 300) : "" };
}

export async function deleteSink(env: CfEnv, name: string): Promise<number> {
  // ?force=true also removes the Durable Object namespace the script owns
  const r = await cf(env, "DELETE", `/workers/scripts/${name}?force=true`);
  return r.status;
}

export async function sinkExists(env: CfEnv, name: string): Promise<boolean> {
  const r = await cf(env, "GET", "/workers/scripts");
  const rows = Array.isArray(r.json.result) ? (r.json.result as { id?: string }[]) : [];
  return rows.some((s) => s.id === name);
}
