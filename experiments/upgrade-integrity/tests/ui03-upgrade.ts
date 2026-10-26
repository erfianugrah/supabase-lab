/**
 * UI03 - In-place major upgrade while pg_cron and pgmq write.
 *
 *   UI03a  GET /upgrade/eligibility with the fixture's extensions enabled,
 *          verbatim (unsupported_extensions, objects_to_be_dropped,
 *          warnings).
 *   UI03b  POST /v1/projects/{ref}/upgrade with the first target from the
 *          eligibility payload (`target_version` = its postgres_version,
 *          `release_channel`). GET /upgrade/status polled every
 *          PVLAB_UI_POLL_MS (default 5000; runs 1-2 used 15000), each change
 *          recorded with its time; done when the project is ACTIVE_HEALTHY
 *          and a Management API write answers on the target major. Timeout
 *          PVLAB_UI_UPGRADE_TIMEOUT_MIN (default 120).
 *   UI03c/d/f/g/h  Client writers, one per path, every PVLAB_UI_WRITE_MS
 *          (default 1000; runs 1-2 used 3000; run 1 had only c, run 2 c and d):
 *          Management API query endpoint (c), session pooler 5432 (d),
 *          transaction pooler 6543 (f), direct connection (g; IPv6-only,
 *          dropped and recorded as unreachable if its first 5 attempts all
 *          fail), Data API (h; PostgREST `POST /rest/v1/ui_client` with the
 *          legacy service_role key and `Prefer: return=representation`, added
 *          after run 3). Each write is ONE statement inserting a row whose column
 *          defaults capture, and RETURNING returns, server_version,
 *          pg_postmaster_start_time(), system_identifier, inet_server_addr()
 *          (published as a label), pg_current_wal_lsn(), txid_current() and
 *          pg_is_in_recovery(). Attempt start and acknowledgement times are
 *          kept per write. UI04c checks every acknowledged write afterwards.
 *   UI03e  the same identity read once before the POST and once after the
 *          upgrade, plus synchronous_commit, fsync and wal_level.
 *
 * DESTRUCTIVE: upgrades the shared project.
 */
import { mgmt } from "../../../harness/src/mgmt.js";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { fetchKeys } from "../../../harness/src/platform.js";
import { type Attempt, IDENTITY_SQL, REST_SELECT, addrLabel, type PgPath, ensureProject, errText, pgClient, pgTimestamptzText, projectStatus, redact, skipWithoutPro, sleep, sql, state, writeSql } from "../lib/ui.js";

const TIMEOUT_MIN = Number(process.env.PVLAB_UI_UPGRADE_TIMEOUT_MIN || 120);
// Runs 1-2 wrote every 3 s and polled every 15 s; run 3 on, 1 s and 5 s.
const WRITER_GAP_MS = Number(process.env.PVLAB_UI_WRITE_MS || 1_000);
const POLL_MS = Number(process.env.PVLAB_UI_POLL_MS || 5_000);


const mod: TestModule = {
  id: "UI03",
  title: "In-place major upgrade with cron and queue writing, plus a client writer",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const skip = skipWithoutPro(ctx, "UI03");
    if (skip) return skip;
    const p = await ensureProject(ctx);
    const ref = p.ref;
    const out: TestResult[] = [];

    const e = await mgmt(ctx, "GET", `/projects/${ref}/upgrade/eligibility`);
    const ej = (e.json ?? {}) as {
      eligible?: boolean | null;
      current_app_version?: string;
      target_upgrade_versions?: { postgres_version?: string; release_channel?: string; app_version?: string }[];
      unsupported_extensions?: unknown[];
      objects_to_be_dropped?: unknown[];
      warnings?: unknown[];
      validation_errors?: unknown[];
    };
    const target = ej.target_upgrade_versions?.[0];
    out.push({
      id: "UI03a",
      title: "UI03a: eligibility with pg_cron, pgmq and amcheck enabled",
      status: e.status === 200 && ej.eligible === true && target ? "pass" : "fail",
      detail: `HTTP ${e.status}; eligible ${String(ej.eligible)}; target ${target ? `${target.postgres_version} (${target.app_version})` : "none"}; unsupported_extensions ${JSON.stringify(ej.unsupported_extensions ?? [])}; objects_to_be_dropped ${(ej.objects_to_be_dropped ?? []).length}; warnings ${(ej.warnings ?? []).length}`,
      measurements: { eligible: String(ej.eligible), target_app_version: target?.app_version ?? "none" },
      evidence: redact(e.text.slice(0, 4000)),
    });
    if (!target || ej.eligible !== true) return out;

    const fromVersion = p.version;
    const targetMajor = String(target.postgres_version ?? "");
    const attempts: Attempt[] = [];
    const unreachable: Record<string, string> = {};
    let stopWriter = false;
    const rec = (src: Attempt["src"], seq: number, t: number, row: Record<string, unknown> | null, err: string): void => {
      const v = String(row?.server_version ?? "");
      attempts.push({
        src,
        seq,
        t,
        ackT: Date.now(),
        ok: !err && Boolean(v),
        version: v,
        pmStart: String(row?.pm ?? ""),
        sysid: String(row?.sysid ?? ""),
        addr: addrLabel(row?.addr),
        lsn: String(row?.lsn ?? ""),
        xid: String(row?.xid ?? ""),
        recovery: String(row?.recovery ?? ""),
        err,
      });
    };
    const pace = async (t: number) => {
      const wait = WRITER_GAP_MS - (Date.now() - t);
      if (wait > 0) await sleep(wait);
    };
    const mgmtWriter = (async () => {
      let seq = 0;
      while (!stopWriter) {
        seq++;
        const t = Date.now();
        const r = await sql(ctx, ref, writeSql("mgmt", seq), 20_000);
        rec("mgmt", seq, t, r.rows?.[0] ?? null, r.error ? `${r.status} ${r.error}` : "");
        await pace(t);
      }
    })();
    // pg paths: one connection each, reconnect after any error, 15 s client timeout per insert.
    const pgWriter = (src: Attempt["src"], path: PgPath) =>
      (async () => {
        let seq = 0;
        let everOk = false;
        let conn: Awaited<ReturnType<typeof pgClient>> | null = null;
        while (!stopWriter) {
          seq++;
          const t = Date.now();
          try {
            if (!conn) conn = await pgClient(ctx, p, path, path === "direct" ? 8_000 : 20_000);
            const q = conn.client.query(writeSql(src, seq));
            const r = await Promise.race([q, sleep(15_000).then(() => { throw new Error("client timeout 15 s"); })]);
            rec(src, seq, t, (r as { rows: Record<string, unknown>[] }).rows[0] ?? null, "");
            everOk = true;
          } catch (e) {
            rec(src, seq, t, null, errText(e));
            if (conn) await conn.client.end().catch(() => {});
            conn = null;
            // A path that never worked in its first 5 attempts is recorded as unreachable and dropped.
            if (!everOk && seq >= 5) {
              unreachable[src] = redact(errText(e));
              break;
            }
          }
          await pace(t);
        }
        if (conn) await conn.client.end().catch(() => {});
      })();
    // Data API: PostgREST insert as service_role, 15 s client timeout; the row comes back with the same identity columns.
    const keys = await fetchKeys({ ...ctx, ref }).catch((e: unknown) => {
      unreachable.rest = `api-keys: ${errText(e)}`;
      return null;
    });
    const restWriter = (async () => {
      if (!keys) return;
      let seq = 0;
      while (!stopWriter) {
        seq++;
        const t = Date.now();
        try {
          const r = await fetch(`https://${ref}.supabase.co/rest/v1/ui_client?select=${REST_SELECT}`, {
            method: "POST",
            headers: { apikey: keys.service, authorization: `Bearer ${keys.service}`, "content-type": "application/json", prefer: "return=representation" },
            body: JSON.stringify({ src: "rest", seq }),
            signal: AbortSignal.timeout(15_000),
          });
          const text = await r.text();
          const row = r.status === 201 ? ((JSON.parse(text) as Record<string, unknown>[])[0] ?? null) : null;
          rec("rest", seq, t, row ? { ...row, pm: pgTimestamptzText(row.pm) } : null, r.status === 201 ? "" : `${r.status} ${text.replace(/\s+/g, " ").slice(0, 200)}`);
        } catch (e) {
          rec("rest", seq, t, null, errText(e));
        }
        await pace(t);
      }
    })();
    const writers = [mgmtWriter, pgWriter("pooler", "session"), pgWriter("txn", "transaction"), pgWriter("direct", "direct"), restWriter];
    const pre = await sql(ctx, ref, IDENTITY_SQL);
    const preIdentity: Record<string, unknown> = pre.rows?.[0] ? { ...pre.rows[0], addr: addrLabel(pre.rows[0].addr) } : { error: pre.error };
    // A few acknowledgements on the old major first.
    await sleep(10_000);

    const body = { target_version: targetMajor, release_channel: target.release_channel ?? "ga" };
    const postAt = Date.now();
    const post = await mgmt(ctx, "POST", `/projects/${ref}/upgrade`, body);
    ctx.log(`UI03: POST /upgrade ${JSON.stringify(body)} -> ${post.status}`);
    const timeline: string[] = [`+0 s POST /upgrade ${JSON.stringify(body)} -> ${post.status} ${post.text.slice(0, 300)}`];
    let doneAt = 0;
    let newVersionAt = 0;
    let lastProgress = "";
    let lastStatus = "";
    let lastProj = "";
    let upErr = "";
    let polls = 0;
    let proj = { status: "", database: {} as Record<string, unknown> };
    if (post.status < 300) {
      while (Date.now() - postAt < TIMEOUT_MIN * 60_000) {
        await sleep(POLL_MS);
        const s = await mgmt(ctx, "GET", `/projects/${ref}/upgrade/status`).catch(() => undefined);
        const st = ((s?.json ?? {}) as { databaseUpgradeStatus?: { progress?: string; status?: number; error?: string } | null }).databaseUpgradeStatus;
        polls++;
        if (polls % 3 === 1 || lastProgress === "9_completed_upgrade" || lastProgress === "10_completed_post_physical_backup" || lastProgress === "null") proj = await projectStatus(ctx, ref);
        const now = Date.now();
        const el = Math.round((now - postAt) / 1000);
        const prog = String(st?.progress ?? "null");
        const stn = String(st?.status ?? "null");
        if (prog !== lastProgress || stn !== lastStatus || proj.status !== lastProj) {
          timeline.push(`+${el} s (${new Date(now).toISOString()}) upgrade/status progress ${prog} status ${stn}${st?.error ? ` error ${st.error}` : ""}; project ${proj.status}; database.version ${String(proj.database.version ?? "")}`);
          ctx.log(`UI03: ${timeline.at(-1)}`);
          lastProgress = prog;
          lastStatus = stn;
          lastProj = proj.status;
        }
        if (st?.error) {
          upErr = st.error;
          break;
        }
        const onNew = attempts.find((a) => a.src === "mgmt" && a.ok && a.t > postAt && a.version.startsWith(targetMajor));
        if (onNew && !newVersionAt) {
          newVersionAt = onNew.t;
          timeline.push(`+${Math.round((onNew.t - postAt) / 1000)} s first acknowledged Management API write on ${onNew.version}`);
        }
        if (proj.status === "ACTIVE_HEALTHY" && newVersionAt) {
          doneAt = Date.now();
          break;
        }
      }
    }
    // Keep writing for 30 s after done to see the new side settle.
    await sleep(30_000);
    stopWriter = true;
    await Promise.all(writers);
    const postQ = await sql(ctx, ref, IDENTITY_SQL);
    const postIdentity: Record<string, unknown> = postQ.rows?.[0] ? { ...postQ.rows[0], addr: addrLabel(postQ.rows[0].addr) } : { error: postQ.error };

    const ver = await sql(ctx, ref, "select current_setting('server_version') as v, version() as full");
    const toVersion = String(ver.rows?.[0]?.v ?? "");
    proj = await projectStatus(ctx, ref);

    state.upgrade = {
      postAt,
      postStatus: post.status,
      postBody: redact(post.text.slice(0, 500)),
      doneAt,
      newVersionAt,
      finalProgress: lastProgress,
      error: upErr,
      attempts,
      preIdentity,
      postIdentity,
      unreachable,
      fromVersion,
      toVersion,
    };
    const totalS = doneAt ? Math.round((doneAt - postAt) / 1000) : -1;
    out.push({
      id: "UI03b",
      title: `UI03b: upgrade ${fromVersion} -> ${targetMajor}`,
      status: post.status < 300 && doneAt && toVersion.startsWith(targetMajor) && !upErr ? "pass" : "fail",
      detail: `POST ${post.status}; ${doneAt ? `ACTIVE_HEALTHY and answering on ${toVersion} after ${totalS} s` : `not done within ${TIMEOUT_MIN} min (last progress ${lastProgress}, project ${proj.status})`}${upErr ? `; error ${upErr}` : ""}; final app version ${String(proj.database.version ?? "")}`,
      measurements: {
        post_status: post.status,
        from_version: fromVersion,
        to_version: toVersion,
        app_version_after: String(proj.database.version ?? ""),
        post_to_healthy_on_new_s: totalS,
        final_progress: lastProgress,
      },
      evidence: redact(`${timeline.join("\n")}\nversion(): ${String(ver.rows?.[0]?.full ?? ver.error ?? "")}`),
    });

    out.push({
      id: "UI03e",
      title: "UI03e: server identity before the POST and after the upgrade",
      status: "info",
      detail: `before: ${String(preIdentity.v)} postmaster ${String(preIdentity.pm)} sysid ${String(preIdentity.sysid)} lsn ${String(preIdentity.lsn)} xid ${String(preIdentity.xid)} synchronous_commit ${String(preIdentity.synchronous_commit)} fsync ${String(preIdentity.fsync)}; after: ${String(postIdentity.v)} postmaster ${String(postIdentity.pm)} sysid ${String(postIdentity.sysid)} lsn ${String(postIdentity.lsn)} xid ${String(postIdentity.xid)} synchronous_commit ${String(postIdentity.synchronous_commit)} fsync ${String(postIdentity.fsync)}`,
      measurements: {
        pre_sysid: String(preIdentity.sysid),
        post_sysid: String(postIdentity.sysid),
        pre_addr: String(preIdentity.addr),
        post_addr: String(postIdentity.addr),
        pre_lsn: String(preIdentity.lsn),
        post_lsn: String(postIdentity.lsn),
        pre_xid: String(preIdentity.xid),
        post_xid: String(postIdentity.xid),
      },
      evidence: redact(JSON.stringify({ pre: preIdentity, post: postIdentity }, null, 1)),
    });
    const label = { mgmt: ["c", "Management API query endpoint"], pooler: ["d", "session pooler (5432)"], txn: ["f", "transaction pooler (6543)"], direct: ["g", "direct connection"], rest: ["h", "Data API (PostgREST)"] } as const;
    for (const src of ["mgmt", "pooler", "txn", "direct", "rest"] as const) {
      const mine = attempts.filter((a) => a.src === src);
      const acks = mine.filter((a) => a.ok);
      let gap = 0;
      let gapFrom: Attempt | undefined;
      let gapTo: Attempt | undefined;
      for (let i = 1; i < acks.length; i++) {
        const d = acks[i]!.t - acks[i - 1]!.t;
        if (d > gap) {
          gap = d;
          gapFrom = acks[i - 1];
          gapTo = acks[i];
        }
      }
      const failed = mine.filter((a) => !a.ok);
      const pms = [...new Set(acks.map((a) => `${a.version}@${a.pmStart}`))];
      const off = (ms?: number) => (ms ? Math.round((ms - postAt) / 1000) : -1);
      // Runs of identical outcome, so the evidence shows the sequence without one line per write.
      const runs: { key: string; a: Attempt[] }[] = [];
      for (const a of mine) {
        const key = a.ok ? `ok ${a.version} postmaster ${a.pmStart} sysid ${a.sysid} addr ${a.addr} recovery ${a.recovery}` : `FAIL ${a.err.slice(0, 140)}`;
        const last = runs.at(-1);
        if (last && last.key === key) last.a.push(a);
        else runs.push({ key, a: [a] });
      }
      const lines = runs.map(({ key, a }) => {
        const f = a[0]!;
        const l = a.at(-1)!;
        const range = f === l ? `seq ${f.seq} (start +${off(f.t)} s, ack +${off(f.ackT)} s)` : `seq ${f.seq}-${l.seq} (start +${off(f.t)}..${off(l.t)} s, ack +${off(f.ackT)}..${off(l.ackT)} s)`;
        return `${range} ${key}${f.ok ? ` lsn ${f.lsn}..${l.lsn} xid ${f.xid}..${l.xid}` : ""}`;
      });
      const [suffix, name] = label[src];
      out.push({
        id: `UI03${suffix}`,
        title: `UI03${suffix}: client writes through the ${name} across the window`,
        status: unreachable[src] ? "skip" : "info",
        detail: unreachable[src]
          ? `path unreachable from this vantage, dropped after ${mine.length} attempts: ${unreachable[src]}`
          : `${mine.length} attempts, ${acks.length} acknowledged, ${failed.length} failed; largest gap between acknowledged writes ${Math.round(gap / 1000)} s (seq ${gapFrom?.seq ?? "?"} at +${off(gapFrom?.t)} s -> seq ${gapTo?.seq ?? "?"} at +${off(gapTo?.t)} s); ${pms.length} distinct server_version@postmaster_start among acknowledged writes`,
        measurements: {
          attempts: mine.length,
          acknowledged: acks.length,
          failed: failed.length,
          max_ack_gap_s: Math.round(gap / 1000),
          gap_start_after_post_s: off(gapFrom?.t),
          gap_end_after_post_s: off(gapTo?.t),
          postmasters: pms.length,
        },
        evidence: redact(lines.join("\n")),
      });
    }
    return out;
  },
};
export default mod;
