/**
 * supabase-js against one base URL, with every outgoing request's host
 * captured, plus the host inside every URL the SDK or the server hands back.
 * `getPublicUrl` is built client-side from the URL the client was given;
 * `createSignedUrl` and friends are built from the server's relative path
 * plus the client's storage URL. The question is whether any host other than
 * the one the client was given appears: in a request, or in a returned URL.
 */
import { createClient } from "@supabase/supabase-js";
import { PW, USER_EMAIL, jwtPayload } from "./state";

const issOf = (jwt: string): string => String(jwtPayload(jwt).iss ?? "");

export interface OpRow {
  op: string;
  /** Hosts requested while the op ran (the SDK's own fetches). */
  requested: string[];
  /** Host of the URL the op returned, when it returns one. */
  resultHost: string;
  /** HTTP status of GETting the returned URL (or of the op), "-" if not applicable. */
  fetched: string;
  note: string;
}

const hostOf = (u: string) => {
  try {
    return new URL(u).host;
  } catch {
    return "";
  }
};

export async function sdkProbe(baseUrl: string, serviceKey: string, anonKey: string): Promise<OpRow[]> {
  let seen: string[] = [];
  const capture: typeof fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const u = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    seen.push(hostOf(u));
    return fetch(input, init);
  }) as typeof fetch;
  const opts = { global: { fetch: capture }, auth: { persistSession: false, autoRefreshToken: false } };
  const sb = createClient(baseUrl, serviceKey, opts);
  const anon = createClient(baseUrl, anonKey, opts);
  const rows: OpRow[] = [];
  const op = async (name: string, f: () => Promise<{ resultUrl?: string; fetched?: string; note?: string }>) => {
    seen = [];
    let r: { resultUrl?: string; fetched?: string; note?: string };
    try {
      r = await f();
    } catch (e) {
      r = { note: `threw: ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}` };
    }
    rows.push({ op: name, requested: [...new Set(seen)], resultHost: r.resultUrl ? hostOf(r.resultUrl) : "-", fetched: r.fetched ?? "-", note: r.note ?? "" });
  };
  const get = async (url: string) => String((await fetch(url, { redirect: "manual" })).status);
  const pub = sb.storage.from("hp-pub");
  const priv = sb.storage.from("hp-priv");

  await op("getPublicUrl", async () => {
    const u = pub.getPublicUrl("hello.txt").data.publicUrl;
    return { resultUrl: u, fetched: await get(u), note: u.replace(/^https:\/\/[^/]+/, "") };
  });
  await op("getPublicUrl download", async () => {
    const u = pub.getPublicUrl("hello.txt", { download: true }).data.publicUrl;
    return { resultUrl: u, fetched: await get(u), note: u.replace(/^https:\/\/[^/]+/, "") };
  });
  await op("getPublicUrl transform", async () => {
    const u = pub.getPublicUrl("hello.txt", { transform: { width: 100 } }).data.publicUrl;
    return { resultUrl: u, note: u.replace(/^https:\/\/[^/]+/, "") };
  });
  await op("createSignedUrl", async () => {
    const r = await priv.createSignedUrl("hello.txt", 600);
    const u = r.data?.signedUrl ?? "";
    return { resultUrl: u, fetched: u ? await get(u) : "-", note: r.error ? r.error.message : u.replace(/^https:\/\/[^/]+/, "").replace(/token=[^&]+/, "token=<jwt>") };
  });
  await op("createSignedUrls", async () => {
    const r = await priv.createSignedUrls(["hello.txt"], 600);
    const u = r.data?.[0]?.signedUrl ?? "";
    return { resultUrl: u, fetched: u ? await get(u) : "-" };
  });
  await op("createSignedUploadUrl", async () => {
    const r = await priv.createSignedUploadUrl("signed-up.txt");
    const u = r.data?.signedUrl ?? "";
    return { resultUrl: u, note: u.replace(/^https:\/\/[^/]+/, "").replace(/token=[^&]+/, "token=<jwt>") };
  });
  await op("upload", async () => {
    const r = await priv.upload("up.txt", "x", { upsert: true });
    return { fetched: r.error ? r.error.message.slice(0, 60) : "ok", note: JSON.stringify(Object.keys(r.data ?? {})) };
  });
  await op("download", async () => {
    const r = await priv.download("hello.txt");
    return { fetched: r.error ? r.error.message.slice(0, 60) : "ok" };
  });
  await op("list", async () => {
    const r = await priv.list();
    return { fetched: r.error ? r.error.message.slice(0, 60) : `ok ${r.data?.length ?? 0}` };
  });
  await op("rest select", async () => {
    const r = await anon.from("hp_items").select("id,label");
    return { fetched: r.error ? r.error.message.slice(0, 60) : `ok ${r.data?.length ?? 0}` };
  });
  await op("functions.invoke", async () => {
    const r = await anon.functions.invoke("hp-mock-idp/ping", { method: "GET" });
    return { fetched: r.error ? r.error.message.slice(0, 60) : "ok" };
  });
  await op("auth signInWithPassword", async () => {
    const r = await anon.auth.signInWithPassword({ email: USER_EMAIL, password: PW });
    return { fetched: r.error ? r.error.message.slice(0, 60) : "ok", note: `iss ${issOf(r.data.session?.access_token ?? "")}` };
  });
  return rows;
}
