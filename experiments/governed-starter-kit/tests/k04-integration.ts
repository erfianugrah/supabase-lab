/**
 * K04 - a purchase decision notifies an external system, and the integration
 * can neither widen access nor break the decision.
 *
 * Path under test (sql/30-integrations.sql, `make integrations`): a decision
 * through decide_purchase_request -> AFTER UPDATE trigger -> pg_net POST after
 * commit -> the webhook-sink Edge Function, which checks the shared secret and
 * records a receipt in private.webhook_receipts. Decisions are made the way
 * the web app makes them: the Data API with a user JWT from password sign-in
 * (publishable key), so RLS and the decide policy are live, not simulated.
 *
 * The two failure probes swap the receiver's config in Vault for a few
 * seconds (wrong shared secret; a host under .invalid, which never resolves)
 * and restore it from an in-database backup, so the real values never leave
 * the database. A run that died mid-swap is repaired at the start of the next.
 * Fixture requests and their receipts are deleted at the end so K01's
 * positive-control counts stay at the seed values.
 *
 * Needs: the seed (make seed-ready), make integrations, and
 * evidence/users-<ref>.json (override with PVLAB_USERS_FILE).
 */
import { readFileSync } from "node:fs";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { mgmt } from "../../../harness/src/mgmt";
import { asOwner } from "../lib/pg";

const MARK = "K04 probe";
/** Seconds a receipt has to arrive in. pg_net sends after commit, in batches. */
const RECEIPT_WAIT_S = 20;
/** How long "nothing arrives" is watched for before it counts. */
const QUIET_S = 8;
const PAYLOAD_KEYS = [
  "amount",
  "decided_at",
  "decided_by",
  "decided_by_name",
  "decision_note",
  "department",
  "event",
  "event_id",
  "item",
  "request_id",
  "status",
  "vendor",
].join(",");

type Who = "alice" | "bob" | "carol" | "dave";
const EMAIL: Record<Who, string> = {
  alice: "alice@example.com",
  bob: "bob@example.com",
  carol: "carol@example.com",
  dave: "dave@example.com",
};

interface Session {
  jwt: string;
  id: string;
}

const lit = (s: string) => `'${s.replaceAll("'", "''")}'`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function publishableKey(ctx: Ctx): Promise<string> {
  const r = await mgmt(ctx, "GET", `/projects/${ctx.ref}/api-keys?reveal=true`);
  const keys = (r.json ?? []) as { type?: string; api_key?: string }[];
  const k = keys.find((x) => x.type === "publishable")?.api_key;
  if (!k) throw new Error(`no publishable key (http ${r.status})`);
  return k;
}

async function signIn(ctx: Ctx, pub: string, email: string, password: string): Promise<Session> {
  const r = await fetch(`https://${ctx.apiHost}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: pub, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!r.ok) throw new Error(`sign-in ${email}: http ${r.status}`);
  const j = (await r.json()) as { access_token: string; user: { id: string } };
  return { jwt: j.access_token, id: j.user.id };
}

interface Rest {
  status: number;
  body: unknown;
}

async function rest(ctx: Ctx, pub: string, jwt: string, path: string, body: unknown): Promise<Rest> {
  const r = await fetch(`https://${ctx.apiHost}/rest/v1/${path}`, {
    method: "POST",
    headers: {
      apikey: pub,
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // keep the raw text
  }
  return { status: r.status, body: parsed };
}

const decide = (ctx: Ctx, pub: string, s: Session, id: string, decision: string, note: string) =>
  rest(ctx, pub, s.jwt, "rpc/decide_purchase_request", { request_id: id, decision, note });

async function createRequest(ctx: Ctx, pub: string, s: Session, item: string, amount: number): Promise<string> {
  const r = await rest(ctx, pub, s.jwt, "purchase_requests", {
    item,
    vendor: "Acme Supplies",
    amount,
    justification: `${MARK}: ${item}`,
  });
  const id = (r.body as { id?: string }[] | undefined)?.[0]?.id;
  if (r.status !== 201 || !id) throw new Error(`create ${item}: http ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  return id;
}

const receiptCount = async (ctx: Ctx, id: string) =>
  Number((await asOwner(ctx, `select count(*) from private.webhook_receipts where request_id = ${lit(id)}::uuid`)).value);

/** Poll until at least one receipt exists for the request, or the budget runs out. */
async function waitReceipt(ctx: Ctx, id: string, budgetS: number): Promise<number> {
  const until = Date.now() + budgetS * 1000;
  while (Date.now() < until) {
    if ((await receiptCount(ctx, id)) > 0) return 1;
    await sleep(1000);
  }
  return 0;
}

// Vault swap/restore, entirely in SQL: the backup is another Vault secret.
const BACKUP = "k04_backup_";
const restoreSql = `
  select private.put_integration_secret(substr(name, ${BACKUP.length + 1}), decrypted_secret)
    from vault.decrypted_secrets where name like '${BACKUP}%';
  delete from vault.secrets where name like '${BACKUP}%';
  select count(*) from vault.secrets where name in ('webhook_sink_url', 'webhook_sink_secret')`;
const backupSql = `
  select private.put_integration_secret('${BACKUP}' || name, decrypted_secret)
    from vault.decrypted_secrets where name in ('webhook_sink_url', 'webhook_sink_secret');
  select count(*) from vault.secrets where name like '${BACKUP}%'`;

/** Responses pg_net stored since `since` (owner view of net._http_response). */
const responsesSince = async (ctx: Ctx, since: string) =>
  (
    await asOwner(
      ctx,
      `select coalesce(string_agg(coalesce(status_code::text, 'err:' || left(error_msg, 60)), ' | ' order by id), '') from net._http_response where created >= ${lit(since)}::timestamptz`,
    )
  ).value;

const mod: TestModule = {
  id: "K04",
  title: "integration: purchase decisions notify an external receiver (pg_net trigger -> Edge Function)",
  where: "local",
  requires: ["pooler", "pat"],
  async run(ctx: Ctx): Promise<TestResult[]> {
    const results: TestResult[] = [];
    const add = (
      n: number,
      title: string,
      pass: boolean,
      detail: string,
      evidence = "",
      measurements?: Record<string, number | string>,
    ) =>
      results.push({
        id: `K04.${String(n).padStart(2, "0")}`,
        title,
        status: pass ? "pass" : "fail",
        detail,
        evidence: evidence.slice(0, 800),
        ...(measurements ? { measurements } : {}),
      });

    const usersFile = process.env.PVLAB_USERS_FILE ?? `evidence/users-${ctx.ref}.json`;
    let pub: string;
    const s = {} as Record<Who, Session>;
    try {
      // A previous run that died mid-swap left a backup: put it back first.
      await asOwner(ctx, restoreSql);
      const cfg = await asOwner(
        ctx,
        "select (select count(*) from vault.secrets where name in ('webhook_sink_url', 'webhook_sink_secret'))::text || ',' || (select count(*) from pg_trigger where tgname = 'on_purchase_request_decided')::text",
      );
      if (cfg.value !== "2,1") throw new Error(`integration not installed (vault entries,trigger = ${cfg.value}) - run make integrations`);
      const creds = JSON.parse(readFileSync(usersFile, "utf8")) as Record<string, string>;
      pub = await publishableKey(ctx);
      for (const who of Object.keys(EMAIL) as Who[]) {
        const pw = creds[EMAIL[who]];
        if (!pw) throw new Error(`${EMAIL[who]} missing from ${usersFile}`);
        s[who] = await signIn(ctx, pub, EMAIL[who], pw);
      }
    } catch (e) {
      return [{ id: "K04", title: this.title, status: "fail", detail: `setup: ${(e as Error).message}` }];
    }

    const ids: string[] = [];
    try {
      const r1 = await createRequest(ctx, pub, s.alice, "Standing desk", 640);
      const r2 = await createRequest(ctx, pub, s.alice, "Monitor arm", 120);
      const r3 = await createRequest(ctx, pub, s.carol, "Event booth", 2200);
      const r4 = await createRequest(ctx, pub, s.carol, "Poster run", 300);
      ids.push(r1, r2, r3, r4);

      // 1-3. Bob (Sales manager) approves alice's request: exactly one
      //      receipt, with the decided row's fields and nothing else.
      const ok = await decide(ctx, pub, s.bob, r1, "approved", "within budget");
      const t0 = Date.now();
      const arrived = await waitReceipt(ctx, r1, RECEIPT_WAIT_S);
      const waitedMs = Date.now() - t0;
      await sleep(3000); // give a duplicate the chance to show up
      const rec = await asOwner(
        ctx,
        `select json_build_object(
           'n', count(*),
           'deliveries', max(w.deliveries),
           'status', max(w.payload ->> 'status'),
           'department', max(w.payload ->> 'department'),
           'item', max(w.payload ->> 'item'),
           'amount', max(w.payload ->> 'amount'),
           'decided_by', max(w.payload ->> 'decided_by'),
           'event_id', max(w.event_id),
           'keys', max((select string_agg(k, ',' order by k) from jsonb_object_keys(w.payload) k)),
           'latency_ms', max(round(extract(epoch from (w.received_at - r.decided_at)) * 1000))
         ) from private.webhook_receipts w join public.purchase_requests r on r.id = w.request_id
          where w.request_id = ${lit(r1)}::uuid`,
      );
      const j = JSON.parse(rec.value || "{}") as Record<string, string | number | null>;
      add(
        1,
        "bob approves a Sales request through the Data API: the decision commits",
        ok.status === 200 && (ok.body as { status?: string }).status === "approved",
        `http ${ok.status}, status=${(ok.body as { status?: string }).status}`,
        JSON.stringify(ok.body),
      );
      add(
        2,
        `exactly one receipt arrives within ${RECEIPT_WAIT_S} s, with the right fields`,
        arrived === 1 &&
          j.n === 1 &&
          j.deliveries === 1 &&
          j.status === "approved" &&
          j.department === "Sales" &&
          j.item === "Standing desk" &&
          Number(j.amount) === 640 &&
          j.decided_by === s.bob.id &&
          j.event_id === `${r1}:approved`,
        `receipts=${j.n}, deliveries=${j.deliveries}, ${j.status}/${j.department}/${j.item}/${j.amount}, decided_by is bob=${j.decided_by === s.bob.id}, decided->received ${j.latency_ms} ms`,
        rec.value,
        { receipt_latency_ms: Number(j.latency_ms ?? -1), poll_wait_ms: waitedMs },
      );
      add(
        3,
        "payload carries only the decided row's own fields (no justification, requester or other rows)",
        j.keys === PAYLOAD_KEYS,
        `keys=${j.keys}`,
      );

      // 4. Refused decisions send nothing: alice approving her own request
      //    and carol (Marketing) rejecting a Sales request.
      const self = await decide(ctx, pub, s.alice, r2, "approved", "");
      const cross = await decide(ctx, pub, s.carol, r2, "rejected", "");
      await sleep(QUIET_S * 1000);
      const n2 = await receiptCount(ctx, r2);
      const st2 = (await asOwner(ctx, `select status from public.purchase_requests where id = ${lit(r2)}::uuid`)).value;
      const msg = (b: unknown) => String((b as { message?: string })?.message ?? JSON.stringify(b)).slice(0, 80);
      add(
        4,
        `refused decisions (employee self-approval, other department) send no receipt in ${QUIET_S} s`,
        self.status >= 400 &&
          cross.status >= 400 &&
          msg(self.body).includes("not permitted or not found") &&
          msg(cross.body).includes("not permitted or not found") &&
          n2 === 0 &&
          st2 === "pending",
        `alice http ${self.status} "${msg(self.body)}"; carol http ${cross.status} "${msg(cross.body)}"; receipts=${n2}; row ${st2}`,
      );

      // 5. The rejection path, in the other department.
      const rej = await decide(ctx, pub, s.dave, r3, "rejected", "not this quarter");
      const got3 = await waitReceipt(ctx, r3, RECEIPT_WAIT_S);
      const rec3 = (
        await asOwner(
          ctx,
          `select count(*)::text || ',' || max(status) || ',' || max(department) from private.webhook_receipts where request_id = ${lit(r3)}::uuid`,
        )
      ).value;
      add(
        5,
        "dave rejects a Marketing request: one receipt, status rejected, department Marketing",
        rej.status === 200 && got3 === 1 && rec3 === "1,rejected,Marketing",
        `http ${rej.status}; receipt ${rec3}`,
      );

      // 6. Wrong shared secret: the sink refuses (401), the decision still commits.
      const backed = await asOwner(ctx, backupSql);
      if (backed.value !== "2") throw new Error(`vault backup failed: ${backed.value}`);
      const since6 = (await asOwner(ctx, "select now()")).value;
      await asOwner(ctx, "select private.put_integration_secret('webhook_sink_secret', 'k04-wrong-secret')");
      const bad = await decide(ctx, pub, s.bob, r2, "approved", "secret mismatch probe");
      await sleep(QUIET_S * 1000);
      const resp6 = await responsesSince(ctx, since6);
      const n6 = await receiptCount(ctx, r2);
      const st6 = (await asOwner(ctx, `select status from public.purchase_requests where id = ${lit(r2)}::uuid`)).value;
      add(
        6,
        "wrong shared secret: sink answers 401, no receipt, the decision still commits",
        bad.status === 200 && st6 === "approved" && n6 === 0 && resp6.split(" | ").includes("401"),
        `decide http ${bad.status}, row ${st6}, receipts=${n6}, pg_net responses since: ${resp6 || "none"}`,
      );

      // 7. Receiver unreachable (DNS never resolves): same outcome.
      await asOwner(ctx, restoreSql.replace(`delete from vault.secrets where name like '${BACKUP}%';`, ""));
      const since7 = (await asOwner(ctx, "select now()")).value;
      await asOwner(ctx, "select private.put_integration_secret('webhook_sink_url', 'https://receiver-down.invalid/hook')");
      const down = await decide(ctx, pub, s.dave, r4, "approved", "receiver down probe");
      await sleep(QUIET_S * 1000);
      const resp7 = await responsesSince(ctx, since7);
      const n7 = await receiptCount(ctx, r4);
      const st7 = (await asOwner(ctx, `select status from public.purchase_requests where id = ${lit(r4)}::uuid`)).value;
      add(
        7,
        "receiver unreachable: pg_net records an error, no receipt, the decision still commits",
        down.status === 200 && st7 === "approved" && n7 === 0 && resp7.includes("err:"),
        `decide http ${down.status}, row ${st7}, receipts=${n7}, pg_net responses since: ${resp7 || "none"}`,
      );
    } catch (e) {
      results.push({ id: "K04", title: this.title, status: "fail", detail: `aborted: ${(e as Error).message}` });
    } finally {
      // 8. Config back to what make integrations set, and the backup gone.
      const restored = await asOwner(ctx, restoreSql);
      const left = (await asOwner(ctx, `select count(*) from vault.secrets where name like '${BACKUP}%'`)).value;
      add(8, "receiver config restored in Vault after the failure probes", restored.value === "2" && left === "0", `entries=${restored.value}, backups left=${left}`);
      if (ids.length) {
        const list = ids.map((i) => `${lit(i)}::uuid`).join(", ");
        await asOwner(ctx, `delete from private.webhook_receipts where request_id in (${list})`);
      }
      await asOwner(ctx, `delete from public.purchase_requests where justification like ${lit(`${MARK}%`)}`);
    }
    return results;
  },
};

export default mod;
