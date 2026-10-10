/**
 * CL21 - two git worktrees side by side on the experimental stack, in the same
 * box with no container engine as CL20.
 *
 * The workflow behind the question: one repository, one worktree per branch or
 * per agent, each with its own local backend running at the same time.
 *
 *   CL21a  a repo initialised under STACK=1 (its config has no port lines) with
 *          two linked worktrees, 3 stacks in all: start order, wall time per
 *          start, the ports each stack was given, whether any port is shared,
 *          whether the stack ids differ.
 *   CL21b  isolation and load: a table created in one stack is absent from the
 *          other; both gateways answer; summed memory with the two stacks awake
 *          (same seven-service wake as CL20c) against the single-stack figure.
 *   CL21c  stop one stack: the other keeps answering and the first one's
 *          ports are released.
 *   CL21d  a branch switch inside one worktree, then `start`: is that the same
 *          stack and the same data, or a new stack.
 *   CL21e  a repo whose config carries the legacy fixed ports (54321 ...): the
 *          second worktree's `start`, the error text, the exit code and the
 *          stack table, then the same worktree with its ports shifted.
 *
 * Local vantage; the box needs Docker only as a host.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { dockerReachable, saveRaw, scrub, tail } from "../lib/cli";
import { BOX_ENV, Box, ensureImage, parseStatus, portsOf } from "../lib/box";

const kv = (out: string) => {
  const m: Record<string, string> = {};
  for (const l of out.split("\n")) {
    const x = l.match(/^([A-Za-z0-9_]+)=(.*)$/);
    if (x) m[x[1]!] = x[2]!;
  }
  return m;
};
/** "<exit> <ms>" as printed by the scripts -> [exit, ms]. */
const pair = (v: string | undefined): [number, number] => {
  const p = (v ?? "").split(" ");
  return [Number(p[0] ?? NaN), Number(p[1] ?? NaN)];
};
const rc = pair;
const ms = pair;

const ENV = { ...BOX_ENV, SUPABASE_EXPERIMENTAL_STACK: "1" };

/** bash: wake the seven HTTP surfaces of the stack in the current directory, quietly. */
const WAKE = `
wake() {
  eval "$(supabase status --env 2>/dev/null)"
  API=$(echo "$API_URL" | sed -E 's#/$##')
  for p in /rest/v1/ /auth/v1/health /storage/v1/status /realtime/v1/api/ping; do curl -s -o /dev/null -m 90 -H "apikey: $PUBLISHABLE_KEY" "$API$p"; done
  curl -s -o /dev/null -m 90 "$STUDIO_URL/"; curl -s -o /dev/null -m 90 "$MAILPIT_URL/"
  curl -s -o /dev/null -m 90 -H "Authorization: Bearer $ANON_KEY" "$API/functions/v1/none"
}
rss() { ps -eo rss= | awk '{s+=$1} END {printf "%d", s/1024}'; }
pss() { cat /proc/[0-9]*/smaps_rollup 2>/dev/null | awk '/^Pss:/{s+=$2} END {printf "%d", s/1024}'; }
ms() { awk -v a=$1 -v b=$2 'BEGIN{printf "%d", (b-a)*1000}'; }
`;

const mod: TestModule = {
  id: "CL21",
  title: "Two worktrees side by side on the experimental stack (no Docker): ports, time, isolation, stop, branch switch, fixed-port config",
  where: "local",
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!(await dockerReachable())) return [{ id: "CL21", title: this.title, status: "skip", detail: "no Docker daemon on the host to run the box" }];
    const out: TestResult[] = [];
    let box: Box | undefined;
    try {
      try {
        await ensureImage();
      } catch (e) {
        return [{ id: "CL21", title: this.title, status: "skip", detail: `box image unavailable, build failed: ${e instanceof Error ? e.message : String(e)}` }];
      }
      box = await Box.create("cl21");
      const B = box;

      // ---------------- CL21a ----------------
      const a = await B.sh(
        `${WAKE}
mkdir -p ~/repo && cd ~/repo && git init -q -b main && supabase init >/dev/null 2>&1 && git add -A && git commit -qm init
git worktree add -q ../wt_b -b b && git worktree add -q ../wt_c -b c
echo PORT_LINES=$(grep -c '^port = ' supabase/config.toml)
for d in repo wt_b wt_c; do
  cd ~/$d; t0=$(date +%s.%N); supabase start >/tmp/start-$d.out 2>&1; r=$?; t1=$(date +%s.%N)
  echo "S_$d=$r $(ms $t0 $t1)"
  echo "J_$d=$(supabase stack status --output-format json | tr -d '\\n')"
done
cd ~/repo; echo "LIST=$(supabase stack list --output-format json | tr -d '\\n')"`,
        { env: ENV },
      );
      const ka = kv(a.stdout);
      const dirs = ["repo", "wt_b", "wt_c"];
      const sts = Object.fromEntries(dirs.map((d) => [d, parseStatus(ka[`J_${d}`] ?? "")]));
      // Within one stack several services share the gateway port, so compare DISTINCT ports per stack.
      const portSets = dirs.map((d) => [...new Set(Object.values(portsOf(sts[d]!)))]);
      const all = portSets.flat();
      const dupes = all.length - new Set(all).size;
      const ids = dirs.map((d) => sts[d]!.identity?.id ?? "");
      saveRaw("cl21a-status.json", scrub(JSON.stringify(sts)));
      out.push({
        id: "CL21a",
        title: "Three stacks (main plus two linked worktrees) from one config with no port lines",
        status: dirs.every((d) => rc(ka[`S_${d}`])[0] === 0) && dupes === 0 ? "pass" : "fail",
        detail: `start exits ${dirs.map((d) => rc(ka[`S_${d}`])[0]).join("/")}, wall ms ${dirs.map((d) => ms(ka[`S_${d}`])[1]).join("/")}; ${portSets.map((p) => p.length).join("/")} distinct ports per stack, ${dupes} shared between stacks; ${new Set(ids).size} distinct stack ids`,
        measurements: {
          config_port_lines: Number(ka.PORT_LINES ?? -1),
          start_exit_main: rc(ka.S_repo)[0],
          start_exit_wt_b: rc(ka.S_wt_b)[0],
          start_exit_wt_c: rc(ka.S_wt_c)[0],
          start_ms_main_cold_artifacts: ms(ka.S_repo)[1],
          start_ms_wt_b: ms(ka.S_wt_b)[1],
          start_ms_wt_c: ms(ka.S_wt_c)[1],
          distinct_ports_per_stack: portSets.map((p) => p.length).join("/"),
          endpoints_listed_per_stack: dirs.map((d) => Object.keys(portsOf(sts[d]!)).length).join("/"),
          distinct_ports_total: new Set(all).size,
          ports_shared_between_stacks: dupes,
          distinct_stack_ids: new Set(ids).size,
          gateway_ports: dirs.map((d) => portsOf(sts[d]!)["rest.http"] ?? 0).join("/"),
          db_ports: dirs.map((d) => portsOf(sts[d]!)["database.sql"] ?? 0).join("/"),
          branch_contexts: dirs.map((d) => sts[d]!.identity?.branch_context ?? "").join(","),
          runtimes: dirs.map((d) => sts[d]!.runtime ?? "").join(","),
        },
        evidence: tail(scrub(a.stdout.replace(/J_[a-z_]+=.*/g, "J_...")), 8),
      });

      // ---------------- CL21b ----------------
      const b = await B.sh(
        `${WAKE}
echo RSS_ALL_ASLEEP_MB=$(rss); echo PSS_ALL_ASLEEP_MB=$(pss); echo PROCS_ASLEEP=$(ps -e --no-headers | wc -l)
for d in repo wt_b; do
  cd ~/$d; eval "$(supabase status --env 2>/dev/null)"
  PGPASSWORD=postgres psql "$DB_URL" -q -c "create table public.only_in_$(echo $d | tr - _)(i int)" >/dev/null
done
for d in repo wt_b; do cd ~/$d; wake; done
echo RSS_TWO_AWAKE_MB=$(rss); echo PSS_TWO_AWAKE_MB=$(pss); echo PROCS_TWO_AWAKE=$(ps -e --no-headers | wc -l)
for d in repo wt_b; do
  cd ~/$d; eval "$(supabase status --env 2>/dev/null)"
  echo "TABLES_$(echo $d | tr - _)=$(PGPASSWORD=postgres psql "$DB_URL" -Atc "select coalesce(string_agg(tablename, ',' order by tablename), '') from pg_tables where schemaname='public'")"
  echo "REST_$(echo $d | tr - _)=$(curl -s -o /dev/null -w '%{http_code}' -H "apikey: $PUBLISHABLE_KEY" "$(echo $API_URL | sed -E 's#/$##')/rest/v1/")"
done
ls ~/.supabase/stacks | wc -l | sed 's/^/STACK_DIRS=/'; du -sm ~/.supabase/stacks | cut -f1 | sed 's/^/STACKS_MB=/'`,
        { env: ENV },
      );
      const kb = kv(b.stdout);
      out.push({
        id: "CL21b",
        title: "Isolation and memory with two stacks awake",
        status: kb.TABLES_repo === "only_in_repo" && kb.TABLES_wt_b === "only_in_wt_b" ? "pass" : "fail",
        detail: `tables seen: main "${kb.TABLES_repo}", wt_b "${kb.TABLES_wt_b}"; gateways ${kb.REST_repo}/${kb.REST_wt_b}; summed PSS ${kb.PSS_ALL_ASLEEP_MB} MB with three stacks asleep, ${kb.PSS_TWO_AWAKE_MB} MB with two awake (summed RSS ${kb.RSS_ALL_ASLEEP_MB}/${kb.RSS_TWO_AWAKE_MB})`,
        measurements: {
          tables_in_main: kb.TABLES_repo ?? "",
          tables_in_wt_b: kb.TABLES_wt_b ?? "",
          rest_http_main: kb.REST_repo ?? "",
          rest_http_wt_b: kb.REST_wt_b ?? "",
          rss_sum_three_stacks_asleep_mb: Number(kb.RSS_ALL_ASLEEP_MB ?? NaN),
          rss_sum_two_stacks_awake_mb: Number(kb.RSS_TWO_AWAKE_MB ?? NaN),
          pss_sum_three_stacks_asleep_mb: Number(kb.PSS_ALL_ASLEEP_MB ?? NaN),
          pss_sum_two_stacks_awake_mb: Number(kb.PSS_TWO_AWAKE_MB ?? NaN),
          processes_asleep: Number(kb.PROCS_ASLEEP ?? NaN),
          processes_two_awake: Number(kb.PROCS_TWO_AWAKE ?? NaN),
          stack_state_dirs: Number(kb.STACK_DIRS ?? NaN),
          stack_state_mb: Number(kb.STACKS_MB ?? NaN),
        },
      });

      // ---------------- CL21c ----------------
      const c = await B.sh(
        `${WAKE}
cd ~/repo; eval "$(supabase status --env 2>/dev/null)"; PA=$(echo "$DB_URL" | sed -E 's#.*:([0-9]+)/.*#\\1#')
t0=$(date +%s.%N); supabase stop >/tmp/stop.out 2>&1; r=$?; t1=$(date +%s.%N)
echo "STOP_A=$r $(ms $t0 $t1)"
echo A_PORT_LISTENING=$(ss -ltnH | awk '{print $4}' | grep -c ":$PA\\$")
cd ~/wt_b; eval "$(supabase status --env 2>/dev/null)"
echo B_REST=$(curl -s -o /dev/null -w '%{http_code}' -H "apikey: $PUBLISHABLE_KEY" "$(echo $API_URL | sed -E 's#/$##')/rest/v1/")
echo B_TABLE=$(PGPASSWORD=postgres psql "$DB_URL" -Atc "select to_regclass('public.only_in_wt_b')")
echo "LIST=$(supabase stack list --output-format json | tr -d '\\n')"`,
        { env: ENV },
      );
      const kc = kv(c.stdout);
      const list = (() => {
        try {
          return (JSON.parse(kc.LIST ?? "{}") as { stacks?: Array<{ project_root: string; owner: string }> }).stacks ?? [];
        } catch {
          return [];
        }
      })();
      out.push({
        id: "CL21c",
        title: "Stop one stack; the other keeps serving",
        status: kc.B_REST === "200" && kc.A_PORT_LISTENING === "0" ? "pass" : "fail",
        detail: `stop exit ${rc(kc.STOP_A)[0]} in ${ms(kc.STOP_A)[1]} ms; stopped stack's db port listening: ${kc.A_PORT_LISTENING}; other stack gateway ${kc.B_REST}, its table ${kc.B_TABLE}`,
        measurements: {
          stop_exit: rc(kc.STOP_A)[0],
          stop_ms: ms(kc.STOP_A)[1],
          stopped_db_port_listening: Number(kc.A_PORT_LISTENING ?? -1),
          other_gateway_http: kc.B_REST ?? "",
          other_table_survives: kc.B_TABLE ?? "",
          stack_table_owner_states: list.map((s) => `${s.project_root.split("/").pop()}:${s.owner}`).join(","),
        },
      });

      // ---------------- CL21d: branch switch ----------------
      const d = await B.sh(
        `${WAKE}
cd ~/wt_b; git switch -q -c b2
echo "STATUS_BEFORE=$(supabase stack status --output-format json 2>&1 | head -c 240 | tr -d '\\n')"
t0=$(date +%s.%N); supabase start >/tmp/start-b2.out 2>&1; r=$?; t1=$(date +%s.%N)
echo "START_B2=$r $(ms $t0 $t1)"
eval "$(supabase status --env 2>/dev/null)"
echo B2_TABLES=$(PGPASSWORD=postgres psql "$DB_URL" -Atc "select coalesce(string_agg(tablename, ',' order by tablename), '') from pg_tables where schemaname='public'")
echo "J=$(supabase stack status --output-format json | tr -d '\\n')"
echo "LIST=$(supabase stack list --output-format json | tr -d '\\n')"`,
        { env: ENV },
      );
      const kd = kv(d.stdout);
      const std = parseStatus(kd.J ?? "");
      const listD = (() => {
        try {
          return (JSON.parse(kd.LIST ?? "{}") as { stacks?: Array<{ id: string; project_root: string; branch_context: string; owner: string }> }).stacks ?? [];
        } catch {
          return [];
        }
      })();
      out.push({
        id: "CL21d",
        title: "git switch -c inside a worktree, then start",
        status: "info",
        detail: `start exit ${rc(kd.START_B2)[0]}; branch context now ${std.identity?.branch_context}; public tables seen: "${kd.B2_TABLES}" (the first branch's stack had only_in_wt_b); stacks listed for wt_b: ${listD.filter((s) => s.project_root.endsWith("wt_b")).map((s) => `${s.branch_context}:${s.owner}`).join(", ")}`,
        measurements: {
          status_before_start: (kd.STATUS_BEFORE ?? "").replace(/"id":"[0-9a-f]+"/g, '"id":"X"').slice(0, 200),
          start_exit: rc(kd.START_B2)[0],
          start_ms: ms(kd.START_B2)[1],
          branch_context_after: std.identity?.branch_context ?? "",
          tables_after_switch: kd.B2_TABLES ?? "",
          stacks_for_this_worktree: listD.filter((s) => s.project_root.endsWith("wt_b")).map((s) => `${s.branch_context}:${s.owner}`).join(","),
          stack_ids_distinct_for_worktree: new Set(listD.filter((s) => s.project_root.endsWith("wt_b")).map((s) => s.id)).size,
        },
      });

      // ---------------- CL21e: fixed-port config ----------------
      const e = await B.sh(
        `${WAKE}
mkdir -p ~/lg && cd ~/lg && git init -q -b main && SUPABASE_EXPERIMENTAL_STACK=0 supabase init >/dev/null 2>&1
echo LG_PORT_LINES=$(grep -c '^port = ' supabase/config.toml); echo LG_STACK_KEY=$(grep -c '^stack = true' supabase/config.toml)
git add -A && git commit -qm init && git worktree add -q ../lg-b -b lgb
cd ~/lg; t0=$(date +%s.%N); supabase start >/tmp/lg1.out 2>&1; r=$?; t1=$(date +%s.%N); echo "LG_A=$r $(ms $t0 $t1)"
cd ~/lg-b; t0=$(date +%s.%N); supabase start >/tmp/lg2.out 2>&1; r=$?; t1=$(date +%s.%N); echo "LG_B=$r $(ms $t0 $t1)"
echo "LG_B_ERR=$(grep -E 'Cannot bind|claims' /tmp/lg2.out | head -1 | cut -c1-260)"
echo "LG_LIST=$(supabase stack list --output-format json | tr -d '\\n' | grep -o '"project_root":"/home/dev/lg[^}]*' | tr '\\n' ';')"
sed -i -E 's/^(port|shadow_port) = 54([0-9]{3})/\\1 = 55\\2/; s/^inspector_port = 8083/inspector_port = 8183/' supabase/config.toml
t0=$(date +%s.%N); supabase start >/tmp/lg3.out 2>&1; r=$?; t1=$(date +%s.%N); echo "LG_B_SHIFTED=$r $(ms $t0 $t1)"
echo "LG_B_SHIFTED_ERR=$(grep -E 'Cannot bind|claims' /tmp/lg3.out | head -1 | cut -c1-200)"
supabase stack status --output-format json | tr -d '\\n' | grep -o '"database.sql":{[^}]*}' | sed 's/^/LG_B_DB=/'`,
        { env: ENV },
      );
      const ke = kv(e.stdout);
      out.push({
        id: "CL21e",
        title: "Legacy fixed-port config: the second worktree collides; shifted ports work",
        status: "info",
        detail: `config port lines ${ke.LG_PORT_LINES}, stack key ${ke.LG_STACK_KEY}; first start exit ${rc(ke.LG_A)[0]}, second worktree exit ${rc(ke.LG_B)[0]} (${(ke.LG_B_ERR ?? "").slice(0, 150)}); after shifting its ports: exit ${rc(ke.LG_B_SHIFTED)[0]}`,
        measurements: {
          config_port_lines: Number(ke.LG_PORT_LINES ?? -1),
          config_has_stack_key: Number(ke.LG_STACK_KEY ?? -1),
          first_worktree_exit: rc(ke.LG_A)[0],
          second_worktree_exit: rc(ke.LG_B)[0],
          second_worktree_ms: ms(ke.LG_B)[1],
          second_worktree_error: scrub(ke.LG_B_ERR ?? "").replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, "<uuid>"),
          second_worktree_stack_listing: scrub(ke.LG_LIST ?? "").slice(0, 300),
          shifted_ports_exit: rc(ke.LG_B_SHIFTED)[0],
          shifted_ports_error: scrub(ke.LG_B_SHIFTED_ERR ?? "").replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, "<uuid>"),
          shifted_db_endpoint: (ke.LG_B_DB ?? "").slice(0, 120),
        },
      });
    } catch (e) {
      out.push({ id: "CL21", title: this.title, status: "fail", detail: `threw: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      await box?.destroy();
    }
    return out;
  },
};

export default mod;
