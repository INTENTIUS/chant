/**
 * Forgejo plan/diff.
 *
 * Composes the shared `diffCollection` / `diffFields` primitives from
 * `@intentius/chant/reconcile` over Forgejo's resource types into a `ChangeSet`.
 * The diff machinery is imported, not vendored.
 *
 * Selective-by-omission (a field/collection absent from desired is never
 * diffed) and ownership-gated deletes (`opts.isOwned`).
 */

import {
  diffCollection,
  diffFields,
  summarizeChangeSet,
  renderChangeSet,
} from "@intentius/chant/reconcile";
import type {
  ChangeSet,
  ChangeSetEntry,
  DiffOptions,
  FieldChange,
} from "@intentius/chant/reconcile";
import type {
  OrgConfig,
  OrgSettings,
  MemberConfig,
  TeamConfig,
  TeamMember,
  TeamRepo,
  RepoConfig,
  BranchProtectionConfig,
  WebhookConfig,
  SecretConfig,
  VariableConfig,
  RepoBaselineConfig,
} from "../config/types.js";
import type {
  LiveOrgState,
  LiveOrgSettings,
  LiveMember,
  LiveTeam,
  LiveTeamMember,
  LiveTeamRepo,
  LiveRepo,
  LiveBranchProtection,
  LiveWebhook,
  LiveSecret,
  LiveVariable,
} from "./live.js";

// Re-export the shared change-set surface so cycles import it from here.
export type { ChangeSet, ChangeSetEntry, DiffOptions, FieldChange } from "@intentius/chant/reconcile";
export { summarizeChangeSet, renderChangeSet } from "@intentius/chant/reconcile";

// ---------------------------------------------------------------------------
// Stable ordering
// ---------------------------------------------------------------------------

const RESOURCE_TYPE_ORDER = [
  "org-settings",
  "org-secret",
  "org-variable",
  "org-webhook",
  "repo-baseline",
  "team",
  "team-member",
  "team-repo",
  "member",
  "repo",
  "branch-protection",
  "repo-webhook",
  "repo-secret",
  "repo-variable",
] as const;

// ---------------------------------------------------------------------------
// diff — entry point
// ---------------------------------------------------------------------------

export function diff(
  org: string,
  desired: OrgConfig,
  live: LiveOrgState,
  opts: DiffOptions = {},
): ChangeSet {
  const entries: ChangeSetEntry[] = [];

  diffSettings(desired.settings, live.settings, entries);
  diffSecrets("", "org-secret", desired.secrets, live.secrets ?? [], opts, entries);
  diffVariables("", "org-variable", desired.variables, live.variables ?? [], opts, entries);
  diffWebhooks("", "org-webhook", desired.webhooks, live.webhooks ?? [], opts, entries);
  diffRepoBaselines(desired.repoBaselines, live.repos ?? {}, entries);
  diffMembers(desired.members, live.members ?? [], opts, entries);
  diffTeams(desired.teams, live.teams ?? {}, opts, entries);
  diffRepos(desired.repos, live.repos ?? {}, opts, entries);

  const typeIndex = (t: string): number => {
    const i = (RESOURCE_TYPE_ORDER as readonly string[]).indexOf(t);
    return i === -1 ? RESOURCE_TYPE_ORDER.length : i;
  };
  entries.sort((a, b) => {
    const ti = typeIndex(a.resourceType) - typeIndex(b.resourceType);
    return ti !== 0 ? ti : a.key.localeCompare(b.key);
  });

  return { org, entries };
}

// ---------------------------------------------------------------------------
// Org settings (object diff)
// ---------------------------------------------------------------------------

function diffSettings(
  desired: OrgSettings | undefined,
  live: LiveOrgSettings | undefined,
  out: ChangeSetEntry[],
): void {
  if (desired === undefined) return;
  if (live === undefined) {
    out.push({ kind: "create", resourceType: "org-settings", key: "org-settings", after: desired });
    return;
  }
  const fields = diffFields(desired as Record<string, unknown>, live as Record<string, unknown>);
  if (fields.length > 0) {
    out.push({ kind: "update", resourceType: "org-settings", key: "org-settings", before: live, after: desired, fields });
  }
}

// ---------------------------------------------------------------------------
// Members (presence only — Forgejo membership is team-driven)
// ---------------------------------------------------------------------------

function diffMembers(
  desired: MemberConfig[] | undefined,
  live: LiveMember[],
  opts: DiffOptions,
  out: ChangeSetEntry[],
): void {
  if (desired === undefined) return;
  diffCollection<MemberConfig, LiveMember>({
    resourceType: "member",
    desired: new Map(desired.map((m) => [m.username, m])),
    live: new Map(live.map((m) => [m.username, m])),
    compareFields: () => [],
    opts,
    out,
  });
}

// ---------------------------------------------------------------------------
// Teams (+ embedded children on create; separate child entries on update)
// ---------------------------------------------------------------------------

const TEAM_FIELDS = ["description", "permission", "canCreateOrgRepo", "includesAllRepositories", "units"];

function diffTeams(
  desired: Record<string, TeamConfig> | undefined,
  live: Record<string, LiveTeam>,
  opts: DiffOptions,
  out: ChangeSetEntry[],
): void {
  if (desired === undefined) return;

  for (const [name, dt] of Object.entries(desired)) {
    const lt = live[name];
    if (!lt) {
      out.push({ kind: "create", resourceType: "team", key: name, after: dt });
      continue;
    }
    const fields = diffFields(dt as Record<string, unknown>, lt as Record<string, unknown>, TEAM_FIELDS);
    if (fields.length > 0) {
      out.push({ kind: "update", resourceType: "team", key: name, before: lt, after: dt, fields });
    }
    diffTeamMembers(name, dt.members, lt.members ?? [], opts, out);
    diffTeamRepos(name, dt.repos, lt.repos ?? [], opts, out);
  }

  for (const name of Object.keys(live)) {
    if (!Object.prototype.hasOwnProperty.call(desired, name) && opts.isOwned?.("team", name)) {
      out.push({ kind: "delete", resourceType: "team", key: name, before: live[name] });
    }
  }
}

function diffTeamMembers(
  team: string,
  desired: TeamMember[] | undefined,
  live: LiveTeamMember[],
  opts: DiffOptions,
  out: ChangeSetEntry[],
): void {
  if (desired === undefined) return;
  diffCollection<TeamMember, LiveTeamMember>({
    resourceType: "team-member",
    keyPrefix: `${team}/`,
    desired: new Map(desired.map((m) => [m.username, m])),
    live: new Map(live.map((m) => [m.username, m])),
    compareFields: () => [],
    opts,
    out,
  });
}

function diffTeamRepos(
  team: string,
  desired: TeamRepo[] | undefined,
  live: LiveTeamRepo[],
  opts: DiffOptions,
  out: ChangeSetEntry[],
): void {
  if (desired === undefined) return;
  diffCollection<TeamRepo, LiveTeamRepo>({
    resourceType: "team-repo",
    keyPrefix: `${team}/`,
    desired: new Map(desired.map((r) => [r.name, r])),
    live: new Map(live.map((r) => [r.name, r])),
    compareFields: () => [],
    opts,
    out,
  });
}

// ---------------------------------------------------------------------------
// Repos (object fields + topics + nested branch protection / webhooks / actions)
// ---------------------------------------------------------------------------

const REPO_FIELDS = [
  "description",
  "website",
  "private",
  "hasIssues",
  "hasWiki",
  "hasPullRequests",
  "defaultBranch",
  "allowMergeCommits",
  "allowRebase",
  "allowSquashMerge",
  "defaultMergeStyle",
];

function diffRepos(
  desired: Record<string, RepoConfig> | undefined,
  live: Record<string, LiveRepo>,
  opts: DiffOptions,
  out: ChangeSetEntry[],
): void {
  if (desired === undefined) return;

  for (const [name, dr] of Object.entries(desired)) {
    const lr = live[name];
    if (!lr) {
      out.push({ kind: "create", resourceType: "repo", key: name, after: dr });
      continue;
    }
    const fields = diffFields(dr as Record<string, unknown>, lr as Record<string, unknown>, REPO_FIELDS);
    if (dr.topics !== undefined) {
      const d = [...dr.topics].sort().join(",");
      const l = [...(lr.topics ?? [])].sort().join(",");
      if (d !== l) fields.push({ field: "topics", before: lr.topics ?? [], after: dr.topics });
    }
    if (fields.length > 0) {
      out.push({ kind: "update", resourceType: "repo", key: name, before: lr, after: dr, fields });
    }
    diffBranchProtection(name, dr.branchProtection, lr.branchProtection ?? [], opts, out);
    diffWebhooks(`${name}/`, "repo-webhook", dr.webhooks, lr.webhooks ?? [], opts, out);
    diffSecrets(`${name}/`, "repo-secret", dr.secrets, lr.secrets ?? [], opts, out);
    diffVariables(`${name}/`, "repo-variable", dr.variables, lr.variables ?? [], opts, out);
  }
}

// ---------------------------------------------------------------------------
// Branch protection
// ---------------------------------------------------------------------------

const BP_FIELDS = [
  "enablePush",
  "requireSignedCommits",
  "requiredApprovals",
  "enableStatusCheck",
  "blockOnOutdatedBranch",
  "dismissStaleApprovals",
];

function diffBranchProtection(
  repo: string,
  desired: BranchProtectionConfig[] | undefined,
  live: LiveBranchProtection[],
  opts: DiffOptions,
  out: ChangeSetEntry[],
): void {
  if (desired === undefined) return;
  diffCollection<BranchProtectionConfig, LiveBranchProtection>({
    resourceType: "branch-protection",
    keyPrefix: `${repo}/`,
    desired: new Map(desired.map((b) => [b.ruleName, b])),
    live: new Map(live.map((b) => [b.ruleName, b])),
    compareFields: (db, lb) => {
      const fields = diffFields(
        db as unknown as Record<string, unknown>,
        lb as unknown as Record<string, unknown>,
        BP_FIELDS,
      );
      if (db.statusCheckContexts !== undefined) {
        const d = [...db.statusCheckContexts].sort().join(",");
        const l = [...(lb.statusCheckContexts ?? [])].sort().join(",");
        if (d !== l) {
          fields.push({ field: "statusCheckContexts", before: lb.statusCheckContexts ?? [], after: db.statusCheckContexts });
        }
      }
      return fields;
    },
    opts,
    out,
  });
}

// ---------------------------------------------------------------------------
// Webhooks (keyed by url; live id carried on `before` for apply)
// ---------------------------------------------------------------------------

const WEBHOOK_FIELDS = ["type", "contentType", "active", "branchFilter"];

function diffWebhooks(
  keyPrefix: string,
  resourceType: "org-webhook" | "repo-webhook",
  desired: WebhookConfig[] | undefined,
  live: LiveWebhook[],
  opts: DiffOptions,
  out: ChangeSetEntry[],
): void {
  if (desired === undefined) return;
  diffCollection<WebhookConfig, LiveWebhook>({
    resourceType,
    keyPrefix,
    desired: new Map(desired.map((w) => [w.url, w])),
    live: new Map(live.map((w) => [w.url, w])),
    compareFields: (dw, lw) => {
      const fields = diffFields(
        dw as unknown as Record<string, unknown>,
        lw as unknown as Record<string, unknown>,
        WEBHOOK_FIELDS,
      );
      if (dw.events !== undefined) {
        const d = [...dw.events].sort().join(",");
        const l = [...(lw.events ?? [])].sort().join(",");
        if (d !== l) fields.push({ field: "events", before: lw.events ?? [], after: dw.events });
      }
      return fields;
    },
    opts,
    out,
  });
}

// ---------------------------------------------------------------------------
// Actions secrets (presence) & variables (value)
// ---------------------------------------------------------------------------

function diffSecrets(
  keyPrefix: string,
  resourceType: "org-secret" | "repo-secret",
  desired: SecretConfig[] | undefined,
  live: LiveSecret[],
  opts: DiffOptions,
  out: ChangeSetEntry[],
): void {
  if (desired === undefined) return;
  diffCollection<SecretConfig, LiveSecret>({
    resourceType,
    keyPrefix,
    desired: new Map(desired.map((s) => [s.name, s])),
    live: new Map(live.map((s) => [s.name, s])),
    compareFields: () => [],
    opts,
    out,
  });
}

function diffVariables(
  keyPrefix: string,
  resourceType: "org-variable" | "repo-variable",
  desired: VariableConfig[] | undefined,
  live: LiveVariable[],
  opts: DiffOptions,
  out: ChangeSetEntry[],
): void {
  if (desired === undefined) return;
  diffCollection<VariableConfig, LiveVariable>({
    resourceType,
    keyPrefix,
    desired: new Map(desired.map((v) => [v.name, v])),
    live: new Map(live.map((v) => [v.name, v])),
    compareFields: (dv, lv) =>
      dv.value !== undefined && dv.value !== lv.value
        ? [{ field: "value", before: lv.value, after: dv.value }]
        : [],
    opts,
    out,
  });
}

// ---------------------------------------------------------------------------
// Repo baselines (existence only)
// ---------------------------------------------------------------------------

function diffRepoBaselines(
  desired: RepoBaselineConfig[] | undefined,
  liveRepos: Record<string, LiveRepo>,
  out: ChangeSetEntry[],
): void {
  if (desired === undefined) return;
  for (const baseline of desired) {
    if (!Object.prototype.hasOwnProperty.call(liveRepos, baseline.name)) {
      out.push({ kind: "create", resourceType: "repo-baseline", key: baseline.name, after: baseline });
    }
  }
}
