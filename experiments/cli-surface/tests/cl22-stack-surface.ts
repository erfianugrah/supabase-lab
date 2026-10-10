/**
 * CL22 - what the experimental stack switches on, what it leaves out, and how
 * it reacts to a config change, in the same no-Docker box.
 *
 *   CL22a  the switches: `[experimental] stack = true` in config.toml, the
 *          `SUPABASE_EXPERIMENTAL_STACK` variable (0, 1, 2), and their
 *          precedence, each as one `supabase start` in a project whose config
 *          carries the legacy port lines.
 *   CL22b  the command surface with the stack running and no Docker: db diff
 *          (default, --use-pg-delta, --use-migra), declarative generate and
 *          sync, db reset, migration new/up/list, db dump, db lint, gen types,
 *          db query, inspect, test db, functions serve. Exit code, wall time,
 *          first output line.
 *   CL22c  services against the legacy list: the `--exclude` choices each
 *          backend documents, then the ones the stack is suspected to lack
 *          (pooler, image transformation, realtime websocket upgrade,
 *          analytics health).
 *   CL22d  config drift: change `[auth] enable_signup` while the stack runs;
 *          what `status` says, whether `start` applies it, whether `stack
 *          restart` does, and what sign-up answers at each point.
 *
 * Local vantage; the box needs Docker only as a host.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { dockerReachable, saveRaw, scrub, tail } from "../lib/cli";
import { BOX_ENV, Box, ensureImage } from "../lib/box";

const ENV = { ...BOX_ENV, SUPABASE_EXPERIMENTAL_STACK: "1" };

const HELPERS = `
ms() { awk -v a=$1 -v b=$2 'BEGIN{printf "%d", (b-a)*1000}'; }
# step NAME cmd...  ->  X_NAME=<exit> <ms> <first two non-empty output lines>
step() { n=$1; shift; a=$(date +%s.%N); o=$("$@" 2>&1); r=$?; b=$(date +%s.%N)
  echo "X_$n=$r $(ms $a $b) $(printf '%s\\n' "$o" | grep -v '^\\s*$' | grep -v -E '^[│├╰╭◇]' | head -2 | tr '\\n' ' ' | cut -c1-230)"; }
api() { eval "$(supabase status --env 2>/dev/null)"; API=$(echo "$API_URL" | sed -E 's#/$##'); }
`;

const parseSteps = (out: string) => {
  const m: Record<string, { code: number; ms: number; line: string }> = {};
  for (const l of out.split("\n")) {
    const x = l.match(/^X_([A-Za-z0-9_]+)=(-?\d+) (\d+) ?(.*)$/);
    if (x) m[x[1]!] = { code: Number(x[2]), ms: Number(x[3]), line: x[4]!.trim() };
  }
  return m;
};
const kv = (out: string) => {
  const m: Record<string, string> = {};
  for (const l of out.split("\n")) {
    const x = l.match(/^([A-Za-z0-9_]+)=(.*)$/);
    if (x) m[x[1]!] = x[2]!;
  }
  return m;
};

const mod: TestModule = {
  id: "CL22",
  title: "Experimental stack: switches, command surface, missing services, config drift (no Docker)",
  where: "local",
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!(await dockerReachable())) return [{ id: "CL22", title: this.title, status: "skip", detail: "no Docker daemon on the host to run the box" }];
    const out: TestResult[] = [];
    let box: Box | undefined;
    try {
      try {
        await ensureImage();
      } catch (e) {
        return [{ id: "CL22", title: this.title, status: "skip", detail: `box image unavailable, build failed: ${e instanceof Error ? e.message : String(e)}` }];
      }
      box = await Box.create("cl22");
      const B = box;

      // ---------------- CL22a: switches ----------------
      const a = await B.sh(
        `${HELPERS}
mkdir -p ~/sw && cd ~/sw && SUPABASE_EXPERIMENTAL_STACK=0 supabase init >/dev/null 2>&1
rt() { supabase stack status --output-format json 2>/dev/null | grep -o '"runtime":"[a-z]*"' | head -1; }
try() { n=$1; shift; a=$(date +%s.%N); o=$("$@" 2>&1); r=$?; b=$(date +%s.%N)
  echo "X_$n=$r $(ms $a $b) $(printf '%s\\n' "$o" | grep -E 'Docker|docker|must be|Runtime|ready|rror' | head -1 | cut -c1-200)"; }
stop_all() { SUPABASE_EXPERIMENTAL_STACK=1 supabase stop >/dev/null 2>&1; SUPABASE_EXPERIMENTAL_STACK=1 supabase stack destroy --yes >/dev/null 2>&1; }
# 1 env=1, no key in config
try env1 env SUPABASE_EXPERIMENTAL_STACK=1 supabase start; stop_all
# 2 key in config, env unset
printf '\\n' >/dev/null; sed -i 's/^\\[experimental\\]$/[experimental]\\nstack = true/' supabase/config.toml
echo KEY_LINES=$(grep -c '^stack = true' supabase/config.toml)
try key_envunset env -u SUPABASE_EXPERIMENTAL_STACK supabase start; stop_all
# 3 key in config, env=0
try key_env0 env SUPABASE_EXPERIMENTAL_STACK=0 supabase start; stop_all
# 4 key false, env=1
sed -i 's/^stack = true/stack = false/' supabase/config.toml
try keyfalse_env1 env SUPABASE_EXPERIMENTAL_STACK=1 supabase start; stop_all
# 5 key false, env unset
try keyfalse_envunset env -u SUPABASE_EXPERIMENTAL_STACK supabase start
# 6 env=2 and env empty
try env2 env SUPABASE_EXPERIMENTAL_STACK=2 supabase start
try envempty env SUPABASE_EXPERIMENTAL_STACK= supabase start
# 7 global --experimental flag
try flag env -u SUPABASE_EXPERIMENTAL_STACK supabase --experimental start
# 8 stack subcommand visible only when enabled
echo HELP_STACK_ON=$(SUPABASE_EXPERIMENTAL_STACK=1 supabase --help 2>&1 | grep -c '^  stack ')
echo HELP_STACK_OFF=$(SUPABASE_EXPERIMENTAL_STACK=0 supabase --help 2>&1 | grep -c '^  stack ')
step stack_cmd_off env SUPABASE_EXPERIMENTAL_STACK=0 supabase stack list`,
        { env: ENV },
      );
      const sa = parseSteps(a.stdout);
      const ka = kv(a.stdout);
      saveRaw("cl22a-switches.txt", scrub(a.stdout));
      const cell = (k: string) => `${sa[k]?.code ?? "?"}`;
      out.push({
        id: "CL22a",
        title: "Switches and precedence for the stack backend",
        status: "info",
        detail: `start exit by case (no Docker in the box): env=1 ${cell("env1")}; config stack=true + env unset ${cell("key_envunset")}; config true + env=0 ${cell("key_env0")}; config false + env=1 ${cell("keyfalse_env1")}; config false + env unset ${cell("keyfalse_envunset")}; env=2 ${cell("env2")}; env empty ${cell("envempty")}; --experimental ${cell("flag")}`,
        measurements: {
          config_key_lines_written: Number(ka.KEY_LINES ?? -1),
          env1_exit: sa.env1?.code ?? -1,
          env1_line: sa.env1?.line ?? "",
          config_true_env_unset_exit: sa.key_envunset?.code ?? -1,
          config_true_env_unset_line: sa.key_envunset?.line ?? "",
          config_true_env0_exit: sa.key_env0?.code ?? -1,
          config_true_env0_line: sa.key_env0?.line ?? "",
          config_false_env1_exit: sa.keyfalse_env1?.code ?? -1,
          config_false_env1_line: sa.keyfalse_env1?.line ?? "",
          config_false_env_unset_exit: sa.keyfalse_envunset?.code ?? -1,
          config_false_env_unset_line: sa.keyfalse_envunset?.line ?? "",
          env2_exit: sa.env2?.code ?? -1,
          env2_line: sa.env2?.line ?? "",
          env_empty_exit: sa.envempty?.code ?? -1,
          env_empty_line: sa.envempty?.line ?? "",
          experimental_flag_exit: sa.flag?.code ?? -1,
          experimental_flag_line: sa.flag?.line ?? "",
          help_lists_stack_when_env1: Number(ka.HELP_STACK_ON ?? -1),
          help_lists_stack_when_env0: Number(ka.HELP_STACK_OFF ?? -1),
          stack_subcommand_when_off_exit: sa.stack_cmd_off?.code ?? -1,
          stack_subcommand_when_off_line: sa.stack_cmd_off?.line ?? "",
        },
      });

      // ---------------- CL22b: command surface ----------------
      const b = await B.sh(
        `${HELPERS}
mkdir -p ~/app && cd ~/app && supabase init >/dev/null 2>&1
mkdir -p supabase/functions/hello supabase/tests/database
printf 'Deno.serve(() => new Response("hello"));\\n' > supabase/functions/hello/index.ts
printf 'begin;\\nselect plan(1);\\nselect ok(true, %s);\\nselect * from finish();\\nrollback;\\n' "'smoke'" > supabase/tests/database/smoke.test.sql
supabase start >/dev/null 2>&1; echo START_RC=$?
api
step db_dump_empty supabase db dump --local -f /tmp/dump0.sql
PGPASSWORD=postgres psql "$DB_URL" -q -c "create extension if not exists pgtap with schema extensions; create table public.t(i int primary key, v text); alter table public.t enable row level security; create policy p on public.t for select using (true);"
step status supabase status
step diff_default supabase db diff --output-format text
step diff_pgdelta supabase db diff --use-pg-delta --output-format text
step diff_migra supabase db diff --use-migra --output-format text
step diff_pgschema supabase db diff --use-pg-schema --output-format text
step decl_generate supabase db schema declarative generate --local --output-format text
step decl_sync supabase db schema declarative sync --no-apply --name box --output-format text
step migration_list supabase migration list --local --output-format text
step db_reset supabase db reset --local --yes --output-format text
step migration_new supabase migration new smoke
step migration_up supabase migration up --local --output-format text
step db_dump supabase db dump --local -f /tmp/dump.sql
step db_dump_again supabase db dump --local -f /tmp/dump2.sql
step db_dump_data supabase db dump --local --data-only -f /tmp/dump3.sql
step db_lint supabase db lint --local --output-format text
step gen_types supabase gen types --local
step db_query supabase db query --local "select 1 as one"
step advisors supabase db advisors --local --output-format text
step inspect supabase inspect db table-sizes --local
step test_db supabase test db
a=$(date +%s.%N); timeout 25 supabase functions serve >/tmp/fs.out 2>&1; r=$?; b=$(date +%s.%N)
echo "X_functions_serve=$r $(ms $a $b) $(grep -v '^\\s*$' /tmp/fs.out | head -2 | tr '\\n' ' ' | cut -c1-230)"
f=0; for i in 1 2 3 4 5; do supabase db dump --local -f /tmp/dl$i.sql >/dev/null 2>&1 || f=$((f+1)); done; echo DUMP_REPEAT_FAILS_REDIRECTED=$f
f=0; for i in 1 2 3 4 5; do o=$(supabase db dump --local -f /tmp/dm$i.sql 2>&1) || f=$((f+1)); done; echo DUMP_REPEAT_FAILS_CAPTURED=$f
echo DUMP_BYTES=$(wc -c < /tmp/dump.sql 2>/dev/null)
echo TYPES_BYTES=$(supabase gen types --local 2>/dev/null | wc -c)`,
        { env: ENV },
      );
      const sb = parseSteps(b.stdout);
      const kb = kv(b.stdout);
      saveRaw("cl22b-commands.txt", scrub(b.stdout));
      const okCmds = Object.entries(sb).filter(([, v]) => v.code === 0).map(([k]) => k);
      const badCmds = Object.entries(sb).filter(([, v]) => v.code !== 0).map(([k]) => k);
      out.push({
        id: "CL22b",
        title: "Command surface against a running stack, no Docker",
        status: "info",
        detail: `exit 0: ${okCmds.join(", ") || "none"}; non-zero: ${badCmds.map((k) => `${k}=${sb[k]!.code}`).join(", ") || "none"}`,
        measurements: {
          start_exit: Number(kb.START_RC ?? -1),
          commands_run: Object.keys(sb).length,
          commands_exit_zero: okCmds.length,
          commands_nonzero: badCmds.length,
          ...Object.fromEntries(Object.entries(sb).flatMap(([k, v]) => [[`${k}_exit`, v.code], [`${k}_ms`, v.ms], [`${k}_line`, scrub(v.line).replace(/[0-9]{14}/g, "<ts>")]])),
          dump_repeat_failures_of_5_stdout_redirected: Number(kb.DUMP_REPEAT_FAILS_REDIRECTED ?? -1),
          dump_repeat_failures_of_5_stdout_captured: Number(kb.DUMP_REPEAT_FAILS_CAPTURED ?? -1),
          dump_bytes: Number(kb.DUMP_BYTES ?? NaN),
          types_bytes: Number(kb.TYPES_BYTES ?? NaN),
        },
        evidence: tail(scrub(b.stdout), 12),
      });

      // ---------------- CL22c: services vs the legacy list ----------------
      const c = await B.sh(
        `${HELPERS}
cd ~/app
echo EXCL_STACK=$(SUPABASE_EXPERIMENTAL_STACK=1 supabase start --help 2>&1 | grep -E '^\\s+--exclude' | sed -E 's/.*\\[(.*)\\].*/\\1/')
echo EXCL_LEGACY=$(SUPABASE_EXPERIMENTAL_STACK=0 supabase start --help 2>&1 | grep -E '^\\s+--exclude' | sed -E 's/.*\\[(.*)\\].*/\\1/')
api
echo "STACK_SERVICES=$(supabase stack status --output-format json | grep -o '"service":"[a-z]*","state"' | sed -E 's/"service":"([a-z]*)".*/\\1/' | tr '\\n' ',')"
# image transformation: a public bucket, a 1x1 PNG, a render request
printf 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==' | base64 -d > /tmp/p.png
echo BUCKET=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/storage/v1/bucket" -H "Authorization: Bearer $SERVICE_ROLE_KEY" -H 'Content-Type: application/json' -d '{"name":"pics","public":true}')
echo UPLOAD=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/storage/v1/object/pics/p.png" -H "Authorization: Bearer $SERVICE_ROLE_KEY" -H 'Content-Type: image/png' --data-binary @/tmp/p.png)
echo PUBLIC_GET=$(curl -s -o /dev/null -w '%{http_code}' "$API/storage/v1/object/public/pics/p.png")
echo RENDER_DEFAULT=$(curl -s -o /tmp/r0.out -w '%{http_code}' "$API/storage/v1/render/image/public/pics/p.png?width=20"); echo RENDER_DEFAULT_BODY=$(head -c 120 /tmp/r0.out | tr -c '[:print:]' '?')
sed -i 's/^# \\[storage.image_transformation\\]/[storage.image_transformation]/; /^\\[storage.image_transformation\\]/{n;s/^# enabled = true/enabled = true/}' supabase/config.toml
echo IMG_CFG_LINES=$(sed -n '/^\\[storage.image_transformation\\]/,/^\\[/p' supabase/config.toml | grep -c '^enabled = true')
step img_stop supabase stop
step img_start supabase start
api
echo RENDER=$(curl -s -o /tmp/r.out -w '%{http_code}' "$API/storage/v1/render/image/public/pics/p.png?width=20"); echo RENDER_BODY=$(head -c 160 /tmp/r.out | tr -c '[:print:]' '?')
echo RENDER_BYTES=$(wc -c < /tmp/r.out)
echo IMGPROXY_PROC=$(ps -eo args | grep -c -i '[i]mgproxy')
# realtime websocket upgrade
curl -s -D /tmp/ws.hdr -o /dev/null -m 4 --http1.1 -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' "$API/realtime/v1/websocket?apikey=$ANON_KEY&vsn=1.0.0"
echo WS=$(head -1 /tmp/ws.hdr | tr -d '\\r')
# analytics
AP=$(supabase stack status --output-format json | grep -o '"analytics.http":{[^}]*}' | grep -o '"port":[0-9]*' | cut -d: -f2)
echo ANALYTICS_HEALTH=$(curl -s -o /dev/null -w '%{http_code}' -m 30 "http://127.0.0.1:$AP/health")
# s3 protocol endpoint answers
echo S3_ROOT=$(curl -s -o /dev/null -w '%{http_code}' "$API/storage/v1/s3")
# pooler: enable in config on a running stack (start, restart), then recreate the stack
sed -i '/^\\[db.pooler\\]/,/^\\[/ s/^enabled = false/enabled = true/' supabase/config.toml
echo POOLER_ENABLED_LINES=$(sed -n '/^\\[db.pooler\\]/,/^\\[/p' supabase/config.toml | grep -c '^enabled = true')
step pooler_start supabase start
step pooler_restart supabase stack restart
echo "POOLER_SERVICES_RUNNING_STACK=$(supabase stack status --output-format json | grep -o '"service":"[a-z]*","state"' | sed -E 's/"service":"([a-z]*)".*/\\1/' | tr '\\n' ',')"
step pooler_destroy supabase stack destroy --yes
step pooler_fresh_start supabase start
echo "POOLER_SERVICES=$(supabase stack status --output-format json | grep -o '"service":"[a-z]*","state"' | sed -E 's/"service":"([a-z]*)".*/\\1/' | tr '\\n' ',')"
echo "POOLER_ENDPOINTS=$(supabase stack status --output-format json | grep -o '"pooler[^"]*":{[^}]*}' | head -3 | tr '\\n' ' ')"
echo "STATUS_TEXT_SERVICES=$(supabase status 2>&1 | grep -i -E 'pooler' | head -2 | tr '\\n' ' ')"
api
PP=$(supabase stack status --output-format json | grep -o '"pooler.sql":{[^}]*}' | grep -o '"port":[0-9]*' | head -1 | cut -d: -f2)
echo POOLER_PORT=$PP
echo POOLER_PSQL=$(PGPASSWORD=postgres PGCONNECT_TIMEOUT=5 psql "postgresql://postgres.app@127.0.0.1:\${PP:-0}/postgres" -Atc 'select 1' 2>&1 | head -1 | cut -c1-160)
echo LISTEN_LEGACY_POOLER_PORT=$(ss -ltnH | awk '{print $4}' | grep -c ':54329$')`,
        { env: ENV },
      );
      const kc = kv(c.stdout);
      const sc = parseSteps(c.stdout);
      saveRaw("cl22c-services.txt", scrub(c.stdout));
      const legacyEx = (kc.EXCL_LEGACY ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      const stackEx = (kc.EXCL_STACK ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      out.push({
        id: "CL22c",
        title: "Services the stack documents against the legacy container list",
        status: "info",
        detail: `legacy --exclude choices ${legacyEx.length}, stack ${stackEx.length}; image render ${kc.RENDER_DEFAULT} with the default config, ${kc.RENDER} after enabling it; websocket upgrade "${kc.WS}"; analytics health ${kc.ANALYTICS_HEALTH}; pooler enabled in config ${kc.POOLER_ENABLED_LINES}: services on the running stack "${kc.POOLER_SERVICES_RUNNING_STACK}", on a recreated stack "${kc.POOLER_SERVICES}"`,
        measurements: {
          exclude_choices_legacy: legacyEx.join(","),
          exclude_choices_stack: stackEx.join(","),
          services_in_stack: kc.STACK_SERVICES ?? "",
          bucket_create_http: kc.BUCKET ?? "",
          upload_http: kc.UPLOAD ?? "",
          public_object_get_http: kc.PUBLIC_GET ?? "",
          image_render_http_default_config: kc.RENDER_DEFAULT ?? "",
          image_render_body_default_config: scrub(kc.RENDER_DEFAULT_BODY ?? ""),
          image_transformation_enabled_lines_after_edit: Number(kc.IMG_CFG_LINES ?? -1),
          image_enable_stop_exit: sc.img_stop?.code ?? -1,
          image_enable_start_exit: sc.img_start?.code ?? -1,
          image_render_http_enabled: kc.RENDER ?? "",
          image_render_body_enabled: scrub(kc.RENDER_BODY ?? ""),
          image_render_bytes_enabled: Number(kc.RENDER_BYTES ?? NaN),
          imgproxy_process_running: Number(kc.IMGPROXY_PROC ?? -1),
          realtime_websocket_status_line: kc.WS ?? "",
          analytics_health_http: kc.ANALYTICS_HEALTH ?? "",
          s3_root_http: kc.S3_ROOT ?? "",
          pooler_enabled_in_config: Number(kc.POOLER_ENABLED_LINES ?? -1),
          pooler_start_on_running_stack_exit: sc.pooler_start?.code ?? -1,
          pooler_restart_exit: sc.pooler_restart?.code ?? -1,
          pooler_restart_line: sc.pooler_restart?.line ?? "",
          services_on_running_stack_after_edit: kc.POOLER_SERVICES_RUNNING_STACK ?? "",
          destroy_exit: sc.pooler_destroy?.code ?? -1,
          fresh_start_exit: sc.pooler_fresh_start?.code ?? -1,
          fresh_start_ms: sc.pooler_fresh_start?.ms ?? -1,
          services_on_recreated_stack: kc.POOLER_SERVICES ?? "",
          pooler_endpoints_on_recreated_stack: kc.POOLER_ENDPOINTS ?? "",
          pooler_in_status_text: kc.STATUS_TEXT_SERVICES ?? "",
          pooler_port: kc.POOLER_PORT ?? "",
          pooler_psql_first_line: scrub(kc.POOLER_PSQL ?? ""),
          legacy_pooler_port_listening: Number(kc.LISTEN_LEGACY_POOLER_PORT ?? -1),
        },
      });

      // ---------------- CL22d: config drift ----------------
      const d = await B.sh(
        `${HELPERS}
cd ~/app
sed -i '/^\\[db.pooler\\]/,/^\\[/ s/^enabled = true/enabled = false/' supabase/config.toml
supabase stack destroy --yes >/dev/null 2>&1
supabase start >/dev/null 2>&1; echo FRESH_RC=$?
api
PGPASSWORD=postgres psql "$DB_URL" -q -c "create table public.drift_marker(i int)" >/dev/null
marker() { PGPASSWORD=postgres psql "$DB_URL" -Atc "select to_regclass('public.drift_marker')"; }
su() { curl -s -o /tmp/su -w '%{http_code}' -X POST "$API/auth/v1/signup" -H "apikey: $PUBLISHABLE_KEY" -H 'Content-Type: application/json' -d "{\\"email\\":\\"$1@example.com\\",\\"password\\":\\"drift-test-password-1\\"}"; }
echo SIGNUP_BEFORE=$(su before)
sed -i '/^\\[auth\\]/,/^\\[/ s/^enable_signup = true/enable_signup = false/' supabase/config.toml
echo SIGNUP_LINE=$(sed -n '/^\\[auth\\]/,/^\\[/p' supabase/config.toml | grep '^enable_signup')
echo "DRIFT_STATUS=$(supabase stack status --output-format json | grep -o '"config_drift":{[^}]*}')"
echo "DRIFT_TEXT=$(supabase status 2>&1 | grep -i -E 'drift|differs|restart' | head -2 | tr '\\n' ' ' | cut -c1-240)"
step start_again supabase start
echo SIGNUP_AFTER_START=$(su after_start)
step restart supabase stack restart
api; echo SIGNUP_AFTER_RESTART=$(su after_restart)
step stop supabase stop
step start_after_stop supabase start
api; echo SIGNUP_AFTER_STOP_START=$(su after_stop_start); echo MARKER_AFTER_STOP_START=$(marker)
echo "DRIFT_AFTER_STOP_START=$(supabase stack status --output-format json | grep -o '"config_drift":{[^}]*}' | cut -c1-120)"
step destroy supabase stack destroy --yes
step start_after_destroy supabase start
api; echo SIGNUP_AFTER_DESTROY=$(su after_destroy); echo SIGNUP_BODY=$(head -c 90 /tmp/su | sed -E 's/eyJ[A-Za-z0-9_.-]+/JWT/g')
echo MARKER_AFTER_DESTROY=$(marker)
echo "DRIFT_AFTER_DESTROY=$(supabase stack status --output-format json | grep -o '"config_drift":{[^}]*}' | cut -c1-120)"`,
        { env: ENV },
      );
      const kd = kv(d.stdout);
      const sd = parseSteps(d.stdout);
      saveRaw("cl22d-drift.txt", scrub(d.stdout));
      out.push({
        id: "CL22d",
        title: "Config drift: enable_signup=false while the stack is running",
        status: "info",
        detail: `sign-up HTTP status: before edit ${kd.SIGNUP_BEFORE}; after start ${kd.SIGNUP_AFTER_START}; after stack restart ${kd.SIGNUP_AFTER_RESTART}; after stop and start ${kd.SIGNUP_AFTER_STOP_START}; after stack destroy and start ${kd.SIGNUP_AFTER_DESTROY}`,
        measurements: {
          signup_http_before_edit: kd.SIGNUP_BEFORE ?? "",
          edited_line: kd.SIGNUP_LINE ?? "",
          drift_in_status_json: scrub(kd.DRIFT_STATUS ?? "").slice(0, 200),
          drift_in_status_text: scrub(kd.DRIFT_TEXT ?? ""),
          start_again_exit: sd.start_again?.code ?? -1,
          start_again_line: sd.start_again?.line ?? "",
          signup_http_after_start: kd.SIGNUP_AFTER_START ?? "",
          restart_exit: sd.restart?.code ?? -1,
          restart_line: sd.restart?.line ?? "",
          signup_http_after_restart: kd.SIGNUP_AFTER_RESTART ?? "",
          signup_http_after_stop_start: kd.SIGNUP_AFTER_STOP_START ?? "",
          marker_table_after_stop_start: kd.MARKER_AFTER_STOP_START ?? "",
          drift_after_stop_start: scrub(kd.DRIFT_AFTER_STOP_START ?? ""),
          destroy_exit: sd.destroy?.code ?? -1,
          signup_http_after_destroy_start: kd.SIGNUP_AFTER_DESTROY ?? "",
          signup_body_after_destroy_start: scrub(kd.SIGNUP_BODY ?? ""),
          marker_table_after_destroy_start: kd.MARKER_AFTER_DESTROY === "" ? "absent" : (kd.MARKER_AFTER_DESTROY ?? ""),
          drift_after_destroy_start: scrub(kd.DRIFT_AFTER_DESTROY ?? ""),
        },
      });
    } catch (e) {
      out.push({ id: "CL22", title: this.title, status: "fail", detail: `threw: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      await box?.destroy();
    }
    return out;
  },
};

export default mod;
