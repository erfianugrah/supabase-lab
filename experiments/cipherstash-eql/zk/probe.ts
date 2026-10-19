/**
 * ZK01-ZK07: CipherStash with real ZeroKMS keys against a managed Supabase
 * project, through @cipherstash/stack 1.2.1 and @cipherstash/stack-supabase
 * 1.2.1 (encryptedSupabase), authenticated by the CLI device session in
 * ~/.cipherstash (no CS_* env). Started by ../run-zk-managed.sh.
 *
 * Env: SUPABASE_URL, SUPABASE_ANON_KEY, DATABASE_URL (postgres, direct),
 * UA_EMAIL/UA_PASS, UB_EMAIL/UB_PASS (two Auth users), REF and
 * SUPABASE_ACCESS_TOKEN (Management API, logs only), PROXY_PORT (the local
 * CONNECT proxy this process listens on; the runner sets HTTPS_PROXY to it and
 * NO_PROXY to the Supabase hosts), OUT (result JSON), PHASES (optional,
 * comma-separated subset).
 *
 * Nothing secret is written to OUT: no tokens, keys or passwords. Captured
 * request URLs carry ciphertext operands, which are not secrets.
 */
import net from "node:net";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { encryptedSupabase } from "@cipherstash/stack-supabase";
import { Encryption } from "@cipherstash/stack/v3";
import { encryptedTable, types } from "@cipherstash/stack/eql/v3";
import pg from "pg";

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} not set`);
  return v;
};
const out: Record<string, unknown> = { startedAt: new Date().toISOString() };
const want = (p: string) => !process.env.PHASES || process.env.PHASES.split(",").includes(p);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ms = (t0: number) => Math.round(performance.now() - t0);
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : null;
};
const errText = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 300);
const shapeErr = (error: unknown) => {
  if (!error) return null;
  const e = error as { message?: string; code?: string; encryptionError?: { type?: string; message?: string } };
  return {
    message: String(e.message ?? "").slice(0, 300),
    code: e.code ?? null,
    encryptionError: e.encryptionError ? { type: e.encryptionError.type ?? null, message: String(e.encryptionError.message ?? "").slice(0, 300) } : null,
  };
};

// ---------- local CONNECT proxy (ZeroKMS / CTS traffic only, via HTTPS_PROXY) ----------
type Mode = "pass" | "refuse" | "blackhole";
let mode: Mode = "pass";
const hosts = new Map<string, number>();
const live = new Set<net.Socket>();
const proxy = net.createServer((sock) => {
  live.add(sock);
  sock.on("close", () => live.delete(sock));
  sock.on("error", () => {});
  sock.once("data", (buf) => {
    const m = /^CONNECT ([^:\s]+):(\d+)/.exec(buf.toString("latin1"));
    if (!m) return sock.destroy();
    hosts.set(m[1], (hosts.get(m[1]) ?? 0) + 1);
    if (mode === "refuse") return void sock.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    if (mode === "blackhole") return; // hold the socket, never answer
    const up = net.connect(Number(m[2]), m[1], () => {
      sock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      up.pipe(sock);
      sock.pipe(up);
    });
    live.add(up);
    up.on("close", () => live.delete(up));
    up.on("error", () => sock.destroy());
  });
});
await new Promise<void>((r) => proxy.listen(Number(env("PROXY_PORT")), "127.0.0.1", r));
const setMode = (m: Mode) => {
  mode = m;
  for (const s of live) s.destroy(); // drop pooled tunnels so the new mode applies to every request
};

// ---------- clients ----------
const recorded: { method: string; url: string }[] = [];
const recordingFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  recorded.push({ method: init?.method ?? "GET", url });
  return fetch(input, init);
}) as typeof fetch;
async function signedIn(email: string, pass: string, record = false): Promise<SupabaseClient> {
  const c = createClient(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: record ? { fetch: recordingFetch } : {},
  });
  const { error } = await c.auth.signInWithPassword({ email, password: pass });
  if (error) throw new Error(`sign-in ${email.split("@")[0]}: ${error.message}`);
  return c;
}
const sbA = await signedIn(env("UA_EMAIL"), env("UA_PASS"), true);
const sbB = await signedIn(env("UB_EMAIL"), env("UB_PASS"));
const uidA = (await sbA.auth.getUser()).data.user!.id;
const uidB = (await sbB.auth.getUser()).data.user!.id;
let t0 = performance.now();
const dbA = await encryptedSupabase(sbA as never, { databaseUrl: env("DATABASE_URL") });
out.wrapperInitMs = ms(t0);
const dbB = await encryptedSupabase(sbB as never, { databaseUrl: env("DATABASE_URL") });
const pgc = new pg.Client({ connectionString: env("DATABASE_URL") });
await pgc.connect();

// ---------- dataset ----------
const dek = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
type Row = { subject: string; label: string; score: number; seen: string; note: string; wrapped_dek: string };
const rowsA: Row[] = [
  { subject: "S-001", label: "alpha", score: 10, seen: "2026-01-05", note: "a1", wrapped_dek: dek() },
  { subject: "S-002", label: "delta", score: 55, seen: "2026-03-10", note: "a2", wrapped_dek: dek() },
  { subject: "S-001", label: "bravo", score: 30, seen: "2025-12-24", note: "a3", wrapped_dek: dek() },
  { subject: "S-003", label: "echo", score: -5, seen: "2026-07-01", note: "a4", wrapped_dek: dek() },
  { subject: "S-002", label: "charlie", score: 1000, seen: "2026-02-14", note: "a5", wrapped_dek: dek() },
  { subject: "S-004", label: "foxtrot", score: 0, seen: "2024-02-29", note: "a6", wrapped_dek: dek() },
];
const rowsB: Row[] = [
  { subject: "S-001", label: "golf", score: 20, seen: "2026-05-05", note: "b1", wrapped_dek: dek() },
  { subject: "S-005", label: "hotel", score: 70, seen: "2026-06-06", note: "b2", wrapped_dek: dek() },
  { subject: "S-002", label: "india", score: -100, seen: "2025-01-01", note: "b3", wrapped_dek: dek() },
];
const notes = (rs: { note: string }[]) => rs.map((r) => r.note);
const sortedNotes = (rs: { note: string }[]) => notes(rs).sort();
const same = (a: string[], b: string[]) => JSON.stringify(a) === JSON.stringify(b);
const dateOf = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

// ---------- ZK01: wrapper writes, stored shape ----------
if (want("ZK01")) {
  const r: Record<string, unknown> = {};
  t0 = performance.now();
  const insA = await dbA.from("records").insert(rowsA as never).select("id, note");
  r.insertA = { ms: ms(t0), rows: (insA.data as unknown[] | null)?.length ?? 0, error: shapeErr(insA.error) };
  t0 = performance.now();
  const insB = await dbB.from("records").insert(rowsB as never).select("id, note");
  r.insertB = { ms: ms(t0), rows: (insB.data as unknown[] | null)?.length ?? 0, error: shapeErr(insB.error) };
  // What Postgres holds (as postgres, bypassing RLS)
  const stored = await pgc.query(
    "select subject::text s, label::text l, score::text sc, seen::text se, wrapped_dek::text w, note, owner::text o from public.records order by id",
  );
  const blob = stored.rows.map((x) => [x.s, x.l, x.sc, x.se, x.w].join("|")).join("\n");
  const plain = [...rowsA, ...rowsB].flatMap((x) => [x.subject, x.label, x.wrapped_dek, `"${x.score}"`, x.seen]);
  const keysOf = (j: string) => Object.keys(JSON.parse(j)).sort().join(",");
  const first = stored.rows[0];
  const s001 = stored.rows.filter((_, i) => [...rowsA, ...rowsB][i]?.subject === "S-001").map((x) => JSON.parse(x.s));
  r.stored = {
    rows: stored.rows.length,
    owners: { a: stored.rows.filter((x) => x.o === uidA).length, b: stored.rows.filter((x) => x.o === uidB).length },
    plaintextHits: plain.filter((p) => blob.includes(p)),
    payloadKeys: first ? { subject: keysOf(first.s), label: keysOf(first.l), score: keysOf(first.sc), seen: keysOf(first.se), wrapped_dek: keysOf(first.w) } : null,
    identifier: first ? JSON.parse(first.s).i : null,
    sameSubjectSameHm: s001.length >= 2 && s001.every((p) => p.hm === s001[0].hm),
    sameSubjectDifferentC: s001.length >= 2 && new Set(s001.map((p) => p.c)).size === s001.length,
  };
  out.ZK01 = r;
}

// ---------- ZK02: reads, filters, ordering under RLS ----------
if (want("ZK02")) {
  const r: Record<string, unknown> = {};
  const q = async (name: string, run: () => PromiseLike<{ data: unknown; error: unknown }>, expect: string[] | null, ordered = false) => {
    const t = performance.now();
    let res: { data: unknown; error: unknown };
    try {
      res = await run();
    } catch (e) {
      r[name] = { threw: errText(e), ms: ms(t) };
      return;
    }
    const got = Array.isArray(res.data) ? notes(res.data as { note: string }[]) : null;
    r[name] = {
      ms: ms(t),
      error: shapeErr(res.error),
      got: ordered ? got : got?.slice().sort(),
      expected: expect,
      pass: expect === null ? null : got !== null && same(ordered ? got : got.slice().sort(), expect),
    };
  };
  const A = rowsA;
  await q("selectAllA", () => dbA.from("records").select("*"), sortedNotes(A));
  await q("selectAllB", () => dbB.from("records").select("*"), sortedNotes(rowsB));
  // full decrypted values for A
  {
    const { data, error } = await dbA.from("records").select("note, subject, label, score, seen, wrapped_dek");
    const byNote = new Map((data as Record<string, unknown>[] | null)?.map((x) => [x.note as string, x]) ?? []);
    const mism = A.filter((x) => {
      const g = byNote.get(x.note);
      return !g || g.subject !== x.subject || g.label !== x.label || Number(g.score) !== x.score || dateOf(g.seen) !== x.seen || g.wrapped_dek !== x.wrapped_dek;
    }).map((x) => x.note);
    r.decryptedValuesA = { error: shapeErr(error), mismatches: mism, sampleTypes: data ? Object.fromEntries(Object.entries((data as Record<string, unknown>[])[0]).map(([k, v]) => [k, v instanceof Date ? "Date" : typeof v])) : null };
  }
  await q("eqSubjectA", () => dbA.from("records").select("note").eq("subject", "S-001"), sortedNotes(A.filter((x) => x.subject === "S-001")));
  await q("eqSubjectB", () => dbB.from("records").select("note").eq("subject", "S-001"), sortedNotes(rowsB.filter((x) => x.subject === "S-001")));
  await q("inSubject", () => dbA.from("records").select("note").in("subject", ["S-002", "S-004"]), sortedNotes(A.filter((x) => ["S-002", "S-004"].includes(x.subject))));
  await q("neqSubject", () => dbA.from("records").select("note").neq("subject", "S-001"), sortedNotes(A.filter((x) => x.subject !== "S-001")));
  await q("rangeScore", () => dbA.from("records").select("note").gte("score", 0).lt("score", 100), sortedNotes(A.filter((x) => x.score >= 0 && x.score < 100)));
  await q("gtLabel", () => dbA.from("records").select("note").gt("label", "charlie"), sortedNotes(A.filter((x) => x.label > "charlie")));
  await q("gteSeen", () => dbA.from("records").select("note").gte("seen", "2026-01-01"), sortedNotes(A.filter((x) => x.seen >= "2026-01-01")));
  await q("eqScore", () => dbA.from("records").select("note").eq("score", 1000), sortedNotes(A.filter((x) => x.score === 1000)));
  await q("orderScoreAsc", () => dbA.from("records").select("note").order("score", { ascending: true }), notes([...A].sort((a, b) => a.score - b.score)), true);
  await q("orderScoreDesc", () => dbA.from("records").select("note").order("score", { ascending: false }), notes([...A].sort((a, b) => b.score - a.score)), true);
  await q("orderLabelAsc", () => dbA.from("records").select("note").order("label", { ascending: true }), notes([...A].sort((a, b) => (a.label < b.label ? -1 : 1))), true);
  await q("orderSeenDesc", () => dbA.from("records").select("note").order("seen", { ascending: false }), notes([...A].sort((a, b) => (a.seen < b.seen ? 1 : -1))), true);
  await q("pageScoreAsc", () => dbA.from("records").select("note").order("score", { ascending: true }).range(0, 1), notes([...A].sort((a, b) => a.score - b.score)).slice(0, 2), true);
  await q("encryptedPlusPlain", () => dbA.from("records").select("note").eq("subject", "S-002").eq("note", "a5"), ["a5"]);
  await q("isNullSubject", () => dbA.from("records").select("note").is("subject", null), []);
  await q("plaintextOnlySelect", () => dbA.from("records").select("id, note"), sortedNotes(A));
  // unsupported or misuse cases: record what happens
  await q("eqStorageOnly", () => dbA.from("records").select("note").eq("wrapped_dek", A[0].wrapped_dek), null);
  await q("orderEqOnly", () => dbA.from("records").select("note").order("subject"), null, true);
  await q("gtEqOnly", () => dbA.from("records").select("note").gt("subject", "S-001"), null);
  try {
    t0 = performance.now();
    const res = await (dbA.from("records").select("note") as unknown as { csv: () => PromiseLike<{ data: unknown; error: unknown }> }).csv();
    r.csv = { ms: ms(t0), error: shapeErr(res.error), dataType: typeof res.data };
  } catch (e) {
    r.csv = { threw: errText(e) };
  }
  // update and delete through the wrapper
  {
    const u = await dbA.from("records").update({ score: 11, label: "alpha2" } as never).eq("note", "a1").select("note, score, label");
    const back = (u.data as { score: number; label: string }[] | null)?.[0];
    r.updateA = { error: shapeErr(u.error), back: back ? { score: Number(back.score), label: back.label } : null, pass: back ? Number(back.score) === 11 && back.label === "alpha2" : false };
    const d = await dbB.from("records").delete().eq("subject", "S-005").select("note");
    r.deleteB = { error: shapeErr(d.error), deleted: notes((d.data as { note: string }[] | null) ?? []) };
    // B cannot touch A's rows: update by subject matches only B's rows under RLS
    const ub = await dbB.from("records").update({ note: "hijack" } as never).eq("subject", "S-003").select("note");
    r.crossOwnerUpdateB = { error: shapeErr(ub.error), updated: ((ub.data as unknown[] | null) ?? []).length };
  }
  out.ZK02 = r;
}

// ---------- ZK03: data key column with ZeroKMS keys ----------
if (want("ZK03")) {
  const k = dek();
  const ins = await dbA.from("records").insert({ subject: "S-900", note: "dek", wrapped_dek: k } as never).select("id");
  const back = await dbA.from("records").select("note, wrapped_dek").eq("note", "dek");
  const got = (back.data as { wrapped_dek: string }[] | null)?.[0]?.wrapped_dek;
  const raw = await pgc.query("select wrapped_dek::text w from public.records where note = 'dek'");
  out.ZK03 = {
    insertError: shapeErr(ins.error),
    readError: shapeErr(back.error),
    roundTrip: got === k,
    keyBytes: got ? Buffer.from(got, "base64").length : 0,
    storedKeys: raw.rows[0] ? Object.keys(JSON.parse(raw.rows[0].w)).sort() : null,
    plaintextInStore: raw.rows[0] ? raw.rows[0].w.includes(k) : null,
  };
}

// ---------- ZK04: latency ----------
if (want("ZK04")) {
  const t = encryptedTable("lat", { subject: types.TextEq("subject") });
  t0 = performance.now();
  const client = await Encryption({ schemas: [t] });
  const r: Record<string, unknown> = { clientInitMs: ms(t0) };
  const N = 20;
  const enc: number[] = [], dec: number[] = [];
  let last: unknown = null;
  for (let i = 0; i < N; i++) {
    const a = performance.now();
    const e = await client.encrypt(`L-${i}` as never, { table: t, column: t.subject } as never);
    enc.push(ms(a));
    if (e.failure) { r.encryptFailure = e.failure.type; break; }
    last = e.data;
    const b = performance.now();
    const d = await client.decrypt(e.data as never);
    dec.push(ms(b));
    if (d.failure) { r.decryptFailure = d.failure.type; break; }
  }
  const sum = (xs: number[]) => ({ n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95), min: Math.min(...xs), max: Math.max(...xs) });
  r.singleEncrypt = sum(enc);
  r.singleDecrypt = sum(dec);
  r.bulk = {} as Record<string, unknown>;
  for (const n of [10, 100, 500]) {
    const items = Array.from({ length: n }, (_, i) => ({ id: `b${i}`, plaintext: `B-${n}-${i}` }));
    const a = performance.now();
    const be = await client.bulkEncrypt(items as never, { table: t, column: t.subject } as never);
    const eMs = ms(a);
    const b = performance.now();
    const bd = be.failure ? null : await client.bulkDecrypt(be.data as never);
    const dMs = ms(b);
    (r.bulk as Record<string, unknown>)[n] = {
      encryptMs: eMs,
      decryptMs: dMs,
      ok: !be.failure && !bd?.failure && (bd!.data as Array<{ data?: unknown }>).every((x, i) => x.data === items[i].plaintext),
    };
  }
  // wrapper vs plain supabase-js, one row per call, same user and project
  const wIns: number[] = [], pIns: number[] = [], wSel: number[] = [], pSel: number[] = [];
  for (let i = 0; i < 10; i++) {
    let a = performance.now();
    const w = await dbA.from("lat").insert({ subject: `W-${i}`, note: `w${i}` } as never);
    wIns.push(ms(a));
    if (w.error) r.wrapperInsertError = shapeErr(w.error);
    a = performance.now();
    const p = await sbA.from("lat_plain").insert({ subject: `W-${i}`, note: `w${i}` });
    pIns.push(ms(a));
    if (p.error) r.plainInsertError = p.error.message;
  }
  for (let i = 0; i < 10; i++) {
    let a = performance.now();
    const w = await dbA.from("lat").select("note, subject").eq("subject", `W-${i}`);
    wSel.push(ms(a));
    if (w.error || (w.data as unknown[])?.length !== 1) r.wrapperSelectIssue = { error: shapeErr(w.error), rows: (w.data as unknown[] | null)?.length };
    a = performance.now();
    await sbA.from("lat_plain").select("note, subject").eq("subject", `W-${i}`);
    pSel.push(ms(a));
  }
  r.wrapperInsert = sum(wIns);
  r.plainInsert = sum(pIns);
  r.wrapperSelectEq = sum(wSel);
  r.plainSelectEq = sum(pSel);
  void last;
  out.ZK04 = r;
}

// ---------- ZK05: ZeroKMS unreachable after init ----------
if (want("ZK05")) {
  const r: Record<string, unknown> = {};
  const t = encryptedTable("records", { subject: types.TextEq("subject") });
  const client = await Encryption({ schemas: [t] });
  const pre = await client.encrypt("S-777" as never, { table: t, column: t.subject } as never);
  const warm = await dbA.from("records").select("note").eq("subject", "S-001");
  r.warm = { error: shapeErr(warm.error), rows: (warm.data as unknown[] | null)?.length ?? 0, preEncrypt: !pre.failure };
  const cap = 120_000;
  const timed = async <T>(fn: () => Promise<T>) => {
    const a = performance.now();
    try {
      const v = await Promise.race([fn(), sleep(cap).then(() => "__timeout__" as const)]);
      return { ms: ms(a), v };
    } catch (e) {
      return { ms: ms(a), v: { threw: errText(e) } };
    }
  };
  const summarise = (v: unknown) => {
    if (v === "__timeout__") return { timedOutAfterMs: cap };
    if (v && typeof v === "object" && "threw" in (v as object)) return v;
    const x = v as { data?: unknown; error?: unknown; failure?: { type?: string; message?: string } };
    if (x && "failure" in x && x.failure) return { failure: x.failure.type, message: String(x.failure.message ?? "").slice(0, 300) };
    return { error: shapeErr(x?.error), rows: Array.isArray(x?.data) ? (x.data as unknown[]).length : x?.data ? 1 : 0 };
  };
  for (const m of ["refuse", "blackhole"] as const) {
    setMode(m);
    const ph: Record<string, unknown> = {};
    let x = await timed(() => dbA.from("lat").insert({ subject: `O-${m}`, note: `o-${m}` } as never) as unknown as Promise<unknown>);
    ph.wrapperInsert = { ms: x.ms, ...summarise(x.v) };
    x = await timed(() => dbA.from("records").select("note, subject") as unknown as Promise<unknown>);
    ph.wrapperSelectDecrypt = { ms: x.ms, ...summarise(x.v) };
    x = await timed(() => dbA.from("records").select("id, note") as unknown as Promise<unknown>);
    ph.wrapperSelectPlaintextOnly = { ms: x.ms, ...summarise(x.v) };
    x = await timed(() => dbA.from("records").select("note").eq("subject", "S-001") as unknown as Promise<unknown>);
    ph.wrapperEqFilter = { ms: x.ms, ...summarise(x.v) };
    x = await timed(() => client.decrypt((pre as { data: unknown }).data as never) as unknown as Promise<unknown>);
    ph.sdkDecryptEarlierCiphertext = { ms: x.ms, ...summarise(x.v) };
    x = await timed(() => sbA.from("records").select("id, note, subject") as unknown as Promise<unknown>);
    ph.plainSupabaseSelect = { ms: x.ms, ...summarise(x.v) };
    r[m] = ph;
  }
  setMode("pass");
  const rec: Record<string, unknown> = {};
  for (let i = 0; i < 3; i++) {
    const a = performance.now();
    const w = await dbA.from("records").select("note").eq("subject", "S-001");
    rec[`try${i + 1}`] = { ms: ms(a), error: shapeErr(w.error), rows: (w.data as unknown[] | null)?.length ?? 0 };
    if (!w.error) break;
    await sleep(2000);
  }
  r.recovery = rec;
  out.ZK05 = r;
}

// ---------- ZK06: what reaches the project's logs ----------
if (want("ZK06")) {
  const r: Record<string, unknown> = {};
  // The S-001 equality GET this process sent, as recorded on the wire.
  const eqGets = recorded.filter((x) => x.method === "GET" && x.url.includes("/rest/v1/records") && x.url.includes("subject=eq."));
  const sample = eqGets[0]?.url ?? "";
  const operand = decodeURIComponent(sample.split("subject=eq.")[1]?.split("&")[0] ?? "");
  let hm = "", c = "";
  try {
    const j = JSON.parse(operand);
    hm = String(j.hm ?? "");
    c = String(j.c ?? "");
  } catch {}
  const hmSlice = hm.slice(8, 32);
  const cSlice = c.replace(/[^A-Za-z0-9]/g, "").slice(20, 44); // postgres_logs search only
  r.request = { recordedEqGets: eqGets.length, operandBytes: operand.length, operandKeys: operand ? Object.keys(JSON.parse(operand)).sort() : null, urlBytes: sample.length };
  const logs = async (sql: string) => {
    const end = new Date(), start = new Date(end.getTime() - 3 * 3600_000);
    const u = `https://api.supabase.com/v1/projects/${env("REF")}/analytics/endpoints/logs?sql=${encodeURIComponent(sql)}&iso_timestamp_start=${encodeURIComponent(start.toISOString())}&iso_timestamp_end=${encodeURIComponent(end.toISOString())}`;
    const res = await fetch(u, { headers: { Authorization: `Bearer ${env("SUPABASE_ACCESS_TOKEN")}` } });
    const j = (await res.json().catch(() => ({}))) as { result?: Record<string, unknown>[]; error?: unknown };
    return { status: res.status, rows: j.result ?? [], error: j.error ? JSON.stringify(j.error).slice(0, 200) : "" };
  };
  if (hmSlice) {
    let edge = { status: 0, rows: [] as Record<string, unknown>[], error: "" };
    const t = performance.now();
    for (let i = 0; i < 15; i++) {
      edge = await logs(
        `select timestamp, log_attributes['request.method'] as m, log_attributes['request.path'] as p, length(log_attributes['request.search']) as slen, toString(log_attributes) as a from logs where source = 'edge_logs' and log_attributes['request.search'] like '%${hmSlice}%' order by timestamp asc limit 20`,
      );
      if (edge.rows.length) break;
      await sleep(20_000);
    }
    // Decode the stored query string and compare its operand with the one sent
    // (a raw substring test fails on percent-encoded base64 characters).
    let storedOperandMatches: boolean | null = null;
    try {
      const sq = await logs(`select log_attributes['request.search'] as s from logs where source = 'edge_logs' and log_attributes['request.search'] like '%${hmSlice}%' limit 1`);
      const s = String(sq.rows[0]?.s ?? "");
      const v = new URLSearchParams(s.replace(/^\?/, "")).get("subject") ?? "";
      const o = JSON.parse(v.replace(/^eq\./, ""));
      storedOperandMatches = o.c === c && o.hm === hm;
    } catch {}
    r.edgeLogs = {
      status: edge.status,
      error: edge.error,
      waitedMs: ms(t),
      rowsWithHmSlice: edge.rows.length,
      searchLength: edge.rows[0]?.slen ?? null,
      storedOperandMatchesSent: storedOperandMatches,
      path: edge.rows[0]?.p ?? null,
    };
    const pgl = await logs(`select timestamp, event_message from logs where source = 'postgres_logs' and (event_message like '%${hmSlice}%' or event_message like '%${cSlice}%') order by timestamp asc limit 20`);
    r.postgresLogs = { status: pgl.status, error: pgl.error, rowsWithOperandSlices: pgl.rows.length, sample: pgl.rows.slice(0, 2).map((x) => String(x.event_message).slice(0, 200)) };
    // the statements PostgREST ran for the table, to see how operands appear
    const st = await logs(`select timestamp, event_message from logs where source = 'postgres_logs' and event_message like '%records%' order by timestamp asc limit 20`);
    r.postgresLogsMentioningTable = { status: st.status, rows: st.rows.length, sample: st.rows.slice(0, 3).map((x) => String(x.event_message).slice(0, 240)) };
  } else {
    r.skipped = "no recorded equality GET to trace";
  }
  out.ZK06 = r;
}

// ---------- ZK07: federation without a registered issuer ----------
if (want("ZK07")) {
  const r: Record<string, unknown> = {};
  try {
    const { OidcFederationStrategy } = (await import("@cipherstash/stack")) as unknown as {
      OidcFederationStrategy: { create: (crn: string, getJwt: () => Promise<string>) => { data?: unknown; failure?: { type?: string; error?: { message?: string } } } };
    };
    const crn = process.env.CS_FED_CRN ?? "";
    r.crnSupplied = Boolean(crn);
    if (crn) {
      const fed = OidcFederationStrategy.create(crn, async () => (await sbA.auth.getSession()).data.session!.access_token);
      r.create = fed.failure ? { failure: fed.failure.type, message: String(fed.failure.error?.message ?? "").slice(0, 300) } : "ok";
      if (!fed.failure) {
        const t = encryptedTable("records", { subject: types.TextEq("subject") });
        try {
          const c2 = await Encryption({ schemas: [t], config: { authStrategy: fed.data } } as never);
          const e = await c2.encrypt("S-123" as never, { table: t, column: t.subject } as never);
          r.encrypt = e.failure ? { failure: e.failure.type, message: String(e.failure.message ?? "").slice(0, 300) } : "ok";
        } catch (e) {
          r.encrypt = { threw: errText(e) };
        }
      }
    }
  } catch (e) {
    r.threw = errText(e);
  }
  out.ZK07 = r;
}

out.proxy = { hostsConnected: Object.fromEntries(hosts), supabaseThroughProxy: [...hosts.keys()].some((h) => h.includes("supabase")) };
out.finishedAt = new Date().toISOString();
await pgc.end();
proxy.close();
await Bun.write(env("OUT"), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
process.exit(0);
