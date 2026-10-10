/**
 * The probe sequence, parameterised by org and id prefix so the free-org run
 * (FE01) and the paid-org control (FE02) execute identical requests.
 *
 *   a  create the project, wait healthy, wait for GET config/auth = 200
 *   b  baseline read: which mailer_* / smtp_* keys exist and what they hold
 *   c  control write: PATCH a non-template field (does PATCH work at all)
 *   d  default SMTP: PATCH each mailer_templates_*_content alone, then all
 *      mailer_subjects_* together, then read back
 *   e  custom SMTP (dummy host) written alone
 *   f  with custom SMTP set: the same per-field template PATCHes + readback
 *   g  custom SMTP cleared: do saved templates survive, are writes locked
 *      again
 *   h  smtp_host alone (no user/pass/sender), then a template PATCH
 *   i  one PATCH carrying the SMTP fields and a template field together,
 *      sent while the project is back on default SMTP
 *
 * Only a..d run when `full` is false (the control).
 */
import type { Ctx, TestResult } from "../../../harness/src/types.js";
import {
  CLEAR_SMTP,
  DUMMY_SMTP,
  TEMPLATE_KINDS,
  contentField,
  createProject,
  call,
  getAuth,
  mailView,
  patchAuth,
  sampleTemplate,
  subjectField,
  waitAuthConfig,
  waitHealthy,
  type Cfg,
} from "./probe.js";

const j = (v: unknown) => JSON.stringify(v);

/** Per-kind content PATCHes, one request each, then one readback. */
async function perKindSweep(ctx: Ctx, ref: string, tag: string) {
  const status: Record<string, number> = {};
  const errors: Record<string, string> = {};
  const sent: Record<string, string> = {};
  for (const k of TEMPLATE_KINDS) {
    const f = contentField(k);
    sent[f] = sampleTemplate(k, tag);
    const r = await patchAuth(ctx, ref, { [f]: sent[f] });
    status[k] = r.status;
    if (!r.ok) errors[k] = r.summary;
  }
  const after = await getAuth(ctx, ref);
  const persisted: Record<string, boolean> = {};
  for (const k of TEMPLATE_KINDS) persisted[k] = after.cfg[contentField(k)] === sent[contentField(k)];
  return { status, errors, persisted, after, sent };
}

function sweepMeasurements(prefix: string, s: Awaited<ReturnType<typeof perKindSweep>>) {
  const m: Record<string, number | string> = {};
  for (const k of TEMPLATE_KINDS) {
    m[`${prefix}_${k}_status`] = s.status[k] ?? 0;
    m[`${prefix}_${k}_persisted`] = s.persisted[k] ? 1 : 0;
  }
  m[`${prefix}_accepted`] = TEMPLATE_KINDS.filter((k) => (s.status[k] ?? 0) >= 200 && (s.status[k] ?? 0) < 300).length;
  m[`${prefix}_persisted_n`] = TEMPLATE_KINDS.filter((k) => s.persisted[k]).length;
  return m;
}

const NOTIF_KINDS = [
  "password_changed",
  "email_changed",
  "phone_changed",
  "mfa_factor_enrolled",
  "mfa_factor_unenrolled",
  "identity_linked",
  "identity_unlinked",
] as const;

/** Number of true flags in mailer_templates_custom_contents / mailer_subjects_custom_contents. */
function customFlags(cfg: Cfg, key: "mailer_templates_custom_contents" | "mailer_subjects_custom_contents"): number {
  const v = cfg[key];
  if (!v || typeof v !== "object") return -1;
  return Object.values(v as Record<string, unknown>).filter((x) => x === true).length;
}

/** Notification-email templates (newer fields): one content PATCH for all seven, one enable-flag PATCH. */
async function notifSweep(ctx: Ctx, ref: string, tag: string) {
  const content: Cfg = {};
  for (const n of NOTIF_KINDS) content[`mailer_templates_${n}_notification_content`] = `<p>lab ${n} ${tag}</p>`;
  const c = await patchAuth(ctx, ref, content);
  const e = await patchAuth(ctx, ref, { mailer_notifications_password_changed_enabled: true });
  return { content: c, enabled: e };
}

export interface PhaseOpts {
  org: string;
  /** e.g. "FE01"; sub-results are `${prefix}a`..`${prefix}i`. */
  prefix: string;
  label: string;
  full: boolean;
}

export async function runPhases(ctx: Ctx, o: PhaseOpts): Promise<TestResult[]> {
  const P = o.prefix;
  const results: TestResult[] = [];
  const ids = ["a", "b", "c", "d", ...(o.full ? ["e", "f", "g", "h", "i"] : [])].map((s) => `${P}${s}`);
  const has = (id: string) => results.some((r) => r.id === id);
  let ref = "";
  let deleted = false;
  try {
    // ---- a: create ----
    const t0 = Date.now();
    const created = await createProject(ctx, o.org, `fe-${P.toLowerCase()}-${t0}`);
    ref = created.ref;
    if (created.res.status !== 201 || !ref) {
      results.push({
        id: `${P}a`,
        title: `${P}a: create project on ${o.label}`,
        status: "fail",
        detail: `HTTP ${created.res.status}: ${created.res.text.slice(0, 300)}`,
      });
      return results;
    }
    const healthy = await waitHealthy(ctx, ref);
    const authReady = healthy.status === "ACTIVE_HEALTHY" ? await waitAuthConfig(ctx, ref) : { status: 0, ms: 0 };
    results.push({
      id: `${P}a`,
      title: `${P}a: create project on ${o.label}`,
      status: authReady.status === 200 ? "pass" : "fail",
      detail: authReady.status === 200 ? undefined : `status=${healthy.status} config/auth=${authReady.status}`,
      measurements: {
        create_status: created.res.status,
        healthy_s: Math.round(healthy.ms / 1000),
        auth_config_ready_s: Math.round(authReady.ms / 1000),
      },
    });
    if (authReady.status !== 200) return results;

    // ---- b: baseline ----
    const base = await getAuth(ctx, ref);
    const view = mailView(base.cfg);
    const contentKeys = TEMPLATE_KINDS.map(contentField);
    const present = contentKeys.filter((f) => f in base.cfg).length;
    const subjectPresent = TEMPLATE_KINDS.map(subjectField).filter((f) => f in base.cfg).length;
    results.push({
      id: `${P}b`,
      title: `${P}b: baseline mailer_* / smtp_* keys`,
      status: "info",
      detail: `smtp_host=${j(base.cfg.smtp_host ?? null)}; ${present}/6 content keys, ${subjectPresent}/6 subject keys present`,
      measurements: {
        get_status: base.status,
        content_keys_present: present,
        subject_keys_present: subjectPresent,
        smtp_host_null: base.cfg.smtp_host == null || base.cfg.smtp_host === "" ? 1 : 0,
      },
      evidence: j(
        Object.fromEntries(
          Object.entries(view).map(([k, v]) => [k, typeof v === "string" && v.length > 60 ? `${v.slice(0, 60)}...(${v.length} chars)` : v]),
        ),
      ),
    });

    // ---- c: control write (non-template) ----
    const site = await patchAuth(ctx, ref, { site_url: "https://lab.example.com" });
    const afterSite = await getAuth(ctx, ref);
    results.push({
      id: `${P}c`,
      title: `${P}c: control PATCH of a non-template field`,
      status: site.ok ? "pass" : "fail",
      detail: site.summary,
      measurements: { patch_status: site.status, persisted: afterSite.cfg.site_url === "https://lab.example.com" ? 1 : 0 },
    });

    // ---- d: default SMTP template writes ----
    const d = await perKindSweep(ctx, ref, "default");
    const subj: Cfg = {};
    for (const k of TEMPLATE_KINDS) subj[subjectField(k)] = `lab ${k} subject`;
    const subjPatch = await patchAuth(ctx, ref, subj);
    const afterSubj = await getAuth(ctx, ref);
    const subjPersisted = TEMPLATE_KINDS.filter((k) => afterSubj.cfg[subjectField(k)] === subj[subjectField(k)]).length;
    const nd = await notifSweep(ctx, ref, "default");
    const dFlags = await getAuth(ctx, ref);
    const dm = sweepMeasurements("content", d);
    results.push({
      id: `${P}d`,
      title: `${P}d: template PATCH on ${o.label}, default SMTP`,
      status: "info",
      detail: `content: ${dm.content_accepted}/6 accepted, ${dm.content_persisted_n}/6 persisted; subjects (one PATCH): ${subjPatch.summary}, ${subjPersisted}/6 persisted; notification templates (one PATCH): ${nd.content.summary}; notification enable flag: ${nd.enabled.summary}`,
      measurements: {
        ...dm,
        subjects_status: subjPatch.status,
        subjects_persisted_n: subjPersisted,
        notif_content_status: nd.content.status,
        notif_enable_status: nd.enabled.status,
        templates_custom_flags_true: customFlags(dFlags.cfg, "mailer_templates_custom_contents"),
        subjects_custom_flags_true: customFlags(dFlags.cfg, "mailer_subjects_custom_contents"),
      },
      evidence: j({ content_errors: d.errors, subjects: subjPatch.summary, notif_content: nd.content.summary, notif_enable: nd.enabled.summary }),
    });

    if (!o.full) return results;

    // ---- e: custom SMTP written alone ----
    const smtp = await patchAuth(ctx, ref, { ...DUMMY_SMTP });
    const afterSmtp = await getAuth(ctx, ref);
    results.push({
      id: `${P}e`,
      title: `${P}e: custom SMTP fields (dummy host) written`,
      status: smtp.ok ? "pass" : "fail",
      detail: smtp.summary,
      measurements: {
        patch_status: smtp.status,
        smtp_host_persisted: afterSmtp.cfg.smtp_host === DUMMY_SMTP.smtp_host ? 1 : 0,
      },
      evidence: j(Object.fromEntries(Object.entries(mailView(afterSmtp.cfg)).filter(([k]) => k.startsWith("smtp_")))),
    });

    // ---- f: template writes with custom SMTP set ----
    const f = await perKindSweep(ctx, ref, "custom");
    const fm = sweepMeasurements("content", f);
    const subjF: Cfg = {};
    for (const k of TEMPLATE_KINDS) subjF[subjectField(k)] = `lab ${k} subject custom`;
    const subjFPatch = await patchAuth(ctx, ref, subjF);
    const nf = await notifSweep(ctx, ref, "custom");
    const fFlags = await getAuth(ctx, ref);
    results.push({
      id: `${P}f`,
      title: `${P}f: template PATCH with custom SMTP set`,
      status: "info",
      detail: `content: ${fm.content_accepted}/6 accepted, ${fm.content_persisted_n}/6 persisted; subjects (one PATCH): ${subjFPatch.summary}; notification templates (one PATCH): ${nf.content.summary}; notification enable flag: ${nf.enabled.summary}`,
      measurements: {
        ...fm,
        subjects_status: subjFPatch.status,
        notif_content_status: nf.content.status,
        notif_enable_status: nf.enabled.status,
        templates_custom_flags_true: customFlags(fFlags.cfg, "mailer_templates_custom_contents"),
        subjects_custom_flags_true: customFlags(fFlags.cfg, "mailer_subjects_custom_contents"),
      },
      evidence: j({ content_errors: f.errors, notif_content: nf.content.summary }),
    });

    // ---- g: clear SMTP; saved templates survive? writes locked again? ----
    const clear = await patchAuth(ctx, ref, { ...CLEAR_SMTP });
    const afterClear = await getAuth(ctx, ref);
    const survived = TEMPLATE_KINDS.filter((k) => afterClear.cfg[contentField(k)] === f.sent[contentField(k)]).length;
    const backToDefault = TEMPLATE_KINDS.filter((k) => afterClear.cfg[contentField(k)] === base.cfg[contentField(k)]).length;
    const subjBackToDefault = TEMPLATE_KINDS.filter((k) => afterClear.cfg[subjectField(k)] === base.cfg[subjectField(k)]).length;
    const g = await perKindSweep(ctx, ref, "cleared");
    const gm = sweepMeasurements("retry", g);
    results.push({
      id: `${P}g`,
      title: `${P}g: custom SMTP cleared`,
      status: "info",
      detail: `clear: ${clear.summary}; smtp_host after=${j(afterClear.cfg.smtp_host ?? null)}; ${survived}/6 custom-SMTP-era templates still stored; retry: ${gm.retry_accepted}/6 accepted`,
      measurements: {
        clear_status: clear.status,
        smtp_host_null_after: afterClear.cfg.smtp_host == null || afterClear.cfg.smtp_host === "" ? 1 : 0,
        templates_survived_n: survived,
        templates_equal_baseline_n: backToDefault,
        subjects_equal_baseline_n: subjBackToDefault,
        templates_custom_flags_true_after_clear: customFlags(afterClear.cfg, "mailer_templates_custom_contents"),
        ...gm,
      },
      evidence: j({ retry_errors: g.errors }),
    });

    // ---- h: which SMTP field lifts the lock: host alone ----
    const hostOnly = await patchAuth(ctx, ref, { smtp_host: DUMMY_SMTP.smtp_host });
    const iT = await patchAuth(ctx, ref, { [contentField("confirmation")]: sampleTemplate("confirmation", "host-only") });
    await patchAuth(ctx, ref, { ...CLEAR_SMTP });
    results.push({
      id: `${P}h`,
      title: `${P}h: smtp_host alone set, then a template PATCH`,
      status: "info",
      detail: `smtp_host only: ${hostOnly.summary}; template after: ${iT.summary}`,
      measurements: { host_only_status: hostOnly.status, template_status: iT.status },
    });

    // ---- i: SMTP + template in one request, from default state ----
    const combo = await patchAuth(ctx, ref, {
      ...DUMMY_SMTP,
      [contentField("recovery")]: sampleTemplate("recovery", "combined"),
    });
    const afterCombo = await getAuth(ctx, ref);
    results.push({
      id: `${P}i`,
      title: `${P}i: SMTP and template fields in one PATCH from default state`,
      status: "info",
      detail: combo.summary,
      measurements: {
        patch_status: combo.status,
        smtp_host_persisted: afterCombo.cfg.smtp_host === DUMMY_SMTP.smtp_host ? 1 : 0,
        template_persisted: afterCombo.cfg[contentField("recovery")] === sampleTemplate("recovery", "combined") ? 1 : 0,
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    for (const id of ids) if (!has(id)) results.push({ id, title: id, status: "fail", detail: `test threw: ${msg}` });
  } finally {
    if (ref && !deleted) {
      const del = await call(ctx, "DELETE", `/projects/${ref}`).catch(() => null);
      deleted = !!del && del.status >= 200 && del.status < 300;
      ctx.log(`${P}: delete project -> ${del?.status ?? "error"}`);
    }
  }
  for (const id of ids) if (!has(id)) results.push({ id, title: id, status: "skip", detail: "row never produced" });
  return results;
}
