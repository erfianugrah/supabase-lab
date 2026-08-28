/**
 * L12 - supabase-js through a transparent proxy, tested in a real browser.
 *
 * Serves a page at / that runs supabase-js (createClient pointed at this
 * worker's own origin) against the proxied REST/Auth/Storage/Realtime paths,
 * and forwards everything else to UPSTREAM (<ref>.supabase.co). The chrome
 * agent loads the page and reads the results element. The expected finding:
 * REST/Auth/Storage survive path-prefix proxying; Realtime's WebSocket upgrade
 * is the casualty.
 *
 * Deployed to workers.dev (no zone). Config at deploy: UPSTREAM, ANON.
 */
export interface Env {
  UPSTREAM: string;
  ANON: string;
}

const page = (anon: string) => `<!doctype html><html><head><meta charset=utf8><title>L12 running</title></head>
<body><h3>L12 supabase-js through proxy</h3><pre id="results">running...</pre>
<script type="module">
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const sb = createClient(location.origin, ${JSON.stringify(anon)}, { realtime: { params: { eventsPerSecond: 2 } } });
const out = { rest:'?', auth:'?', storage:'?', realtime:'pending' };
const render = () => { document.getElementById('results').textContent = JSON.stringify(out); document.title = 'L12:'+JSON.stringify(out); };
try { const { data, error } = await sb.from('l12_probe').select('id'); out.rest = error ? ('ERR '+error.message) : ('ok rows='+(data?.length ?? 0)); } catch(e){ out.rest='EX '+e.message; }
try { const { data, error } = await sb.storage.listBuckets(); out.storage = error ? ('ERR '+error.message) : ('ok n='+(data?.length ?? 0)); } catch(e){ out.storage='EX '+e.message; }
try { const { error } = await sb.auth.getSession(); out.auth = error ? ('ERR '+error.message) : 'ok'; } catch(e){ out.auth='EX '+e.message; }
render();
try {
  const ch = sb.channel('l12-'+Math.random()).subscribe((status, err) => { out.realtime = status + (err? (' '+err.message):''); render(); });
  setTimeout(() => { if (out.realtime === 'pending') out.realtime = 'no-status-8s'; render(); }, 8000);
} catch(e){ out.realtime='EX '+e.message; render(); }
render();
</script></body></html>`;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/" || url.pathname === "") {
      return new Response(page(env.ANON), { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    // Transparent forward (including the Realtime WS upgrade).
    const target = new URL(url.pathname + url.search, env.UPSTREAM);
    return fetch(new Request(target, req));
  },
};
