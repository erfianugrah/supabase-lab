/**
 * AR06 - the `/auth/v1/token` bucket: which grants share it, whether
 * `GET /auth/v1/user` is limited at all, and what shape the bucket has when
 * the limit is raised.
 *
 * The rate-limits docs page (https://supabase.com/docs/guides/auth/rate-limits,
 * read 2026-10-26) gives the token endpoint 150 requests per 5 minutes per IP
 * with bursts up to 30, "This covers password, refresh token, ID token, and
 * PKCE grants" (key `rate_limit_token_refresh`), and lists `/auth/v1/user` in
 * the "Sign-ups and sign-ins" row (30 per 5 minutes, bursts up to 30).
 *
 * Competing hypotheses and what separates them:
 *   AR06a  shared bucket vs one bucket per grant type: drain with password
 *          grants until the first 429, then send one refresh grant at once
 *          (429 = shared, 200 = separate); then the reverse. The PATCHed
 *          value (60) is checked against the running limiter by the refill:
 *          30 s after a drain, 60/5 min refills about 6 tokens, the 150
 *          default about 15.
 *   AR06b  GET /user limited or not: 60 sequential plus 100 concurrent GETs
 *          with one user token. Whether they drew from the token bucket
 *          (password grants until 429 after them: about 30 = untouched).
 *          PUT /user (the same route, update) drained until 429; then
 *          email sign-ups (autoconfirm on, no email sent) until 429: about
 *          31 = a separate bucket from PUT /user, 1 = shared. Which key
 *          moves PUT /user: refill after 10 s at rate_limit_otp default
 *          (30/5 min, about 1 token) against rate_limit_otp 3000 (about 30).
 *   AR06c  burst fixed at 30 vs proportional to the limit: at
 *          rate_limit_token_refresh 10000 (33.3/s refill), open-loop
 *          password grants at 25, 33, 45 and 60 per second for
 *          PVLAB_AR06_ARM_S seconds each, then 300 concurrent grants against
 *          a full bucket (n=2) and a control at 150 (n=1). A fixed burst of
 *          30 predicts no 429 at 25/s, first 429 near 30/(r - 33.3) s above
 *          the refill rate, and about 30 + 33.3 x (arrival window) passes in
 *          the 300 burst; a proportional burst predicts far more.
 *          Grants in AR06c use an email with no account (one indexed lookup,
 *          400 invalid_credentials, no bcrypt): GoTrue applies the token
 *          limiter before the grant handler (auth master, internal/api/
 *          token.go), so a 400 is a request that passed the limiter.
 *   AR06d  every rate_limit_* value read back on the fresh project.
 *
 * Vantage: one Mac, one egress IPv4, against an ap-southeast-1 project.
 *
 * DESTRUCTIVE: creates a Pro-org project (lib/ar-project.ts) unless
 * PVLAB_AR_REF is set, creates users, PATCHes auth config (restored at the
 * end). AR99 or `make clean DELETE=1` deletes the project.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import {
  authConfig,
  authLogLines,
  createUsers,
  ensureProject,
  errText,
  fmtCounts,
  getUser,
  type Hit,
  passwordGrant,
  patchAndSettle,
  pctl,
  putUser,
  rateLimitFields,
  redact,
  refreshGrant,
  signup,
  skipWithoutPro,
  sleep,
  untilFirst429,
  type ArProject,
} from "../lib/ar-project.js";

const ARM_S = Number(process.env.PVLAB_AR06_ARM_S || 60);
const RATES = (process.env.PVLAB_AR06_RATES || "25,33,45,60").split(",").map(Number);
const ONLY = (process.env.PVLAB_AR06_ONLY || "a,b,c").split(",");
const NOBODY = () => `ar06-nobody-${crypto.randomUUID().slice(0, 8)}@example.com`;
const NOBODY_PW = "not-a-real-password-1A!";

function hist(hits: Hit[]): Record<string, number> {
  const o: Record<string, number> = {};
  for (const h of hits) o[String(h.status)] = (o[String(h.status)] ?? 0) + 1;
  return o;
}

/** Open-loop: request i leaves at t0 + i/rate regardless of earlier answers. */
async function openLoop(make: (t0: number) => Promise<Hit>, rate: number, durS: number): Promise<Hit[]> {
  const n = Math.round(rate * durS);
  const t0 = performance.now();
  const pending: Promise<Hit>[] = [];
  for (let i = 0; i < n; i++) {
    const due = t0 + (i * 1000) / rate;
    const wait = due - performance.now();
    if (wait > 1) await sleep(wait);
    pending.push(make(t0));
  }
  return Promise.all(pending);
}

const mod: TestModule = {
  id: "AR06",
  title: "Auth token bucket: shared grants, /user, burst shape at a raised limit",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const skip = skipWithoutPro(ctx, "AR06");
    if (skip) return skip;
    const out: TestResult[] = [];
    let p: ArProject;
    try {
      p = await ensureProject(ctx);
    } catch (e) {
      return [{ id: "AR06", title: this.title, status: "fail", detail: `provision: ${errText(e)}` }];
    }
    const base = await authConfig(ctx, p);
    const defaults = rateLimitFields(base);
    out.push({
      id: "AR06d",
      title: "rate_limit_* values read back from config/auth (project as created)",
      status: "info",
      detail: Object.entries(defaults)
        .map(([k, v]) => `${k}=${v}`)
        .join(", "),
      measurements: { ...defaults, mailer_autoconfirm: String(base.mailer_autoconfirm), project_create_ms: p.createMs },
    });
    const restore: Record<string, unknown> = {
      rate_limit_token_refresh: base.rate_limit_token_refresh,
      rate_limit_otp: base.rate_limit_otp,
      mailer_autoconfirm: base.mailer_autoconfirm,
    };

    try {
      const { users, failed } = await createUsers(p, `a${Date.now()}`, 4);
      if (failed) throw new Error(`could not create ${failed} of 4 users`);
      const u = users[0]!;

      // ------------------------------------------------------------ AR06a
      if (ONLY.includes("a")) {
        // Refresh tokens for the four trials, minted before the PATCH.
        const seeds: string[] = [];
        for (let i = 0; i < 4; i++) {
          const g = await passwordGrant(p, u.email, u.password);
          seeds.push(String(g.json?.refresh_token ?? ""));
        }
        if (seeds.some((s) => !s)) throw new Error("could not mint refresh tokens");
        const st = await patchAndSettle(ctx, p, { rate_limit_token_refresh: 60 });
        ctx.log(`AR06a PATCH 60: ${st.status}, readback ${st.readbackS}s, health gaps ${st.healthGaps}`);
        const trials: Record<string, number | string>[] = [];
        for (let t = 0; t < 4; t++) {
          const pwFirst = t % 2 === 0;
          let chain = seeds[t]!;
          const pw = () => passwordGrant(p, u.email, u.password);
          const rf = async () => {
            const h = await refreshGrant(p, chain);
            const next = h.json?.refresh_token;
            if (h.status === 200 && typeof next === "string") chain = next;
            return h;
          };
          const drainWith = pwFirst ? pw : rf;
          const other = pwFirst ? rf : pw;
          const drain = await untilFirst429(() => drainWith(), 80);
          const cross = await other();
          await sleep(30_000);
          const refill = await untilFirst429(() => drainWith(), 80);
          trials.push({
            order: pwFirst ? "password then refresh" : "refresh then password",
            drain_first_429: drain.first429,
            drain_statuses: fmtCounts(drain.statuses),
            cross_status: cross.status,
            cross_code: cross.code,
            refill_30s_passes: refill.first429 > 0 ? refill.first429 - 1 : -1,
            body_429: drain.body429,
          });
          ctx.log(`AR06a trial ${t + 1}: ${JSON.stringify(trials[t])}`);
          if (t < 3) await sleep(160_000); // 30 tokens at 0.2/s = 150 s
        }
        const logs = await authLogLines(ctx, p, "%RATE_LIMIT_TOKEN%", st.patchAt);
        trials.forEach((tr, i) =>
          out.push({
            id: `AR06a.${i + 1}`,
            title: `shared token bucket at rate_limit_token_refresh=60: ${tr.order}`,
            status: "info",
            detail: `drain 429 at request ${tr.drain_first_429} (${tr.drain_statuses}); the other grant right after: ${tr.cross_status} ${tr.cross_code}; passes after a 30 s wait: ${tr.refill_30s_passes}`,
            measurements: tr,
          }),
        );
        out.push({
          id: "AR06a.cfg",
          title: "rate_limit_token_refresh=60 PATCH: readback and auth log",
          status: "info",
          detail: `PATCH ${st.status}, read back after ${st.readbackS} s, health gaps ${st.healthGaps}; ${logs.lines.length} auth log lines matching RATE_LIMIT_TOKEN (logs ${logs.status}${logs.error ? ` ${logs.error}` : ""})`,
          measurements: { patch_status: st.status, readback_s: st.readbackS, health_gaps: st.healthGaps, log_lines: logs.lines.length },
          evidence: logs.lines.join("\n"),
        });
      }

      // ------------------------------------------------------------ AR06b
      if (ONLY.includes("b")) {
        const st = await patchAndSettle(ctx, p, { rate_limit_token_refresh: 150, mailer_autoconfirm: true }, 20);
        ctx.log(`AR06b PATCH 150 + autoconfirm: ${st.status}`);
        const u2 = users[1]!;
        const g = await passwordGrant(p, u2.email, u2.password);
        const jwt = String(g.json?.access_token ?? "");
        if (!jwt) throw new Error(`AR06b sign-in ${g.status} ${g.body}`);
        const seq: Hit[] = [];
        for (let i = 0; i < 60; i++) seq.push(await getUser(p, jwt));
        const conc = await Promise.all(Array.from({ length: 100 }, () => getUser(p, jwt)));
        const after = await untilFirst429(() => passwordGrant(p, u2.email, u2.password), 80);
        out.push({
          id: "AR06b.1",
          title: "GET /auth/v1/user: 60 sequential + 100 concurrent with one user token",
          status: "info",
          detail: `sequential ${fmtCounts(hist(seq))} (p50 ${pctl(seq.map((h) => h.ms), 50)} ms); concurrent ${fmtCounts(hist(conc))} (p50 ${pctl(conc.map((h) => h.ms), 50)} ms); password grants after: first 429 at ${after.first429} (${fmtCounts(after.statuses)})`,
          measurements: {
            get_seq: fmtCounts(hist(seq)),
            get_conc: fmtCounts(hist(conc)),
            grants_after_first_429: after.first429,
            grant_before_get: g.status,
          },
        });

        const putDrain = await untilFirst429((i) => putUser(p, jwt, i), 80);
        const signDrain = await untilFirst429((i) => signup(p, `ar06b-${Date.now()}-${i}@example.com`, `${crypto.randomUUID()}Aa1!`), 60);
        await sleep(10_000);
        const putRefillDefault = await untilFirst429((i) => putUser(p, jwt, 1000 + i), 80);
        out.push({
          id: "AR06b.2",
          title: "PUT /auth/v1/user drained, then email sign-up (autoconfirm): one bucket or two",
          status: "info",
          detail: `PUT first 429 at ${putDrain.first429} (${fmtCounts(putDrain.statuses)}) ${putDrain.body429}; sign-ups right after: first 429 at ${signDrain.first429} (${fmtCounts(signDrain.statuses)}); PUT passes 10 s later at rate_limit_otp=${String(base.rate_limit_otp)}: ${putRefillDefault.first429 - 1}`,
          measurements: {
            put_first_429: putDrain.first429,
            signup_after_first_429: signDrain.first429,
            signup_statuses: fmtCounts(signDrain.statuses),
            put_refill_10s_default: putRefillDefault.first429 - 1,
          },
        });

        const st2 = await patchAndSettle(ctx, p, { rate_limit_otp: 3000 }, 20);
        const putFresh = await untilFirst429((i) => putUser(p, jwt, 2000 + i), 80);
        await sleep(10_000);
        const putRefill = await untilFirst429((i) => putUser(p, jwt, 3000 + i), 80);
        out.push({
          id: "AR06b.3",
          title: "PUT /auth/v1/user refill with rate_limit_otp=3000 (10/s)",
          status: "info",
          detail: `PATCH ${st2.status}; PUT first 429 at ${putFresh.first429}; passes 10 s after the drain: ${putRefill.first429 - 1} (default gave ${putRefillDefault.first429 - 1})`,
          measurements: { patch_status: st2.status, put_first_429_fresh: putFresh.first429, put_refill_10s_otp3000: putRefill.first429 - 1 },
        });
      }

      // ------------------------------------------------------------ AR06c
      if (ONLY.includes("c")) {
        const st = await patchAndSettle(ctx, p, { rate_limit_token_refresh: 10000 }, 20);
        // Check the running limiter: 100 grants paced at 20/s (below the 33.3/s
        // refill at 10000); at 150 the 31st is a 429. Unpaced sequential grants
        // ran at about 50/s in the 2026-10-26 smoke run and 429'd at request 90,
        // which is the 10000 limiter working, not a failure to apply it.
        const seq = await untilFirst429(async () => {
          const s = performance.now();
          const h = await passwordGrant(p, NOBODY(), NOBODY_PW);
          const left = 50 - (performance.now() - s);
          if (left > 0) await sleep(left);
          return h;
        }, 100);
        out.push({
          id: "AR06c.0",
          title: "rate_limit_token_refresh=10000 took effect (100 grants paced at 20/s)",
          status: seq.first429 === 0 ? "pass" : "fail",
          detail: `PATCH ${st.status}, readback ${st.readbackS} s; ${fmtCounts(seq.statuses)}, first 429 at ${seq.first429}; mean ${Math.round(seq.hits.reduce((a, h) => a + h.ms, 0) / seq.hits.length)} ms per request`,
          measurements: { patch_status: st.status, first_429: seq.first429, statuses: fmtCounts(seq.statuses) },
        });

        for (const rate of RATES) {
          await sleep(5_000); // 30 tokens refill in under 1 s at 33.3/s
          const hits = await openLoop((t0) => passwordGrant(p, NOBODY(), NOBODY_PW, t0), rate, ARM_S);
          const h = hist(hits);
          const first = hits.find((x) => x.status === 429);
          const firstIdx = first ? hits.indexOf(first) + 1 : 0;
          const n429 = h["429"] ?? 0;
          const lastSend = hits.at(-1)?.at ?? 0;
          const ok = hits.filter((x) => x.status !== 429 && x.status !== 0);
          out.push({
            id: `AR06c.${rate}`,
            title: `steady ${rate}/s password grants for ${ARM_S} s at rate_limit_token_refresh=10000`,
            status: "info",
            detail: `${hits.length} sent over ${(lastSend / 1000).toFixed(1)} s; ${fmtCounts(h)}; first 429 at request ${firstIdx} (${first ? (first.at / 1000).toFixed(2) : "-"} s); passed ${ok.length} = ${(ok.length / (lastSend / 1000)).toFixed(1)}/s; non-429 p50 ${pctl(ok.map((x) => x.ms), 50)} ms`,
            measurements: {
              rate_per_s: rate,
              sent: hits.length,
              send_span_s: Math.round(lastSend / 100) / 10,
              statuses: fmtCounts(h),
              n429,
              first_429_req: firstIdx,
              first_429_s: first ? Math.round(first.at / 10) / 100 : -1,
              passed_per_s: Math.round((10 * ok.length) / (lastSend / 1000)) / 10,
              p50_ms: pctl(ok.map((x) => x.ms), 50),
              p95_ms: pctl(ok.map((x) => x.ms), 95),
            },
          });
          ctx.log(`AR06c ${rate}/s: ${fmtCounts(h)} first429 ${firstIdx}`);
        }

        const bursts: { label: string; limit: number }[] = [
          { label: "10000 #1", limit: 10000 },
          { label: "10000 #2", limit: 10000 },
          { label: "150 control", limit: 150 },
          { label: "100000", limit: 100000 },
        ];
        let curLimit = 10000;
        for (const b of bursts) {
          if (b.limit !== curLimit) {
            const s2 = await patchAndSettle(ctx, p, { rate_limit_token_refresh: b.limit }, 20);
            ctx.log(`AR06c PATCH ${b.limit}: ${s2.status}`);
            curLimit = b.limit;
          } else await sleep(5_000);
          const t0 = performance.now();
          const hits = await Promise.all(Array.from({ length: 300 }, () => passwordGrant(p, NOBODY(), NOBODY_PW, t0)));
          const h = hist(hits);
          const passed = hits.filter((x) => x.status !== 429 && x.status !== 0).length;
          const sendSpan = Math.max(...hits.map((x) => x.at)) - Math.min(...hits.map((x) => x.at));
          const doneAt = hits.map((x) => x.at + x.ms);
          const respSpan = Math.max(...doneAt) - Math.min(...doneAt);
          out.push({
            id: `AR06c.burst.${b.label.replace(/\s+/g, "-")}`,
            title: `300 concurrent grants against a full bucket, rate_limit_token_refresh=${b.limit}`,
            status: "info",
            detail: `${fmtCounts(h)}; passed ${passed}; client send span ${Math.round(sendSpan)} ms, response span ${Math.round(respSpan)} ms`,
            measurements: {
              limit: b.limit,
              statuses: fmtCounts(h),
              passed,
              send_span_ms: Math.round(sendSpan),
              response_span_ms: Math.round(respSpan),
              p50_ms: pctl(hits.map((x) => x.ms), 50),
            },
          });
          ctx.log(`AR06c burst ${b.label}: ${fmtCounts(h)}`);
        }
      }
    } catch (e) {
      out.push({ id: "AR06", title: this.title, status: "fail", detail: redact(`threw: ${errText(e)}`) });
    } finally {
      const r = await patchAndSettle(ctx, p, restore, 5).catch(() => ({ status: 0 }));
      out.push({ id: "AR06z", title: "restore auth config", status: r.status < 300 ? "pass" : "fail", detail: `PATCH ${r.status} ${JSON.stringify(restore)}` });
    }
    return out;
  },
};

export default mod;
