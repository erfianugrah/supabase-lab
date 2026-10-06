import { useEffect, useState } from "react";

// The signal that JavaScript ran: the server-rendered text says "static", and
// only a hydrated island replaces it. With PUBLIC_SUPABASE_URL set at build
// time it also calls the project's Auth health endpoint with the anon key, the
// way a real app's first API call would.
export default function Island() {
  const [state, setState] = useState("static (island not hydrated)");
  const [api, setApi] = useState("not called");
  const [n, setN] = useState(0);
  useEffect(() => {
    setState("hydrated");
    const url = import.meta.env.PUBLIC_SUPABASE_URL;
    const key = import.meta.env.PUBLIC_SUPABASE_ANON_KEY;
    if (url && key) {
      fetch(`${url}/auth/v1/health`, { headers: { apikey: key } })
        .then((r) => setApi(`HTTP ${r.status}`))
        .catch((e) => setApi(`error: ${String(e)}`));
    }
  }, []);
  return (
    <section className="mt-6 rounded border border-neutral-300 bg-white p-4 text-sm">
      <p>
        island: <strong id="island-state">{state}</strong>
      </p>
      <p>
        api: <span id="api-state">{api}</span>
      </p>
      <button type="button" className="mt-2 rounded bg-emerald-500 px-3 py-1 text-white" onClick={() => setN(n + 1)}>
        clicked {n}
      </button>
    </section>
  );
}
