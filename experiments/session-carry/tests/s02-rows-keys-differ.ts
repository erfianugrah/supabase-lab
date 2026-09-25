/**
 * S02 - rows copied, signing keys necessarily different: the held session at
 * the target before and after its first refresh.
 *
 * S01 established that the two projects cannot share a kid, so this is the
 * shape a hosted cross-project move actually gets. A session is created at
 * the source, its rows are copied in FK order, and the tokens the browser
 * ALREADY holds are presented to the target:
 *
 *   S02a  target Auth /user with the un-refreshed source access token
 *   S02b  target PostgREST with the same token
 *   S02c  refresh at the target with the held refresh token
 *   S02d  iss moves from the source to the target on that refresh
 *   S02e  the refreshed token works at target Auth /user
 *
 * S02a/b measure the "one access-token lifetime" window: whether the
 * access token the browser holds at cutover is usable at all before a refresh.
 */
import type { TestModule, TestResult } from "../../../harness/src/types";
import {
  authReq,
  claims,
  copyUser,
  errText,
  host,
  keys,
  newSession,
  refreshSession,
  restRead,
  skipNoPeer,
  str,
  waitReady,
} from "../lib/carry";

const mod: TestModule = {
  id: "S02",
  title: "Rows copied, keys differ: held session at the target",
  where: "local",
  requires: ["pat", "peer"],
  destructive: true,
  async run(ctx) {
    const src = ctx.ref;
    const dst = ctx.peers.target;
    if (!dst) return skipNoPeer("S02", this.title);
    await waitReady(ctx, src);
    await waitReady(ctx, dst);
    const sk = await keys(ctx, src);
    const dk = await keys(ctx, dst);
    if (!sk.anon || !sk.service || !dk.anon) {
      return { id: "S02z", title: "key fetch", status: "fail", detail: "could not read API keys" };
    }
    const s = await newSession(src, { anon: sk.anon, service: sk.service }, "s02");
    if ("error" in s) return { id: "S02z", title: "source session", status: "fail", detail: s.error };

    const copy = await copyUser(ctx, src, dst, s.uid, "S02c0");
    const results: TestResult[] = [...copy.results];
    if (!copy.ok) return results;

    const u = await authReq(dst, "GET", "/user", dk.anon, s.access);
    results.push({
      id: "S02a",
      title: "Target Auth /user with the held (un-refreshed) source access token",
      status: "info",
      detail: errText(u),
      measurements: { status: u.status, error_code: String(u.json.error_code ?? "none") },
    });

    const rest = await restRead(host(dst), dk.anon, s.access, "rpc/nonexistent_probe");
    results.push({
      id: "S02b",
      title: "Target PostgREST with the held source access token",
      status: "info",
      detail: `HTTP ${rest.status} code=${rest.code ?? "none"}`,
      measurements: { status: rest.status, code: rest.code ?? "none" },
    });

    const r = await refreshSession(host(dst), dk.anon, s.refresh);
    const na = str(r.json.access_token);
    results.push({
      id: "S02c",
      title: "Held refresh token mints a session at the target",
      status: na ? "pass" : "fail",
      detail: errText(r),
      measurements: { status: r.status, error_code: String(r.json.error_code ?? "none") },
    });
    if (!na) return results;

    const before = String(claims(s.access).iss ?? "");
    const after = String(claims(na).iss ?? "");
    results.push({
      id: "S02d",
      title: "iss moves from the source to the target on the first target refresh",
      status: before.includes(src) && after.includes(dst) ? "pass" : "fail",
      detail: `before=${before.includes(src) ? "source" : "other"} after=${after.includes(dst) ? "target" : after.includes(src) ? "source" : "other"}`,
    });

    const u2 = await authReq(dst, "GET", "/user", dk.anon, na);
    results.push({
      id: "S02e",
      title: "Refreshed token is accepted by target Auth /user",
      status: u2.status === 200 && u2.json.id === s.uid ? "pass" : "fail",
      detail: u2.status === 200 ? "HTTP 200, same user id" : errText(u2),
      measurements: { status: u2.status },
    });
    return results;
  },
};
export default mod;
