/**
 * CL20 - the experimental local stack backend (`[experimental] stack = true`,
 * `SUPABASE_EXPERIMENTAL_STACK=1`) inside a Linux container that has no
 * container engine: what starts, how fast, on which ports, and what is asleep.
 *
 * Doc claim under test (Select 2026 notes, alpha, off by default): the stack
 * runs local development without Docker. The CLI's own help text says `auto`
 * picks Docker, then Podman, then the native runtime on supported platforms;
 * this module is the "native" row, measured.
 *
 *   CL20a  the box: architecture, no docker/podman binary, no socket. The
 *          control: `supabase start` with the legacy backend in the same box.
 *   CL20b  cold start: `supabase init` under STACK=1, `supabase start` in an
 *          empty SUPABASE_HOME (so native artifacts are downloaded), wall time,
 *          the runtime the CLI reports, the services and their activation
 *          (eager or lazy), the listening ports.
 *   CL20c  wake: one request per HTTP service, in sequence; first-request
 *          latency and status, then the service table again, then resident
 *          memory summed over the box (an upper bound, shared pages counted
 *          per process).
 *   CL20d  restart: `stop`, then `start` with artifacts cached; wall time and
 *          whether the ports survive.
 *   CL20e  an application flow through the gateway port: create a table with
 *          RLS, sign up and sign in, insert and read back with the user's JWT.
 *
 * Local vantage, Docker required only to host the box.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { dockerReachable, saveRaw, scrub, tail } from "../lib/cli";
import { BOX_ENV, Box, ensureImage, IMAGE, parseStatus, portsOf, stampMs } from "../lib/box";

const kv = (out: string) => {
  const m: Record<string, string> = {};
  for (const l of out.split("\n")) {
    const x = l.match(/^([A-Za-z0-9_]+)=(.*)$/);
    if (x) m[x[1]!] = x[2]!;
  }
  return m;
};

const STACK = { SUPABASE_EXPERIMENTAL_STACK: "1" };

const mod: TestModule = {
  id: "CL20",
  title: "Experimental stack without Docker: cold start, ports, lazy services, restart, app flow",
  where: "local",
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!(await dockerReachable())) return [{ id: "CL20", title: this.title, status: "skip", detail: "no Docker daemon on the host to run the box" }];
    const out: TestResult[] = [];
    let box: Box | undefined;
    try {
      let img: { built: boolean; ms: number };
      try {
        img = await ensureImage();
      } catch (e) {
        return [{ id: "CL20", title: this.title, status: "skip", detail: `box image unavailable, build failed: ${e instanceof Error ? e.message : String(e)}` }];
      }
      ctx.log(`cl20: image ${IMAGE} ${img.built ? `built in ${img.ms} ms` : "present"}`);
      box = await Box.create("cl20");
      const B = box;

      // ---------------- CL20a: the box and the control ----------------
      const facts = kv((await B.sh(`
echo ARCH=$(uname -m); echo KERNEL=$(uname -sr | tr ' ' _)
echo DOCKER_BIN=$(command -v docker || echo none); echo PODMAN_BIN=$(command -v podman || echo none)
echo SOCK=$([ -S /var/run/docker.sock ] && echo present || echo absent)
echo CLI=$(supabase --version); echo NPROC=$(nproc); echo MEM_MB=$(free -m | awk 'NR==2{print $2}'); echo UID=$(id -u)
`)).stdout);
      const ctl = await B.sh(`mkdir -p ~/ctl && cd ~/ctl && supabase init >/dev/null 2>&1
env -u SUPABASE_EXPERIMENTAL_STACK supabase start 2>&1 | head -4; echo "RC=\${PIPESTATUS[0]}"
echo ---0; SUPABASE_EXPERIMENTAL_STACK=0 supabase start 2>&1 | head -4; echo "RC=\${PIPESTATUS[0]}"`);
      const rcs = [...ctl.stdout.matchAll(/RC=(\d+)/g)].map((m) => Number(m[1]));
      out.push({
        id: "CL20a",
        title: "The box has no container engine; the legacy backend fails in it",
        status: facts.DOCKER_BIN === "none" && facts.PODMAN_BIN === "none" && facts.SOCK === "absent" ? "pass" : "fail",
        detail: `${facts.ARCH}, docker ${facts.DOCKER_BIN}, podman ${facts.PODMAN_BIN}, socket ${facts.SOCK}; legacy start exit ${rcs[0]}/${rcs[1]}: ${(ctl.stdout.split("\n").find((l) => /docker|podman/i.test(l)) ?? "").slice(0, 150)}`,
        measurements: {
          arch: facts.ARCH ?? "",
          kernel: facts.KERNEL ?? "",
          cli_version: facts.CLI ?? "",
          cpus: Number(facts.NPROC ?? NaN),
          mem_mb: Number(facts.MEM_MB ?? NaN),
          docker_binary: facts.DOCKER_BIN ?? "",
          podman_binary: facts.PODMAN_BIN ?? "",
          docker_socket: facts.SOCK ?? "",
          runs_as_uid: Number(facts.UID ?? NaN),
          legacy_start_exit_unset_env: rcs[0] ?? -1,
          legacy_start_exit_env0: rcs[1] ?? -1,
          legacy_start_first_error: (ctl.stdout.split("\n").find((l) => /docker|podman/i.test(l)) ?? "").slice(0, 200),
        },
        evidence: tail(ctl.stdout, 10),
      });

      // ---------------- CL20b: cold start ----------------
      const setup = await B.sh(
        `mkdir -p ~/app && cd ~/app && git init -q -b main && supabase init >/dev/null 2>&1
mkdir -p supabase/functions/hello && printf 'Deno.serve(() => new Response("hello from the stack"));\\n' > supabase/functions/hello/index.ts
git add -A && git commit -qm init
echo STACK_KEY=$(grep -c '^stack = true' supabase/config.toml); echo PORT_LINES=$(grep -c '^port = ' supabase/config.toml)`,
        { env: { ...BOX_ENV, ...STACK } },
      );
      const sk = kv(setup.stdout);
      const start = await B.sh(
        `cd ~/app
echo T0=$(date +%s.%N)
supabase start > /tmp/start.out 2>&1; echo RC=$?
echo T1=$(date +%s.%N)
sed -E 's/(sb_(publishable|secret)_)[A-Za-z0-9_-]+/\\1X/; s/(Access Key|Secret Key) +│ [0-9a-f]+/\\1 │ X/' /tmp/start.out | grep -E 'Runtime|Stack is ready|Docker|runtime|rror' | head -8
supabase stack status --output-format json > /tmp/status.json 2>&1; echo STATUS_RC=$?
cat /tmp/status.json
echo ---ss; ss -ltnH | awk '{print $4}' | sort -t: -k2 -n | tr '\\n' ' '`,
        { env: { ...BOX_ENV, ...STACK } },
      );
      const sm = kv(start.stdout);
      const statusJson = start.stdout.split("\n").find((l) => l.startsWith('{"identity"')) ?? "";
      const st = parseStatus(statusJson);
      const ports = portsOf(st);
      saveRaw("cl20b-status.json", scrub(statusJson));
      saveRaw("cl20b-start-banner.txt", scrub(start.stdout.split("---ss")[0] ?? ""));
      const cold = stampMs(start.stdout, "T0", "T1");
      const lis = (start.stdout.split("---ss")[1] ?? "").trim().split(/\s+/).filter(Boolean);
      const cfgPortsHit = lis.filter((a) => /:(54321|54322|54323|54324|54327|8083)$/.test(a)).length;
      const svc = st.services ?? [];
      out.push({
        id: "CL20b",
        title: "Cold start in an empty SUPABASE_HOME with no container engine",
        status: sm.RC === "0" && st.runtime === "native" ? "pass" : "fail",
        detail: `init wrote stack=true: ${sk.STACK_KEY === "1"}, port lines in config: ${sk.PORT_LINES}; start exit ${sm.RC} in ${cold} ms; runtime ${st.runtime}; ${svc.length} services, ${svc.filter((s) => s.state === "running").length} running at return`,
        measurements: {
          init_wrote_stack_true: Number(sk.STACK_KEY ?? -1),
          init_port_lines_in_config: Number(sk.PORT_LINES ?? -1),
          cold_start_ms: cold,
          start_exit: Number(sm.RC ?? -1),
          runtime: st.runtime ?? "",
          lifecycle: st.lifecycle ?? "",
          readiness_at_return: st.readiness ?? "",
          services: svc.map((s) => s.service).join(","),
          running_at_return: svc.filter((s) => s.state === "running").map((s) => s.service).join(","),
          sleeping_at_return: svc.filter((s) => s.state === "sleeping").map((s) => s.service).join(","),
          endpoint_ports: JSON.stringify(ports),
          listeners_total: lis.length,
          listeners_on_legacy_default_ports: cfgPortsHit,
        },
        evidence: tail(scrub(start.stdout.split("---ss")[0] ?? ""), 8),
      });
      if (sm.RC !== "0") return out;

      // ---------------- CL20c: wake each service ----------------
      const wake = await B.sh(
        `cd ~/app
eval "$(supabase status --env 2>/dev/null)"
API=$(echo "$API_URL" | sed -E 's#/$##'); K="$PUBLISHABLE_KEY"
rss() { ps -eo rss= | awk '{s+=$1} END {printf "%d", s/1024}'; }
pss() { cat /proc/[0-9]*/smaps_rollup 2>/dev/null | awk '/^Pss:/{s+=$2} END {printf "%d", s/1024}'; }
echo RSS_BEFORE_MB=$(rss); echo PSS_BEFORE_MB=$(pss); echo PROCS_BEFORE=$(ps -e --no-headers | wc -l)
probe() { n=$1; shift; a=$(date +%s.%N); c=$(curl -s -o /tmp/b -w '%{http_code}' -m 90 "$@"); b=$(date +%s.%N); echo "P_$n=$c $(awk -v a=$a -v b=$b 'BEGIN{printf "%d", (b-a)*1000}') $(head -c 60 /tmp/b | tr -c '[:alnum:]{}:,._ \\n-' '?' | tr '\\n' ' ')"; }
probe rest -H "apikey: $K" "$API/rest/v1/"
probe auth "$API/auth/v1/health"
probe storage -H "apikey: $K" "$API/storage/v1/status"
probe realtime "$API/realtime/v1/api/ping"
probe functions -H "Authorization: Bearer $ANON_KEY" "$API/functions/v1/hello"
probe studio "$STUDIO_URL/"
probe mail "$MAILPIT_URL/"
echo RSS_AFTER_MB=$(rss); echo PSS_AFTER_MB=$(pss); echo PROCS_AFTER=$(ps -e --no-headers | wc -l)
supabase stack status --output-format json | tr -d '\\n'; echo
du -sm ~/.supabase/cache/stack 2>/dev/null | cut -f1 | sed 's/^/CACHE_MB=/'
du -sm ~/.supabase/cache/stack/slim-services/* 2>/dev/null | awk '{n=$2; sub(".*/","",n); printf "%s:%s ", n, $1}' | sed 's/^/ART=/'; echo`,
        { env: { ...BOX_ENV, ...STACK } },
      );
      const wk = kv(wake.stdout);
      const wst = parseStatus(wake.stdout.split("\n").find((l) => l.startsWith('{"identity"')) ?? "");
      const probes = Object.fromEntries(
        Object.entries(wk)
          .filter(([k]) => k.startsWith("P_"))
          .map(([k, v]) => {
            const [code, ms, ...rest] = v.split(" ");
            return [k.slice(2), { code: code ?? "", ms: Number(ms ?? NaN), body: rest.join(" ").trim() }];
          }),
      );
      saveRaw("cl20c-wake.txt", scrub(wake.stdout));
      out.push({
        id: "CL20c",
        title: "First request to each lazy service, then memory",
        status: "info",
        detail: Object.entries(probes).map(([k, v]) => `${k} ${v.code} ${v.ms} ms`).join(", ") + `; summed PSS ${wk.PSS_BEFORE_MB} -> ${wk.PSS_AFTER_MB} MB (summed RSS ${wk.RSS_BEFORE_MB} -> ${wk.RSS_AFTER_MB})`,
        measurements: {
          ...Object.fromEntries(Object.entries(probes).flatMap(([k, v]) => [[`${k}_http`, v.code], [`${k}_first_request_ms`, v.ms]])),
          rss_sum_before_wake_mb: Number(wk.RSS_BEFORE_MB ?? NaN),
          rss_sum_after_wake_mb: Number(wk.RSS_AFTER_MB ?? NaN),
          pss_sum_before_wake_mb: Number(wk.PSS_BEFORE_MB ?? NaN),
          pss_sum_after_wake_mb: Number(wk.PSS_AFTER_MB ?? NaN),
          processes_before: Number(wk.PROCS_BEFORE ?? NaN),
          processes_after: Number(wk.PROCS_AFTER ?? NaN),
          running_after_wake: (wst.services ?? []).filter((s) => s.state === "running").map((s) => s.service).join(","),
          sleeping_after_wake: (wst.services ?? []).filter((s) => s.state !== "running").map((s) => s.service).join(","),
          artifact_cache_mb: Number(wk.CACHE_MB ?? NaN),
          artifacts_mb: (wk.ART ?? "").trim(),
        },
        evidence: tail(scrub(wake.stdout), 14),
      });

      // ---------------- CL20d: restart ----------------
      const rst = await B.sh(
        `cd ~/app
echo T0=$(date +%s.%N); supabase stop > /tmp/stop.out 2>&1; echo STOP_RC=$?; echo T1=$(date +%s.%N)
supabase start > /tmp/start2.out 2>&1; echo START_RC=$?; echo T2=$(date +%s.%N)
supabase stack status --output-format json | tr -d '\\n'; echo
echo LEFT_PROCS=$(ps -e --no-headers | wc -l)`,
        { env: { ...BOX_ENV, ...STACK } },
      );
      const rk = kv(rst.stdout);
      const st2 = parseStatus(rst.stdout.split("\n").find((l) => l.startsWith('{"identity"')) ?? "");
      const ports2 = portsOf(st2);
      const same = Object.keys(ports).filter((k) => ports[k] === ports2[k]).length;
      out.push({
        id: "CL20d",
        title: "stop, then start with artifacts cached",
        status: rk.STOP_RC === "0" && rk.START_RC === "0" ? "pass" : "fail",
        detail: `stop ${stampMs(rst.stdout, "T0", "T1")} ms, start ${stampMs(rst.stdout, "T1", "T2")} ms; ${same} of ${Object.keys(ports).length} endpoint ports unchanged`,
        measurements: {
          stop_exit: Number(rk.STOP_RC ?? -1),
          stop_ms: stampMs(rst.stdout, "T0", "T1"),
          restart_exit: Number(rk.START_RC ?? -1),
          restart_ms: stampMs(rst.stdout, "T1", "T2"),
          cold_start_ms: cold,
          ports_unchanged: same,
          ports_total: Object.keys(ports).length,
          processes_after_stop_and_start: Number(rk.LEFT_PROCS ?? NaN),
        },
      });

      // ---------------- CL20e: application flow ----------------
      const flow = await B.sh(
        `cd ~/app
eval "$(supabase status --env 2>/dev/null)"
API=$(echo "$API_URL" | sed -E 's#/$##'); K="$PUBLISHABLE_KEY"
PGPASSWORD=postgres psql "$DB_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
create table public.notes (id bigint generated always as identity primary key, owner uuid not null default auth.uid(), body text not null);
alter table public.notes enable row level security;
create policy notes_own on public.notes for all to authenticated using (owner = (select auth.uid())) with check (owner = (select auth.uid()));
grant all on public.notes to authenticated;
SQL
echo DDL_RC=$?
curl -s -o /tmp/su -w 'SIGNUP=%{http_code}\\n' -X POST "$API/auth/v1/signup" -H "apikey: $K" -H 'Content-Type: application/json' -d '{"email":"flow@example.com","password":"flow-test-password-1"}'
curl -s -o /tmp/tok -w 'SIGNIN=%{http_code}\\n' -X POST "$API/auth/v1/token?grant_type=password" -H "apikey: $K" -H 'Content-Type: application/json' -d '{"email":"flow@example.com","password":"flow-test-password-1"}'
JWT=$(sed -E 's/.*"access_token":"([^"]+)".*/\\1/' /tmp/tok)
echo JWT_SHAPE=$(echo "$JWT" | awk -F. '{print NF}')
curl -s -o /dev/null -w 'INSERT=%{http_code}\\n' -X POST "$API/rest/v1/notes" -H "apikey: $K" -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' -d '{"body":"hello"}'
curl -s -o /tmp/sel -w 'SELECT=%{http_code}\\n' "$API/rest/v1/notes?select=body" -H "apikey: $K" -H "Authorization: Bearer $JWT"
echo SELECT_BODY=$(cat /tmp/sel)
curl -s -o /tmp/anon -w 'ANON_SELECT=%{http_code}\\n' "$API/rest/v1/notes?select=body" -H "apikey: $K"
echo ANON_BODY=$(cat /tmp/anon)
curl -s -o /tmp/fn -w 'FUNCTION=%{http_code}\n' -H "Authorization: Bearer $ANON_KEY" "$API/functions/v1/hello";echo FN_BODY=$(cat /tmp/fn)
curl -s "$MAILPIT_URL/api/v1/messages" | head -c 200 | tr -d '\\n' | sed 's/^/MAILPIT=/'; echo`,
        { env: { ...BOX_ENV, ...STACK } },
      );
      const fk = kv(flow.stdout);
      saveRaw("cl20e-flow.txt", scrub(flow.stdout));
      const okFlow = fk.SIGNUP === "200" && fk.SIGNIN === "200" && fk.INSERT === "201" && fk.SELECT === "200" && (fk.SELECT_BODY ?? "").includes("hello") && (fk.ANON_BODY ?? "") === "[]";
      out.push({
        id: "CL20e",
        title: "App flow through the gateway: RLS table, sign-up, sign-in, insert, read, anon read, function, mail",
        status: okFlow ? "pass" : "info",
        detail: `ddl rc ${fk.DDL_RC}; signup ${fk.SIGNUP}, signin ${fk.SIGNIN}, insert ${fk.INSERT}, select ${fk.SELECT} ${fk.SELECT_BODY}, anon select ${fk.ANON_SELECT} ${fk.ANON_BODY}; function ${fk.FUNCTION} "${fk.FN_BODY}"`,
        measurements: {
          ddl_exit: Number(fk.DDL_RC ?? -1),
          signup_http: fk.SIGNUP ?? "",
          signin_http: fk.SIGNIN ?? "",
          access_token_is_jwt: fk.JWT_SHAPE === "3" ? 1 : 0,
          insert_http: fk.INSERT ?? "",
          select_http: fk.SELECT ?? "",
          select_body: fk.SELECT_BODY ?? "",
          anon_select_http: fk.ANON_SELECT ?? "",
          anon_select_body: fk.ANON_BODY ?? "",
          function_http: fk.FUNCTION ?? "",
          function_body: fk.FN_BODY ?? "",
          mailpit_api_head: scrub(fk.MAILPIT ?? "").slice(0, 120),
        },
      });
    } catch (e) {
      out.push({ id: "CL20", title: this.title, status: "fail", detail: `threw: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      await box?.destroy();
    }
    return out;
  },
};

export default mod;
