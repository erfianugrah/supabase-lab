/**
 * CK10 - Is a tenant pinned to its region: does the other region refuse a
 * token it did not issue, and does it hold nothing of the tenant?
 *
 * SIDE: two managed projects (region-a ap-southeast-1, region-b eu-central-1)
 * in the same run; each direction tested (a's owner against b, and b's owner
 * against a). Only runs with two or more targets; a single-target run skips.
 *
 *   auth_user     GET <other>/auth/v1/user with the foreign token
 *   data_api      GET <other>/rest/v1/records (schema app) with the foreign token
 *   storage_rest  GET <other>/storage/v1/object/authenticated/<home object key>
 *   storage_s3    S3 GetObject on <other> in the session-token form with the
 *                 foreign token (other's access key id and anon key)
 *   object_absent HEAD of the home object key on <other> with service credentials
 *   keysvc        unwrap of the home asset's DEK with the OTHER region's owner
 *                 token (the key service pins the issuer per tenant)
 *
 * Pass = every cell refused / absent.
 * Not settled: replication or backups across regions (not visible to an API
 * client); network-level isolation.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { errMsg, http, loadRun, loadState, row, runClient, s3svc, scrub, shape, signIn } from "../lib/ckrun";

const mod: TestModule = {
  id: "CK10",
  title: "Region isolation between two projects",
  where: "local",
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const l = loadRun(ctx);
    if ("skip" in l) return [{ id: "CK10", title: this.title, status: "skip", detail: l.skip }];
    if (l.targets.length < 2) return l.targets.map((t) => row("CK10", t, this.title, "skip", "needs two regions in one run (managed run only)"));
    const out: TestResult[] = [];
    for (const home of l.targets) {
      for (const other of l.targets) {
        if (home === other) continue;
        const m: Record<string, string | number> = { home: home.name, other: other.name };
        try {
          const hs = loadState(l.run, home.name);
          const os = loadState(l.run, other.name);
          const tok = (await signIn(home, hs.users.owner.email, hs.users.owner.password)).j.access_token as string;
          const otherTok = (await signIn(other, os.users.owner.email, os.users.owner.password)).j.access_token as string;
          const a = hs.assets.mid ?? hs.assets.big_s3;
          if (!a) throw new Error("no home asset");
          const key = `${a.tenant}/${a.id}/data`;
          const fmt = (r: Awaited<ReturnType<typeof http>>) => {
            const s = shape(r);
            return `${s.status} ${s.code}`;
          };
          const refused: Record<string, boolean> = {};
          let r = await http(`${other.client.url}/auth/v1/user`, { headers: { apikey: other.client.anonKey, authorization: `Bearer ${tok}` } });
          m.auth_user = fmt(r);
          refused.auth_user = r.status >= 400;
          r = await http(`${other.client.url}/rest/v1/records?select=id`, { headers: { apikey: other.client.anonKey, authorization: `Bearer ${tok}`, "accept-profile": "app" } });
          m.data_api = fmt(r);
          refused.data_api = r.status >= 400;
          r = await http(`${other.client.url}/storage/v1/object/authenticated/${other.client.bucket}/${key}`, { headers: { apikey: other.client.anonKey, authorization: `Bearer ${tok}` } });
          m.storage_rest = fmt(r);
          refused.storage_rest = r.status >= 400;
          const s3u = await runClient({
            cmd: "s3ops",
            s3: { endpoint: other.client.s3.endpoint, region: other.client.s3.region, accessKeyId: other.client.s3.accessKeyId, secretAccessKey: other.client.anonKey, sessionToken: tok },
            bucket: other.client.bucket,
            ops: [{ op: "get", key }],
          });
          const g = s3u.result.results?.[0] ?? {};
          m.storage_s3 = g.ok ? `200 READ` : `${g.status} ${g.code}`;
          refused.storage_s3 = !g.ok;
          const s3s = await runClient({ cmd: "s3ops", s3: s3svc(other), bucket: other.client.bucket, ops: [{ op: "head", key }] });
          const h = s3s.result.results?.[0] ?? {};
          m.object_absent = h.ok ? "PRESENT" : `${h.status} ${h.code}`;
          refused.object_absent = !h.ok && Number(h.status) === 404;
          const ar = await http(`${home.client.url}/rest/v1/assets?id=eq.${a.id}&select=wrapped_dek`, { headers: { apikey: home.client.anonKey, authorization: `Bearer ${tok}`, "accept-profile": "app" } });
          const wrapped = JSON.parse(ar.body)[0]?.wrapped_dek;
          r = await http(`${l.run.keysvc.url}/unwrap`, { method: "POST", headers: { authorization: `Bearer ${otherTok}`, "content-type": "application/json" }, body: JSON.stringify({ tenant_id: a.tenant, wrapped }) });
          m.keysvc = fmt(r);
          refused.keysvc = r.status === 401 || r.status === 403;
          const leak = Object.entries(refused).filter(([, v]) => !v).map(([k]) => k);
          out.push({ ...row("CK10", home, this.title, leak.length ? "fail" : "pass", leak.length ? `not refused on ${other.name}: ${leak.join(", ")}` : `${other.name} refused ${home.name}'s token on Auth, Data API, Storage REST and S3; object absent; key service refused ${other.name}'s token`, m), id: `CK10-${home.name}-to-${other.name}` });
        } catch (e) {
          out.push({ ...row("CK10", home, this.title, "fail", `threw: ${scrub(l, errMsg(e))}`, m), id: `CK10-${home.name}-to-${other.name}` });
        }
      }
    }
    return out;
  },
};
export default mod;
