/**
 * The agent's tools, one per app function, all executed through the caller's
 * RLS-scoped client. Nothing here takes a user id, department or role as an
 * argument: column defaults (auth.uid(), private.my_department()) and the
 * policies in sql/10-app.sql and sql/20-agent.sql supply them from the JWT.
 *
 * Write tools are two-step: without `confirmed` they return a
 * status "confirm" payload and touch nothing; the client confirms with a
 * second call. Every executed call (success or database refusal) is written
 * to agent_audit through the same client, so the audit row is attributed by
 * the same defaults and checked by the "audit: write own" policy.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.117.2";

// gte-small in Edge Runtime: 384 dims; mean_pool + normalize gives unit
// vectors, which is why match_kb_chunks orders by inner product.
// https://supabase.com/docs/guides/functions/ai-models
// The Supabase global is provided by Edge Runtime. Typed locally because
// `deno check` (2.9) did not pick up the edge-runtime.d.ts globals.
type EmbedSession = { run(input: string, opts: { mean_pool: boolean; normalize: boolean }): Promise<unknown> };
const { Supabase } = globalThis as unknown as { Supabase: { ai: { Session: new (model: string) => EmbedSession } } };
const embedder = new Supabase.ai.Session("gte-small");

export async function embed(text: string): Promise<number[]> {
  const out = await embedder.run(text, { mean_pool: true, normalize: true });
  return Array.from(out as ArrayLike<number>);
}

export const WRITE_TOOLS = new Set(["create_request", "decide_request"]);

/** Anthropic tool definitions (JSON Schema). strict: true keeps inputs schema-valid. */
export const TOOL_DEFS = [
  {
    name: "search_kb",
    description:
      "Search the company knowledge base (purchasing policy, department rules). Returns only articles the signed-in user may read.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look up, in plain English." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "list_requests",
    description:
      "List purchase requests visible to the signed-in user (their own department), newest first.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["pending", "approved", "rejected", "any"],
          description: "Filter by status; 'any' for all.",
        },
      },
      required: ["status"],
      additionalProperties: false,
    },
  },
  {
    name: "create_request",
    description:
      "Submit a new purchase request as the signed-in user. The user must confirm before it runs.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        item: { type: "string" },
        vendor: { type: "string" },
        amount: { type: "number", description: "Amount in the company currency, >= 0." },
        justification: { type: "string" },
      },
      required: ["item", "vendor", "amount", "justification"],
      additionalProperties: false,
    },
  },
  {
    name: "decide_request",
    description:
      "Approve or reject a purchase request by id, as the signed-in user. The database decides whether the user may; the user must confirm before it runs.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        request_id: { type: "string", description: "The request's uuid, from list_requests." },
        decision: { type: "string", enum: ["approved", "rejected"] },
        note: { type: "string", description: "Decision note; empty string for none." },
      },
      required: ["request_id", "decision", "note"],
      additionalProperties: false,
    },
  },
];

export type ToolOutcome =
  | { status: "ok"; tool: string; input: Record<string, unknown>; result: unknown; audited: boolean }
  | { status: "error"; tool: string; input: Record<string, unknown>; error: string; audited: boolean }
  | { status: "confirm"; tool: string; input: Record<string, unknown>; summary: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function str(input: Record<string, unknown>, k: string, max = 500): string {
  const v = input[k];
  if (typeof v !== "string" || v.trim() === "" || v.length > max) {
    throw new Error(`${k} must be a non-empty string of at most ${max} characters`);
  }
  return v.trim();
}

/** Validate and normalise the model's (or client's) input. Throws on bad input. */
export function validate(tool: string, input: Record<string, unknown>): Record<string, unknown> {
  switch (tool) {
    case "search_kb":
      return { query: str(input, "query") };
    case "list_requests": {
      const s = input.status ?? "any";
      if (!["pending", "approved", "rejected", "any"].includes(String(s))) throw new Error("bad status");
      return { status: s };
    }
    case "create_request": {
      const amount = Number(input.amount);
      if (!Number.isFinite(amount) || amount < 0 || amount > 1e9) throw new Error("amount must be a number >= 0");
      return {
        item: str(input, "item", 200),
        vendor: str(input, "vendor", 200),
        amount: Math.round(amount * 100) / 100,
        justification: str(input, "justification", 1000),
      };
    }
    case "decide_request": {
      const id = str(input, "request_id", 64);
      if (!UUID.test(id)) throw new Error("request_id must be a uuid");
      const decision = input.decision;
      if (decision !== "approved" && decision !== "rejected") throw new Error("decision must be approved or rejected");
      const note = typeof input.note === "string" ? input.note.slice(0, 1000) : "";
      return { request_id: id, decision, note };
    }
    default:
      throw new Error(`unknown tool ${tool}`);
  }
}

function summarise(tool: string, input: Record<string, unknown>): string {
  if (tool === "create_request") {
    return `Submit a request for ${input.item} from ${input.vendor}, amount ${input.amount}: ${input.justification}`;
  }
  if (tool === "decide_request") {
    return `Mark request ${input.request_id} as ${input.decision}${input.note ? ` (note: ${input.note})` : ""}`;
  }
  return tool;
}

async function execute(db: SupabaseClient, tool: string, input: Record<string, unknown>): Promise<unknown> {
  switch (tool) {
    case "search_kb": {
      const v = await embed(String(input.query));
      // match_kb_chunks is SECURITY INVOKER: RLS on kb_chunks decides which rows can match.
      const { data, error } = await db.rpc("match_kb_chunks", { query_embedding: JSON.stringify(v), match_count: 5 });
      if (error) throw new Error(error.message);
      return data;
    }
    case "list_requests": {
      let q = db
        .from("purchase_requests")
        .select("id, item, vendor, amount, justification, status, requester_id, decision_note, created_at")
        .order("created_at", { ascending: false })
        .limit(50);
      if (input.status !== "any") q = q.eq("status", input.status as string);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return data;
    }
    case "create_request": {
      // Only the four granted columns; department, requester and status come from defaults.
      const { data, error } = await db
        .from("purchase_requests")
        .insert({ item: input.item, vendor: input.vendor, amount: input.amount, justification: input.justification })
        .select("id, item, vendor, amount, status, created_at")
        .single();
      if (error) throw new Error(error.message);
      return data;
    }
    case "decide_request": {
      const { data, error } = await db.rpc("decide_purchase_request", {
        request_id: input.request_id,
        decision: input.decision,
        note: input.note === "" ? null : input.note,
      });
      if (error) throw new Error(error.message);
      const r = data as { id: string; status: string; decided_at: string };
      return { id: r.id, status: r.status, decided_at: r.decided_at };
    }
  }
  throw new Error(`unknown tool ${tool}`);
}

async function audit(db: SupabaseClient, tool: string, args: Record<string, unknown>, summary: string): Promise<boolean> {
  const { error } = await db.from("agent_audit").insert({ tool, args, result_summary: summary.slice(0, 500) });
  if (error) console.error("agent_audit insert failed:", error.message);
  return !error;
}

/**
 * Run one tool call as the caller. Write tools need `confirmed: true`.
 * Bad input is returned as an error without executing or auditing.
 */
export async function runTool(
  db: SupabaseClient,
  tool: string,
  rawInput: Record<string, unknown>,
  confirmed: boolean,
): Promise<ToolOutcome> {
  let input: Record<string, unknown>;
  try {
    input = validate(tool, rawInput ?? {});
  } catch (e) {
    return { status: "error", tool, input: rawInput ?? {}, error: (e as Error).message, audited: false };
  }
  if (WRITE_TOOLS.has(tool) && !confirmed) {
    return { status: "confirm", tool, input, summary: summarise(tool, input) };
  }
  try {
    const result = await execute(db, tool, input);
    const n = Array.isArray(result) ? `${result.length} rows` : "ok";
    const audited = await audit(db, tool, input, n);
    return { status: "ok", tool, input, result, audited };
  } catch (e) {
    const msg = (e as Error).message;
    const audited = await audit(db, tool, input, `error: ${msg}`);
    return { status: "error", tool, input, error: msg, audited };
  }
}
