// OB01 client. Not run directly: the module renders it per variant, replacing
// the two double-underscore placeholders below (the npm alias of one
// supabase-js release, and the opt-in tracing subpath import that exists from
// the release that introduced it - empty for earlier releases and for the
// "forgot the import" control).
//
// Output: one JSON line on stdout, prefixed "OBJSON ".
import { context, trace } from "@opentelemetry/api";
import { AlwaysOffSampler, NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { createClient } from "__SDK__";
__TRACING_IMPORT__

const url = process.env.OB_URL!;
const key = process.env.OB_KEY!;
const sampled = process.env.OB_SAMPLED !== "off";
const noProp = process.env.OB_PROPAGATE === "off";

const warnings: string[] = [];
const origWarn = console.warn;
console.warn = (...a: unknown[]) => {
  warnings.push(a.map(String).join(" ").slice(0, 300));
};
void origWarn;

const provider = new NodeTracerProvider(sampled ? {} : { sampler: new AlwaysOffSampler() });
provider.register();
const tracer = trace.getTracer("ob01");

type Seen = { url: string; traceparent: string | null; tracestate: string | null; baggage: string | null };
const seen: Seen[] = [];
const recording: typeof fetch = async (input, init) => {
  const u = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
  const h = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  seen.push({ url: u, traceparent: h.get("traceparent"), tracestate: h.get("tracestate"), baggage: h.get("baggage") });
  return fetch(input as RequestInfo, init);
};
const fake: typeof fetch = async (input, init) => {
  const u = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
  const h = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  seen.push({ url: u, traceparent: h.get("traceparent"), tracestate: h.get("tracestate"), baggage: h.get("baggage") });
  return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
};

const opts = noProp ? {} : { tracePropagation: true };
// biome-ignore lint/suspicious/noExplicitAny: option exists from 2.106.0, absent in older typings
const sb = createClient(url, key, { ...(opts as any), global: { fetch: recording } });
// biome-ignore lint/suspicious/noExplicitAny: same
const third = createClient("https://third-party.example.test", key, { ...(opts as any), global: { fetch: fake } });

// biome-ignore lint/suspicious/noExplicitAny: same
const fakeSb = createClient(url, key, { ...(opts as any), global: { fetch: fake } });

const out: Record<string, unknown> = { traceIds: {}, rest: null, fn: null };
const ids = out.traceIds as Record<string, string>;

await tracer.startActiveSpan("ob01-rest", async (span) => {
  ids.rest = span.spanContext().traceId;
  const r = await sb.from("ob_probe").select("*").limit(1);
  out.rest = { status: r.status, error: r.error?.message ?? null };
  span.end();
});
await tracer.startActiveSpan("ob01-fn", async (span) => {
  ids.fn = span.spanContext().traceId;
  const r = await sb.functions.invoke("ob-echo", { body: { hello: "ob01" } });
  out.fn = { error: r.error?.message ?? null, data: r.data ?? null };
  span.end();
});
await tracer.startActiveSpan("ob01-third", async (span) => {
  ids.third = span.spanContext().traceId;
  // (a) a client whose own base URL is a non-Supabase host (the self-hosted shape)
  await third.from("anything").select("*");
  // (b) the Supabase client's wrapped fetch pointed at hosts that are not its own.
  // The custom fetch underneath is a fake, so nothing leaves the machine.
  // biome-ignore lint/suspicious/noExplicitAny: `fetch` is a public field on the client but not in every typing
  const wrapped = (fakeSb as any).fetch as typeof fetch;
  for (const u of [
    "https://third-party.example.test/x",
    "https://xsupabase.co/x",
    "https://supabase.co.example.test/x",
    "https://abcdefghijklmnopqrst.supabase.co/x",
  ]) {
    await wrapped(u);
  }
  span.end();
});
// Control: no active span.
context.with(context.active(), () => undefined);
await sb.from("ob_probe").select("*").limit(1);
// Control: Edge Function invoke with no active span; what does the function itself receive?
const noSpanFn = await sb.functions.invoke("ob-echo", { body: { hello: "no-span" } });
out.fnNoSpan = noSpanFn.data ?? null;

await provider.shutdown();
out.seen = seen.map((s) => ({ ...s, url: s.url.replace(/https:\/\/[a-z]{20}\.supabase\.co/, "https://<ref>.supabase.co") }));
out.warnings = warnings;
console.log(`OBJSON ${JSON.stringify(out)}`);
