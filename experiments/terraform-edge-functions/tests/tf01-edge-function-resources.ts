/**
 * TF01 - the supabase_edge_function and supabase_edge_function_secrets
 * resources under load: does "apply complete" mean the functions exist?
 *
 * edge-function-limits EF05a deployed 24 functions through the Management API
 * 8 in flight and got 24 x 201 with 10 present afterwards. The provider's
 * edge-function resource (added in provider 1.9.0, public May 2026 developer
 * update) is a different client of the same endpoint, and OpenTofu's default
 * is 10 concurrent operations. This module runs the same 24-function shape
 * with -parallelism=24 and records, for every step, BOTH what tofu reported
 * and what the Management API lists afterwards.
 *
 * Phases, in execution order (state is fresh at the start of each):
 *
 *   1  TF01a  24 functions + a secrets resource, one apply, -parallelism=24
 *      TF01b  re-plan, then re-apply at 24 until listed or 4 rounds
 *      TF01c  secrets the API lists after that apply
 *      TF03a  destroy at -parallelism=24: reported vs still listed, and what
 *             tofu's state holds afterwards (orphans)
 *   2  TF02a  baseline at -parallelism=1: 24 functions + secrets land
 *      TF02b  re-plan with nothing changed
 *      TF02c  change every source, apply at 1: in place or replace, versions
 *      TF02d  change every source again, apply at 24: do updates land
 *      TF02e  change one source: the other 23 untouched
 *      TF02f  secrets: change one value, add one, remove one
 *      TF02g  secrets out of band: an extra secret, a changed digest
 *      TF03b  destroy at -parallelism=1
 *   3  TF04x  controls on fresh state, apply + destroy at the same width:
 *             parallelism 1, 2, 4, 10 (the default), 24 (twice) with no
 *             secrets resource, then 24 with it
 *   4  TF05x  the same 24 functions through the Management API directly,
 *             all in flight and one at a time (is the loss the provider's?)
 *
 * Self-provisioning: creates one throwaway Pro-org project named tf-*
 * (or reuses PVLAB_REF without deleting it), and deletes the project in
 * `finally`. A measured fail is data; nothing here retries a landing except
 * the convergence rows, which exist to measure exactly that.
 *
 * DESTRUCTIVE and slow (about an hour).
 */
import { mgmt } from "../../../harness/src/mgmt";
import { fetchKeys } from "../../../harness/src/platform";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { deleteFunction, deployViaApi, invoke, invokeWhenLive, landed, listSlugs, tinySource } from "../../edge-function-limits/lib/ef";
import { apply, counts, destroy, init, plan, type Stage, stage, stateList, version, writeSources, writeVars } from "../lib/tofu";

const P = "pvlab-tf-";
const N = 24;
const SECRET_PREFIX = "TFEF_";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const slugsOf = (n: number) => Array.from({ length: n }, (_, i) => `${P}${String(i).padStart(2, "0")}`);
const secretsV1 = () => ({ [`${SECRET_PREFIX}A`]: "alpha-1", [`${SECRET_PREFIX}B`]: "bravo-1", [`${SECRET_PREFIX}C`]: "charlie-1" });
const hist = (xs: (number | string)[]) => {
  const m = new Map<string, number>();
  for (const x of xs) m.set(String(x), (m.get(String(x)) ?? 0) + 1);
  return [...m.entries()]
    .sort(([a], [b]) => a.localeCompare(b, "en"))
    .map(([k, v]) => `${k}:${v}`)
    .join("|");
};
const planStr = (p: { add: number; change: number; destroy: number } | null) =>
  p ? `${p.add} add / ${p.change} change / ${p.destroy} destroy` : "no plan line";

interface FnRow {
  version?: number;
  status?: string;
}

/** Retry a control-plane read through 429, an HTML interstitial, or a client-side timeout (status 0). */
async function patient<T extends { status: number; throttled: boolean }>(f: () => Promise<T>): Promise<T> {
  const once = async (): Promise<T> => {
    try {
      return await f();
    } catch {
      return { status: 0, throttled: true } as T;
    }
  };
  let r = await once();
  for (let i = 0; i < 4 && (r.status === 429 || r.status === 0 || r.throttled); i++) {
    await sleep(15_000);
    r = await once();
  }
  return r;
}

async function listFns(ctx: Ctx): Promise<Map<string, FnRow>> {
  const r = await patient(() => mgmt(ctx, "GET", `/projects/${ctx.ref}/functions`));
  const rows = Array.isArray(r.json) ? (r.json as { slug?: string; version?: number; status?: string }[]) : [];
  const fns = new Map<string, FnRow>();
  for (const f of rows) if (f.slug?.startsWith(P)) fns.set(f.slug, { version: f.version, status: f.status });
  return fns;
}

async function listSecrets(ctx: Ctx): Promise<Map<string, string>> {
  const r = await patient(() => mgmt(ctx, "GET", `/projects/${ctx.ref}/secrets`));
  const rows = Array.isArray(r.json) ? (r.json as { name?: string; value?: string }[]) : [];
  const m = new Map<string, string>();
  for (const s of rows) if (s.name?.startsWith(SECRET_PREFIX)) m.set(s.name, String(s.value ?? ""));
  return m;
}

/** Listed after 10 s, and again 60 s later for whatever was absent: separates "late" from "lost". */
async function landedAt(ctx: Ctx, slugs: string[]): Promise<{ at10: number; at70: number; present: string[]; missing: string[] }> {
  await sleep(10_000);
  const a = await listFns(ctx);
  let present = slugs.filter((s) => a.has(s));
  const at10 = present.length;
  if (present.length < slugs.length) {
    await sleep(60_000);
    const b = await listFns(ctx);
    present = slugs.filter((s) => b.has(s));
  }
  return { at10, at70: present.length, present, missing: slugs.filter((s) => !present.includes(s)) };
}

/** For slugs the listing does not show: does GET /functions/{slug} agree, and does the data plane answer? */
async function probeMissing(ctx: Ctx, missing: string[]): Promise<{ get: string; invoke: string }> {
  const gets: number[] = [];
  const invs: number[] = [];
  for (const s of missing) {
    gets.push((await patient(async () => ({ ...(await landed(ctx, s)), throttled: false }))).status);
    invs.push((await invoke(ctx, s, { timeoutMs: 20_000 })).status);
  }
  return { get: hist(gets) || "none", invoke: hist(invs) || "none" };
}

/** Invoke each listed slug; with `tag`, also wait for the body to carry it. */
async function serving(ctx: Ctx, slugs: string[], tag?: string): Promise<{ ok: number; tagged: number; statuses: string }> {
  const codes: number[] = [];
  let tagged = 0;
  const queue = [...slugs];
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      for (let s = queue.shift(); s; s = queue.shift()) {
        let inv = await invokeWhenLive(ctx, s, 45_000);
        for (let i = 0; tag && inv.status === 200 && !inv.text.includes(`"${tag}:`) && i < 8; i++) {
          await sleep(5_000);
          inv = await invokeWhenLive(ctx, s, 5_000);
        }
        codes.push(inv.status);
        if (tag && inv.status === 200 && inv.text.includes(`"${tag}:`)) tagged++;
      }
    }),
  );
  return { ok: codes.filter((c) => c === 200).length, tagged, statuses: hist(codes) };
}

/** Serial API deletes of whatever the lab prefix left; returns how many were left. */
async function sweep(ctx: Ctx): Promise<number> {
  const fns = [...(await listFns(ctx)).keys()];
  for (const s of fns) await deleteFunction(ctx, s);
  const sec = [...(await listSecrets(ctx)).keys()];
  if (sec.length) await patient(() => mgmt(ctx, "DELETE", `/projects/${ctx.ref}/secrets`, sec));
  return fns.length;
}

/** One phase failing (a client timeout, a tofu crash) records a fail row and lets the later phases run. */
async function guardWith(out: TestResult[], id: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    out.push({ id, title: `${id} aborted`, status: "fail", detail: `threw: ${e instanceof Error ? e.message : String(e)}` });
  }
}

const mod: TestModule = {
  id: "TF01",
  title: "OpenTofu supabase_edge_function: 24 functions at -parallelism=24, reported vs landed",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(base: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];
    const pat = base.pat ?? "";
    const reuse = Boolean(base.ref);
    const org = base.orgs.pro ?? "";
    if (!reuse && !org) return [{ id: "TF01", title: this.title, status: "skip", detail: "no PVLAB_ORG_PRO and no PVLAB_REF" }];
    if ((await version(import.meta.dir)).tofu === "absent") {
      return [{ id: "TF01", title: this.title, status: "skip", detail: "tofu not on PATH" }];
    }

    let ref = base.ref;
    let created = false;
    let ctx: Ctx = base;
    const stages: Stage[] = [];
    let teardown = "";
    const slugs = slugsOf(N);
    const src = (tag: string) => (slug: string) => tinySource(`${tag}:${slug}:`);
    const mk = async (vars: Parameters<typeof stage>[0], tag = "v1") => {
      const s = await stage(vars, src(tag));
      stages.push(s);
      const i = await init(s.dir, pat);
      if (i.exitCode !== 0) throw new Error(`tofu init failed: ${(i.stderr || i.stdout).slice(-400)}`);
      return s;
    };
    const cool = () => sleep(15_000);
    const guard = (id: string, fn: () => Promise<void>) => guardWith(out, id, fn);

    try {
      // ---- project ----
      if (!reuse) {
        const c = await mgmt(base, "POST", "/projects", {
          organization_slug: org,
          name: `tf-${Date.now()}`,
          db_pass: `${crypto.randomUUID()}Aa1!`,
          region_selection: { type: "specific", code: "ap-southeast-1" },
          desired_instance_size: "micro",
        });
        const body = (c.json ?? {}) as { ref?: string; id?: string };
        ref = body.ref ?? body.id ?? "";
        if (!ref) {
          return [{ id: "TF01", title: this.title, status: "fail", detail: `project create HTTP ${c.status}: ${c.text.slice(0, 200)}` }];
        }
        created = true;
        let st = "";
        for (let i = 0; i < 90 && st !== "ACTIVE_HEALTHY"; i++) {
          await sleep(10_000);
          st = ((await mgmt(base, "GET", `/projects/${ref}`)).json as { status?: string } | undefined)?.status ?? "";
        }
        if (st !== "ACTIVE_HEALTHY") {
          out.push({ id: "TF01", title: this.title, status: "fail", detail: `project never healthy (last status ${st || "?"})` });
          return out;
        }
      }
      ctx = { ...base, ref, apiHost: `${ref}.${base.apiHostSuffix ?? "supabase.co"}` };
      ctx = { ...ctx, anonKey: (await fetchKeys(ctx)).anon };
      const pre = await sweep(ctx);

      // ================= phase 1: the headline, at -parallelism=24 =================
      const s1 = await mk({ project_ref: ref, slugs, secrets: secretsV1(), manage_secrets: true });
      const ver = await version(s1.dir);
      const a = await apply(s1.dir, pat, N);
      const ac = counts(a);
      const land = await landedAt(ctx, slugs);
      const serve = await serving(ctx, land.present);
      const secAfterFirst = (await listSecrets(ctx)).size;
      const probe = await probeMissing(ctx, land.missing);
      out.push({
        id: "TF01a",
        title: `${N} edge functions + secrets resource, one apply at -parallelism=${N}: reported vs landed`,
        status: land.at70 === N && ac.errors === 0 ? "pass" : "fail",
        detail:
          `tofu exit ${a.exitCode}, reported ${ac.created} created (${ac.summary || "no summary"}), ${ac.errors} error block(s); ` +
          `API lists ${land.at10}/${N} functions at +10 s and ${land.at70}/${N} at +70 s; ${serve.ok}/${land.at70} of the listed answer 200; ` +
          `${secAfterFirst}/3 secrets listed; for the ${land.missing.length} unlisted: GET /functions/{slug} ${probe.get}, invoke ${probe.invoke}`,
        measurements: {
          tofu_version: ver.tofu,
          provider_version: ver.provider,
          preexisting_lab_functions: pre,
          parallelism: N,
          functions: N,
          apply_exit: a.exitCode,
          apply_ms: a.ms,
          reported_created: ac.created,
          error_blocks: ac.errors,
          listed_at_10s: land.at10,
          listed_at_70s: land.at70,
          serving_200: serve.ok,
          serving_statuses: serve.statuses,
          secrets_listed_after_first_apply: secAfterFirst,
          unlisted_get_statuses: probe.get,
          unlisted_invoke_statuses: probe.invoke,
        },
        evidence: ac.errorTexts.join("\n") || undefined,
      });

      // ---- TF01b: convergence ----
      await guard("TF01b", async () => {
        await cool();
        const pl = await plan(s1.dir, pat, N);
        const pc = counts(pl);
        const rounds: string[] = [];
        const listed: number[] = [land.at70];
        let present = land.at70;
        for (let r = 0; r < 4 && present < N; r++) {
          await cool();
          const ra = await apply(s1.dir, pat, N);
          const rc = counts(ra);
          present = (await landedAt(ctx, slugs)).at70;
          listed.push(present);
          rounds.push(`round ${r + 1}: exit ${ra.exitCode}, reported ${rc.created} created, ${rc.errors} error(s), listed ${present}/${N}`);
        }
        out.push({
          id: "TF01b",
          title: `convergence: re-plan after the first apply, then re-apply at -parallelism=${N} until all listed`,
          status: present === N ? "pass" : "fail",
          detail:
            `re-plan exit ${pl.exitCode}: ${planStr(pc.planned)}; ` +
            (rounds.length ? rounds.join("; ") : "no re-apply needed") +
            `; final listed ${present}/${N}`,
          measurements: {
            replan_exit: pl.exitCode,
            replan_to_add: pc.planned?.add ?? -1,
            replan_to_change: pc.planned?.change ?? -1,
            reapply_rounds: rounds.length,
            listed_by_round: listed.join(">"),
            final_listed: present,
          },
          evidence: pc.errorTexts.join("\n") || undefined,
        });
      });

      // ---- TF01c: secrets ----
      await guard("TF01c", async () => {
        const s = await listSecrets(ctx);
        const want = Object.keys(secretsV1());
        const got = want.filter((k) => s.has(k)).length;
        out.push({
          id: "TF01c",
          title: "secrets resource: names the API lists after the headline apply and its re-apply rounds",
          status: got === want.length ? "pass" : "fail",
          detail: `${got}/${want.length} declared secrets listed (first apply alone: ${secAfterFirst}/${want.length})`,
          measurements: { declared: want.length, listed: got },
        });
      });

      // ---- TF03a: destroy at 24, then orphans ----
      await guard("TF03a", async () => {
        await cool();
        const inState = (await stateList(s1.dir, pat)).filter((x) => x.includes("supabase_edge_function.")).length;
        const listedBefore = [...(await listFns(ctx)).keys()];
        const d = await destroy(s1.dir, pat, N);
        const dc = counts(d);
        await sleep(10_000);
        const leftSet = [...(await listFns(ctx)).keys()];
        const left = leftSet.length;
        const resurrected = leftSet.filter((x) => listedBefore.includes(x)).length;
        const stateAfter = await stateList(s1.dir, pat);
        const sec = (await listSecrets(ctx)).size;
        const postInv: number[] = [];
        for (const sl of slugs) postInv.push((await invoke(ctx, sl, { timeoutMs: 20_000 })).status);
        out.push({
          id: "TF03a",
          title: `destroy at -parallelism=${N}: reported vs what the API still lists`,
          status: left === 0 && d.exitCode === 0 ? "pass" : "fail",
          detail:
            `${inState} function resources in state before; exit ${d.exitCode}, reported ${dc.destroyed} destroyed (${dc.summary || "no summary"}), ${dc.errors} error(s); ` +
            `${listedBefore.length} listed before; API still lists ${left} function(s) afterwards (${resurrected} of them were listed before, ${left - resurrected} were not); ${stateAfter.length} address(es) left in state; ${sec} lab secret(s) left; invoking all ${N} slugs afterwards: ${hist(postInv)}`,
          measurements: {
            functions_in_state_before: inState,
            destroy_exit: d.exitCode,
            reported_destroyed: dc.destroyed,
            error_blocks: dc.errors,
            listed_before_destroy: listedBefore.length,
            functions_left_listed: left,
            left_were_listed_before: resurrected,
            left_were_unlisted_before: left - resurrected,
            state_addresses_after: stateAfter.length,
            invoke_after_destroy: hist(postInv),
            secrets_left: sec,
            destroy_ms: d.ms,
          },
          evidence: dc.errorSample || dc.errorTexts.join("\n") || undefined,
        });
        await sweep(ctx);
      });

      // ================= phase 2: baseline at -parallelism=1, then change =================
      const s2 = await mk({ project_ref: ref, slugs, secrets: secretsV1(), manage_secrets: true });
      await guard("TF02a", async () => {
        await cool();
        const ap = await apply(s2.dir, pat, 1);
        const cc = counts(ap);
        const l = await landedAt(ctx, slugs);
        const sv = await serving(ctx, l.present);
        const sec = await listSecrets(ctx);
        out.push({
          id: "TF02a",
          title: `baseline: ${N} functions + secrets resource at -parallelism=1`,
          status: l.at70 === N && sec.size === 3 ? "pass" : "fail",
          detail:
            `exit ${ap.exitCode} in ${Math.round(ap.ms / 1000)} s, reported ${cc.created} created, ${cc.errors} error(s); API lists ${l.at10}/${N} at +10 s, ${l.at70}/${N} at +70 s; ` +
            `${sv.ok}/${l.at70} answer 200; ${sec.size}/3 secrets listed`,
          measurements: {
            parallelism: 1,
            apply_exit: ap.exitCode,
            apply_ms: ap.ms,
            reported_created: cc.created,
            listed_at_10s: l.at10,
            listed_at_70s: l.at70,
            serving_200: sv.ok,
            secrets_listed: sec.size,
          },
        });
      });
      await guard("TF02b", async () => {
        await cool();
        const pl = await plan(s2.dir, pat, 1);
        const pc = counts(pl);
        out.push({
          id: "TF02b",
          title: "re-plan with nothing changed",
          status: pl.exitCode === 0 ? "pass" : "fail",
          detail: `exit ${pl.exitCode}${pc.planned ? `: ${planStr(pc.planned)}` : ""}`,
          measurements: { plan_exit: pl.exitCode, to_add: pc.planned?.add ?? 0, to_change: pc.planned?.change ?? 0 },
          evidence: pl.exitCode === 0 ? undefined : pl.stdout.slice(-1500),
        });
      });
      // update every function, at 1 then at 24
      for (const step of [
        { id: "TF02c", par: 1, tag: "v2" },
        { id: "TF02d", par: N, tag: "v3" },
      ]) {
        await guard(step.id, async () => {
          await cool();
          const before = await listFns(ctx);
          await writeSources(s2.dir, slugs, src(step.tag));
          const pl = await plan(s2.dir, pat, step.par);
          const pc = counts(pl);
          const replaced = (pl.stdout.match(/must be replaced/g) ?? []).length;
          const ap = await apply(s2.dir, pat, step.par);
          const ac2 = counts(ap);
          await sleep(10_000);
          const after = await listFns(ctx);
          const bumped = slugs.filter((s) => (after.get(s)?.version ?? 0) > (before.get(s)?.version ?? 0)).length;
          const sv = await serving(
            ctx,
            slugs.filter((s) => after.has(s)),
            step.tag,
          );
          await cool();
          const rp = await plan(s2.dir, pat, step.par);
          const rpc = counts(rp);
          out.push({
            id: step.id,
            title: `change all ${N} sources, apply at -parallelism=${step.par}: in place or replace, versions, new body served`,
            status: bumped === N && sv.tagged === N ? "pass" : "fail",
            detail:
              `plan ${planStr(pc.planned)}, ${replaced} must-be-replaced; apply exit ${ap.exitCode} in ${Math.round(ap.ms / 1000)} s, ` +
              `${ac2.modified} modified, ${ac2.errors} error(s); ${bumped}/${N} versions increased, ` +
              `${sv.tagged}/${N} serve the ${step.tag} body (invoke statuses ${sv.statuses}); ` +
              `inconsistent-result attributes ${ac2.inconsistentAttrs || "none"}; plan afterwards exit ${rp.exitCode}, ${planStr(rpc.planned)}`,
            measurements: {
              parallelism: step.par,
              plan_to_change: pc.planned?.change ?? -1,
              plan_to_add: pc.planned?.add ?? -1,
              plan_to_destroy: pc.planned?.destroy ?? -1,
              must_be_replaced: replaced,
              apply_exit: ap.exitCode,
              reported_modified: ac2.modified,
              error_blocks: ac2.errors,
              versions_increased: bumped,
              serving_new_body: sv.tagged,
              apply_ms: ap.ms,
              inconsistent_attrs: ac2.inconsistentAttrs || "none",
              replan_exit: rp.exitCode,
              replan_to_change: rpc.planned?.change ?? 0,
            },
            evidence: ac2.errorSample || undefined,
          });
        });
      }
      // one function
      await guard("TF02e-f", async () => {
        await cool();
        const before = await listFns(ctx);
        const target = slugs[0] as string;
        await writeSources(s2.dir, [target], (s) => tinySource(`v4:${s}:`));
        const pl = await plan(s2.dir, pat, N);
        const pc = counts(pl);
        const ap = await apply(s2.dir, pat, N);
        await sleep(10_000);
        const after = await listFns(ctx);
        const bumped = slugs.filter((s) => (after.get(s)?.version ?? 0) > (before.get(s)?.version ?? 0));
        out.push({
          id: "TF02e",
          title: "change one source: the other functions untouched",
          status: bumped.length === 1 && bumped[0] === target ? "pass" : "fail",
          detail: `plan ${planStr(pc.planned)}; apply exit ${ap.exitCode}; ${bumped.length} version(s) increased`,
          measurements: { plan_to_change: pc.planned?.change ?? -1, apply_exit: ap.exitCode, versions_increased: bumped.length },
          evidence: counts(ap).errorSample || undefined,
        });
      });
      // secrets
      await guard("TF02f-g", async () => {
        await cool();
        const before = await listSecrets(ctx);
        const next = { [`${SECRET_PREFIX}A`]: "alpha-2", [`${SECRET_PREFIX}C`]: "charlie-1", [`${SECRET_PREFIX}D`]: "delta-1" };
        await writeVars(s2.dir, { project_ref: ref, slugs, secrets: next, manage_secrets: true });
        const pl = await plan(s2.dir, pat, 1);
        const pc = counts(pl);
        const ap = await apply(s2.dir, pat, 1);
        const after = await listSecrets(ctx);
        const k = (n: string) => `${SECRET_PREFIX}${n}`;
        const changed = before.has(k("A")) && after.has(k("A")) && before.get(k("A")) !== after.get(k("A"));
        const kept = after.has(k("C")) && before.get(k("C")) === after.get(k("C"));
        const added = after.has(k("D"));
        const removed = before.has(k("B")) && !after.has(k("B"));
        out.push({
          id: "TF02f",
          title: "secrets: change one value, add one, remove one",
          status: changed && kept && added && removed ? "pass" : "fail",
          detail: `plan ${planStr(pc.planned)}; apply exit ${ap.exitCode}; digest of A changed ${changed}, C unchanged ${kept}, D added ${added}, B removed ${removed}`,
          measurements: {
            apply_exit: ap.exitCode,
            value_changed: changed ? 1 : 0,
            untouched_kept: kept ? 1 : 0,
            added: added ? 1 : 0,
            removed: removed ? 1 : 0,
            plan_to_change: pc.planned?.change ?? -1,
          },
          evidence: counts(ap).errorTexts.join("\n") || undefined,
        });
        // out of band: an undeclared secret, then a declared one changed behind tofu's back
        await cool();
        const oob = await mgmt(ctx, "POST", `/projects/${ref}/secrets`, [{ name: k("X"), value: "oob-1" }]);
        const pl1 = await plan(s2.dir, pat, 1);
        await mgmt(ctx, "POST", `/projects/${ref}/secrets`, [{ name: k("C"), value: "charlie-oob" }]);
        const pl2 = await plan(s2.dir, pat, 1);
        const pc2 = counts(pl2);
        const ap2 = await apply(s2.dir, pat, 1);
        const after2 = await listSecrets(ctx);
        out.push({
          id: "TF02g",
          title: "secrets out of band: an undeclared secret, then a declared one changed outside tofu",
          status: "info",
          detail:
            `POST of an undeclared secret HTTP ${oob.status}; re-plan exit ${pl1.exitCode} (0 = tofu does not see it); ` +
            `after changing declared C out of band: re-plan exit ${pl2.exitCode}, ${planStr(pc2.planned)}; apply exit ${ap2.exitCode}; ` +
            `undeclared secret still listed ${after2.has(k("X"))}, C digest back to declared value ${after2.get(k("C")) === before.get(k("C"))}`,
          measurements: {
            undeclared_plan_exit: pl1.exitCode,
            drift_plan_exit: pl2.exitCode,
            drift_plan_to_change: pc2.planned?.change ?? -1,
            undeclared_survives_apply: after2.has(k("X")) ? 1 : 0,
            drift_reverted: after2.get(k("C")) === before.get(k("C")) ? 1 : 0,
          },
        });
      });
      // clean destroy at 1
      await guard("TF03b", async () => {
        await cool();
        const d = await destroy(s2.dir, pat, 1);
        const dc = counts(d);
        await sleep(10_000);
        const left = (await listFns(ctx)).size;
        const sec = [...(await listSecrets(ctx)).keys()].filter((n) => n !== `${SECRET_PREFIX}X`).length;
        out.push({
          id: "TF03b",
          title: "destroy at -parallelism=1 from a converged state",
          status: left === 0 && d.exitCode === 0 && sec === 0 ? "pass" : "fail",
          detail: `exit ${d.exitCode}, reported ${dc.destroyed} destroyed, ${dc.errors} error(s); API lists ${left} function(s); ${sec} declared secret(s) left (the undeclared one is swept separately)`,
          measurements: {
            destroy_exit: d.exitCode,
            reported_destroyed: dc.destroyed,
            functions_left_listed: left,
            secrets_left: sec,
            destroy_ms: d.ms,
          },
          evidence: dc.errorSample || undefined,
        });
        await sweep(ctx);
      });

      // ================= phase 3: width sweep on fresh state =================
      const controls: { id: string; par: number; withSecrets: boolean }[] = [
        { id: "TF04a", par: 1, withSecrets: false },
        { id: "TF04b", par: 2, withSecrets: false },
        { id: "TF04c", par: 4, withSecrets: false },
        { id: "TF04d", par: 10, withSecrets: false },
        { id: "TF04e", par: N, withSecrets: false },
        { id: "TF04f", par: N, withSecrets: false },
        { id: "TF04g", par: N, withSecrets: true },
      ];
      for (const c of controls) {
        await guard(c.id, async () => {
          await cool();
          const s = await mk({ project_ref: ref, slugs, ...(c.withSecrets ? { secrets: secretsV1(), manage_secrets: true } : {}) });
          const ap = await apply(s.dir, pat, c.par);
          const cc = counts(ap);
          const l = await landedAt(ctx, slugs);
          const sec = c.withSecrets ? (await listSecrets(ctx)).size : 0;
          await cool();
          const d = await destroy(s.dir, pat, c.par);
          const dc = counts(d);
          await sleep(10_000);
          const leftSet = [...(await listFns(ctx)).keys()];
          const left = leftSet.length;
          const resurrected = leftSet.filter((x) => l.present.includes(x)).length;
          const swept = await sweep(ctx);
          out.push({
            id: c.id,
            title: `fresh state, ${N} functions${c.withSecrets ? " + secrets resource" : ""} at -parallelism=${c.par}: apply then destroy at the same width`,
            status: l.at70 === N && left === 0 ? "pass" : "fail",
            detail:
              `apply exit ${ap.exitCode} in ${Math.round(ap.ms / 1000)} s, reported ${cc.created} created, ${cc.errors} error(s); API lists ${l.at10}/${N} at +10 s, ${l.at70}/${N} at +70 s` +
              (c.withSecrets ? `, ${sec}/3 secrets listed` : "") +
              `; destroy exit ${d.exitCode}, reported ${dc.destroyed} destroyed, ${left} still listed (${resurrected} of them were listed before the destroy, ${left - resurrected} were not; ${swept} removed through the API)`,
            measurements: {
              parallelism: c.par,
              with_secrets: c.withSecrets ? 1 : 0,
              apply_exit: ap.exitCode,
              apply_ms: ap.ms,
              reported_created: cc.created,
              error_blocks: cc.errors,
              listed_at_10s: l.at10,
              listed_at_70s: l.at70,
              ...(c.withSecrets ? { secrets_listed: sec } : {}),
              destroy_exit: d.exitCode,
              reported_destroyed: dc.destroyed,
              functions_left_listed: left,
              left_were_listed_before: resurrected,
              left_were_unlisted_before: left - resurrected,
            },
            evidence: cc.errorSample || dc.errorSample || undefined,
          });
        });
      }

      // ================= phase 4: the same through the Management API =================
      for (const c of [
        { id: "TF05a", width: N },
        { id: "TF05b", width: 1 },
      ]) {
        await guard(c.id, async () => {
          await cool();
          const statuses: number[] = [];
          const meta = (slug: string) => ({ entrypoint_path: "index.ts", name: slug, verify_jwt: true });
          const queue = [...slugs];
          const t0 = Date.now();
          await Promise.all(
            Array.from({ length: c.width }, async () => {
              for (let s = queue.shift(); s; s = queue.shift()) {
                const r = await deployViaApi(ctx, s, [{ name: "index.ts", content: tinySource(s) }], meta(s), 120_000);
                statuses.push(r.status);
              }
            }),
          );
          const l = await landedAt(ctx, slugs);
          const swept = await sweep(ctx);
          out.push({
            id: c.id,
            title: `${N} deploys straight to POST /functions/deploy, ${c.width} in flight`,
            status: l.at70 === N ? "pass" : "fail",
            detail: `statuses ${hist(statuses)} in ${Math.round((Date.now() - t0) / 1000)} s; API lists ${l.at10}/${N} at +10 s, ${l.at70}/${N} at +70 s (${swept} swept)`,
            measurements: {
              in_flight: c.width,
              reported_2xx: statuses.filter((s) => s >= 200 && s < 300).length,
              status_histogram: hist(statuses),
              listed_at_10s: l.at10,
              listed_at_70s: l.at70,
            },
          });
        });
      }
    } catch (e) {
      out.push({ id: "TF01", title: this.title, status: "fail", detail: `threw: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      // Whatever tofu left, then the project. A reused project is kept.
      try {
        if (ref) {
          const { slugs: left } = await listSlugs(ctx);
          for (const s of left.filter((x) => x.startsWith(P))) await deleteFunction(ctx, s);
          const sec = [...(await listSecrets(ctx)).keys()];
          if (sec.length) await mgmt(ctx, "DELETE", `/projects/${ref}/secrets`, sec);
        }
        if (created && ref) {
          const d = await mgmt(base, "DELETE", `/projects/${ref}`);
          teardown = `project delete HTTP ${d.status}`;
          for (let i = 0; i < 30; i++) {
            await sleep(10_000);
            const all = await mgmt(base, "GET", "/projects");
            const rows = Array.isArray(all.json) ? (all.json as { id?: string; ref?: string }[]) : [];
            if (!rows.some((p) => (p.ref ?? p.id) === ref)) {
              teardown += "; gone from GET /projects";
              break;
            }
          }
        }
      } catch (e) {
        teardown = `cleanup threw: ${e instanceof Error ? e.message : String(e)}`;
      }
      for (const s of stages) await s.cleanup().catch(() => undefined);
      out.push({
        id: "TF01z",
        title: "cleanup: functions, secrets, project",
        status: teardown.includes("threw") || (created && !teardown.includes("gone")) ? "fail" : "pass",
        detail: reuse ? "reused PVLAB_REF: project kept, lab-prefixed functions and secrets deleted" : teardown,
      });
    }
    return out;
  },
};
export default mod;
