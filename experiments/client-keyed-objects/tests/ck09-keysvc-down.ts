/**
 * CK09 - With the operator's key service down, do uploads and reads fail
 * closed, does the catalogue and the stored ciphertext stay as it was, and
 * does everything work again after a restart?
 *
 * SIDE: the key service container (stopped with `docker stop`, started with
 * `docker start`) and each target, as the primary tenant's editor (upload) and
 * viewer (read), each call in a FRESH client process (no DEK cached).
 *
 *   before    read of the 64 MiB asset (CK07) succeeds: control
 *   down      upload of the 64 MiB fixture -> KeyServiceUnavailable, no asset
 *             row and no new object under the tenant prefix; read ->
 *             KeyServiceUnavailable
 *   intact    asset and chunk row counts, and the S3 ETag of the stored
 *             object, equal their values from before the stop
 *   after     key service restarted; the same read succeeds
 *
 * Not settled: a process that already holds a DEK keeps decrypting while the
 * service is down (by design of the cache, not measured); a key service that
 * answers slowly rather than not at all.
 * DESTRUCTIVE: stops the run's key service for the duration of the module.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { credsFor, directory, errMsg, http, loadRun, loadState, row, runClient, s3svc, scrub, sh, sleep, type HarnessTarget, type Loaded } from "../lib/ckrun";

async function snapshot(l: Loaded, t: HarnessTarget, tenant: string, assetId: string) {
  const h = { apikey: t.serviceKey, authorization: `Bearer ${t.serviceKey}`, "accept-profile": "app" };
  const a = await http(`${t.client.url}/rest/v1/assets?select=id&tenant_id=eq.${tenant}`, { headers: h });
  const c = await http(`${t.client.url}/rest/v1/asset_chunks?select=idx&asset_id=eq.${assetId}`, { headers: h });
  const s3 = await runClient({
    cmd: "s3ops",
    s3: s3svc(t),
    bucket: t.client.bucket,
    ops: [
      { op: "head", key: `${tenant}/${assetId}/data` },
      { op: "list", prefix: `${tenant}/` },
    ],
  });
  const [head, list] = (s3.result.results ?? []) as { etag?: string; keys?: string[] }[];
  return { assets: JSON.parse(a.body).length as number, chunks: JSON.parse(c.body).length as number, etag: String(head?.etag ?? ""), objects: list?.keys?.length ?? -1, l };
}

const mod: TestModule = {
  id: "CK09",
  title: "Key service down: fail closed, nothing changes, recovery after restart",
  where: "local",
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const l = loadRun(ctx);
    if ("skip" in l) return [{ id: "CK09", title: this.title, status: "skip", detail: l.skip }];
    const out: TestResult[] = [];
    const dir = directory(l);
    const readOne = (t: HarnessTarget, tenant: string, asset: string) =>
      runClient({ cmd: "read-one", directory: dir, creds: credsFor(l, "viewer"), tenant, asset, start: 1000, end: 2_000_000, path: "s3", file: l.run.fixtures.mid.path });
    const ready = l.targets.map((t) => ({ t, st: loadState(l.run, t.name) })).filter((x) => x.st.assets.mid);
    for (const t of l.targets) if (!loadState(l.run, t.name).assets.mid) out.push(row("CK09", t, this.title, "skip", "no 64 MiB asset from CK07 on this target"));
    const per = new Map<string, Record<string, string | number>>();
    const before = new Map<string, Awaited<ReturnType<typeof snapshot>>>();
    for (const { t, st } of ready) {
      const m: Record<string, string | number> = {};
      const r = await readOne(t, st.tenants.primary, st.assets.mid!.id);
      m.before_read = r.result.ok ? (r.result.equal ? "ok" : "WRONG-BYTES") : String(r.result.code);
      before.set(t.name, await snapshot(l, t, st.tenants.primary, st.assets.mid!.id));
      per.set(t.name, m);
    }
    const stop = await sh(["docker", "stop", l.run.keysvc.container]);
    const down = (await http(`${l.run.keysvc.url}/health`)).status;
    try {
      for (const { t, st } of ready) {
        const m = per.get(t.name)!;
        m.keysvc_health_while_stopped = down;
        m.stop_exit = stop.code;
        const up = await runClient({ cmd: "upload", directory: dir, creds: credsFor(l, "editor"), tenant: st.tenants.primary, record: st.records.primary, file: l.run.fixtures.mid.path, method: "s3-multipart" });
        m.down_upload = up.result.ok ? "UPLOADED" : String(up.result.code);
        const rd = await readOne(t, st.tenants.primary, st.assets.mid!.id);
        m.down_read = rd.result.ok ? "READ" : String(rd.result.code);
        const after = await snapshot(l, t, st.tenants.primary, st.assets.mid!.id);
        const b = before.get(t.name)!;
        m.intact_assets = `${b.assets} -> ${after.assets}`;
        m.intact_chunks = `${b.chunks} -> ${after.chunks}`;
        m.intact_objects = `${b.objects} -> ${after.objects}`;
        m.intact_etag = b.etag === after.etag && b.etag ? "same" : "changed";
      }
    } finally {
      await sh(["docker", "start", l.run.keysvc.container]);
      for (let i = 0; i < 30 && (await http(`${l.run.keysvc.url}/health`)).status !== 200; i++) await sleep(1000);
    }
    for (const { t, st } of ready) {
      const m = per.get(t.name)!;
      try {
        const r = await readOne(t, st.tenants.primary, st.assets.mid!.id);
        m.after_read = r.result.ok ? (r.result.equal ? "ok" : "WRONG-BYTES") : String(r.result.code);
        const [ba, aa] = String(m.intact_assets).split(" -> ");
        const [bo, ao] = String(m.intact_objects).split(" -> ");
        const [bc, ac] = String(m.intact_chunks).split(" -> ");
        const ok =
          m.before_read === "ok" &&
          m.down_upload === "KeyServiceUnavailable" &&
          m.down_read === "KeyServiceUnavailable" &&
          ba === aa &&
          bo === ao &&
          bc === ac &&
          m.intact_etag === "same" &&
          m.after_read === "ok";
        out.push(row("CK09", t, this.title, ok ? "pass" : "fail", ok ? "upload and read refused with KeyServiceUnavailable; catalogue and object unchanged; read ok after restart" : `unexpected: ${scrub(l, JSON.stringify(m))}`, m));
      } catch (e) {
        out.push(row("CK09", t, this.title, "fail", `threw: ${scrub(l, errMsg(e))}`, m));
      }
    }
    return out;
  },
};
export default mod;
