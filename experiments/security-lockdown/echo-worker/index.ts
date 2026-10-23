// Echo receiver for S23. Answers every request with what it read, so the
// caller's stored response is the receipt. Deliberately omits the client
// address: the artifact is published.
export default {
  async fetch(req: Request): Promise<Response> {
    const raw = await req.text();
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(raw); } catch { /* non-JSON body: echo length only */ }
    const record = (body.record ?? {}) as Record<string, unknown>;
    const nonce = String(body.nonce ?? record.note ?? new URL(req.url).searchParams.get("nonce") ?? "");
    const out = {
      received: true,
      receiver: "cf-worker",
      nonce,
      method: req.method,
      ua: req.headers.get("user-agent") ?? "",
      webhook_type: body.type ?? null,
      bytes: raw.length,
      at: new Date().toISOString(),
    };
    console.log(JSON.stringify(out));
    return Response.json(out);
  },
};
