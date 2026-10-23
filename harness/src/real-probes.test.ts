import { describe, expect, test } from "bun:test";
import { classifyRestRead, classifyRealtimeFrame, PROBE_TABLE } from "./real-probes";

describe("classifyRestRead", () => {
  test("200 with the seeded row is up", () => {
    expect(classifyRestRead(200, '[{"id":1}]')).toEqual({ ok: true });
  });

  test("the 401 the old probe counted as up is down here", () => {
    const o = classifyRestRead(401, '{"message":"Invalid API key","hint":"Only the `service_role` API key can be used for this endpoint."}');
    expect(o.ok).toBe(false);
    expect(o.error).toBe("HTTP 401 Invalid API key");
  });

  test("a PostgREST error code is kept as the mode", () => {
    const o = classifyRestRead(503, '{"code":"PGRST002","details":null,"hint":null,"message":"Could not query the database for the schema cache. Retrying."}');
    expect(o).toEqual({ ok: false, error: "HTTP 503 PGRST002" });
  });

  test("200 with the wrong body is not up", () => {
    expect(classifyRestRead(200, "[]")).toEqual({ ok: false, error: "HTTP 200 row-missing" });
    expect(classifyRestRead(200, "<html>")).toEqual({ ok: false, error: "HTTP 200 non-json" });
  });

  test("a gateway page without JSON still names the status", () => {
    expect(classifyRestRead(521, "<html>origin down</html>")).toEqual({ ok: false, error: "HTTP 521" });
  });

  test("table name is the documented constant", () => {
    expect(PROBE_TABLE).toBe("pvlab_probe");
  });
});

describe("classifyRealtimeFrame", () => {
  const topic = "realtime:pvlab-probe";

  test("join reply ok advances to joined", () => {
    const f = { topic, event: "phx_reply", ref: "1", payload: { status: "ok", response: {} } };
    expect(classifyRealtimeFrame(f, topic, "n1")).toEqual({ kind: "joined" });
  });

  test("join reply error is a failure with its reason", () => {
    const f = { topic, event: "phx_reply", ref: "1", payload: { status: "error", response: { reason: "UnableToConnectToProject" } } };
    expect(classifyRealtimeFrame(f, topic, "n1")).toEqual({ kind: "fail", error: "join: UnableToConnectToProject" });
  });

  test("postgres_changes system ok is subscribed", () => {
    const f = { topic, event: "system", payload: { extension: "postgres_changes", status: "ok", message: "Subscribed to PostgreSQL" } };
    expect(classifyRealtimeFrame(f, topic, "n1")).toEqual({ kind: "subscribed" });
  });

  test("postgres_changes system error is a failure", () => {
    const f = { topic, event: "system", payload: { extension: "postgres_changes", status: "error", message: "Too many database timeouts" } };
    expect(classifyRealtimeFrame(f, topic, "n1")).toEqual({ kind: "fail", error: "pg_changes: Too many database timeouts" });
  });

  test("our own broadcast echo with the nonce is delivered", () => {
    const f = { topic, event: "broadcast", payload: { type: "broadcast", event: "ping", payload: { nonce: "n1" } } };
    expect(classifyRealtimeFrame(f, topic, "n1")).toEqual({ kind: "delivered" });
  });

  test("a broadcast with another nonce or another topic is ignored", () => {
    expect(classifyRealtimeFrame({ topic, event: "broadcast", payload: { type: "broadcast", event: "ping", payload: { nonce: "old" } } }, topic, "n1")).toEqual({ kind: "ignore" });
    expect(classifyRealtimeFrame({ topic: "phoenix", event: "phx_reply", payload: { status: "ok" } }, topic, "n1")).toEqual({ kind: "ignore" });
  });

  test("a channel error or close is a failure", () => {
    expect(classifyRealtimeFrame({ topic, event: "phx_error", payload: {} }, topic, "n1")).toEqual({ kind: "fail", error: "channel: phx_error" });
    expect(classifyRealtimeFrame({ topic, event: "phx_close", payload: {} }, topic, "n1")).toEqual({ kind: "fail", error: "channel: phx_close" });
  });
});
