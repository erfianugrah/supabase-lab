import { describe, expect, test } from "bun:test";
import { decide as gateDecide, type StatusComponent, type StatusIncident } from "./gate";
import {
  DEFAULT_RUNBOOK_POLICY,
  Detector,
  RecoveryTracker,
  advisesRestart,
  decide,
  gateView,
  supervise,
  type GateView,
  type RunbookIO,
  type RunbookPolicy,
} from "./runbook";
import type { ProbeOutcome } from "../../../harness/src/sampler";

const P = DEFAULT_RUNBOOK_POLICY;
const OPEN_GATE: GateView = { proceed: true, blockers: [], warnings: [] };
const MIN = 60_000;

// Status-page wording of the two cluster B incidents (public, trimmed to the
// sentences the classifier reads). https://status.supabase.com/
const nanoHang: StatusIncident = {
  id: "INC-NANO",
  name: "Unresponsive Projects",
  status: "monitoring",
  impact: "none",
  created_at: "2026-09-10T15:26:00Z",
  resolved_at: null,
  incident_updates: [
    {
      status: "monitoring",
      created_at: "2026-09-11T03:44:00Z",
      body: "We have rolled out a fix across all regions and are continuing to monitor over the next few hours. Users still affected by project outages are encouraged to restart their projects which has shown to resolve lasting errors.",
    },
    {
      status: "investigating",
      created_at: "2026-09-10T15:26:00Z",
      body: "We are aware of Nano projects becoming unresponsive after a period of time, typically hours. We are investigating.",
    },
  ],
};
const jwt401: StatusIncident = {
  id: "INC-JWT",
  name: "401 errors due to JWT rejections",
  status: "identified",
  impact: "none",
  created_at: "2026-08-14T02:23:00Z",
  resolved_at: null,
  incident_updates: [
    {
      status: "identified",
      created_at: "2026-08-27T17:17:00Z",
      body: "PostgREST 14.17 has now been rolled out to all regions. Some customers have reported that restarting their project after the rollout resolved this issue. To restart your project, go to the General settings page in the dashboard and select Restart project.",
    },
  ],
};
const restartsBroken: StatusIncident = {
  id: "INC-BROKEN",
  name: "Project restarts failing",
  status: "investigating",
  impact: "minor",
  created_at: "2026-10-01T00:00:00Z",
  resolved_at: null,
  incident_updates: [
    { status: "investigating", created_at: "2026-10-01T00:00:00Z", body: "Restarts are stuck. Please do not restart your project until this is resolved." },
  ],
};
const sg = (status = "operational"): StatusComponent[] =>
  Array.from({ length: 11 }, (_, i) => ({ id: `c${i}`, name: "ap-southeast-1", status }));

describe("status page during cluster B", () => {
  test("the plain LO01 gate refuses a restart during both cluster B incidents", () => {
    expect(gateDecide("ap-southeast-1", "restart", sg(), [nanoHang]).proceed).toBe(false);
    expect(gateDecide("ap-southeast-1", "restart", sg(), [jwt401]).proceed).toBe(false);
  });
  test("advisesRestart reads the advice in both, and a do-not-restart text wins", () => {
    expect(advisesRestart(nanoHang)).toBe(true);
    expect(advisesRestart(jwt401)).toBe(true);
    expect(advisesRestart(restartsBroken)).toBe(false);
  });
  test("gateView lets the advised restart through with a warning, and still blocks on the rest", () => {
    const v = gateView("ap-southeast-1", sg(), [nanoHang, jwt401]);
    expect(v.proceed).toBe(true);
    expect(v.warnings.filter((w) => w.includes("advises restart")).length).toBe(2);
    expect(gateView("ap-southeast-1", sg(), [nanoHang, restartsBroken]).proceed).toBe(false);
    expect(gateView("ap-southeast-1", sg("partial_outage"), [nanoHang]).proceed).toBe(false);
  });
});

describe("Detector", () => {
  const det = () => new Detector({ triggerPaths: ["rest_read"], detectAfterMs: 60_000, detectMinSamples: 10 });
  const o = (atMs: number, ok: boolean, name = "rest_read") => ({ atMs, outcomes: [{ name, ok, error: ok ? undefined : "timeout" }] });
  test("needs the full span of consecutive failures, and one success resets it", () => {
    const d = det();
    for (let t = 0; t <= 58_000; t += 2000) d.observe(o(t, false));
    expect(d.detected(58_000)).toEqual([]);
    d.observe(o(60_000, false));
    expect(d.detected(60_000)).toEqual(["rest_read"]);
    d.observe(o(62_000, true));
    expect(d.detected(62_000)).toEqual([]);
    expect(d.firstFailAt()).toBeNull();
  });
  test("a slow round cannot detect on too few samples", () => {
    const d = det();
    d.observe(o(0, false));
    d.observe(o(61_000, false));
    expect(d.detected(61_000)).toEqual([]);
  });
  test("a non-trigger path failing never detects, and its modes are kept", () => {
    const d = det();
    for (let t = 0; t <= 120_000; t += 2000) d.observe(o(t, false, "direct"));
    expect(d.detected(120_000)).toEqual([]);
    expect(d.modes.get("direct")).toEqual(["timeout"]);
  });
});

describe("RecoveryTracker", () => {
  test("returns the first sample of a sustained all-ok run", () => {
    const r = new RecoveryTracker(10_000);
    const ok = (atMs: number, a: boolean, b = true) => ({ atMs, outcomes: [{ name: "a", ok: a }, { name: "b", ok: b }] });
    expect(r.observe(ok(0, true))).toBeNull();
    expect(r.observe(ok(2000, false))).toBeNull();
    expect(r.observe(ok(4000, true))).toBeNull();
    expect(r.observe(ok(12_000, true, false))).toBeNull();
    expect(r.observe(ok(14_000, true))).toBeNull();
    expect(r.observe(ok(24_000, true))).toBe(14_000);
  });
});

describe("decide (guard rails)", () => {
  const base = { nowMs: 100 * MIN, detectedPaths: ["rest_read"], controlStatus: "ACTIVE_HEALTHY", restartsAtMs: [] as number[], gate: OPEN_GATE };
  test("no detection, no action", () => {
    expect(decide({ ...base, detectedPaths: [] }).action).toBe("none");
  });
  test("restart when detected, healthy status, no history, gate open", () => {
    expect(decide(base).action).toBe("restart");
  });
  test("hold while the control plane reports an operation", () => {
    for (const s of ["RESTARTING", "RESIZING", "UPGRADING", "COMING_UP", "HTTP 503"]) {
      const d = decide({ ...base, controlStatus: s });
      expect(d.action).toBe("hold");
      expect(d.reasons[1]).toContain(s);
    }
  });
  test("cooldown after a restart, then allowed", () => {
    expect(decide({ ...base, restartsAtMs: [base.nowMs - 5 * MIN] }).action).toBe("hold");
    expect(decide({ ...base, restartsAtMs: [base.nowMs - 16 * MIN] }).action).toBe("restart");
  });
  test("max restarts per window escalates, before any other rule", () => {
    const d = decide({ ...base, controlStatus: "RESTARTING", restartsAtMs: [base.nowMs - 40 * MIN, base.nowMs - 20 * MIN] });
    expect(d.action).toBe("escalate");
    expect(decide({ ...base, restartsAtMs: [base.nowMs - 70 * MIN, base.nowMs - 20 * MIN] }).action).toBe("restart");
  });
  test("hold inside ten minutes of creation", () => {
    expect(decide({ ...base, createdAtMs: base.nowMs - 5 * MIN }).action).toBe("hold");
    expect(decide({ ...base, createdAtMs: base.nowMs - 11 * MIN }).action).toBe("restart");
  });
  test("status page: blockers hold, unreadable holds unless failOpen", () => {
    expect(decide({ ...base, gate: { proceed: false, blockers: ["x"], warnings: [] } }).action).toBe("hold");
    expect(decide({ ...base, gate: { unreadable: "HTTP 503" } }).action).toBe("hold");
    expect(decide({ ...base, gate: { unreadable: "HTTP 503" } }, { ...P, gateFailOpen: true }).action).toBe("restart");
  });
});

/** Fake world: a clock that moves only on sleep, probes scripted by time. */
function world(script: {
  probe: (name: string, t: number, posts: number[]) => ProbeOutcome;
  status?: (t: number, posts: number[]) => string;
  restartHttp?: number;
  gate?: GateView | { unreadable: string };
  probes?: string[];
}) {
  let t = 0;
  const posts: number[] = [];
  const logs: string[] = [];
  const names = script.probes ?? ["rest_read", "direct"];
  const io: RunbookIO = {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    probes: names.map((name) => ({ name, run: async () => ({ ok: true }) })),
    runProbe: async (p) => script.probe(p.name, t, posts),
    controlStatus: async () => (script.status ? script.status(t, posts) : "ACTIVE_HEALTHY"),
    gate: async () => script.gate ?? OPEN_GATE,
    restart: async () => {
      posts.push(t);
      return { http: script.restartHttp ?? 200, body: "" };
    },
    log: (m) => logs.push(m),
  };
  return { io, posts, logs, now: () => t };
}

describe("supervise (fake clock)", () => {
  const policy: RunbookPolicy = { ...P };

  test("healthy project: no restart, no-fault after the watch", async () => {
    const w = world({ probe: () => ({ ok: true }) });
    const ep = await supervise(w.io, { policy, restartsAtMs: [], maxWatchMs: 10 * MIN });
    expect(ep.outcome).toBe("no-fault");
    expect(w.posts).toEqual([]);
  });

  test("a 30 s blip is not acted on", async () => {
    const w = world({ probe: (n, t) => ({ ok: !(n === "rest_read" && t >= 60_000 && t < 90_000), error: "timeout" }) });
    const ep = await supervise(w.io, { policy, restartsAtMs: [], maxWatchMs: 5 * MIN });
    expect(ep.outcome).toBe("no-fault");
    expect(w.posts).toEqual([]);
    expect(ep.failedSamples.rest_read).toBeGreaterThan(0);
  });

  test("hang: detect, restart, verify on the data path even though the status is healthy first", async () => {
    const hangAt = 20_000;
    // Restart: reads down until POST + 150 s; status RESTARTING from POST+5 s, healthy again at POST+40 s.
    const w = world({
      probe: (n, t, posts) => {
        const p = posts[0];
        if (n === "rest_read") return { ok: t < hangAt || (p !== undefined && t >= p + 150_000), error: "HTTP 500 57014" };
        return { ok: p === undefined || t < p + 2000 || t >= p + 140_000, error: "timeout" };
      },
      status: (t, posts) => {
        const p = posts[0];
        return p !== undefined && t >= p + 5000 && t < p + 40_000 ? "RESTARTING" : "ACTIVE_HEALTHY";
      },
    });
    const restarts: number[] = [];
    const ep = await supervise(w.io, { policy, restartsAtMs: restarts, maxWatchMs: 10 * MIN });
    expect(ep.outcome).toBe("recovered");
    expect(w.posts.length).toBe(1);
    expect(restarts).toEqual(w.posts);
    const detectS = ((ep.detectedAtMs as number) - (ep.firstFailAtMs as number)) / 1000;
    expect(detectS).toBeGreaterThanOrEqual(60);
    expect(detectS).toBeLessThan(63);
    expect(ep.statusHealthyAgainAtMs).not.toBeNull();
    expect(ep.statusHealthyAgainAtMs as number).toBeLessThan(ep.recoveredAtMs as number);
    expect((ep.recoveredAtMs as number) - (ep.postAtMs as number)).toBeGreaterThanOrEqual(150_000);
    expect(ep.statusTransitions.map((s) => s.status)).toEqual(["ACTIVE_HEALTHY", "RESTARTING", "ACTIVE_HEALTHY"]);
  });

  test("operation in flight: holds, never posts, then the fault clears by itself", async () => {
    const w = world({
      probe: (n, t) => ({ ok: n !== "rest_read" || t < 10_000 || t >= 200_000, error: "timeout" }),
      status: (t) => (t < 200_000 ? "RESIZING" : "ACTIVE_HEALTHY"),
    });
    const ep = await supervise(w.io, { policy, restartsAtMs: [], maxWatchMs: 10 * MIN });
    expect(w.posts).toEqual([]);
    expect(ep.decisions[0]?.action).toBe("hold");
    expect(ep.outcome).toBe("self-cleared");
  });

  test("cooldown: a second episode right after a restart holds, then restarts once the interval passes", async () => {
    const earlier = [0];
    const w = world({
      probe: (n, t, posts) => ({ ok: n !== "rest_read" || (posts[0] !== undefined && t >= posts[0] + 60_000), error: "timeout" }),
    });
    // Clock starts at 0 with a restart recorded at 0: the first decision is a hold.
    const ep = await supervise(w.io, { policy, restartsAtMs: earlier, maxWatchMs: 10 * MIN });
    expect(ep.decisions.map((d) => d.action)).toEqual(["hold", "restart"]);
    expect(w.posts[0]).toBeGreaterThanOrEqual(policy.minIntervalMs);
    expect(ep.outcome).toBe("recovered");
  });

  test("third restart inside the window escalates without a POST", async () => {
    const w = world({ probe: (n) => ({ ok: n !== "rest_read", error: "timeout" }) });
    w.io.now = () => 100 * MIN + 0;
    let t = 100 * MIN;
    w.io.now = () => t;
    w.io.sleep = async (ms) => {
      t += ms;
    };
    const ep = await supervise(w.io, { policy, restartsAtMs: [70 * MIN, 85 * MIN], maxWatchMs: 10 * MIN });
    expect(ep.outcome).toBe("escalated");
    expect(w.posts).toEqual([]);
  });

  test("restart that does not bring reads back: unrecovered after verifyMaxMs", async () => {
    const w = world({ probe: (n) => ({ ok: n !== "rest_read", error: "HTTP 401 PGRST301" }) });
    const ep = await supervise(w.io, { policy, restartsAtMs: [], maxWatchMs: 10 * MIN });
    expect(ep.outcome).toBe("unrecovered");
    expect(w.posts.length).toBe(1);
    expect(ep.modes.rest_read).toEqual(["HTTP 401 PGRST301"]);
  });

  test("a refused POST ends the episode with the body", async () => {
    const w = world({ probe: (n) => ({ ok: n !== "rest_read", error: "timeout" }), restartHttp: 400 });
    const ep = await supervise(w.io, { policy, restartsAtMs: [], maxWatchMs: 10 * MIN });
    expect(ep.outcome).toBe("restart-refused");
    expect(ep.postHttp).toBe(400);
  });

  test("status page blocking holds until the hard stop", async () => {
    const w = world({ probe: (n) => ({ ok: n !== "rest_read", error: "timeout" }), gate: { proceed: false, blockers: ["open, names ap-southeast-1"], warnings: [] } });
    const ep = await supervise(w.io, { policy, restartsAtMs: [], maxWatchMs: 10 * MIN, hardStopMs: 20 * MIN });
    expect(ep.outcome).toBe("hard-stop");
    expect(w.posts).toEqual([]);
  });
});
