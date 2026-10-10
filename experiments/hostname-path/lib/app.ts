/**
 * The "app" HP07 runs inside a container whose only resolver is the local
 * Unbound: supabase-js configured with ONE base URL (the custom hostname, or
 * the project hostname for contrast) doing what a small app does - DNS lookup,
 * password sign-in, a REST read, a public Storage object, an Edge Function
 * call, a Realtime subscription. One JSON object per line on stdout; every
 * request's host is recorded so a call that quietly used another host shows.
 *
 * Runs under `oven/bun` with the repo's node_modules mounted at /work/node_modules.
 */
import { lookup } from "node:dns/promises";
import { createClient } from "@supabase/supabase-js";

const base = process.env.APP_URL ?? "";
const anon = process.env.ANON ?? "";
const host = new URL(base).host;
const seen = new Set<string>();
const capture: typeof fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const u = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  seen.add(new URL(u).host);
  return fetch(input, init);
}) as typeof fetch;

const say = (o: Record<string, unknown>) => console.log(JSON.stringify(o));
const msg = (e: unknown) => (e instanceof Error ? `${(e as { code?: string }).code ?? ""} ${e.message}` : String(e)).trim().slice(0, 140);

async function op(name: string, f: () => Promise<string>) {
  const t0 = Date.now();
  try {
    say({ op: name, ok: true, result: await f(), ms: Date.now() - t0 });
  } catch (e) {
    say({ op: name, ok: false, result: msg(e), ms: Date.now() - t0 });
  }
}

await op("lookup", async () => {
  const a = await lookup(host, { all: true });
  return `${a.length} address(es)`;
});

const sb = createClient(base, anon, { global: { fetch: capture }, auth: { persistSession: false, autoRefreshToken: false } });
let jwt = "";
await op("sign-in", async () => {
  const r = await sb.auth.signInWithPassword({ email: process.env.EMAIL ?? "", password: process.env.PW ?? "" });
  if (r.error) throw new Error(r.error.message);
  jwt = r.data.session?.access_token ?? "";
  return "session";
});
await op("rest", async () => {
  const r = await sb.from("hp_items").select("id,label");
  if (r.error) throw new Error(r.error.message);
  return `${r.data?.length} row(s)`;
});
await op("storage-public", async () => {
  const u = sb.storage.from("hp-pub").getPublicUrl("hello.txt").data.publicUrl;
  const r = await capture(u);
  return `GET ${r.status}`;
});
await op("function", async () => {
  const r = await sb.functions.invoke("hp-mock-idp/ping", { method: "GET" });
  if (r.error) throw new Error(r.error.message);
  return "invoked";
});
await op("realtime", async () => {
  const status = await new Promise<string>((resolve) => {
    const ch = sb.channel("hp-probe").subscribe((s) => {
      if (s === "SUBSCRIBED" || s === "CHANNEL_ERROR" || s === "TIMED_OUT" || s === "CLOSED") resolve(s);
    });
    setTimeout(() => resolve("no-status-in-12s"), 12_000);
    void ch;
  });
  await sb.removeAllChannels();
  if (status !== "SUBSCRIBED") throw new Error(status);
  return status;
});
say({ op: "hosts-requested", ok: true, result: [...seen].join(",") });
void jwt;
process.exit(0);
