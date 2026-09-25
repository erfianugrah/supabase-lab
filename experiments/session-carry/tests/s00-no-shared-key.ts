/**
 * S00 - negative control: before any key is shared, the target refuses the
 * source's access token.
 *
 * S01 claims the target accepts a source-issued token BECAUSE both projects
 * sign with the same imported key. That claim is only interpretable if the
 * same kind of token, presented the same way, is refused while the keys
 * differ - otherwise "accepted" could mean "not checking". So this runs first,
 * and if the two projects already agree on a kid (a re-run against a pair S01
 * has already configured) it reports skip rather than a meaningless pass.
 */
import type { TestModule, TestResult } from "../../../harness/src/types";
import {
  authReq,
  errText,
  header,
  keys,
  newSession,
  restRead,
  sharedInUseKid,
  skipNoPeer,
  waitReady,
  host,
} from "../lib/carry";

const mod: TestModule = {
  id: "S00",
  title: "Control: without a shared key the target refuses the source's token",
  where: "local",
  requires: ["pat", "peer"],
  destructive: true, // creates a user on the source
  async run(ctx) {
    const src = ctx.ref;
    const dst = ctx.peers.target;
    if (!dst) return skipNoPeer("S00", this.title);
    await waitReady(ctx, src);
    await waitReady(ctx, dst);

    const already = await sharedInUseKid(ctx, src, dst);
    if (already) {
      return {
        id: "S00",
        title: this.title,
        status: "skip",
        detail: `both projects already sign with kid ${already.slice(0, 8)} - control cannot be established on this pair`,
      };
    }

    const sk = await keys(ctx, src);
    const dk = await keys(ctx, dst);
    if (!sk.anon || !sk.service || !dk.anon) {
      return { id: "S00z", title: "key fetch", status: "fail", detail: "could not read API keys" };
    }
    const s = await newSession(src, { anon: sk.anon, service: sk.service }, "s00");
    if ("error" in s) return { id: "S00z", title: "source session", status: "fail", detail: s.error };

    const results: TestResult[] = [];
    const h = header(s.access);
    const rest = await restRead(host(dst), dk.anon, s.access, "rpc/nonexistent_probe");
    // PostgREST checks the JWT before resolving the route, so a 401 here is
    // about the token; a 404 would mean the token was accepted.
    results.push({
      id: "S00a",
      title: "Target PostgREST refuses a source token signed with a key it does not hold",
      status: rest.status === 401 ? "pass" : "fail",
      detail: `HTTP ${rest.status} code=${rest.code ?? "none"} (token alg=${String(h.alg)})`,
      measurements: { status: rest.status, code: rest.code ?? "none", alg: String(h.alg ?? "none") },
      evidence: rest.text.slice(0, 200),
    });

    const u = await authReq(dst, "GET", "/user", dk.anon, s.access);
    results.push({
      id: "S00b",
      title: "Target Auth /user refuses the same token",
      status: u.status >= 400 ? "pass" : "fail",
      detail: errText(u),
      measurements: { status: u.status, error_code: String(u.json.error_code ?? "none") },
    });
    return results;
  },
};
export default mod;
