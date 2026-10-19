//! CE01-CE05: EQL v3 ciphertext in a Supabase catalogue table, read through
//! PostgREST under RLS, with no CipherStash account.
//!
//! Runs inside a checkout of cipherstash/stack (packages/eql/tests/encryption),
//! copied in by ../run-local.sh, because the ciphertext comes from that repo's
//! `stack-encrypt` over `stack-kms`'s `FakeDataKeySource`: real EQL payloads,
//! data keys held in this process's memory. Everything that decrypts therefore
//! happens in this one process. The fake models none of ZeroKMS's
//! authorisation, so nothing here says anything about key custody.
//!
//! Env: EQL_TEST_DATABASE_URL (a role that owns schema app, i.e. `postgres`),
//! PGRST_URL, JWT_A / JWT_B (access tokens, role authenticated, sub = UID_A /
//! UID_B), UID_A, UID_B, OUT (file for the JSON result), and on managed APIKEY
//! (the project API key the gateway requires beside the bearer token).
//!
//! Rows: owner A holds assets 1 (S-001) and 2 (S-002); owner B holds 3 (S-001)
//! and 4 (S-003). Each row carries a random 32-byte data key, base64, encrypted
//! into a storage-only `eql_v3_text` column (the key-wrapping question), and a
//! subject reference in an `eql_v3_text_eq` column (the searchable catalogue
//! field). RLS: owner = auth.uid().

mod common;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use eql_bindings::encryption::NativeCiphertextVisitor as NativeLeaf;
use eql_bindings::v3::terms::Ciphertext;
use eql_bindings::v3::text::{Text, TextEq, TextEqQuery};
use eql_bindings::{Identifier, SchemaVersion};
use stack_encrypt::target::transcode::{Reader, Transcode};
use serde_json::{json, Value};
use std::process::Command;

fn col(c: &str) -> stack_encrypt::NonEmpty<Identifier> {
    Identifier::for_column("assets", c).unwrap()
}

fn env(k: &str) -> String {
    std::env::var(k).unwrap_or_else(|_| panic!("{k} not set"))
}

/// A database error as message plus its CONTEXT line (where the server raised it).
fn db_err(e: &postgres::Error) -> Value {
    match e.as_db_error() {
        Some(d) => json!({ "error": d.message(), "context": d.where_() }),
        None => json!({ "error": e.to_string() }),
    }
}

/// One PostgREST GET with the caller's token; returns (status, body).
fn get(path_and_query: &str, jwt: &str) -> (u16, String) {
    let url = format!("{}{}", env("PGRST_URL"), path_and_query);
    let mut cmd = Command::new("curl");
    cmd.args(["-s", "-w", "\n%{http_code}", "-H"]).arg(format!("Authorization: Bearer {jwt}"));
    // Schema `app` is the only exposed schema locally and one of several on
    // managed, where PostgREST serves the first listed (`public`) by default.
    cmd.args(["-H", "Accept-Profile: app"]);
    // Managed: the gateway also wants the project's API key (APIKEY, optional).
    if let Ok(k) = std::env::var("APIKEY") {
        cmd.arg("-H").arg(format!("apikey: {k}"));
    }
    let out = cmd.arg(&url).output().expect("curl");
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    let (body, code) = text.rsplit_once('\n').unwrap_or((&text, "0"));
    (code.trim().parse().unwrap_or(0), body.to_owned())
}

/// Wait until PostgREST's schema cache has the table (a reload is async):
/// any answer from the table other than 503 (a 403 from the planner counts).
fn wait_ready(jwt: &str) {
    let mut last = (0, String::new());
    for _ in 0..60 {
        last = get("/assets?select=id&limit=1", jwt);
        if last.0 != 503 && last.0 != 0 && !last.1.contains("PGRST205") {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    panic!("PostgREST did not serve /assets within 30 s: {} {}", last.0, last.1);
}

fn ids(body: &str) -> Value {
    match serde_json::from_str::<Value>(body) {
        Ok(Value::Array(rows)) => json!(rows.iter().map(|r| r["id"].clone()).collect::<Vec<_>>()),
        Ok(other) => json!({ "error": other }),
        Err(_) => json!({ "raw": body.chars().take(300).collect::<String>() }),
    }
}

/// Plaintext-only reads (no encrypted column referenced) as `role`, each in a
/// NEW connection: Postgres caches a table's index expressions per backend
/// (relcache) after the first time it plans with them, so a backend where a
/// privileged role already planned against the table hides the permission
/// check this measures. `drop_index` drops the EQL index first (rolled back).
fn plain_reads(role: &str, sub: &str, drop_index: bool) -> Value {
    plain_reads_on(role, sub, drop_index, false)
}

/// As plain_reads; with `warm`, the new connection first plans a query on the
/// table as `postgres` (outside the transaction), then switches role.
fn plain_reads_on(role: &str, sub: &str, drop_index: bool, warm: bool) -> Value {
    let mut res = serde_json::Map::new();
    for (name, q) in [
        ("count_star", "SELECT count(*)::int FROM app.assets"),
        ("where_id", "SELECT count(*)::int FROM (SELECT id FROM app.assets WHERE id = 1) s"),
        ("order_by_id", "SELECT count(*)::int FROM (SELECT id FROM app.assets ORDER BY id) s"),
    ] {
        let mut db = postgres::Client::connect(&env("EQL_TEST_DATABASE_URL"), postgres::NoTls).unwrap();
        if warm {
            db.batch_execute("SELECT count(*) FROM (SELECT id FROM app.assets WHERE id = 1) s").unwrap();
        }
        let mut tx = db.transaction().unwrap();
        if drop_index {
            tx.batch_execute("DROP INDEX app.assets_subject_ref_idx").unwrap();
        }
        tx.batch_execute(&format!("SET LOCAL ROLE {role}")).unwrap();
        tx.execute("SELECT set_config('request.jwt.claims', $1, true)", &[&json!({ "sub": sub, "role": role }).to_string()]).unwrap();
        let v = match tx.query_one(q, &[]) {
            Ok(r) => json!(r.get::<_, i32>(0)),
            Err(e) => db_err(&e),
        };
        let _ = tx.rollback();
        res.insert(name.into(), v);
    }
    Value::Object(res)
}

/// SQL as `authenticated` with the given sub, inside a rolled-back transaction.
fn sql_as(sub: &str, query_json: &str) -> Value {
    let mut db = postgres::Client::connect(&env("EQL_TEST_DATABASE_URL"), postgres::NoTls).unwrap();
    let mut tx = db.transaction().unwrap();
    tx.batch_execute("SET LOCAL ROLE authenticated").unwrap();
    tx.execute(
        "SELECT set_config('request.jwt.claims', $1, true)",
        &[&json!({ "sub": sub, "role": "authenticated" }).to_string()],
    )
    .unwrap();
    let r = tx.query(
        "SELECT id FROM app.assets WHERE subject_ref = $1::text::jsonb::eql_v3.query_text_eq ORDER BY id",
        &[&query_json],
    );
    let v = match r {
        Ok(rows) => json!(rows.iter().map(|r| r.get::<_, i32>(0)).collect::<Vec<_>>()),
        Err(e) => db_err(&e),
    };
    tx.rollback().unwrap();
    v
}

#[test]
#[ignore = "requires the local rig from run-local.sh"]
fn ce_catalogue_through_postgrest() {
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let (cipher, _) = rt.block_on(common::cipher());
    let ks = cipher.default_keyset();
    let mut db = postgres::Client::connect(&env("EQL_TEST_DATABASE_URL"), postgres::NoTls).unwrap();
    let (uid_a, uid_b) = (env("UID_A"), env("UID_B"));
    let mut out = serde_json::Map::new();

    db.batch_execute(
        "CREATE SCHEMA IF NOT EXISTS app;
         DROP TABLE IF EXISTS app.assets;
         CREATE TABLE app.assets (
           id int PRIMARY KEY,
           owner uuid NOT NULL,
           subject_ref public.eql_v3_text_eq,
           wrapped_dek public.eql_v3_text);
         CREATE INDEX assets_subject_ref_idx ON app.assets (eql_v3.eq_term(subject_ref));
         ALTER TABLE app.assets ENABLE ROW LEVEL SECURITY;
         CREATE POLICY own ON app.assets FOR SELECT TO authenticated USING (owner = auth.uid());
         GRANT USAGE ON SCHEMA app TO authenticated;
         GRANT SELECT ON app.assets TO authenticated;
         DO $$ BEGIN CREATE ROLE eql_probe_reader NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
         GRANT eql_probe_reader TO postgres;
         GRANT USAGE ON SCHEMA app TO eql_probe_reader;
         GRANT SELECT ON app.assets TO eql_probe_reader;
         NOTIFY pgrst, 'reload schema';",
    )
    .unwrap();

    // CE01: write. Plaintext DEKs kept only in this process for the round-trip check.
    let mut deks = std::collections::BTreeMap::new();
    for (id, owner, subject) in [(1, &uid_a, "S-001"), (2, &uid_a, "S-002"), (3, &uid_b, "S-001"), (4, &uid_b, "S-003")] {
        let mut raw_key = [0u8; 32];
        std::io::Read::read_exact(&mut std::fs::File::open("/dev/urandom").unwrap(), &mut raw_key).unwrap();
        let dek = STANDARD.encode(raw_key);
        let pr: TextEq = rt.block_on(async { ks.encrypt_as(&subject.to_owned(), col("subject_ref")).await }).unwrap();
        // stack-encrypt at this commit derives no EncryptFrom for the storage-only
        // Text domain, so seal natively and wrap it, as tests/text_eq.rs does for TextEq.
        let native = rt.block_on(async { ks.encrypt(dek.clone(), col("wrapped_dek")).await }).unwrap();
        let wd = Text { v: SchemaVersion::CURRENT, i: col("wrapped_dek").into_inner(), c: native.read(Ciphertext::visitor()).unwrap() };
        db.execute(
            "INSERT INTO app.assets VALUES ($1, $2::text::uuid, $3::text::jsonb::public.eql_v3_text_eq, $4::text::jsonb::public.eql_v3_text)",
            &[&id, owner, &serde_json::to_string(&pr).unwrap(), &serde_json::to_string(&wd).unwrap()],
        )
        .unwrap();
        deks.insert(id, dek);
    }
    // No plaintext in the stored rows (subject refs and DEKs).
    let raw: String = db
        .query_one("SELECT string_agg(subject_ref::text || wrapped_dek::text, '') FROM app.assets", &[])
        .unwrap()
        .get(0);
    let leaked: Vec<&str> = ["S-001", "S-002", "S-003"].into_iter().filter(|p| raw.contains(p)).collect();
    let dek_leaked = deks.values().filter(|d| raw.contains(d.as_str())).count();
    let rows: i64 = db.query_one("SELECT count(*) FROM app.assets", &[]).unwrap().get(0);
    out.insert("CE01".into(), json!({ "rows": rows, "plaintext_refs_in_rows": leaked, "plaintext_deks_in_rows": dek_leaked }));

    // Query operands: the term-only query envelope (SQL path) and a full stored
    // envelope of the same value (what the docs say the supabase-js wrapper sends).
    let q: TextEqQuery = rt.block_on(async { ks.encrypt_as(&"S-001".to_owned(), col("subject_ref")).await }).unwrap();
    let q_json = serde_json::to_string(&q).unwrap();
    let stored_q: TextEq = rt.block_on(async { ks.encrypt_as(&"S-001".to_owned(), col("subject_ref")).await }).unwrap();
    let stored_q_json = serde_json::to_string(&stored_q).unwrap();
    let enc = |s: &str| s.bytes().map(|b| if b.is_ascii_alphanumeric() { (b as char).to_string() } else { format!("%{b:02X}") }).collect::<String>();
    let by_stored = format!("/assets?select=id,subject_ref,wrapped_dek&subject_ref=eq.{}&order=id", enc(&stored_q_json));
    let by_query = format!("/assets?select=id&subject_ref=eq.{}&order=id", enc(&q_json));
    out.insert("operand_bytes".into(), json!({ "query_envelope": q_json.len(), "stored_envelope": stored_q_json.len(), "url_path_and_query": by_stored.len() }));

    // CE02: before the EQL grants.
    wait_ready(&env("JWT_A"));
    let (sa, ba) = get(&by_stored, &env("JWT_A"));
    let (su, bu) = get("/assets?select=id&order=id", &env("JWT_A"));
    out.insert("CE02".into(), json!({
        "sql_eq_as_a": sql_as(&uid_a, &q_json),
        "sql_plaintext_as_a": plain_reads("authenticated", &uid_a, false),
        "sql_plaintext_as_a_index_dropped": plain_reads("authenticated", &uid_a, true),
        "sql_plaintext_as_a_warm_backend": plain_reads_on("authenticated", &uid_a, false, true),
        "pgrst_eq_as_a": { "status": sa, "ids": ids(&ba) },
        "pgrst_plaintext_select_as_a": { "status": su, "ids": ids(&bu) },
    }));

    // CE03: after the grants the permissions doc lists.
    db.batch_execute(
        "GRANT USAGE ON SCHEMA eql_v3, eql_v3_internal TO authenticated;
         GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA eql_v3 TO authenticated;
         GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA eql_v3_internal TO authenticated;
         NOTIFY pgrst, 'reload schema';",
    )
    .unwrap();
    std::thread::sleep(std::time::Duration::from_secs(1));
    wait_ready(&env("JWT_A"));
    let (sa, ba) = get(&by_stored, &env("JWT_A"));
    let (sb, bb) = get(&by_stored, &env("JWT_B"));
    let (sq, bq) = get(&by_query, &env("JWT_A"));
    let (sall, ball) = get("/assets?select=id&order=id", &env("JWT_A"));
    out.insert("CE03".into(), json!({
        "sql_eq_as_a": sql_as(&uid_a, &q_json),
        "sql_eq_as_b": sql_as(&uid_b, &q_json),
        "sql_plaintext_as_a": plain_reads("authenticated", &uid_a, false),
        "sql_plaintext_as_reader_no_eql_grant": plain_reads("eql_probe_reader", &uid_a, false),
        "pgrst_stored_operand_as_a": { "status": sa, "ids": ids(&ba) },
        "pgrst_stored_operand_as_b": { "status": sb, "ids": ids(&bb) },
        "pgrst_query_envelope_as_a": { "status": sq, "ids": ids(&bq) },
        "pgrst_unfiltered_as_a": { "status": sall, "ids": ids(&ball) },
    }));

    // CE04: decrypt what PostgREST returned to A; DEK and ref round-trip.
    let mut ce04 = vec![];
    if let Ok(Value::Array(rows)) = serde_json::from_str::<Value>(&ba) {
        for r in rows {
            let id = r["id"].as_i64().unwrap() as i32;
            let wd: Text = serde_json::from_value(r["wrapped_dek"].clone()).unwrap();
            let pr: TextEq = serde_json::from_value(r["subject_ref"].clone()).unwrap();
            let native = wd.c.clone().read(NativeLeaf).unwrap();
            let dek: String = rt.block_on(async { cipher.decrypt(native, col("wrapped_dek")).await }).unwrap();
            let p: String = rt.block_on(async { cipher.decrypt_as(pr, col("subject_ref").into()).await }).unwrap();
            ce04.push(json!({ "id": id, "dek_matches": deks.get(&id) == Some(&dek), "dek_bytes": STANDARD.decode(&dek).map(|b| b.len()).unwrap_or(0), "subject_ref": p }));
        }
    }
    out.insert("CE04".into(), json!(ce04));

    // CE05: the index is usable for the equality predicate.
    db.batch_execute("SET enable_seqscan = off").unwrap();
    let plan: Vec<String> = db
        .query("EXPLAIN SELECT id FROM app.assets WHERE subject_ref = $1::text::jsonb::eql_v3.query_text_eq", &[&q_json])
        .unwrap()
        .iter()
        .map(|r| r.get::<_, String>(0))
        .collect();
    out.insert("CE05".into(), json!({ "uses_index": plan.iter().any(|l| l.contains("assets_subject_ref_idx")), "plan": plan }));

    let result = Value::Object(out);
    std::fs::write(env("OUT"), serde_json::to_string_pretty(&result).unwrap()).unwrap();
    println!("{}", serde_json::to_string_pretty(&result).unwrap());
}
