/**
 * The scoped tokens an operator creates in the dashboard (creation has no API,
 * see SP01) and hands in through PVLAB_SCOPED_PAT_<ROLE>.
 *
 * `grants` is OUR guess at which spec permission names each dashboard toggle
 * maps to. It is only used to predict a refusal; the observed
 * `missing_permissions` is the measurement, and a wrong guess shows up as a
 * mismatch row, not as a wrong result. Override per role with
 * PVLAB_SCOPED_PAT_<ROLE>_GRANTS=name,name.
 */
export interface Role {
  role: string;
  env: string;
  kind: "org" | "project";
  /** What the operator selects in the dashboard, in the dashboard's words. */
  handoff: string;
  grants: (specNames: ReadonlySet<string>) => Set<string>;
}

const ORG_LEVEL = /^(organizations?_|members_|snippets_|projects_|organization_)/;

export const ROLES: Role[] = [
  {
    role: "legacy",
    env: "PVLAB_LEGACY_PAT",
    kind: "org",
    handoff:
      "A pre-GA classic token (dashboard shows a Legacy badge), if one still exists on the account or the dashboard still offers one. Optional contrast for SP02/SP06: the lab's own SUPABASE_ACCESS_TOKEN already has the scoped sbp_fc format.",
    grants: (all) => new Set(all),
  },
  {
    role: "org",
    env: "PVLAB_SCOPED_PAT_ORG",
    kind: "org",
    handoff:
      "Resources: the Pro org only, all projects. Permissions: Organization Projects = Read-write, nothing else.",
    grants: () => new Set(["organization_projects_read", "organization_projects_create"]),
  },
  {
    role: "ro",
    env: "PVLAB_SCOPED_PAT_RO",
    kind: "project",
    handoff:
      "Resources: the fixture project only. Permissions: Read on every project-level permission EXCEPT API Key Secrets (leave that, and every Write, off).",
    grants: (all) =>
      new Set([...all].filter((n) => n.endsWith("_read") && !n.includes("secret") && !ORG_LEVEL.test(n))),
  },
  {
    role: "dbrw",
    env: "PVLAB_SCOPED_PAT_DBRW",
    kind: "project",
    handoff:
      "Resources: the fixture project only. Permissions: Database = Read-write, Project Settings = Read, API Keys = Read, API Key Secrets = Read.",
    grants: () =>
      new Set([
        "database_read",
        "database_write",
        "project_admin_read",
        "api_gateway_keys_read",
        "api_gateway_keys_secret_read",
      ]),
  },
  {
    role: "narrow",
    env: "PVLAB_SCOPED_PAT_NARROW",
    kind: "project",
    handoff: "Resources: the fixture project only. Permissions: Project Settings = Read, nothing else.",
    grants: () => new Set(["project_admin_read"]),
  },
  {
    role: "member",
    env: "PVLAB_SCOPED_PAT_MEMBER",
    kind: "project",
    handoff:
      "Created by a SECOND human member of the Pro org whose org role is Administrator or Developer (so it can be demoted). Resources: the fixture project only. Permissions: Database = Read-write, Project Settings = Read.",
    grants: () => new Set(["database_read", "database_write", "project_admin_read"]),
  },
  {
    role: "revoke",
    env: "PVLAB_SCOPED_PAT_REVOKE",
    kind: "project",
    handoff:
      "A throwaway token the operator deletes in the dashboard during the SP08 watch window. Resources: the fixture project only. Permissions: Project Settings = Read.",
    grants: () => new Set(["project_admin_read"]),
  },
];

export const roleOf = (name: string): Role => {
  const r = ROLES.find((x) => x.role === name);
  if (!r) throw new Error(`unknown role ${name}`);
  return r;
};

export function tokenFor(r: Role): string {
  return process.env[r.env] ?? "";
}

export function grantsFor(r: Role, specNames: ReadonlySet<string>): Set<string> {
  const o = process.env[`${r.env}_GRANTS`];
  if (o) return new Set(o.split(",").map((s) => s.trim()).filter(Boolean));
  return r.grants(specNames);
}

/** Token format class only; never the value. */
export function shape(tok: string): string {
  if (tok.startsWith("sbp_fc")) return "sbp_fc";
  if (tok.startsWith("sbp_")) return "sbp_other";
  return "non-sbp";
}

export const skipReason = (r: Role) => `${r.env} not set (${r.handoff})`;
