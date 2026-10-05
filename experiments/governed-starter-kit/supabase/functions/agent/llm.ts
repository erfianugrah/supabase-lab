/**
 * Claude Messages API call over fetch.
 *
 * simplify: raw HTTP instead of the official TypeScript SDK - the SDK is the
 * better default (typed errors, retries, types); swap it in if this grows.
 * The request shape: model claude-opus-5-5, adaptive thinking (on by default
 * for this model; it cannot be disabled), effort set explicitly because this
 * model defaults to medium, and the server-side refusal fallback in its
 * "default" routing form.
 */

export const MODEL = "claude-opus-5-5";
const URL = "https://api.anthropic.com/v1/messages";

export type Block = { type: string; [k: string]: unknown };
export type ToolUse = { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
export type ToolResult = { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };
export type Msg = { role: "user" | "assistant"; content: string | Block[] };

export interface ClaudeResponse {
  content: Block[];
  stop_reason: string | null;
  model: string;
}

export class LlmError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function callClaude(
  apiKey: string,
  req: { system: string; tools: unknown[]; messages: Msg[] },
): Promise<ClaudeResponse> {
  const body = JSON.stringify({
    model: MODEL,
    max_tokens: 16000,
    system: req.system,
    tools: req.tools,
    output_config: { effort: "medium" },
    fallbacks: "default",
    messages: req.messages,
  });
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "server-side-fallback-2026-07-01",
        "content-type": "application/json",
      },
      body,
    });
    if (r.ok) return (await r.json()) as ClaudeResponse;
    const text = await r.text();
    // Retry rate limits, overload and 5xx; everything else is the caller's problem.
    if (attempt < 2 && (r.status === 429 || r.status === 529 || r.status >= 500)) {
      await new Promise((res) => setTimeout(res, 1000 * (attempt + 1)));
      continue;
    }
    let msg = text.slice(0, 300);
    try {
      msg = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? msg;
    } catch { /* keep raw text */ }
    throw new LlmError(r.status, msg);
  }
}
