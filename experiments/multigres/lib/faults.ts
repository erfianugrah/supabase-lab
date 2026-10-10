import { cells, dexec, psql, type CellInfo } from "./cluster";
import { descendants, type Fault } from "./scenario";

const pidsOf = (p: CellInfo): number[] => [p.postmasterPid, p.poolerPid, p.pgctldPid].filter((x): x is number => x !== null);

/** SIGKILL the primary's postmaster only. pgctld and multipooler of that cell stay up. */
export const killPostgres: Fault = {
  label: "SIGKILL postgres postmaster (pgctld and multipooler of the cell left running)",
  async inject(container, p) {
    if (p.postmasterPid === null) throw new Error("no postmaster pid");
    const r = await dexec(container, ["kill", "-9", String(p.postmasterPid)]);
    return `kill -9 ${p.postmasterPid} exit ${r.code}`;
  },
};

/** SIGKILL postgres, multipooler and pgctld of the primary's cell: the pod-loss shape. The cell's gateway and multiorch stay up. */
export const killCell: Fault = {
  label: "SIGKILL postgres + multipooler + pgctld of the primary's cell",
  async inject(container, p) {
    const pids = pidsOf(p);
    const r = await dexec(container, ["kill", "-9", ...pids.map(String)]);
    return `kill -9 ${pids.join(" ")} exit ${r.code}`;
  },
};

/** SIGSTOP the primary's whole postgres tree, multipooler and pgctld for holdMs, then SIGCONT: a hung host that comes back. */
export const freezeCell = (holdMs: number): Fault => ({
  label: `SIGSTOP postgres tree + multipooler + pgctld of the primary's cell for ${holdMs} ms, then SIGCONT`,
  holdMs,
  async inject(container, p) {
    const tree = p.postmasterPid === null ? [] : [p.postmasterPid, ...(await descendants(container, p.postmasterPid))];
    frozen.set(p.serviceId, [...tree, ...pidsOf(p).filter((x) => !tree.includes(x))]);
    const pids = frozen.get(p.serviceId)!;
    const r = await dexec(container, ["kill", "-STOP", ...pids.map(String)]);
    return `kill -STOP ${pids.length} pids exit ${r.code}`;
  },
  async release(container, p) {
    const pids = frozen.get(p.serviceId) ?? [];
    const r = await dexec(container, ["kill", "-CONT", ...pids.map(String)]);
    return `kill -CONT ${pids.length} pids exit ${r.code}`;
  },
});

const frozen = new Map<string, number[]>();

/**
 * Adversarial durability probe. Under load, SIGSTOP one standby's postgres so it
 * falls `lagMs` behind (the other standby keeps acknowledging the synchronous
 * commits). Then, in one `docker exec`, SIGKILL the primary AND the up-to-date
 * standby and SIGCONT the lagging one. If the orchestrator promoted the lagging
 * standby, every commit acknowledged during the lag is gone; a correct one
 * waits for a node that has them. The pgctld and multipooler of every cell
 * stay up throughout.
 */
export const lagThenDoubleKill = (lagMs: number): Fault => {
  let laggard: CellInfo | undefined;
  let laggardTree: number[] = [];
  // Resolved in prepare(): cells() runs psql on every node and waits 10 s on a
  // stopped one, which must not happen between tFault and the kill.
  let victims: number[] = [];
  return {
    label: `SIGSTOP one standby's postgres ${lagMs} ms, then SIGKILL primary + other standby postgres and SIGCONT the lagging one`,
    async prepare(container, primary) {
      const cs = (await cells(container)).filter((c) => c.serviceId !== primary.serviceId && c.postmasterPid !== null);
      laggard = cs[0];
      if (!laggard || laggard.postmasterPid === null) throw new Error("no standby to lag");
      laggardTree = [laggard.postmasterPid, ...(await descendants(container, laggard.postmasterPid))];
      const other = cs.find((c) => c.serviceId !== laggard?.serviceId);
      if (!other || other.postmasterPid === null || primary.postmasterPid === null) throw new Error("topology changed");
      victims = [primary.postmasterPid, other.postmasterPid];
      const r = await dexec(container, ["kill", "-STOP", ...laggardTree.map(String)]);
      await Bun.sleep(lagMs);
      // Evidence that the standby really is behind: the primary's own view of each walsender.
      const lag = await psql(
        container,
        primary.pgPort,
        "select string_agg(application_name || ' ' || state || ' flush_lag_bytes=' || coalesce(pg_wal_lsn_diff(pg_current_wal_lsn(), flush_lsn), -1)::bigint::text, '; ') from pg_stat_replication",
      );
      return `stopped ${laggard.cell} (service ${laggard.serviceId}) postgres tree, ${laggardTree.length} pids, exit ${r.code}, for ${lagMs} ms; primary's pg_stat_replication: ${lag ?? "unreadable"}; will kill postgres of ${primary.cell} and ${other.cell}`;
    },
    async inject(container) {
      const script = `kill -9 ${victims.join(" ")}; kill -CONT ${laggardTree.join(" ")}`;
      const r = await dexec(container, ["sh", "-c", script]);
      return `killed ${victims.length} postmasters, resumed the lagging standby's ${laggardTree.length} pids; exit ${r.code}`;
    },
    laggardServiceId: () => laggard?.serviceId,
  };
};
