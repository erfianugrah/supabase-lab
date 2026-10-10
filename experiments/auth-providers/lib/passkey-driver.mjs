// Headless Chromium + CDP virtual authenticator driver for AU02.
//
// Runs INSIDE the Playwright container (see tests/au02-passkeys.ts); nothing
// here touches the host. Reads one JSON spec from /w/spec.json, drives the
// supabase-js passkey API in a page whose origin is served by request
// interception (no web server), and prints a single `RESULT:<json>` line.
//
// spec: {
//   origin, url, publishable, secret,
//   steps: [{op, ...}]
// }
// ops:
//   login {email,password}           signInWithPassword
//   register {friendlyName?}         auth.registerPasskey()
//   register_fresh                   new virtual authenticator, then registerPasskey()
//   signout
//   signin                           auth.signInWithPasskey()
//   start_auth                       auth.passkey.startAuthentication() (options only)
//   list                             auth.passkey.list() as the signed-in user
//   admin_list {userId, key?}        GET /auth/v1/admin/users/{id}/passkeys
//   admin_delete {userId,passkeyId,key?}
//   import_creds / export_creds      CDP WebAuthn credentials <-> /w/creds.json
//   fill_until_error {max}           register with a fresh authenticator until it errors
import { chromium } from "playwright";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

// The spec travels in an env var: a bind-mounted spec.json was read back
// truncated once (Docker Desktop file sharing), which is not worth debugging.
const spec = JSON.parse(Buffer.from(process.env.SPEC_B64 ?? "", "base64").toString("utf8"));
const out = { steps: [], version: "" };

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
out.version = browser.version();
const context = await browser.newContext();
const page = await context.newPage();
await page.route((u) => u.origin === spec.origin, (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>pvlab</title><body>pvlab</body>" }));
await page.goto(spec.origin + "/");
await page.addScriptTag({ path: "/w/supabase.js" });
await page.evaluate(({ url, key }) => {
  window.sb = window.supabase.createClient(url, key, { auth: { experimental: { passkey: true }, persistSession: false, autoRefreshToken: false } });
}, { url: spec.url, key: spec.publishable });

const cdp = await context.newCDPSession(page);
await cdp.send("WebAuthn.enable");
let authId = null;
async function newAuthenticator() {
  if (authId) await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId: authId }).catch(() => {});
  const r = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  authId = r.authenticatorId;
}
await newAuthenticator();

const norm = `(e) => e ? ({ name: e.name, message: String(e.message || "").slice(0, 300), code: e.code, status: e.status, authError: Boolean(e.__isAuthError) }) : null`;

async function run(fn, arg) {
  const src = `async (arg) => { const norm = ${norm}; try { const r = await (${fn})(arg); return { ok: !(r && r.error), error: r && r.error ? norm(r.error) : null, data: r && r.data !== undefined ? r.data : null }; } catch (e) { return { ok: false, thrown: true, error: norm(e), data: null }; } }`;
  return page.evaluate(`(${src})(${JSON.stringify(arg ?? null)})`);
}

async function admin(method, path, key) {
  const res = await fetch(`${spec.url}/auth/v1${path}`, { method, headers: { apikey: key || spec.secret } });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text: text.slice(0, 300) };
}

for (const s of spec.steps) {
  const t0 = Date.now();
  let r;
  switch (s.op) {
    case "login":
      r = await run(`async (a) => { const r = await window.sb.auth.signInWithPassword(a); return { error: r.error, data: { user: r.data?.user?.id } }; }`, { email: s.email, password: s.password });
      break;
    case "register":
      r = await run(`async (a) => { const r = await window.sb.auth.registerPasskey(a.friendlyName ? { friendlyName: a.friendlyName } : undefined); return r; }`, s);
      break;
    case "register_fresh":
      await newAuthenticator();
      r = await run(`async () => window.sb.auth.registerPasskey()`);
      break;
    case "signout":
      r = await run(`async () => { const r = await window.sb.auth.signOut(); return { error: r.error, data: {} }; }`);
      break;
    case "signin":
      r = await run(`async () => { const r = await window.sb.auth.signInWithPasskey(); return { error: r.error, data: { user: r.data?.user?.id, hasSession: Boolean(r.data?.session?.access_token), amr: r.data?.session ? JSON.parse(atob(r.data.session.access_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).amr : null } }; }`);
      break;
    case "start_auth":
      r = await run(`async () => { const r = await window.sb.auth.passkey.startAuthentication(); return { error: r.error, data: { rpId: r.data?.options?.rpId, hasChallenge: Boolean(r.data?.options?.challenge), keys: Object.keys(r.data || {}) } }; }`);
      break;
    case "list":
      r = await run(`async () => window.sb.auth.passkey.list()`);
      break;
    case "admin_list": {
      const a = await admin("GET", `/admin/users/${s.userId}/passkeys`, s.key);
      r = { ok: a.status === 200, status: a.status, data: a.json, text: a.status === 200 ? undefined : a.text };
      break;
    }
    case "admin_delete": {
      const a = await admin("DELETE", `/admin/users/${s.userId}/passkeys/${s.passkeyId}`, s.key);
      r = { ok: a.status < 300, status: a.status, data: a.json, text: a.text };
      break;
    }
    case "export_creds": {
      const c = await cdp.send("WebAuthn.getCredentials", { authenticatorId: authId });
      writeFileSync("/w/creds.json", JSON.stringify(c.credentials));
      r = { ok: true, data: { count: c.credentials.length, rpIds: [...new Set(c.credentials.map((x) => x.rpId))], residentKey: c.credentials.map((x) => x.isResidentCredential) } };
      break;
    }
    case "import_creds": {
      const creds = existsSync("/w/creds.json") ? JSON.parse(readFileSync("/w/creds.json", "utf8")) : [];
      for (const c of creds) await cdp.send("WebAuthn.addCredential", { authenticatorId: authId, credential: c });
      r = { ok: true, data: { imported: creds.length } };
      break;
    }
    case "fill_until_error": {
      const log = [];
      for (let i = 1; i <= s.max; i++) {
        await newAuthenticator();
        const x = await run(`async () => window.sb.auth.registerPasskey()`);
        log.push(x.ok ? "ok" : `${x.error?.code || x.error?.name}`);
        if (!x.ok) { r = { ok: true, data: { registered: i - 1, firstError: x.error, log } }; break; }
      }
      if (!r) r = { ok: true, data: { registered: s.max, firstError: null, log } };
      break;
    }
    default:
      r = { ok: false, error: { name: "driver", message: `unknown op ${s.op}` } };
  }
  out.steps.push({ op: s.op, ms: Date.now() - t0, ...r });
}

await browser.close();
console.log("RESULT:" + JSON.stringify(out));
