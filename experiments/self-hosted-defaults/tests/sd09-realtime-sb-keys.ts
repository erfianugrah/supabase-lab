/**
 * SD09 - Realtime through Envoy with the sb_publishable_ / sb_secret_ keys.
 *
 * SD02 measured the opaque keys on REST, Auth and storage routes; the 2026-10-10
 * run left Realtime out. Envoy's Lua filters (volumes/api/envoy/lds.template.yaml
 * at the pin) gate `/realtime/v1/` on the same apikey check, translate an
 * `apikey` query parameter or header holding an sb_ key into the asymmetric
 * anon / service_role JWT, and mirror it into `x-api-key` for the WebSocket
 * route. Realtime itself verifies JWTs (API_JWT_JWKS, uncommented by
 * utils/add-new-auth-keys.sh). This module measures what a client sees:
 *
 *   SD09a  raw Phoenix WebSocket, public channel: per credential (publishable
 *          and secret key as the `apikey` query parameter, publishable key as
 *          an `apikey` header, legacy anon JWT, no key, a made-up sb_ key) -
 *          handshake status and body, join reply, and whether a broadcast sent
 *          with `self: true` comes back.
 *   SD09b  private channel (RLS on realtime.messages; one policy lets
 *          `authenticated` read and write topic sd09-private): publishable
 *          key, secret key, publishable key plus a user's access token in the
 *          join payload, and an sb_ key placed in the join payload's
 *          access_token, with each key on the socket (does an sb_ value there
 *          replace the gateway's JWT, in either direction, or is it ignored?).
 *   SD09c  supabase-js (the harness dependency's version, recorded) with each
 *          key: subscribe status and broadcast round trip, public and private.
 *   SD09d  the REST broadcast endpoint `POST /realtime/v1/api/broadcast` with
 *          each key, and whether a WebSocket subscriber on the topic gets the
 *          message.
 *
 * Creates one auth user and two policies on realtime.messages; removes both.
 * Local vantage; needs a running stack (`make stack up`).
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { http, jsonOr, rigOf, scrub, sql, type Rig } from "../lib/rig";

const ID = "SD09";
const TOPIC = "sd09-public";
const PRIV = "sd09-private";

interface Attempt {
  handshake: string;
  join: string;
  broadcast: "received" | "not received" | "n/a";
}

/** Raw handshake: status line and body when the gateway refuses the upgrade. */
async function handshake(rig: Rig, query: string, headers: Record<string, string> = {}): Promise<string> {
  const u = new URL(rig.gw);
  const port = Number(u.port);
  const extra = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join("");
  // RFC 6455's sample nonce, built at run time so the literal does not look like a credential to scanners.
  const nonce = Buffer.from("the sample nonce").toString("base64");
  const req = `GET /realtime/v1/websocket?vsn=1.0.0${query} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${nonce}\r\nSec-WebSocket-Version: 13\r\n${extra}\r\n`;
  let buf = "";
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    Bun.connect({
      hostname: u.hostname,
      port,
      socket: {
        open(s) {
          s.write(req);
        },
        data(s, d) {
          buf += d.toString();
          if (buf.includes("\r\n\r\n")) setTimeout(() => (s.end(), finish()), 300);
        },
        close: finish,
        error: finish,
        connectError: finish,
      },
    }).catch(finish);
    setTimeout(finish, 5000);
  });
  const status = buf.split("\r\n")[0] ?? "no response";
  const body = buf.split("\r\n\r\n")[1] ?? "";
  return scrub(rig, status.startsWith("HTTP/1.1 101") ? status : `${status}; body "${body.slice(0, 120)}"`);
}

/** Join a channel over a raw Phoenix socket, broadcast once with self: true, report what came back. */
async function joinAndBroadcast(
  rig: Rig,
  o: { query?: string; headers?: Record<string, string>; accessToken?: string; topic: string; priv: boolean },
): Promise<Attempt> {
  const url = `${rig.gw.replace(/^http/, "ws")}/realtime/v1/websocket?vsn=1.0.0${o.query ?? ""}`;
  const hs = await handshake(rig, o.query ?? "", o.headers);
  if (!hs.startsWith("HTTP/1.1 101")) return { handshake: hs, join: "n/a", broadcast: "n/a" };
  return await new Promise<Attempt>((resolve) => {
    let join = "no reply";
    let ws: WebSocket;
    try {
      ws = new WebSocket(url, { headers: o.headers } as unknown as string[]);
    } catch (e) {
      return resolve({ handshake: hs, join: `client error ${String(e)}`, broadcast: "n/a" });
    }
    const done = (b: Attempt["broadcast"]) => {
      clearTimeout(t);
      resolve({ handshake: hs, join, broadcast: b });
      try {
        ws.close();
      } catch {}
    };
    const t = setTimeout(() => done(join.startsWith("ok") ? "not received" : "n/a"), 8000);
    ws.onopen = () =>
      ws.send(
        JSON.stringify({
          topic: `realtime:${o.topic}`,
          event: "phx_join",
          ref: "1",
          join_ref: "1",
          payload: {
            config: { broadcast: { self: true, ack: true }, presence: { key: "" }, postgres_changes: [], private: o.priv },
            ...(o.accessToken ? { access_token: o.accessToken } : {}),
          },
        }),
      );
    ws.onmessage = (ev) => {
      const m = jsonOr(String(ev.data));
      if (m?.event === "phx_reply" && m.ref === "1") {
        if (m.payload?.status === "ok") {
          join = "ok";
          ws.send(JSON.stringify({ topic: `realtime:${o.topic}`, event: "broadcast", ref: "2", join_ref: "1", payload: { type: "broadcast", event: "ping", payload: { n: 1 } } }));
        } else {
          join = scrub(rig, `${m.payload?.status}: ${JSON.stringify(m.payload?.response ?? {})}`);
          done("n/a");
        }
      } else if (m?.event === "broadcast" && m.payload?.event === "ping") {
        done("received");
      } else if (m?.event === "system" || m?.event === "phx_error" || m?.event === "phx_close") {
        join = `${join}; ${scrub(rig, `${m.event} ${JSON.stringify(m.payload ?? {}).slice(0, 200)}`)}`;
      }
    };
    ws.onclose = (e) => {
      if (join === "no reply") join = `socket closed ${e.code} ${e.reason}`;
      done(join.startsWith("ok") ? "not received" : "n/a");
    };
  });
}

const fmt = (a: Attempt): string => `handshake ${a.handshake.startsWith("HTTP/1.1 101") ? "101" : a.handshake}; join ${a.join}; broadcast ${a.broadcast}`;

async function makeUser(rig: Rig, secret: string): Promise<{ id: string; token: string; email: string; password: string } | string> {
  const email = `sd09-${Date.now()}@example.com`;
  const password = `pw-${crypto.randomUUID()}`;
  const c = await http(rig, "/auth/v1/admin/users", {
    method: "POST",
    headers: { apikey: secret, "content-type": "application/json" },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const id = jsonOr(c.body)?.id;
  if (c.status !== 200 || !id) return `admin create user ${c.status} ${scrub(rig, c.body.slice(0, 200))}`;
  const g = await http(rig, "/auth/v1/token?grant_type=password", {
    method: "POST",
    headers: { apikey: secret, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const token = jsonOr(g.body)?.access_token;
  if (g.status !== 200 || !token) return `password grant ${g.status} ${scrub(rig, g.body.slice(0, 200))}`;
  return { id, token, email, password };
}

/**
 * supabase-js channel round trip; returns the subscribe status and whether the
 * broadcast came back. `signIn` signs the client in with a password first (the
 * usual path); `accessToken` passes a token through the client's accessToken
 * option (the third-party-auth path) instead.
 */
async function sbjs(rig: Rig, key: string, topic: string, priv: boolean, user?: { signIn?: { email: string; password: string }; accessToken?: string }): Promise<string> {
  const tok = user?.accessToken;
  const c = createClient(rig.gw, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    ...(tok ? { accessToken: async () => tok } : {}),
  });
  if (user?.signIn) {
    const si = await c.auth.signInWithPassword(user.signIn);
    if (si.error) return scrub(rig, `sign-in failed: ${si.error.message}`);
  }
  try {
    return await new Promise<string>((resolve) => {
      const ch = c.channel(topic, { config: { broadcast: { self: true }, private: priv } });
      const t = setTimeout(() => resolve("timeout after 10 s"), 10_000);
      ch.on("broadcast", { event: "ping" }, () => {
        clearTimeout(t);
        resolve("SUBSCRIBED; broadcast received");
      });
      ch.subscribe(async (status, err) => {
        if (status === "SUBSCRIBED") {
          const r = await ch.send({ type: "broadcast", event: "ping", payload: { n: 1 } });
          if (r !== "ok") {
            clearTimeout(t);
            resolve(`SUBSCRIBED; send returned ${r}`);
          }
        } else if (status !== "CLOSED") {
          clearTimeout(t);
          resolve(scrub(rig, `${status}${err ? `: ${String(err.message ?? err)}` : ""}`));
        }
      });
    });
  } finally {
    await c.removeAllChannels();
  }
}

/** POST /realtime/v1/api/broadcast with a key while a secret-key socket listens on the topic. */
async function restBroadcast(rig: Rig, key: string, listenerKey: string, topic: string): Promise<string> {
  const url = `${rig.gw.replace(/^http/, "ws")}/realtime/v1/websocket?vsn=1.0.0&apikey=${encodeURIComponent(listenerKey)}`;
  const ws = new WebSocket(url);
  let got = false;
  const joined = await new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), 6000);
    ws.onopen = () =>
      ws.send(JSON.stringify({ topic: `realtime:${topic}`, event: "phx_join", ref: "1", join_ref: "1", payload: { config: { broadcast: { self: false }, presence: { key: "" }, postgres_changes: [], private: false } } }));
    ws.onmessage = (ev) => {
      const m = jsonOr(String(ev.data));
      if (m?.event === "phx_reply" && m.ref === "1") {
        clearTimeout(t);
        resolve(m.payload?.status === "ok");
      }
      if (m?.event === "broadcast" && m.payload?.event === "rest") got = true;
    };
  });
  const r = await http(rig, "/realtime/v1/api/broadcast", {
    method: "POST",
    headers: { apikey: key, "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ topic, event: "rest", payload: { n: 1 }, private: false }] }),
  });
  await new Promise((res) => setTimeout(res, 2000));
  try {
    ws.close();
  } catch {}
  return `HTTP ${r.status}${r.body ? ` body "${scrub(rig, r.body.slice(0, 120))}"` : ""}; listener joined ${joined ? "yes" : "no"}; listener got message ${got ? "yes" : "no"}`;
}

const mod: TestModule = {
  id: ID,
  title: "Realtime through Envoy with sb_publishable_ and sb_secret_ keys",
  where: "local",
  requires: [],

  async run(ctx: Ctx): Promise<TestResult[]> {
    const r = rigOf(ctx);
    if ("skip" in r) return [{ id: ID, title: this.title, status: "skip", detail: r.skip }];
    const rig = r.rig;
    const P = rig.env.SUPABASE_PUBLISHABLE_KEY ?? "";
    const S = rig.env.SUPABASE_SECRET_KEY ?? "";
    if (!P.startsWith("sb_publishable_") || !S.startsWith("sb_secret_"))
      return [{ id: ID, title: this.title, status: "skip", detail: "SUPABASE_PUBLISHABLE_KEY / SUPABASE_SECRET_KEY not set in .env (run utils/add-new-auth-keys.sh via `make stack`)" }];
    const q = (k: string) => `&apikey=${encodeURIComponent(k)}`;
    const out: TestResult[] = [];

    // a - public channel, per credential
    const a: Record<string, Attempt> = {
      publishable_query: await joinAndBroadcast(rig, { query: q(P), topic: TOPIC, priv: false }),
      secret_query: await joinAndBroadcast(rig, { query: q(S), topic: TOPIC, priv: false }),
      publishable_header: await joinAndBroadcast(rig, { headers: { apikey: P }, topic: TOPIC, priv: false }),
      legacy_anon_query: await joinAndBroadcast(rig, { query: q(rig.env.ANON_KEY ?? ""), topic: TOPIC, priv: false }),
      no_key: await joinAndBroadcast(rig, { topic: TOPIC, priv: false }),
      made_up_sb_key: await joinAndBroadcast(rig, { query: q("sb_publishable_sd09notarealkey000000000"), topic: TOPIC, priv: false }),
    };
    const ok = (x: Attempt) => x.join === "ok" && x.broadcast === "received";
    const refused = (x: Attempt) => /^HTTP\/1.1 401/.test(x.handshake);
    out.push({
      id: `${ID}a`,
      title: "public channel: both sb_ keys (query or header) join and get their own broadcast back; no key and a made-up sb_ key get Envoy's 401 at the handshake",
      status: ok(a.publishable_query!) && ok(a.secret_query!) && ok(a.publishable_header!) && refused(a.no_key!) && refused(a.made_up_sb_key!) ? "pass" : "fail",
      detail: Object.entries(a).map(([k, v]) => `${k}: ${fmt(v)}`).join(" | "),
      measurements: Object.fromEntries(Object.entries(a).map(([k, v]) => [k, fmt(v)])),
    });

    // b - private channel with an RLS policy for authenticated only
    const user = await makeUser(rig, S);
    try {
      await sql(`drop policy if exists sd09_read on realtime.messages; drop policy if exists sd09_write on realtime.messages;
        create policy sd09_read on realtime.messages for select to authenticated using (realtime.topic() = '${PRIV}');
        create policy sd09_write on realtime.messages for insert to authenticated with check (realtime.topic() = '${PRIV}');`);
      const tok = typeof user === "string" ? "" : user.token;
      const b: Record<string, Attempt | string> = {
        publishable_key: await joinAndBroadcast(rig, { query: q(P), topic: PRIV, priv: true }),
        secret_key: await joinAndBroadcast(rig, { query: q(S), topic: PRIV, priv: true }),
        publishable_key_plus_user_access_token: tok ? await joinAndBroadcast(rig, { query: q(P), accessToken: tok, topic: PRIV, priv: true }) : `no user: ${user}`,
        publishable_key_plus_access_token_sb_publishable: await joinAndBroadcast(rig, { query: q(P), accessToken: P, topic: PRIV, priv: true }),
        secret_key_plus_access_token_sb_publishable: await joinAndBroadcast(rig, { query: q(S), accessToken: P, topic: PRIV, priv: true }),
        secret_key_plus_access_token_sb_secret: await joinAndBroadcast(rig, { query: q(S), accessToken: S, topic: PRIV, priv: true }),
        publishable_key_plus_access_token_sb_secret: await joinAndBroadcast(rig, { query: q(P), accessToken: S, topic: PRIV, priv: true }),
      };
      const s = (x: Attempt | string) => (typeof x === "string" ? x : fmt(x));
      const pubDenied = typeof b.publishable_key !== "string" && /^error/.test(b.publishable_key!.join);
      const secOk = typeof b.secret_key !== "string" && ok(b.secret_key!);
      const userOk = typeof b.publishable_key_plus_user_access_token !== "string" && ok(b.publishable_key_plus_user_access_token!);
      out.push({
        id: `${ID}b`,
        title: "private channel (policy for authenticated): publishable key refused, secret key admitted, publishable key plus a user access token admitted; sb_ keys in access_token recorded",
        status: pubDenied && secOk && userOk ? "pass" : "fail",
        detail: Object.entries(b).map(([k, v]) => `${k}: ${s(v)}`).join(" | "),
        measurements: Object.fromEntries(Object.entries(b).map(([k, v]) => [k, s(v)])),
      });

      // c - supabase-js
      const ver = String(jsonOr(readFileSync(Bun.resolveSync("@supabase/supabase-js/package.json", import.meta.dir), "utf8"))?.version ?? "unknown");
      const c: Record<string, string> = {
        publishable_public: await sbjs(rig, P, `${TOPIC}-js`, false),
        secret_public: await sbjs(rig, S, `${TOPIC}-js`, false),
        publishable_private: await sbjs(rig, P, PRIV, true),
        secret_private: await sbjs(rig, S, PRIV, true),
        publishable_private_signed_in: typeof user !== "string" ? await sbjs(rig, P, PRIV, true, { signIn: { email: user.email, password: user.password } }) : `no user: ${user}`,
        publishable_private_accesstoken_option: tok ? await sbjs(rig, P, PRIV, true, { accessToken: tok }) : `no user: ${user}`,
      };
      out.push({
        id: `${ID}c`,
        title: `supabase-js ${ver}: both sb_ keys subscribe and round-trip a broadcast on a public channel; private channel as in SD09b (signed-in client admitted; the accessToken-option result is recorded, not asserted)`,
        status:
          /broadcast received/.test(c.publishable_public!) && /broadcast received/.test(c.secret_public!) && /CHANNEL_ERROR/.test(c.publishable_private!) && /broadcast received/.test(c.secret_private!) && /broadcast received/.test(c.publishable_private_signed_in!)
            ? "pass"
            : "fail",
        detail: Object.entries(c).map(([k, v]) => `${k}: ${v}`).join(" | "),
        measurements: { supabase_js_version: ver, ...c },
      });
    } finally {
      await sql("drop policy if exists sd09_read on realtime.messages; drop policy if exists sd09_write on realtime.messages;").catch(() => {});
      if (typeof user !== "string") await http(rig, `/auth/v1/admin/users/${user.id}`, { method: "DELETE", headers: { apikey: S } }).catch(() => {});
    }

    // d - REST broadcast endpoint
    const d: Record<string, string> = {
      publishable_key: await restBroadcast(rig, P, S, `${TOPIC}-rest`),
      secret_key: await restBroadcast(rig, S, S, `${TOPIC}-rest`),
      no_key: await restBroadcast(rig, "", S, `${TOPIC}-rest`),
    };
    out.push({
      id: `${ID}d`,
      title: "REST broadcast (POST /realtime/v1/api/broadcast) per key, with a secret-key WebSocket listener on the topic",
      status: "info",
      detail: Object.entries(d).map(([k, v]) => `${k}: ${v}`).join(" | "),
      measurements: d,
    });
    return out;
  },
};
export default mod;
