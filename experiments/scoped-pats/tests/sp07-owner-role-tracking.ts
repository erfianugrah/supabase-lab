/**
 * SP07 - a scoped token tracks its creator's CURRENT role (changelog
 * scoped-personal-access-tokens-ga: "when you lose access, so does the
 * token"; every request validates the creator's current role). Doc-cited,
 * not tested before this module.
 *
 * Needs a second human: PVLAB_SCOPED_PAT_MEMBER is created by an org member
 * other than the lab operator, with an Administrator or Developer org role,
 * scoped to the fixture project with Database = Read-write and Project
 * Settings = Read. Role changes have no API on this plan
 * (`api.members.roles` false on the Pro org in bu-attribution BA01a), so the
 * operator changes the creator's org role in the dashboard DURING the watch.
 *
 * Flow: poll the member token every PVLAB_SP_WATCH_INTERVAL_S (default 15 s)
 * on three probes for up to PVLAB_SP_WATCH_S (default 900 s):
 *   project   GET /projects/{fixture}
 *   select    POST /database/query  `select 1`
 *   write     POST /database/query  `create table if not exists ...`
 * The first poll is the "before" state. When the log prints
 * `WATCH: change the creator's role now`, demote the creator to Read-only
 * (or remove them from the org). Every status change is stamped with seconds
 * since the first poll; the resolution is the poll interval.
 *
 * Needs PVLAB_PEER_FIXTURE (the token is project-scoped, so the project
 * already exists). The probe table is dropped with the lab token after.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { call } from "../lib/http.js";
import { fmt, watch, type WatchProbe } from "../lib/watch.js";
import { roleOf, skipReason, tokenFor } from "../lib/tokens.js";

const TABLE = "public.sp07_probe";
const role = roleOf("member");

const mod: TestModule = {
  id: "SP07",
  title: "Scoped token follows the creator's current org role (operator demotes mid-run)",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const ids = ["SP07a", "SP07b"];
    const tok = tokenFor(role);
    const ref = ctx.peers.fixture ?? "";
    if (!tok || !ref) {
      const why = !tok ? skipReason(role) : "PVLAB_PEER_FIXTURE not set (a project-scoped token needs an existing project)";
      return ids.map((id) => ({ id, title: id, status: "skip" as const, detail: why }));
    }
    const probes: WatchProbe[] = [
      { id: "project", method: "GET", path: `/projects/${ref}` },
      { id: "select", method: "POST", path: `/projects/${ref}/database/query`, body: { query: "select 1 as one" } },
      { id: "write", method: "POST", path: `/projects/${ref}/database/query`, body: { query: `create table if not exists ${TABLE}(id int)` } },
    ];
    try {
      ctx.log("WATCH: change the creator's role now (dashboard: demote to Read-only). Polling...");
      const w = await watch(tok, probes, ctx.log);
      const changed = w.transitions.length > 0;
      return [
        {
          id: "SP07a",
          title: "SP07a: member token before the role change",
          status: "info",
          detail: Object.values(w.initial).every((s) => s.startsWith("2"))
            ? undefined
            : "token was already refused on some probe at the first poll; the 'before' state is not the full-access state",
          measurements: { project_status: w.initial.project ?? "", select_status: w.initial.select ?? "", write_status: w.initial.write ?? "" },
        },
        {
          id: "SP07b",
          title: "SP07b: seconds until each probe changed after the operator demoted the creator",
          status: changed ? "info" : "skip",
          detail: changed
            ? `poll interval ${w.intervalS} s; the operator's dashboard action time is not recorded, so these are seconds since the first poll, not since the action`
            : `no change in ${w.seconds} s over ${w.polls} polls; the operator may not have acted, so this is not a measurement of "no effect"`,
          measurements: {
            polls: w.polls,
            watch_seconds: w.seconds,
            interval_s: w.intervalS,
            final_project: w.final.project ?? "",
            final_select: w.final.select ?? "",
            final_write: w.final.write ?? "",
            transitions: fmt(w.transitions),
          },
        },
      ];
    } finally {
      await call(ctx.pat ?? "", "POST", `/projects/${ref}/database/query`, { query: `drop table if exists ${TABLE}` }).catch(() => null);
    }
  },
};
export default mod;
