/**
 * K03 - the in-app agent's chat loop (model + tools) stays inside the user's
 * permissions, and every write waits for the user's confirmation.
 *
 * Drives the deployed `agent` Edge Function over HTTPS with real user JWTs,
 * in `chat` and `confirm` modes: the path the /assistant page uses. K02
 * proves the tool layer without a model; this module proves the same
 * guarantees hold with the model choosing the tool calls, including when the
 * model is told (by the user, or by a knowledge-base article) to do something
 * the user may not.
 *
 * The checks themselves are lib/agent-chat-checks.ts, the same ones
 * `make agent-local` runs against a local Docker stack. Outcomes are checked
 * in the database, never from the model's prose.
 *
 * Self-skips when the function answers 503 llm_not_configured (no
 * ANTHROPIC_API_KEY function secret; `make fn-secret`); reports one failure
 * naming the reason when the model call itself fails (502/504 llm_error).
 *
 * Needs: the function deployed (make fn-deploy), the seed (make seed-ready),
 * real embeddings (make kb-embed), evidence/users-<ref>.json from the seed
 * (override with PVLAB_USERS_FILE). Each chat call is a live model call:
 * nondeterministic wording, up to ~2 minutes each.
 */
import { readFileSync } from "node:fs";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { mgmt } from "../../../harness/src/mgmt";
import { agentChatChecks, type Session, TITLE, type Who } from "../lib/agent-chat-checks";
import { asOwner } from "../lib/pg";

const EMAIL: Record<Who, string> = {
  alice: "alice@example.com",
  bob: "bob@example.com",
  carol: "carol@example.com",
};

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

const mod: TestModule = {
  id: "K03",
  title: TITLE,
  where: "local",
  requires: ["pooler", "pat"],
  async run(ctx: Ctx): Promise<TestResult[]> {
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
      return [{ id: "K03", title: this.title, status: "fail", detail: `setup: ${(e as Error).message}` }];
    }

    const checks = await agentChatChecks({
      functionsUrl: `https://${ctx.apiHost}/functions/v1`,
      publishableKey: pub,
      sessions: s,
      owner: (sql) => asOwner(ctx, sql),
    });
    return checks.map((c) => ({
      id: c.n === 0 ? "K03" : `K03.${String(c.n).padStart(2, "0")}`,
      title: c.title,
      status: c.status,
      detail: c.detail,
      evidence: c.evidence,
      measurements: c.measurements,
    }));
  },
};

export default mod;
