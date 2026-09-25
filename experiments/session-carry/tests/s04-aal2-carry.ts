/**
 * S04 - does an aal2 session stay aal2 when it is refreshed at the target?
 *
 * tenant-promotion P02 proved the TOTP SECRET survives the copy (a new code
 * verifies at the target). It did not ask whether an already-stepped-up
 * session keeps aal2 through a refresh there. GoTrue records how a session
 * authenticated in auth.mfa_amr_claims, keyed by session - a table the
 * five-table list under test does not include.
 *
 * Two users, same flow, one variable:
 *   S04a  copy the five tables only, refresh the aal2 session at the target
 *   S04b  copy the five plus mfa_amr_claims, same refresh
 *   S04c  control: the S04a session refreshed at the SOURCE keeps aal2
 */
import type { TestModule, TestResult } from "../../../harness/src/types";
import {
  claims,
  copyUser,
  errText,
  host,
  keys,
  newSession,
  refreshSession,
  skipNoPeer,
  sql,
  stepUpToAal2,
  str,
  waitReady,
} from "../lib/carry";

const mod: TestModule = {
  id: "S04",
  title: "aal2 session refreshed at the target",
  where: "local",
  requires: ["pat", "peer"],
  destructive: true,
  async run(ctx) {
    const src = ctx.ref;
    const dst = ctx.peers.target;
    if (!dst) return skipNoPeer("S04", this.title);
    await waitReady(ctx, src);
    await waitReady(ctx, dst);
    const sk = await keys(ctx, src);
    const dk = await keys(ctx, dst);
    if (!sk.anon || !sk.service || !dk.anon) {
      return { id: "S04z", title: "key fetch", status: "fail", detail: "could not read API keys" };
    }
    const results: TestResult[] = [];
    let controlRefresh: string | undefined;

    for (const [id, label, extra] of [
      ["S04a", "five tables only", [] as string[]],
      ["S04b", "five tables + mfa_amr_claims", ["mfa_amr_claims"]],
    ] as const) {
      const s = await newSession(src, { anon: sk.anon, service: sk.service }, id.toLowerCase());
      if ("error" in s) {
        results.push({ id: `${id}z`, title: "source session", status: "fail", detail: s.error });
        continue;
      }
      const up = await stepUpToAal2(src, sk.anon, s);
      if ("error" in up) {
        results.push({ id: `${id}z`, title: "step-up to aal2", status: "fail", detail: up.error });
        continue;
      }
      const amrRows = await sql(
        ctx,
        src,
        `select count(*)::int as n from auth.mfa_amr_claims c join auth.sessions s on s.id = c.session_id where s.user_id = '${s.uid}'`,
      );
      const copy = await copyUser(ctx, src, dst, s.uid, `${id}c0`, [...extra]);
      results.push(...copy.results);
      if (!copy.ok) continue;

      const r = await refreshSession(host(dst), dk.anon, up.refresh);
      const na = str(r.json.access_token);
      const c = na ? claims(na) : {};
      const amr = Array.isArray(c.amr)
        ? (c.amr as Record<string, unknown>[]).map((x) => String(x.method)).join("+")
        : "none";
      results.push({
        id,
        title: `aal after a target refresh of an aal2 session (${label})`,
        status: na ? "info" : "fail",
        detail: na
          ? `source token aal=${String(claims(up.access).aal)}; target-refreshed aal=${String(c.aal)} amr=${amr}`
          : errText(r),
        measurements: {
          status: r.status,
          aal_before: String(claims(up.access).aal ?? "none"),
          aal_after: String(c.aal ?? "none"),
          amr_after: amr,
          source_amr_rows: Number(amrRows.rows?.[0]?.n ?? -1),
        },
      });
      if (id === "S04a") controlRefresh = up.refresh;
    }

    if (controlRefresh) {
      // The same refresh token was already spent at the target, not at the
      // source, so the source sees it unused.
      const r = await refreshSession(host(src), sk.anon, controlRefresh);
      const na = str(r.json.access_token);
      results.push({
        id: "S04c",
        title: "Control: the same aal2 session refreshed at the source keeps aal2",
        status: na && claims(na).aal === "aal2" ? "pass" : "fail",
        detail: na ? `aal=${String(claims(na).aal)}` : errText(r),
        measurements: { status: r.status, aal: String(na ? claims(na).aal : "none") },
      });
    }
    return results;
  },
};
export default mod;
