/**
 * K02 - the in-app agent acts as the signed-in user, and only as them.
 *
 * Drives the deployed `agent` Edge Function over HTTPS with real user JWTs
 * (password sign-in with the publishable key), through its deterministic tool
 * layer (`mode: "tool"`): the same runTool() path the chat loop uses for every
 * model tool call, minus the model. That keeps the RLS guarantees provable
 * without an LLM key and without model nondeterminism; the chat path gets one
 * probe of its own at the end, reported as info when no key is configured.
 *
 * Fixture rows are created through the agent itself (so creation is under
 * test too), marked by a justification prefix, and deleted as the owner at
 * the end so the K01 positive-control counts stay at the seed values. Audit
 * rows are kept: they are the evidence for K02.09.
 *
 * Needs: the function deployed (make fn-deploy), the seed (make seed-ready),
 * real embeddings (make kb-embed), and evidence/users-<ref>.json from the
 * seed (read from the experiment dir, the cwd under `make probe`; override
 * with PVLAB_USERS_FILE).
 */
import { readFileSync } from "node:fs";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { mgmt } from "../../../harness/src/mgmt";
import { asOwner } from "../lib/pg";

const MARK = "K02 probe";
type Who = "alice" | "bob" | "carol";
const EMAIL: Record<Who, string> = {
  alice: "alice@example.com",
  bob: "bob@example.com",
  carol: "carol@example.com",
};

interface Session {
  jwt: string;
  id: string;
}

interface Call {
  status: number;
  body: Record<string, unknown>;
}

/** An executed tool call we expect to find in agent_audit. */
interface Executed {
  who: Who;
  tool: string;
}

const lit = (s: string) => `'${s.replaceAll("'", "''")}'`;

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

async function call(ctx: Ctx, pub: string, jwt: string | null, body: unknown): Promise<Call> {
  const headers: Record<string, string> = { apikey: pub, "Content-Type": "application/json" };
  if (jwt) headers.Authorization = `Bearer ${jwt}`;
  const r = await fetch(`https://${ctx.apiHost}/functions/v1/agent`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text.slice(0, 300) };
  }
  return { status: r.status, body: parsed };
}

const tool = (name: string, input: Record<string, unknown>, confirm = false) => ({
  mode: "tool",
  tool: name,
  input,
  confirm,
});

const mod: TestModule = {
  id: "K02",
  title: "in-app agent acts as the signed-in user (Edge Function tool layer, RLS, audit)",
  where: "local",
  requires: ["pooler", "pat"],
  async run(ctx: Ctx): Promise<TestResult[]> {
    const results: TestResult[] = [];
    const add = (n: number, title: string, pass: boolean, detail: string, evidence = "") =>
      results.push({
        id: `K02.${String(n).padStart(2, "0")}`,
        title,
        status: pass ? "pass" : "fail",
        detail,
        evidence: evidence.slice(0, 800),
      });

    const usersFile = process.env.PVLAB_USERS_FILE ?? `evidence/users-${ctx.ref}.json`;
    let pub: string;
    const s = {} as Record<Who, Session>;
    try {
      const creds = JSON.parse(readFileSync(usersFile, "utf8")) as Record<string, string>;
      pub = await publishableKey(ctx);
      for (const who of Object.keys(EMAIL) as Who[]) {
        const pw = creds[EMAIL[who]];
        if (!pw) throw new Error(`${EMAIL[who]} missing from ${usersFile}`);
        s[who] = await signIn(ctx, pub, EMAIL[who], pw);
      }
    } catch (e) {
      return [{ id: "K02", title: this.title, status: "fail", detail: `setup: ${(e as Error).message}` }];
    }

    const startedAt = (await asOwner(ctx, "select now()")).value;
    const executed: Executed[] = [];
    const notAudited: string[] = [];
    // Every input below is valid, so every ok/error outcome was executed
    // (input-validation errors are the only unexecuted, unaudited kind).
    const track = (who: Who, c: Call) => {
      const st = c.body.status;
      if (st === "ok" || st === "error") {
        executed.push({ who, tool: String(c.body.tool) });
        if (c.body.audited !== true) notAudited.push(`${who}:${c.body.tool}`);
      }
    };

    try {
      // 1. The gateway refuses a call with no user JWT (verify_jwt on).
      const anon = await call(ctx, pub, null, tool("list_requests", { status: "any" }));
      add(1, "no JWT: refused before the function runs", anon.status === 401, `http ${anon.status}`, JSON.stringify(anon.body));

      // 2. A write without confirmation returns a proposal and changes nothing.
      const proposeInput = { item: "Demo laptop", vendor: "Acme Hardware", amount: 1500, justification: `${MARK}: demo unit` };
      const proposed = await call(ctx, pub, s.alice.jwt, tool("create_request", proposeInput));
      const before = await asOwner(ctx, `select count(*) from public.purchase_requests where justification like ${lit(`${MARK}%`)}`);
      add(
        2,
        "alice: create_request without confirm returns a proposal, writes nothing",
        proposed.status === 200 && proposed.body.status === "confirm" && before.value === "0",
        `status=${proposed.body.status}, rows=${before.value}`,
        JSON.stringify(proposed.body),
      );

      // 3. Confirmed: the row lands as alice, in Sales, pending.
      const created = await call(ctx, pub, s.alice.jwt, tool("create_request", proposeInput, true));
      track("alice", created);
      const newId = String((created.body.result as { id?: string } | undefined)?.id ?? "");
      const row = newId
        ? await asOwner(
            ctx,
            `select r.requester_id = ${lit(s.alice.id)}::uuid and d.name = 'Sales' and r.status = 'pending' from public.purchase_requests r join public.departments d on d.id = r.department_id where r.id = ${lit(newId)}::uuid`,
          )
        : { ok: false, value: "no id returned" };
      add(
        3,
        "alice: confirmed create_request lands as alice / Sales / pending",
        created.body.status === "ok" && row.value === "t",
        `status=${created.body.status}, owner check=${row.value}`,
        JSON.stringify(created.body),
      );

      // 4. Alice approving her own request: refused by the database.
      const self = await call(ctx, pub, s.alice.jwt, tool("decide_request", { request_id: newId, decision: "approved", note: "" }, true));
      track("alice", self);
      const stillPending = await asOwner(ctx, `select status from public.purchase_requests where id = ${lit(newId)}::uuid`);
      add(
        4,
        "alice: approving her own request is refused by the database",
        self.body.status === "error" && String(self.body.error).includes("not permitted or not found") && stillPending.value === "pending",
        `error="${self.body.error}", row status=${stillPending.value}`,
        JSON.stringify(self.body),
      );

      // 5. Bob (Sales manager) approves it.
      const approve = await call(ctx, pub, s.bob.jwt, tool("decide_request", { request_id: newId, decision: "approved", note: "ok" }, true));
      track("bob", approve);
      const decided = await asOwner(
        ctx,
        `select status || ',' || (decided_by = ${lit(s.bob.id)}::uuid)::text from public.purchase_requests where id = ${lit(newId)}::uuid`,
      );
      add(
        5,
        "bob: approving in Sales works, decided_by is bob",
        approve.body.status === "ok" && decided.value === "approved,true",
        `status=${approve.body.status}, row=${decided.value}`,
        JSON.stringify(approve.body),
      );

      // 6. Carol (Marketing) cannot decide a Sales request either.
      const cross = await call(ctx, pub, s.carol.jwt, tool("decide_request", { request_id: newId, decision: "rejected", note: "" }, true));
      track("carol", cross);
      add(
        6,
        "carol: deciding a Sales request is refused",
        cross.body.status === "error" && String(cross.body.error).includes("not permitted or not found"),
        `error="${cross.body.error}"`,
        JSON.stringify(cross.body),
      );

      // 7. Forged identity fields in the tool input are dropped: the row lands
      //    as carol / Marketing / pending whatever the input claims.
      const forged = await call(
        ctx,
        pub,
        s.carol.jwt,
        tool(
          "create_request",
          {
            item: "Banner print",
            vendor: "Acme Print",
            amount: 90,
            justification: `${MARK}: forged fields`,
            requester_id: s.bob.id,
            department_id: "00000000-0000-0000-0000-000000000000",
            status: "approved",
          },
          true,
        ),
      );
      track("carol", forged);
      const fid = String((forged.body.result as { id?: string } | undefined)?.id ?? "");
      const frow = fid
        ? await asOwner(
            ctx,
            `select r.requester_id = ${lit(s.carol.id)}::uuid and d.name = 'Marketing' and r.status = 'pending' from public.purchase_requests r join public.departments d on d.id = r.department_id where r.id = ${lit(fid)}::uuid`,
          )
        : { ok: false, value: "no id returned" };
      add(
        7,
        "carol: identity fields in tool input are ignored (session decides)",
        forged.body.status === "ok" && frow.value === "t",
        `status=${forged.body.status}, owner check=${frow.value}`,
        JSON.stringify(forged.body),
      );

      // 8/9. Retrieval: a Sales-targeted query. Carol must get no Sales-only
      //      chunk; alice (positive control) must get one.
      const q = { query: "What is the cap on Sales client entertainment and trade show spend?" };
      const salesIds = await asOwner(
        ctx,
        "select string_agg(k.id::text, ',') from public.kb_chunks k join public.departments d on d.id = k.department_id where d.name = 'Sales'",
      );
      const sales = new Set(salesIds.value.split(",").filter(Boolean));
      const carolHits = await call(ctx, pub, s.carol.jwt, tool("search_kb", q));
      track("carol", carolHits);
      const ch = (carolHits.body.result ?? []) as { id: string; title: string; similarity: number }[];
      const leaked = ch.filter((h) => sales.has(h.id));
      add(
        8,
        "carol: search_kb for a Sales topic returns no Sales-only chunk",
        carolHits.body.status === "ok" && ch.length > 0 && leaked.length === 0 && sales.size === 2,
        `${ch.length} hits, ${leaked.length} Sales-only; top: ${ch[0]?.title} (${ch[0]?.similarity?.toFixed(3)})`,
        JSON.stringify(ch.map((h) => [h.title, Number(h.similarity.toFixed(3))])),
      );
      const aliceHits = await call(ctx, pub, s.alice.jwt, tool("search_kb", q));
      track("alice", aliceHits);
      const ah = (aliceHits.body.result ?? []) as { id: string; title: string; similarity: number }[];
      add(
        9,
        "positive control: alice gets the Sales chunks for the same query, ranked first",
        aliceHits.body.status === "ok" && ah.length > 0 && sales.has(ah[0].id),
        `${ah.filter((h) => sales.has(h.id)).length} Sales hits; top: ${ah[0]?.title} (${ah[0]?.similarity?.toFixed(3)})`,
        JSON.stringify(ah.map((h) => [h.title, Number(h.similarity.toFixed(3))])),
      );

      // 10. Every executed tool call is in agent_audit, as the user who made it.
      const audit = await asOwner(
        ctx,
        `select coalesce(string_agg(u.email || ':' || a.tool, ',' order by u.email, a.tool), '') from public.agent_audit a join auth.users u on u.id = a.user_id where a.created_at >= ${lit(startedAt)}::timestamptz and u.email in (${Object.values(EMAIL).map(lit).join(", ")})`,
      );
      const want = executed.map((e) => `${EMAIL[e.who]}:${e.tool}`).sort().join(",");
      const got = audit.value.split(",").filter(Boolean).sort().join(",");
      add(
        10,
        "every executed tool call is in agent_audit as the right user",
        audit.ok && want === got && notAudited.length === 0,
        `${executed.length} executed, ${got.split(",").filter(Boolean).length} audit rows${notAudited.length ? `; not audited: ${notAudited.join(" ")}` : ""}`,
        `want=${want}\ngot =${got}`,
      );

      // 11. list_requests is department-scoped: carol's new Marketing row is
      //     not visible to alice. (Not audited-checked: runs after K02.10.)
      const listed = await call(ctx, pub, s.alice.jwt, tool("list_requests", { status: "any" }));
      const reqs = (listed.body.result ?? []) as { id: string }[];
      const fidVisible = reqs.some((r) => r.id === fid);
      add(
        11,
        "alice: list_requests shows Sales rows only (carol's new Marketing row absent)",
        listed.body.status === "ok" && reqs.length > 0 && !fidVisible && listed.body.audited === true,
        `${reqs.length} rows, carol's row visible=${fidVisible}, audited=${listed.body.audited}`,
      );

      // 12. Chat path: live only with ANTHROPIC_API_KEY set as a function secret.
      const chat = await call(ctx, pub, s.alice.jwt, {
        mode: "chat",
        messages: [{ role: "user", content: "List my department's pending purchase requests." }],
      });
      const llmMissing = chat.status === 503 && chat.body.code === "llm_not_configured";
      results.push({
        id: "K02.12",
        title: "chat path (model + tools)",
        status: llmMissing ? "info" : chat.status === 200 && typeof chat.body.reply === "string" ? "pass" : "fail",
        detail: llmMissing ? `not live: ${chat.body.error}` : `http ${chat.status}`,
        evidence: JSON.stringify(chat.body).slice(0, 800),
      });
    } finally {
      await asOwner(ctx, `delete from public.purchase_requests where justification like ${lit(`${MARK}%`)}`);
    }
    return results;
  },
};

export default mod;
