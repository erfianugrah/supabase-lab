/**
 * SS12 - self-hosted only: does deleting an object free the backend's space?
 *
 * The 2026-10-12 SS03 runs left several GB in the MinIO data directory after
 * the module's deletes (operator note, not measured). SS12 measures it per
 * delete path on whichever self-hosted stack is up (`make probe-sh
 * SHMODS=SS12`): the s3 backend (MinIO, data on the `minio-hostdir` bind mount,
 * read from the host) or the file backend (read with `find` inside the storage
 * container). The backend's files are listed after every step, and the bytes
 * under each test key's path are reported, so a version left behind shows by
 * key.
 *
 * Steps, 64 MiB objects (seeded fixtures r1, r2 from canary/ss11.ts):
 *   s1  five objects k1-k5 by S3 PutObject
 *   s2  k1 REST DELETE
 *   s3  k2 S3 DeleteObject
 *   s4  k3 REST upsert with other bytes (x-upsert: true)
 *   s5  k5 S3 PutObject over the existing key with other bytes
 *   s6  k4 SQL delete (storage.allow_delete_query = 'true')
 *   s7  a multipart upload k6 left open after 3 x 16 MiB parts, then aborted
 *   s8  a TUS upload k7 SIGKILLed after 3 x 6 MiB chunks, then a TUS DELETE
 *   s9  the bucket emptied (POST /bucket/<id>/empty) and deleted
 * Listings at +0 s and +15 s after each step (+60 s after s4 and s9, where a
 * background job may do the work); every label carries `t=` seconds since s0.
 * Then a tail: a listing every 10 s for up to 10 minutes
 * (PVLAB_ENDPOINT_SS12_TAIL_MIN), stopping once MinIO's `.minio.sys/tmp`
 * (where deleted data was seen to wait, development run 2026-10-23) holds
 * under 1 MiB, or the file backend total stops changing for a minute.
 *
 * The preflight row is the same 1 KiB upload SS03_target makes; on the file
 * backend's default bind mount on Docker Desktop for macOS it failed on
 * 2026-10-12, and the module stops there if it fails again.
 *
 * DESTRUCTIVE (local only): one bucket, the storage service re-created with a
 * raised FILE_SIZE_LIMIT; `make clean` in self-hosted-defaults removes it all.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { canary, raiseStackLimit, shell, sleep, stackOf, stackSql, stackTarget, storageContainer, tusChild } from "../lib";

const FIX_DIR = new URL("../evidence/fixtures/", import.meta.url).pathname;
const MiB = 1024 * 1024;
const BUCKET = "reclaim";

interface F {
  path: string;
  size: number;
}

function walk(root: string): F[] {
  const out: F[] = [];
  const rec = (d: string) => {
    let ents;
    try {
      ents = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = join(d, e.name);
      if (e.isDirectory()) rec(p);
      else if (e.isFile()) {
        try {
          out.push({ path: p.slice(root.length), size: statSync(p).size });
        } catch {
          /* gone between readdir and stat */
        }
      }
    }
  };
  rec(root);
  return out;
}

async function fileBackendFiles(root: string): Promise<F[]> {
  const r = await shell(["docker", "exec", "supabase-storage", "sh", "-c", `find ${root} -type f -exec stat -c '%s %n' {} +`]);
  return r.out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf(" ");
      return { size: Number(l.slice(0, i)), path: l.slice(i + 1).slice(root.length) };
    });
}

const mib = (b: number) => Math.round((b / MiB) * 10) / 10;

const mod: TestModule = {
  id: "SS12",
  title: "Self-hosted: backend bytes after each delete path (file or MinIO)",
  where: "local",
  requires: [],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const stack = stackOf(ctx);
    if (!stack) return [{ id: "SS12", title: this.title, status: "skip", detail: "no self-hosted stack (PVLAB_ENDPOINT_STACK_DIR/GW); make probe-sh SHMODS=SS12" }];
    const out: TestResult[] = [];
    const sc = await storageContainer();
    if (!sc) return [{ id: "SS12", title: this.title, status: "skip", detail: "supabase-storage container not running" }];
    const t = stackTarget(stack, sc.backend, sc.image);
    const gw = t.hosts[0]!;
    const svc = { apikey: t.service, authorization: `Bearer ${t.service}` };
    const setup: Record<string, string | number> = { kind: t.kind, storage_image: sc.image };
    const insp = await shell(["docker", "inspect", "supabase-storage", "--format", "{{range .Mounts}}{{.Type}}:{{.Destination}} {{end}}|{{range .Config.Env}}{{println .}}{{end}}"]);
    const [mounts, envs] = insp.out.split("|");
    const fileRoot = (envs ?? "").split("\n").find((l) => l.startsWith("FILE_STORAGE_BACKEND_PATH="))?.split("=")[1] ?? "/var/lib/storage";
    setup.storage_mounts = (mounts ?? "").trim();
    const minioDir = join(stack.dir, "volumes", "minio");
    const list = async (): Promise<F[]> => (sc.backend === "s3" ? walk(minioDir) : fileBackendFiles(fileRoot));
    setup.measured_at = sc.backend === "s3" ? "host bind mount volumes/minio" : `find inside supabase-storage at ${fileRoot}`;
    if (sc.backend === "s3") {
      const mv = await shell(["sh", "-c", "docker exec $(docker ps -qf name=minio | head -1) minio --version | head -1"]);
      setup.minio_version = mv.out.trim().replace(/^minio version /, "").slice(0, 80) || "unknown";
    }
    try {
      const mk = await fetch(`${gw.rest}/bucket`, { method: "POST", headers: { ...svc, "content-type": "application/json" }, body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false }) });
      setup.create_bucket = mk.status;
      const pf = await canary("upload.ts", { target: t, cmd: "preflight", host: gw.name, bucket: BUCKET });
      setup.preflight_s3_put_1KiB = pf.s3;
      setup.preflight_rest_post_1KiB = pf.rest;
      if (!pf.ok) {
        out.push({ id: "SS12_setup", title: "target and preflight", status: "info", detail: "preflight refused on S3 and REST; steps not run", measurements: setup });
        return out;
      }
      const fx = await canary("ss11.ts", { cmd: "fixtures", dir: FIX_DIR });
      const lim = await raiseStackLimit(10 * 1024 * MiB);
      setup.raise_limit = lim.detail;
      out.push({ id: "SS12_setup", title: "target and preflight", status: "info", detail: t.kind, measurements: setup });

      const m: Record<string, string | number> = { object_mib: 64 };
      const keys = ["k1", "k2", "k3", "k4", "k5", "k6", "k7"].map((k) => `ss12/${k}.bin`);
      const t0 = Date.now();
      let lastTrash = 0;
      const snap = async (label: string) => {
        const fs = await list();
        const total = fs.reduce((a, f) => a + f.size, 0);
        const perKey = keys
          .map((k, i) => {
            const fk = fs.filter((f) => f.path.includes(k));
            return fk.length ? `k${i + 1}=${mib(fk.reduce((a, f) => a + f.size, 0))}MiB/${fk.length}f` : "";
          })
          .filter(Boolean)
          .join(" ");
        const sys = sc.backend === "s3" ? fs.filter((f) => f.path.includes(".minio.sys")) : [];
        const mp = sys.filter((f) => f.path.includes("multipart"));
        const trash = sys.filter((f) => f.path.includes(".trash") || f.path.includes("/tmp/"));
        lastTrash = trash.reduce((a, f) => a + f.size, 0);
        m[label] = `t=${Math.round((Date.now() - t0) / 1000)}s total=${mib(total)}MiB files=${fs.length}${sc.backend === "s3" ? ` minio.sys/multipart=${mib(mp.reduce((a, f) => a + f.size, 0))}MiB minio.sys/tmp+trash=${mib(trash.reduce((a, f) => a + f.size, 0))}MiB` : ""}${perKey ? ` | ${perKey}` : ""}`;
        return total;
      };
      const settle = async (label: string, waits: number[]) => {
        let el = 0;
        for (const w of waits) {
          await sleep((w - el) * 1000);
          el = w;
          await snap(`${label}_+${w}s`);
        }
      };
      const base = await snap("s0_baseline");
      // s1
      for (const [i, k] of keys.slice(0, 5).entries()) {
        const r = await canary("upload.ts", { target: t, cmd: "put-file", host: gw.name, bucket: BUCKET, key: k, path: fx.r1.path });
        m[`s1_put_k${i + 1}`] = `${r.status} ${r.code || "ok"}`;
      }
      await snap("s1_after_5_puts");
      // s2 REST delete
      const d1 = await fetch(`${gw.rest}/object/${BUCKET}/${keys[0]}`, { method: "DELETE", headers: svc });
      m.s2_rest_delete_k1 = d1.status;
      await settle("s2", [0, 15]);
      // s3 S3 delete
      const d2 = await canary("ss11.ts", { target: t, cmd: "s3-delete", host: gw.name, bucket: BUCKET, key: keys[1] });
      m.s3_s3_delete_k2 = `${d2.status} ${d2.code || "ok"}`;
      await settle("s3", [0, 15]);
      // s4 REST upsert
      const up = await fetch(`${gw.rest}/object/${BUCKET}/${keys[2]}`, { method: "POST", headers: { ...svc, "content-type": "application/octet-stream", "x-upsert": "true" }, body: Bun.file(fx.r2.path) });
      m.s4_rest_upsert_k3 = up.status;
      await up.text();
      await settle("s4", [0, 15, 60]);
      // s5 S3 overwrite
      const ow = await canary("upload.ts", { target: t, cmd: "put-file", host: gw.name, bucket: BUCKET, key: keys[4], path: fx.r2.path });
      m.s5_s3_overwrite_k5 = `${ow.status} ${ow.code || "ok"}`;
      await settle("s5", [0, 15]);
      // s6 SQL delete
      const q = await stackSql(`set storage.allow_delete_query = 'true'; delete from storage.objects where bucket_id = '${BUCKET}' and name = '${keys[3]}'`);
      m.s6_sql_delete_k4 = q.ok ? `ok ${q.rows.flat().join(" ")}`.trim() : `err ${q.err}`;
      await settle("s6", [0, 15]);
      // s7 multipart left open, then aborted
      const ab = await canary("ss11.ts", { target: t, cmd: "mpu-abandon", host: gw.name, bucket: BUCKET, key: keys[5], parts: 3, fx: fx.huge });
      m.s7_mpu_open = ab.ok ? `${ab.parts} parts` : `${ab.status} ${ab.code}`;
      await snap("s7_open");
      if (ab.uploadId) {
        const a = await canary("ss11.ts", { target: t, cmd: "mpu-abort", host: gw.name, bucket: BUCKET, key: keys[5], uploadId: ab.uploadId });
        m.s7_abort = `${a.status} ${a.code || "ok"}`;
      }
      await settle("s7_aborted", [0, 15]);
      // s8 TUS killed, then terminated
      const tusHeaders = { authorization: `Bearer ${t.service}`, apikey: t.service, "x-upsert": "true" };
      const k = await tusChild({ endpoint: `${gw.rest}/upload/resumable`, file: fx.r1.path, size: fx.r1.size, chunkSize: 6 * MiB, headers: tusHeaders, bucket: BUCKET, key: keys[6] }, 3);
      const url = k.lines.filter((l) => l.url).at(-1)?.url ?? "";
      m.s8_tus_killed_after_chunks = k.lines.filter((l) => l.chunk).length;
      await snap("s8_partial");
      if (url) {
        const td = await canary("ss11.ts", { target: t, cmd: "tus-delete", host: gw.name, url });
        m.s8_tus_delete = `${td.status} ${td.body ?? ""} ${td.error ?? ""}`.trim();
      }
      await settle("s8_terminated", [0, 15]);
      // s9 empty and delete the bucket
      const em = await fetch(`${gw.rest}/bucket/${BUCKET}/empty`, { method: "POST", headers: svc });
      m.s9_empty = `${em.status} ${(await em.text()).replace(/\s+/g, " ").slice(0, 100)}`;
      await sleep(5000);
      const db = await fetch(`${gw.rest}/bucket/${BUCKET}`, { method: "DELETE", headers: svc });
      m.s9_delete_bucket = `${db.status} ${(await db.text()).replace(/\s+/g, " ").slice(0, 100)}`;
      await settle("s9", [0, 15, 60]);
      // tail: wait for the backend to release what it still holds
      const tailMin = Number(ctx.endpoints["ss12_tail_min"] ?? "10") || 10;
      const tailStart = Date.now();
      let prev = -1;
      let still = 0;
      let tail = "not within the tail";
      while (Date.now() - tailStart < tailMin * 60_000) {
        await sleep(10_000);
        const tot = await snap("tail_last");
        if (sc.backend === "s3" ? lastTrash < MiB : tot === prev && (still += 10) >= 60) {
          tail = `${Math.round((Date.now() - t0) / 1000)}s after s0 (${Math.round((Date.now() - tailStart) / 1000)}s into the tail)`;
          break;
        }
        if (tot !== prev) still = 0;
        prev = tot;
      }
      m.tail_settled_at = tail;
      m.tail_minutes_max = tailMin;
      const fin = (await list()).reduce((a, f) => a + f.size, 0);
      m.final_minus_baseline_mib = mib(fin - base);
      const rows = await stackSql(`select count(*) from storage.objects where bucket_id = '${BUCKET}'`);
      m.objects_rows_left = rows.rows.flat().join("") || rows.err;
      out.push({ id: "SS12", title: "backend bytes after each delete path", status: "info", detail: `${t.kind}: ${mib(fin - base)} MiB left above baseline after every delete`, measurements: m });
    } catch (e) {
      out.push({ id: "SS12", title: "SS12 aborted", status: "fail", detail: `threw: ${(e as Error).message}` });
    }
    return out;
  },
};

export default mod;
