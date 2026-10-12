/**
 * CK03 - Does the same owner / editor / viewer / non-member matrix hold on
 * the catalogue AND on storage objects on every target?
 *
 * SIDE: each target; every call made with the actor's own access token (anon
 * key as `apikey`), through the Data API, Storage REST and the S3 endpoint in
 * the session-token form (access key id from the target config, secret = anon
 * key, session token = the actor's JWT). Actors: owner, editor and viewer of
 * the primary tenant; the outsider owns another tenant only.
 *
 * Cells (expected allow for):
 *   rec_select     select records of the primary tenant, rows > 0   owner editor viewer
 *   rec_insert     insert a record                                   owner editor
 *   rec_update     update the primary record's title, rows > 0       owner editor
 *   chunk_select   asset_chunks visible (CK04 not run yet: n/a)      -
 *   mem_insert     add a membership                                  owner
 *   obj_rest_put   POST /object/assets/<tenant>/<x>/data             owner editor
 *   obj_rest_get   GET /object/authenticated/... of the owner's object owner editor viewer
 *   obj_s3_put     S3 PutObject under the tenant prefix              owner editor
 *   obj_s3_get     S3 GetObject of the owner's object                owner editor viewer
 *   obj_wrong_prefix  the outsider writes under the primary prefix   (nobody: outsider only)
 *
 * Pass = every cell matches. Refusal statuses are recorded per cell.
 * DESTRUCTIVE: creates rows and small objects in the run's own data.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { errMsg, http, jsonOr, loadRun, loadState, row, runClient, scrub, signIn } from "../lib/ckrun";

type Actor = "owner" | "editor" | "viewer" | "outsider";
const ACTORS: Actor[] = ["owner", "editor", "viewer", "outsider"];
const EXPECT: Record<string, Actor[]> = {
  rec_select: ["owner", "editor", "viewer"],
  rec_insert: ["owner", "editor"],
  rec_update: ["owner", "editor"],
  mem_insert: ["owner"],
  obj_rest_put: ["owner", "editor"],
  obj_rest_get: ["owner", "editor", "viewer"],
  obj_s3_put: ["owner", "editor"],
  obj_s3_get: ["owner", "editor", "viewer"],
};

const enc = (k: string) => k.split("/").map(encodeURIComponent).join("/");

const mod: TestModule = {
  id: "CK03",
  title: "RLS matrix on catalogue and storage objects",
  where: "local",
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const l = loadRun(ctx);
    if ("skip" in l) return [{ id: "CK03", title: this.title, status: "skip", detail: l.skip }];
    const out: TestResult[] = [];
    for (const t of l.targets) {
      const st = loadState(l.run, t.name);
      const m: Record<string, string | number> = {};
      const wrong: string[] = [];
      try {
        const tok: Record<Actor, string> = {} as Record<Actor, string>;
        for (const a of ACTORS) {
          const s = await signIn(t, st.users[a].email, st.users[a].password);
          if (s.status !== 200) throw new Error(`sign-in ${a}: ${s.status}`);
          tok[a] = s.j.access_token;
        }
        const restH = (a: Actor, extra: Record<string, string> = {}) => ({
          apikey: t.client.anonKey,
          authorization: `Bearer ${tok[a]}`,
          "accept-profile": "app",
          "content-profile": "app",
          "content-type": "application/json",
          ...extra,
        });
        const P = st.tenants.primary;
        // The object every read cell targets, written by the owner.
        const ownerKey = `${P}/${crypto.randomUUID()}/data`;
        const seed = await http(`${t.client.url}/storage/v1/object/${t.client.bucket}/${enc(ownerKey)}`, {
          method: "POST",
          headers: { apikey: t.client.anonKey, authorization: `Bearer ${tok.owner}`, "content-type": "application/octet-stream" },
          body: "owner object",
        });
        if (seed.status !== 200) throw new Error(`owner seed object: ${seed.status} ${seed.body.slice(0, 120)}`);
        const cells: Record<string, Record<Actor, { ok: boolean; s: string }>> = {};
        const put = (cell: string, a: Actor, ok: boolean, s: string) => ((cells[cell] ??= {} as Record<Actor, { ok: boolean; s: string }>)[a] = { ok, s });

        for (const a of ACTORS) {
          let r = await http(`${t.client.url}/rest/v1/records?tenant_id=eq.${P}&select=id`, { headers: restH(a) });
          const n = Array.isArray(jsonOr(r.body)) ? jsonOr(r.body).length : -1;
          put("rec_select", a, r.status === 200 && n > 0, `${r.status}/${n}`);
          r = await http(`${t.client.url}/rest/v1/records`, { method: "POST", headers: restH(a, { prefer: "return=minimal" }), body: JSON.stringify({ tenant_id: P, title: `by ${a}` }) });
          put("rec_insert", a, r.status === 201, `${r.status}${r.status >= 400 ? ` ${jsonOr(r.body)?.code ?? ""}` : ""}`);
          r = await http(`${t.client.url}/rest/v1/records?id=eq.${st.records.primary}`, { method: "PATCH", headers: restH(a, { prefer: "return=representation" }), body: JSON.stringify({ title: `record-primary (${a})` }) });
          const un = Array.isArray(jsonOr(r.body)) ? jsonOr(r.body).length : -1;
          put("rec_update", a, r.status === 200 && un > 0, `${r.status}/${un}`);
          r = await http(`${t.client.url}/rest/v1/memberships`, {
            method: "POST",
            headers: restH(a, { prefer: "return=minimal" }),
            body: JSON.stringify({ tenant_id: P, user_id: st.users.outsider.id, role: "viewer" }),
          });
          put("mem_insert", a, r.status === 201, `${r.status}${r.status >= 400 ? ` ${jsonOr(r.body)?.code ?? ""}` : ""}`);
          if (r.status === 201) {
            // Undo at once so later cells still see the outsider as a non-member.
            await http(`${t.client.url}/rest/v1/memberships?tenant_id=eq.${P}&user_id=eq.${st.users.outsider.id}`, {
              method: "DELETE",
              headers: { apikey: t.serviceKey, authorization: `Bearer ${t.serviceKey}`, "accept-profile": "app", "content-profile": "app" },
            });
          }
          const k = `${P}/${crypto.randomUUID()}/data`;
          r = await http(`${t.client.url}/storage/v1/object/${t.client.bucket}/${enc(k)}`, {
            method: "POST",
            headers: { apikey: t.client.anonKey, authorization: `Bearer ${tok[a]}`, "content-type": "application/octet-stream" },
            body: `rest put by ${a}`,
          });
          put("obj_rest_put", a, r.status === 200, `${r.status}`);
          r = await http(`${t.client.url}/storage/v1/object/authenticated/${t.client.bucket}/${enc(ownerKey)}`, { headers: { apikey: t.client.anonKey, authorization: `Bearer ${tok[a]}` } });
          put("obj_rest_get", a, r.status === 200 && r.body === "owner object", `${r.status}`);
          const s3 = await runClient({
            cmd: "s3ops",
            s3: { endpoint: t.client.s3.endpoint, region: t.client.s3.region, accessKeyId: t.client.s3.accessKeyId, secretAccessKey: t.client.anonKey, sessionToken: tok[a] },
            bucket: t.client.bucket,
            ops: [
              { op: "put", key: `${P}/${crypto.randomUUID()}/data`, text: `s3 put by ${a}` },
              { op: "get", key: ownerKey },
            ],
          });
          const [sp, sg] = (s3.result.results ?? []) as { ok: boolean; status: number; code?: string; bytes?: number }[];
          put("obj_s3_put", a, !!sp?.ok, `${sp?.status ?? 0}${sp?.ok ? "" : ` ${sp?.code ?? s3.result.code ?? ""}`}`);
          put("obj_s3_get", a, !!sg?.ok && sg.bytes === 12, `${sg?.status ?? 0}${sg?.ok ? "" : ` ${sg?.code ?? ""}`}`);
        }
        for (const [cell, by] of Object.entries(cells)) {
          for (const a of ACTORS) {
            const got = by[a]!;
            m[`${cell}.${a}`] = `${got.ok ? "allow" : "deny"} ${got.s}`;
            if (got.ok !== (EXPECT[cell] ?? []).includes(a)) wrong.push(`${cell}.${a}=${got.ok ? "allow" : "deny"}`);
          }
        }
        out.push(row("CK03", t, "RLS matrix", wrong.length ? "fail" : "pass", wrong.length ? `unexpected: ${wrong.join(", ")}` : `${Object.keys(cells).length} cells x 4 actors as expected`, m));
      } catch (e) {
        out.push(row("CK03", t, "RLS matrix", "fail", `threw: ${scrub(l, errMsg(e))}`, m));
      }
    }
    return out;
  },
};
export default mod;
