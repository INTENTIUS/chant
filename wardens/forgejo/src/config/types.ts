/**
 * Desired-state config types for Forgejo org/repo governance.
 *
 * Selective-by-omission: every field is optional. An absent field means "not
 * managed" — warden will not read, diff, or modify that aspect of the live
 * Forgejo state. Only explicitly-present fields are reconciled.
 */

// ---------------------------------------------------------------------------
// Org settings
// ---------------------------------------------------------------------------

/** Org-level settings (`PATCH /orgs/{org}`). Absent fields are not managed. */
export interface OrgSettings {
  fullName?: string;
  description?: string;
  website?: string;
  location?: string;
  /** "public" | "limited" | "private". */
  visibility?: "public" | "limited" | "private";
  /** Whether repo admins may change team access to their repos. */
  repoAdminChangeTeamAccess?: boolean;
}

// ---------------------------------------------------------------------------
// Membership (team-driven in Forgejo)
// ---------------------------------------------------------------------------

/**
 * An org member. Forgejo org membership is team-driven (there is no direct
 * "add org member" — a user becomes a member by joining a team). So this models
 * presence; role/permission is expressed via team membership (see TeamConfig).
 */
export interface MemberConfig {
  username: string;
}

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

/** Team access level. */
export type TeamPermission = "read" | "write" | "admin" | "owner";

export interface TeamMember {
  username: string;
}

/** A repo a team has access to (the team's permission applies to it). */
export interface TeamRepo {
  name: string;
}

/** Desired state for a team. Keyed by team name in `OrgConfig.teams`. */
export interface TeamConfig {
  description?: string;
  permission?: TeamPermission;
  canCreateOrgRepo?: boolean;
  includesAllRepositories?: boolean;
  /** Enabled units, e.g. ["repo.code", "repo.issues", "repo.pulls"]. */
  units?: string[];
  members?: TeamMember[];
  repos?: TeamRepo[];
  /** Former team name; turns a rename into an update (see guardrail resolveRenames). */
  previously?: string;
}

// ---------------------------------------------------------------------------
// Branch protection
// ---------------------------------------------------------------------------

/**
 * A Forgejo branch protection rule (`branch_protections`). Keyed by `ruleName`.
 * Forgejo uses branch protections, not GitHub-style rulesets.
 */
export interface BranchProtectionConfig {
  /** Rule name (the identity key). Forgejo's `rule_name`. */
  ruleName: string;
  /** Branch name glob the rule applies to (Forgejo's `branch_name`/`rule_name`). */
  enablePush?: boolean;
  requireSignedCommits?: boolean;
  requiredApprovals?: number;
  enableStatusCheck?: boolean;
  statusCheckContexts?: string[];
  blockOnOutdatedBranch?: boolean;
  dismissStaleApprovals?: boolean;
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

/** An org or repo webhook. Keyed by `url`. */
export interface WebhookConfig {
  url: string;
  /** Hook type, e.g. "forgejo" | "gitea" | "slack". Default "forgejo". */
  type?: string;
  contentType?: "json" | "form";
  events?: string[];
  active?: boolean;
  branchFilter?: string;
}

// ---------------------------------------------------------------------------
// Actions secrets & variables
// ---------------------------------------------------------------------------

/** An Actions secret — presence only; warden never reads or writes values. */
export interface SecretConfig {
  name: string;
}

/** An Actions variable (values are not secret, reconciled fully). */
export interface VariableConfig {
  name: string;
  value?: string;
}

// ---------------------------------------------------------------------------
// Repo provisioning
// ---------------------------------------------------------------------------

/** A repo that must exist in the org; created (optionally from a template) when missing. */
export interface RepoBaselineConfig {
  name: string;
  /** Template repo as "owner/repo" to generate from; else an empty repo. */
  template?: string;
  /** New repo private? Default true. */
  private?: boolean;
}

// ---------------------------------------------------------------------------
// Repos
// ---------------------------------------------------------------------------

/** Desired state for a single repository. Absent fields are not managed. */
export interface RepoConfig {
  description?: string;
  website?: string;
  private?: boolean;
  hasIssues?: boolean;
  hasWiki?: boolean;
  hasPullRequests?: boolean;
  defaultBranch?: string;
  allowMergeCommits?: boolean;
  allowRebase?: boolean;
  allowSquashMerge?: boolean;
  /** "merge" | "rebase" | "rebase-merge" | "squash". */
  defaultMergeStyle?: string;
  topics?: string[];
  branchProtection?: BranchProtectionConfig[];
  webhooks?: WebhookConfig[];
  secrets?: SecretConfig[];
  variables?: VariableConfig[];
}

// ---------------------------------------------------------------------------
// Top-level config
// ---------------------------------------------------------------------------

/** Desired state for a single Forgejo organization. Absent fields are not managed. */
export interface OrgConfig {
  settings?: OrgSettings;
  members?: MemberConfig[];
  teams?: Record<string, TeamConfig>;
  repos?: Record<string, RepoConfig>;
  /** Repos that must exist in the org (provisioning). */
  repoBaselines?: RepoBaselineConfig[];
  /** Org-level Actions secrets/variables and webhooks. */
  secrets?: SecretConfig[];
  variables?: VariableConfig[];
  webhooks?: WebhookConfig[];
}

/** Top-level governance config: one or more orgs to manage, keyed by org name. */
export interface GovernanceConfig {
  orgs: Record<string, OrgConfig>;
}
