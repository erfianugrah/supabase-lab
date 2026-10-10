// Log drain sink for OB04. A Worker plus one SQLite-backed Durable Object that
// stores every POST the drain sends: arrival time (Date.now() at the edge),
// the raw body length, the Content-Encoding header, all request headers and the
// decompressed body text. The module reads it back with GET /dump.
//
// Auth: the drain carries a custom header `x-ob-key` (a per-run random value
// bound as the OB_KEY secret). /dump and /clear need the same header.

export class Store {
  constructor(state, env) {
    this.sql = state.storage.sql;
    this.sql.exec(
      "create table if not exists b (id integer primary key autoincrement, recv_ms integer, raw_len integer, enc text, hdr text, proto text, body text)",
    );
  }

  async fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === "/put") {
      const r = await req.json();
      this.sql.exec("insert into b (recv_ms, raw_len, enc, hdr, proto, body) values (?, ?, ?, ?, ?, ?)", r.recv_ms, r.raw_len, r.enc, r.hdr, r.proto, r.body);
      return new Response("ok");
    }
    if (u.pathname === "/dump") {
      const since = Number(u.searchParams.get("since") || 0);
      const rows = this.sql.exec("select id, recv_ms, raw_len, enc, hdr, proto, body from b where id > ? order by id", since).toArray();
      return Response.json(rows);
    }
    if (u.pathname === "/clear") {
      this.sql.exec("delete from b");
      return new Response("cleared");
    }
    return new Response("not found", { status: 404 });
  }
}

async function readBody(req) {
  const raw = await req.arrayBuffer();
  const enc = (req.headers.get("content-encoding") || "").toLowerCase();
  let text;
  let decoded = "none";
  if (enc.includes("gzip")) {
    try {
      const ds = new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream("gzip")));
      text = await ds.text();
      decoded = "gunzipped-by-worker";
    } catch (e) {
      text = `GUNZIP_FAILED ${String(e)}`;
      decoded = "gunzip-failed";
    }
  } else {
    text = new TextDecoder().decode(raw);
  }
  return { rawLen: raw.byteLength, enc, decoded, text };
}

export default {
  async fetch(req, env) {
    const recv = Date.now();
    const u = new URL(req.url);
    const stub = env.STORE.get(env.STORE.idFromName("sink"));
    const authed = req.headers.get("x-ob-key") === env.OB_KEY;
    if (u.pathname === "/ingest" && req.method === "POST") {
      if (!authed) return new Response("unauthorized", { status: 401 });
      const { rawLen, enc, decoded, text } = await readBody(req);
      const hdr = {};
      for (const [k, v] of req.headers) if (k !== "x-ob-key") hdr[k] = v;
      hdr["_method"] = req.method;
      hdr["_decoded"] = decoded;
      await stub.fetch("https://do/put", {
        method: "POST",
        body: JSON.stringify({ recv_ms: recv, raw_len: rawLen, enc, hdr: JSON.stringify(hdr), proto: (req.cf && req.cf.httpProtocol) || "", body: text }),
      });
      return new Response("ok");
    }
    if ((u.pathname === "/dump" || u.pathname === "/clear") && authed) return stub.fetch(`https://do${u.pathname}${u.search}`, { method: req.method });
    if (u.pathname === "/health") return new Response("ok");
    return new Response("not found", { status: 404 });
  },
};
