/**
 * webhook-sink: the receiving end of the purchase-decision integration
 * (sql/30-integrations.sql). Stands in for "the external system" in the demo.
 *
 * Auth is a shared secret, not a user JWT: the caller is the database (pg_net),
 * which has no user session. Deployed with --no-verify-jwt for that reason,
 * and fails closed - no WEBHOOK_SINK_SECRET function secret, no receipts.
 * The secret arrives in the x-webhook-secret header and is compared in
 * constant time.
 *
 * Each accepted event is recorded in private.webhook_receipts through
 * public.record_webhook_receipt, an RPC only service_role may execute
 * (the client below uses the project's secret key). Recording is idempotent
 * on event_id, so a redelivery shows up as deliveries > 1, not a second row.
 *
 * Optional: with a SLACK_WEBHOOK_URL function secret set, the first delivery
 * of each event is also posted to that Slack incoming webhook, and the
 * outcome is noted on the receipt. Without it, `forwarded` stays
 * "not configured".
 */
import { createClient } from "npm:@supabase/supabase-js@2.117.2";

const MAX_BODY = 16 * 1024;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function sameSecret(a: string, b: string): Promise<boolean> {
  // Hash both sides so the comparison is over equal-length buffers, then
  // compare every byte.
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function secretKey(): string {
  const plural = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (plural) {
    const k = (JSON.parse(plural) as Record<string, string>).default;
    if (k) return k;
  }
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  throw new Error("no secret key in the function environment");
}

interface DecisionEvent {
  event: string;
  event_id: string;
  request_id: string;
  status: "approved" | "rejected";
  item: string;
  vendor: string;
  amount: number;
  department: string;
  decided_by_name?: string | null;
  decision_note?: string | null;
}

function parseEvent(raw: unknown): DecisionEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (e.event !== "purchase_request.decided") return null;
  if (typeof e.event_id !== "string" || typeof e.request_id !== "string" || !uuid.test(e.request_id)) return null;
  if (e.status !== "approved" && e.status !== "rejected") return null;
  if (typeof e.department !== "string" || typeof e.item !== "string" || typeof e.vendor !== "string") return null;
  return e as unknown as DecisionEvent;
}

async function forwardToSlack(url: string, e: DecisionEvent): Promise<string> {
  const who = e.decided_by_name ? ` by ${e.decided_by_name}` : "";
  const note = e.decision_note ? ` - "${e.decision_note}"` : "";
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: `Purchase request ${e.status}${who} (${e.department}): ${e.item} from ${e.vendor}, ${e.amount}${note}`,
      }),
      signal: AbortSignal.timeout(3000),
    });
    return `slack http ${r.status}`;
  } catch (err) {
    return `slack failed: ${(err as Error).message}`.slice(0, 200);
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });

  const expected = Deno.env.get("WEBHOOK_SINK_SECRET");
  if (!expected) return json(503, { error: "sink not configured (WEBHOOK_SINK_SECRET unset)" });
  const given = req.headers.get("x-webhook-secret") ?? "";
  if (!(await sameSecret(given, expected))) return json(401, { error: "bad or missing x-webhook-secret" });

  const text = await req.text();
  if (text.length > MAX_BODY) return json(413, { error: "body too large" });
  let event: DecisionEvent | null = null;
  try {
    event = parseEvent(JSON.parse(text));
  } catch {
    event = null;
  }
  if (!event) return json(400, { error: "not a purchase_request.decided event" });

  const db = createClient(Deno.env.get("SUPABASE_URL")!, secretKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await db.rpc("record_webhook_receipt", { p_payload: event });
  if (error) return json(500, { error: `record failed: ${error.message}` });
  const row = (Array.isArray(data) ? data[0] : data) as { id: number; deliveries: number };

  const slack = Deno.env.get("SLACK_WEBHOOK_URL");
  if (slack && row.deliveries === 1) {
    const outcome = await forwardToSlack(slack, event);
    await db.rpc("note_webhook_forward", { p_id: row.id, p_forwarded: outcome });
  }
  return json(200, { received: true, event_id: event.event_id, deliveries: row.deliveries });
});
