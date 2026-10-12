/**
 * Shared flow for CK04 (S3 multipart) and CK05 (TUS): upload the 2 GiB
 * fixture as the tenant editor, SIGKILL the uploader at ~40 % progress,
 * resume from a NEW process that knows only the asset id (everything else
 * comes from the catalogue and the server), then read the whole object back
 * as the viewer through S3 GetObject and check the plaintext SHA-256.
 */
import type { TestResult } from "../../../harness/src/types";
import { credsFor, directory, type HarnessTarget, type Loaded, loadState, MARKER, row, runClient, saveState, scrub } from "./ckrun";

const MiB = 1024 * 1024;
const r1 = (x: number) => Math.round(x * 10) / 10;

export async function interruptResume(l: Loaded, t: HarnessTarget, id: string, method: "s3-multipart" | "tus", stateKey: string): Promise<TestResult> {
  const title = `2 GiB via ${method}: interrupt at 40 %, resume from a new process, verify`;
  const st = loadState(l.run, t.name);
  const dir = directory(l);
  const fx = l.run.fixtures.big;
  const m: Record<string, string | number> = { plaintext_bytes: fx.size };
  const base = { directory: dir, tenant: st.tenants.primary };
  // 1. upload, killed at 40 %
  const first = await runClient({ ...base, cmd: "upload", creds: credsFor(l, "editor"), record: st.records.primary, file: fx.path, method }, { killAt: 0.4 });
  m.first_process_killed = first.killed ? "yes" : "no";
  m.killed_at_fraction = first.killedAt ?? -1;
  m.first_process_ms = first.ms;
  if (!first.killed) return row(id, t, title, "fail", `uploader was not interrupted: ${scrub(l, JSON.stringify(first.result)).slice(0, 300)}`, m);
  // The asset id is the only thing the second process gets; find it in the catalogue as the editor would.
  const assetId = await findUploading(t, st, method);
  if (!assetId) return row(id, t, title, "fail", "no asset in state 'uploading' after the kill", m);
  // 2. resume from a fresh process
  const second = await runClient({ ...base, cmd: "resume", creds: credsFor(l, "editor"), asset: assetId, file: fx.path });
  const r = second.result;
  m.resume_process_ms = second.ms;
  if (!r.ok) return row(id, t, title, "fail", `resume failed: ${scrub(l, `${r.code} ${r.message}`)}`, m);
  for (const k of ["parts", "partsSkipped", "resumedEtagMatches", "resumedEtagMismatches", "etagSource", "tusOffsetAtResume", "chunkRows", "ciphertextSize"]) {
    if (r[k] !== undefined) m[k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)] = r[k];
  }
  m.sha256_matches_fixture = r.plaintextSha256 === fx.sha256 ? "yes" : "no";
  // 3. full read as the viewer (S3 GetObject, 64 MiB windows); the
  // ciphertext it downloads is also scanned for the plaintext marker (CK08).
  const read = await runClient({ ...base, cmd: "read-all", creds: credsFor(l, "viewer"), asset: assetId, path: "s3", needle: MARKER });
  const markerHits = typeof read.result.cipherNeedleHits === "number" ? read.result.cipherNeedleHits : undefined;
  if (markerHits !== undefined) m.read_all_ciphertext_marker_hits = markerHits;
  st.assets[stateKey] = { id: assetId, tenant: st.tenants.primary, method, size: fx.size, markerHits };
  saveState(l.run, t.name, st);
  m.read_all_ok = read.result.ok ? "yes" : `no ${read.result.code} ${read.result.detail?.status ?? ""} ${read.result.detail?.code ?? ""} ${String(read.result.detail?.message ?? "").slice(0, 80)}`.trim();
  m.read_all_ms = Math.round(Number(read.result.ms ?? read.ms));
  m.iat_future_retries = Number(first.result.iatFutureRetries ?? 0) + Number(r.iatFutureRetries ?? 0) + Number(read.result.iatFutureRetries ?? 0);
  m.read_all_transferred = Number(read.result.transferred ?? -1);
  // Info only: one laptop vantage, not a throughput claim.
  m.info_upload_wall_s = r1((first.ms + second.ms) / 1000);
  m.info_upload_mib_per_s = r1(fx.size / MiB / ((first.ms + second.ms) / 1000));
  m.info_read_mib_per_s = read.result.ok ? r1(fx.size / MiB / (Number(read.result.ms) / 1000)) : -1;
  // A resume that re-sends everything still ends with the right bytes; it is not a resume.
  const resumed = method === "tus" ? Number(r.tusOffsetAtResume) > 0 : Number(r.partsSkipped) > 0;
  m.resumed_from_server_state = resumed ? "yes" : "no";
  const ok =
    resumed &&
    r.plaintextSha256 === fx.sha256 &&
    read.result.ok === true &&
    read.result.sha256 === fx.sha256 &&
    Number(r.chunkRows) === 256 &&
    Number(r.resumedEtagMismatches ?? 0) === 0;
  return row(
    id,
    t,
    title,
    ok ? "pass" : "fail",
    ok
      ? `killed at ${m.killed_at_fraction}, resumed (${method === "tus" ? `offset ${m.tus_offset_at_resume}` : `${m.parts_skipped} of ${m.parts} parts kept, ${m.resumed_etag_matches} ETags match`}), full read SHA-256 equals the fixture`
      : `${resumed ? "" : "no resume: the new process found nothing to keep and re-sent everything; "}${scrub(l, JSON.stringify({ upload_sha_ok: r.plaintextSha256 === fx.sha256, read: read.result.code ?? read.result.sha256 === fx.sha256, chunks: r.chunkRows, parts_skipped: r.partsSkipped, tus_offset: r.tusOffsetAtResume }))}`,
    m,
  );
}

async function findUploading(t: HarnessTarget, st: ReturnType<typeof loadState>, method: string): Promise<string> {
  const r = await fetch(`${t.client.url}/rest/v1/assets?select=id&upload_state=eq.uploading&upload_method=eq.${method}&tenant_id=eq.${st.tenants.primary}&order=created_at.desc&limit=1`, {
    headers: { apikey: t.serviceKey, authorization: `Bearer ${t.serviceKey}`, "accept-profile": "app" },
  });
  const rows = (await r.json().catch(() => [])) as { id: string }[];
  return rows[0]?.id ?? "";
}
