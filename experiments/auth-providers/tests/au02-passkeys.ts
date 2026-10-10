/**
 * AU02 - passkeys (experimental) end to end, with a CDP virtual authenticator.
 *
 * Source: https://supabase.com/docs/guides/auth/passkeys. Headless
 * Chromium runs in a Playwright container (never on the host); supabase-js
 * with `auth.experimental.passkey` drives registerPasskey / signInWithPasskey
 * against a throwaway project. The page origin is served by request
 * interception, so WebAuthn sees http://localhost:3000 (a secure context).
 *
 *   AU02a  control: passkeys disabled -> registerPasskey error code
 *   AU02b  enable via the Management API (rp_id=localhost); register, sign out,
 *          signInWithPasskey; list as the user and via the admin API
 *   AU02c  page origin NOT in webauthn_rp_origins (localhost:3001): which layer refuses
 *   AU02d  webauthn_rp_id=example.com while the page is localhost: which layer refuses
 *   AU02e  RP ID changed after enrolment (localhost -> example.com, https origin): old
 *          credential unusable; plus the config check on a non-loopback http origin
 *   AU02f  admin API: publishable key refused, delete a passkey, sign-in afterwards
 *   AU02g  passkeys per user until the platform refuses
 *
 * DESTRUCTIVE: creates a au-* project (deleted in `finally`).
 * Requires docker and the image below.
 */
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { adminCreateUser, authFetch, cell, destroyProject, patchAuthConfig, provisionProject, sleep, type Rig } from "../lib/rig.js";

const IMAGE = "mcr.microsoft.com/playwright:v1.64.0-noble";
const PW_VERSION = "1.64.0";
const DRIVER = resolve(import.meta.dir, "../lib/passkey-driver.mjs");
const UMD = resolve(import.meta.dir, "../../../node_modules/@supabase/supabase-js/dist/umd/supabase.js");

interface Step {
  op: string;
  ok?: boolean;
  status?: number;
  error?: { name?: string; message?: string; code?: string; status?: number } | null;
  data?: any;
  ms?: number;
}

async function docker(args: string[], timeoutMs = 300_000): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => p.kill(), timeoutMs);
  const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  clearTimeout(timer);
  return { code, out: o + e };
}

class Browser {
  constructor(private dir: string) {}
  static async create(): Promise<Browser> {
    const dir = await mkdtemp(join(tmpdir(), "au-pk-"));
    await copyFile(DRIVER, join(dir, "passkey-driver.mjs"));
    await copyFile(UMD, join(dir, "supabase.js"));
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "w", type: "module", private: true }));
    const i = await docker(["run", "--rm", "-v", `${dir}:/w`, "-w", "/w", IMAGE, "npm", "i", `playwright@${PW_VERSION}`, "--no-audit", "--no-fund", "--silent"]);
    if (i.code !== 0) throw new Error(`npm i playwright in container failed: ${i.out.slice(-300)}`);
    return new Browser(dir);
  }
  async run(rig: Rig, origin: string, steps: Record<string, unknown>[]): Promise<{ version: string; steps: Step[] }> {
    const spec = Buffer.from(
      JSON.stringify({ origin, url: `https://${rig.ctx.apiHost}`, publishable: rig.keys.publishable, secret: rig.keys.secret, steps }),
    ).toString("base64");
    const r = await docker(["run", "--rm", "--ipc=host", "-e", `SPEC_B64=${spec}`, "-v", `${this.dir}:/w`, "-w", "/w", IMAGE, "node", "passkey-driver.mjs"]);
    const line = r.out.split("\n").find((l) => l.startsWith("RESULT:"));
    if (!line) throw new Error(`driver produced no result (exit ${r.code}): ${r.out.slice(-400)}`);
    return JSON.parse(line.slice(7)) as { version: string; steps: Step[] };
  }
  async dispose(): Promise<void> {
    // the container ran as root, so files are root-owned; delete through docker
    await docker(["run", "--rm", "-v", `${this.dir}:/w`, IMAGE, "sh", "-c", "rm -rf /w/* /w/.[!.]*"]);
    await rm(this.dir, { recursive: true, force: true });
  }
}

const code = (s?: Step): string => cell(s?.error?.code ?? s?.error?.name) as string;
const msg = (s?: Step): string => String(s?.error?.message ?? "").replace(/\s+/g, " ").slice(0, 200);
const by = (steps: Step[], op: string, nth = 0): Step | undefined => steps.filter((s) => s.op === op)[nth];

async function awaitRp(rig: Rig, rpId: string, budgetMs = 90_000): Promise<number> {
  const t0 = Date.now();
  while (Date.now() - t0 < budgetMs) {
    const r = await authFetch(rig, "POST", "/passkeys/authentication/options", { key: rig.keys.publishable, body: {} });
    if (new RegExp(`"rpId"\\s*:\\s*"${rpId.replace(/\./g, "\\.")}"`).test(r.text)) return Math.round((Date.now() - t0) / 1000);
    await sleep(3_000);
  }
  return -1;
}

const mod: TestModule = {
  id: "AU02",
  title: "Passkeys (experimental): register / sign in / mismatches / admin API",
  where: "local",
  requires: ["pat", "org"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const results: TestResult[] = [];
    const pro = ctx.orgs.pro ?? "";
    if (!pro) return [{ id: "AU02", title: this.title, status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    if ((await docker(["image", "inspect", IMAGE])).code !== 0) {
      return [{ id: "AU02", title: this.title, status: "skip", detail: `docker image ${IMAGE} not present (docker pull it)` }];
    }
    let rig: Rig | undefined;
    let browser: Browser | undefined;
    try {
      rig = await provisionProject(ctx, pro, "au02", { pro: true });
      const r = rig;
      browser = await Browser.create();
      const email = `pk-${Date.now()}@example.com`;
      const password = `${crypto.randomUUID()}Aa1!`;
      const userId = await adminCreateUser(r, email, password);
      const login = { op: "login", email, password };
      results.push({ id: "AU02-setup", title: "AU02-setup: project, user, browser container", status: "info", measurements: { provision_s: r.provisionS } });

      // ---- AU02a: disabled control ----
      const a = await browser.run(r, "http://localhost:3000", [login, { op: "register" }]);
      results.push({
        id: "AU02a",
        title: "AU02a: registerPasskey with passkeys disabled (default)",
        status: by(a.steps, "register")?.ok === false ? "pass" : "fail",
        detail: `${code(by(a.steps, "register"))} "${msg(by(a.steps, "register"))}"`,
        measurements: { chromium: a.version, login_ok: String(by(a.steps, "login")?.ok), register_error_code: code(by(a.steps, "register")), register_http: cell(by(a.steps, "register")?.error?.status) },
      });

      // ---- AU02b: enable + happy path ----
      const en = await patchAuthConfig(r, {
        passkey_enabled: true,
        webauthn_rp_display_name: "pvlab",
        webauthn_rp_id: "localhost",
        webauthn_rp_origins: "http://localhost:3000",
      });
      const settleRp = en.status < 300 ? await awaitRp(r, "localhost") : -1;
      const b = await browser.run(r, "http://localhost:3000", [
        login,
        { op: "register", friendlyName: "lab key" },
        { op: "list" },
        { op: "signout" },
        { op: "signin" },
        { op: "admin_list", userId },
        { op: "export_creds" },
      ]);
      const reg = by(b.steps, "register");
      const si = by(b.steps, "signin");
      const al = by(b.steps, "admin_list");
      const adminRows = (Array.isArray(al?.data) ? al?.data : al?.data?.passkeys ?? []) as Record<string, unknown>[];
      results.push({
        id: "AU02b",
        title: "AU02b: enable, registerPasskey, signInWithPasskey, list",
        status: en.status < 300 && reg?.ok && si?.ok && si?.data?.user === userId ? "pass" : "fail",
        detail: `patch HTTP ${en.status}${en.text ? " " + en.text : ""}; register ${reg?.ok ? "ok" : code(reg) + " " + msg(reg)}; signin ${si?.ok ? "ok" : code(si) + " " + msg(si)}`,
        measurements: {
          patch_status: en.status,
          rp_visible_s: settleRp,
          register_ok: String(reg?.ok),
          register_friendly_name_requested: "lab key",
          register_friendly_name_returned: cell(reg?.data?.friendly_name),
          register_data_keys: Object.keys(reg?.data ?? {}).sort().join(","),
          signin_ok: String(si?.ok),
          signin_same_user: String(si?.data?.user === userId),
          signin_amr: cell(JSON.stringify(si?.data?.amr ?? null)),
          user_list_count: Array.isArray(by(b.steps, "list")?.data) ? (by(b.steps, "list")!.data as unknown[]).length : cell(by(b.steps, "list")?.data?.length),
          admin_list_status: cell(al?.status),
          admin_list_count: adminRows.length,
          admin_row_keys: Object.keys(adminRows[0] ?? {}).sort().join(","),
          admin_last_used_set: String(Boolean(adminRows[0]?.last_used_at)),
          credentials_exported: cell(by(b.steps, "export_creds")?.data?.count),
          credential_rp_ids: cell((by(b.steps, "export_creds")?.data?.rpIds ?? []).join(",")),
        },
      });

      // ---- AU02c: page origin not in rp_origins ----
      const c = await browser.run(r, "http://localhost:3001", [{ op: "import_creds" }, login, { op: "start_auth" }, { op: "signin" }, { op: "register_fresh" }]);
      results.push({
        id: "AU02c",
        title: "AU02c: page origin outside webauthn_rp_origins",
        status: by(c.steps, "signin")?.ok === false ? "pass" : "fail",
        detail: `signin: ${code(by(c.steps, "signin"))} "${msg(by(c.steps, "signin"))}"; register: ${code(by(c.steps, "register_fresh"))} "${msg(by(c.steps, "register_fresh"))}"`,
        measurements: {
          options_rp_id: cell(by(c.steps, "start_auth")?.data?.rpId),
          signin_error_code: code(by(c.steps, "signin")),
          signin_http: cell(by(c.steps, "signin")?.error?.status),
          signin_error_is_browser_dom_error: String(/Error$/.test(String(by(c.steps, "signin")?.error?.name)) && !by(c.steps, "signin")?.error?.status),
          register_error_code: code(by(c.steps, "register_fresh")),
          register_http: cell(by(c.steps, "register_fresh")?.error?.status),
        },
      });

      // ---- AU02d: rp_id=example.com, page is localhost ----
      const d1 = await patchAuthConfig(r, { webauthn_rp_id: "example.com", webauthn_rp_origins: "https://example.com" });
      const dSettle = d1.status < 300 ? await awaitRp(r, "example.com") : -1;
      const d = await browser.run(r, "http://localhost:3000", [login, { op: "register_fresh" }, { op: "signin" }]);
      results.push({
        id: "AU02d",
        title: "AU02d: webauthn_rp_id not a suffix of the page host",
        status: d1.status < 300 && by(d.steps, "register_fresh")?.ok === false ? "pass" : "fail",
        detail: `patch HTTP ${d1.status}; register: ${code(by(d.steps, "register_fresh"))} "${msg(by(d.steps, "register_fresh"))}"; signin: ${code(by(d.steps, "signin"))} "${msg(by(d.steps, "signin"))}"`,
        measurements: {
          patch_status: d1.status,
          rp_visible_s: dSettle,
          register_error_name: cell(by(d.steps, "register_fresh")?.error?.name),
          register_http: cell(by(d.steps, "register_fresh")?.error?.status),
          signin_error_name: cell(by(d.steps, "signin")?.error?.name),
          signin_http: cell(by(d.steps, "signin")?.error?.status),
        },
      });

      // ---- AU02e: RP ID changed after enrolment ----
      // First the config validation: an http:// origin that is not one of the
      // documented loopback names (localhost, 127.0.0.1, [::1]).
      const e0 = await patchAuthConfig(r, { webauthn_rp_id: "app.localhost", webauthn_rp_origins: "http://app.localhost:3000" });
      // Then a valid change: rp_id=example.com with an https origin, the page
      // served at that origin by request interception. The enrolled credential
      // is bound to rpId localhost.
      const e1 = await patchAuthConfig(r, { webauthn_rp_id: "example.com", webauthn_rp_origins: "https://example.com" });
      const eSettle = e1.status < 300 ? await awaitRp(r, "example.com") : -1;
      const e = await browser.run(r, "https://example.com", [{ op: "import_creds" }, login, { op: "signin" }, { op: "register_fresh" }, { op: "signout" }, { op: "signin" }]);
      results.push({
        id: "AU02e",
        title: "AU02e: RP ID changed after enrolment; http non-loopback origin config",
        status: e1.status < 300 && by(e.steps, "signin", 0)?.ok === false ? "pass" : "fail",
        detail: `http://app.localhost origin patch HTTP ${e0.status} ${e0.text.replace(/\s+/g, " ").slice(0, 200)}; example.com patch HTTP ${e1.status}; old credential signin: ${code(by(e.steps, "signin", 0))} "${msg(by(e.steps, "signin", 0))}"; new RP register: ${by(e.steps, "register_fresh")?.ok ? "ok" : code(by(e.steps, "register_fresh"))}; new RP signin: ${by(e.steps, "signin", 1)?.ok ? "ok" : code(by(e.steps, "signin", 1))}`,
        measurements: {
          http_nonloopback_origin_patch_status: e0.status,
          patch_status: e1.status,
          rp_visible_s: eSettle,
          old_credential_signin_ok: String(by(e.steps, "signin", 0)?.ok),
          old_credential_error_name: cell(by(e.steps, "signin", 0)?.error?.name),
          old_credential_http: cell(by(e.steps, "signin", 0)?.error?.status),
          new_rp_register_ok: String(by(e.steps, "register_fresh")?.ok),
          new_rp_signin_ok: String(by(e.steps, "signin", 1)?.ok),
        },
      });

      // ---- AU02f: admin API ----
      await patchAuthConfig(r, { webauthn_rp_id: "localhost", webauthn_rp_origins: "http://localhost:3000" });
      await awaitRp(r, "localhost");
      const f0 = await browser.run(r, "http://localhost:3000", [
        { op: "import_creds" },
        { op: "admin_list", userId, key: r.keys.publishable },
        { op: "admin_list", userId },
      ]);
      const rows = (f0.steps[2]?.data?.passkeys ?? f0.steps[2]?.data ?? []) as { id?: string; created_at?: string }[];
      const rowsArr = Array.isArray(rows) ? rows : [];
      // the earliest enrolment is the one made under rpId localhost (AU02b)
      const localhostRow = [...rowsArr].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))[0];
      const f1 = await browser.run(r, "http://localhost:3000", [
        { op: "import_creds" },
        { op: "admin_delete", userId, passkeyId: localhostRow?.id ?? "none" },
        { op: "admin_list", userId },
        { op: "signin" },
      ]);
      results.push({
        id: "AU02f",
        title: "AU02f: admin passkey API (list, delete) and sign-in afterwards",
        status: f0.steps[2]?.ok && by(f1.steps, "admin_delete")?.ok && by(f1.steps, "signin")?.ok === false ? "pass" : "fail",
        detail: `publishable-key list HTTP ${f0.steps[1]?.status}; delete HTTP ${by(f1.steps, "admin_delete")?.status}; signin after delete: ${code(by(f1.steps, "signin"))} "${msg(by(f1.steps, "signin"))}"`,
        measurements: {
          list_with_publishable_key_status: cell(f0.steps[1]?.status),
          list_with_secret_key_status: cell(f0.steps[2]?.status),
          passkeys_before_delete: rowsArr.length,
          delete_status: cell(by(f1.steps, "admin_delete")?.status),
          passkeys_after_delete: ((by(f1.steps, "admin_list")?.data?.passkeys ?? by(f1.steps, "admin_list")?.data ?? []) as unknown[]).length,
          signin_after_delete_ok: String(by(f1.steps, "signin")?.ok),
          signin_after_delete_code: code(by(f1.steps, "signin")),
          signin_after_delete_http: cell(by(f1.steps, "signin")?.error?.status),
        },
      });

      // ---- AU02g: per-user cap ----
      const g = await browser.run(r, "http://localhost:3000", [login, { op: "admin_list", userId }, { op: "fill_until_error", max: 12 }, { op: "admin_list", userId }]);
      const countOf = (st?: Step): number => ((st?.data?.passkeys ?? st?.data ?? []) as unknown[]).length;
      const gBefore = countOf(g.steps[1]);
      const gAfter = countOf(g.steps[3]);
      const gd = by(g.steps, "fill_until_error")?.data;
      results.push({
        id: "AU02g",
        title: "AU02g: passkeys per user until refusal",
        status: "info",
        detail: `${gBefore} existing, registered ${gd?.registered} more (${gAfter} total) before: ${gd?.firstError?.code ?? gd?.firstError?.name ?? "none"} "${String(gd?.firstError?.message ?? "").slice(0, 160)}"`,
        measurements: {
          max_attempted: 12,
          passkeys_before_loop: gBefore,
          registered_in_loop_before_refusal: cell(gd?.registered),
          passkeys_at_refusal: gAfter,
          refusal_code: cell(gd?.firstError?.code ?? gd?.firstError?.name),
          refusal_http: cell(gd?.firstError?.status),
        },
        evidence: JSON.stringify(gd?.log ?? []),
      });
    } catch (e) {
      results.push({ id: "AU02-error", title: "AU02-error", status: "fail", detail: String((e as Error)?.message ?? e).slice(0, 500) });
    } finally {
      const cleanup: string[] = [];
      if (browser) {
        await browser.dispose().catch(() => {});
        cleanup.push("browser dir removed");
      }
      if (rig) cleanup.push(`project delete HTTP ${await destroyProject(ctx, rig.ref)}`);
      results.push({ id: "AU02z", title: "AU02z: cleanup", status: cleanup.some((c) => /HTTP [45]/.test(c)) ? "fail" : "info", detail: cleanup.join("; ") });
    }
    return results;
  },
};
export default mod;
