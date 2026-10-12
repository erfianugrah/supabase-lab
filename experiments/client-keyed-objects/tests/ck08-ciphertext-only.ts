/**
 * CK08 - Does the platform hold ciphertext only: no plaintext in the object
 * store, no DEK or KEK in Postgres? And what does storage.objects.metadata
 * record about an encrypted object?
 *
 * SIDE: each target. Every fixture MiB starts with the ASCII marker
 * `CK-PLAINTEXT-MARKER-`. A positive control (the first MiB of the 64 MiB
 * fixture, uploaded UNENCRYPTED with service S3 credentials) must be found by
 * the same scan, or a zero would mean nothing.
 *
 *   api_scan       every object under the primary tenant prefix read back
 *                  through S3 GetObject with service credentials and scanned
 *                  for the marker (all targets; this is what the platform
 *                  serves, not a view of its disks). The 2 GiB objects are
 *                  counted during CK04/CK05's full read of the same bytes
 *                  instead of a second download.
 *   backend_scan   self-hosted only: the storage backend's own bytes (the
 *                  MinIO data volume, or the file backend's directory) grepped
 *                  for the marker from a throwaway container. Managed: no
 *                  access to the backend; recorded as not measurable.
 *   pg_scan        every row of every table in schemas app, storage, auth and
 *                  public cast to text and searched for the 64 MiB asset's DEK
 *                  (hex and base64, fetched from the key service as the viewer)
 *                  and the primary tenant's KEK (hex and base64, from the
 *                  run's gitignored key file). Expected 0 hits; the
 *                  `wrapped_dek` column is the control that the scan reads app.assets.
 *   metadata       keys and values of storage.objects.metadata for the
 *                  encrypted 64 MiB object.
 *
 * Not settled: Postgres WAL, backups, logs, or anything outside the four
 * schemas; the managed object store's disks.
 * DESTRUCTIVE: uploads one 1 MiB plaintext control object.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { errMsg, http, loadRun, MARKER, loadState, row, runClient, s3svc, scrub, sh, signIn, sqlRows, type HarnessTarget } from "../lib/ckrun";


async function backendScan(t: HarnessTarget): Promise<{ files: number; hits: string[] } | string> {
  if (t.kind !== "compose") return "not measurable (no access to the managed object store)";
  const c = t.compose!;
  const mount = c.backend === "s3" ? `${c.stackDir}/volumes/minio:/data:ro` : `${c.project}_storage-data:/data:ro`;
  // grep -c prints one line per file; keep files with a non-zero count.
  const r = await sh(["docker", "run", "--rm", "-v", mount, "oven/bun:1.3-alpine", "sh", "-c", `find /data -type f | wc -l; grep -r -a -c -F '${MARKER}' /data | grep -v ':0$' || true`], { timeoutMs: 900_000 });
  if (r.code) return `scan failed: ${r.err.slice(0, 200)}`;
  const [n, ...hits] = r.out.trim().split("\n");
  return { files: Number(n), hits: hits.filter(Boolean) };
}

const mod: TestModule = {
  id: "CK08",
  title: "Ciphertext only: object store and Postgres scanned for plaintext and keys",
  where: "local",
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const l = loadRun(ctx);
    if ("skip" in l) return [{ id: "CK08", title: this.title, status: "skip", detail: l.skip }];
    const out: TestResult[] = [];
    const keks = JSON.parse(readFileSync(join(l.run.keysvc.configDir, "keks.json"), "utf8")) as Record<string, { kek_b64: string }>;
    for (const t of l.targets) {
      const st = loadState(l.run, t.name);
      const m: Record<string, string | number> = {};
      const problems: string[] = [];
      try {
        const P = st.tenants.primary;
        const svc = (ops: Record<string, unknown>[]) => runClient({ cmd: "s3ops", s3: s3svc(t), bucket: t.client.bucket, ops }, { timeoutMs: 3_600_000 });
        // Positive control: 1 MiB of plaintext, unencrypted.
        const ctl = `${P}/control-${crypto.randomUUID()}/plain`;
        const ctlFile = join(l.run.dir, "control.bin");
        await Bun.write(ctlFile, new Uint8Array(await Bun.file(l.run.fixtures.mid.path).slice(0, 1024 * 1024).arrayBuffer()));
        await svc([{ op: "put", key: ctl, file: ctlFile }]);
        const list = await svc([{ op: "list", prefix: `${P}/` }]);
        const keys = (list.result.results?.[0]?.keys ?? []) as string[];
        // Objects whose whole ciphertext a full read already scanned (CK04/CK05)
        // are not downloaded again; their counts come from the state file.
        const scanned = new Map(Object.values(st.assets).filter((a) => a.markerHits !== undefined).map((a) => [`${a.tenant}/${a.id}/data`, a.markerHits!]));
        const scan = await svc(keys.filter((k) => !scanned.has(k)).map((k) => ({ op: "get", key: k, needle: MARKER })));
        let encHits = [...scanned.entries()].filter(([k]) => keys.includes(k)).reduce((n, [, h]) => n + h, 0);
        let encBytes = 0;
        let ctlHits = -1;
        m.api_scan_objects_counted_during_full_read = [...scanned.keys()].filter((k) => keys.includes(k)).length;
        for (const r of (scan.result.results ?? []) as { key: string; ok: boolean; bytes?: number; needleHits?: number }[]) {
          if (r.key === ctl) ctlHits = r.needleHits ?? -1;
          else {
            encHits += r.needleHits ?? 0;
            encBytes += r.bytes ?? 0;
          }
        }
        m.api_scan_objects = keys.length;
        m.api_scan_bytes_downloaded_excluding_control = encBytes;
        m.api_scan_marker_hits_excluding_control = encHits;
        m.api_scan_control_hits = ctlHits;
        if (encHits !== 0 || ctlHits < 1) problems.push("api_scan");

        const b = await backendScan(t);
        if (typeof b === "string") m.backend_scan = b;
        else {
          m.backend_scan_files = b.files;
          m.backend_scan_files_with_marker = b.hits.length;
          m.backend_scan_hits = b.hits.map((h) => h.replace(/^\/data\//, "").replace(/[0-9a-f-]{36}/g, "<uuid>")).join(" ; ").slice(0, 300);
          // Only the control object's files may carry the marker, and they must.
          const ctlDir = ctl.split("/")[1]!;
          if (!b.hits.length || b.hits.some((h) => !h.includes(ctlDir))) problems.push("backend_scan");
        }

        // DEK of the 64 MiB asset, as the viewer would get it.
        const mid = st.assets.mid;
        const needles: Record<string, string> = {};
        const kek = Buffer.from(keks[P]!.kek_b64, "base64");
        needles.kek_hex = kek.toString("hex");
        needles.kek_b64 = kek.toString("base64");
        if (mid) {
          const vs = await signIn(t, st.users.viewer.email, st.users.viewer.password);
          const a = await http(`${t.client.url}/rest/v1/assets?id=eq.${mid.id}&select=wrapped_dek`, {
            headers: { apikey: t.client.anonKey, authorization: `Bearer ${vs.j.access_token}`, "accept-profile": "app" },
          });
          const wrapped = JSON.parse(a.body)[0]?.wrapped_dek as string;
          const u = await http(`${l.run.keysvc.url}/unwrap`, {
            method: "POST",
            headers: { authorization: `Bearer ${vs.j.access_token}`, "content-type": "application/json" },
            body: JSON.stringify({ tenant_id: P, wrapped }),
          });
          const dek = Buffer.from(JSON.parse(u.body).dek as string, "base64");
          needles.dek_hex = dek.toString("hex");
          needles.dek_b64 = dek.toString("base64");
          needles.control_wrapped_dek = wrapped;
        }
        for (const [name, needle] of Object.entries(needles)) {
          const rows = await sqlRows(
            ctx,
            t,
            `select table_schema || '.' || table_name as t,
                    (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I x where x::text like %L', table_schema, table_name, '%' || ${`'${needle.replace(/'/g, "''")}'`} || '%'), false, true, '')))[1]::text::int as hits
               from information_schema.tables
              where table_schema in ('app', 'storage', 'auth', 'public') and table_type = 'BASE TABLE'
                and has_table_privilege(format('%I.%I', table_schema, table_name), 'select')`,
          );
          const hit = rows.filter((r) => Number(r.hits) > 0).map((r) => `${r.t}:${r.hits}`);
          m[`pg_scan.${name}`] = hit.length ? hit.join(" ") : "0";
          m.pg_scan_tables = rows.length;
          if (name === "control_wrapped_dek" ? !hit.some((h) => h.startsWith("app.assets")) : hit.length) problems.push(`pg_scan ${name}`);
        }
        if (mid) {
          const md = await sqlRows(ctx, t, `select metadata, user_metadata from storage.objects where bucket_id = 'assets' and name = '${P}/${mid.id}/data'`);
          const meta = (md[0]?.metadata ?? {}) as Record<string, unknown>;
          m.metadata_keys = Object.keys(meta).sort().join(",");
          for (const k of ["mimetype", "size", "contentLength", "cacheControl", "httpStatusCode"]) if (meta[k] !== undefined) m[`metadata.${k}`] = String(meta[k]);
          m.metadata_etag_shape = String(meta.eTag ?? "").replace(/[0-9a-f]{32}/, "<md5>");
          m.user_metadata = JSON.stringify(md[0]?.user_metadata ?? null);
        }
        out.push(row("CK08", t, this.title, problems.length ? "fail" : "pass", problems.length ? `failed: ${problems.join(", ")}` : `no marker outside the control; no DEK or KEK in ${m.pg_scan_tables} tables`, m));
      } catch (e) {
        out.push(row("CK08", t, this.title, "fail", `threw: ${scrub(l, errMsg(e))}`, m));
      }
    }
    return out;
  },
};
export default mod;
