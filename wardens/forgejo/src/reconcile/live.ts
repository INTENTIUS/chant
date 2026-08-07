/**
 * Live-state snapshot types.
 *
 * Each mirrors a desired-config slice (`config/types.ts`) with concrete values.
 * Where Forgejo addresses a resource by a numeric `id` (teams, webhooks), the id
 * is carried here so the apply path can target it — it is never diffed.
 */

import type { TeamPermission } from "../config/types.js";

export interface LiveOrgSettings {
  fullName?: string;
  description?: string;
  website?: string;
  location?: string;
  visibility?: "public" | "limited" | "private";
  repoAdminChangeTeamAccess?: boolean;
}

export interface LiveMember {
  username: string;
}

export interface LiveTeamMember {
  username: string;
}

export interface LiveTeamRepo {
  name: string;
}

export interface LiveTeam {
  /** Forgejo team id (used by the apply path; never diffed). */
  id?: number;
  description?: string;
  permission?: TeamPermission;
  canCreateOrgRepo?: boolean;
  includesAllRepositories?: boolean;
  units?: string[];
  members?: LiveTeamMember[];
  repos?: LiveTeamRepo[];
}

export interface LiveBranchProtection {
  ruleName: string;
  enablePush?: boolean;
  requireSignedCommits?: boolean;
  requiredApprovals?: number;
  enableStatusCheck?: boolean;
  statusCheckContexts?: string[];
  blockOnOutdatedBranch?: boolean;
  dismissStaleApprovals?: boolean;
}

export interface LiveWebhook {
  /** Forgejo hook id (used by the apply path; never diffed). */
  id?: number;
  url: string;
  type?: string;
  contentType?: "json" | "form";
  events?: string[];
  active?: boolean;
  branchFilter?: string;
}

export interface LiveSecret {
  name: string;
}

export interface LiveVariable {
  name: string;
  value?: string;
}

export interface LiveRepo {
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
  defaultMergeStyle?: string;
  topics?: string[];
  branchProtection?: LiveBranchProtection[];
  webhooks?: LiveWebhook[];
  secrets?: LiveSecret[];
  variables?: LiveVariable[];
}

/** Live snapshot of a single org's state. */
export interface LiveOrgState {
  settings?: LiveOrgSettings;
  members?: LiveMember[];
  teams?: Record<string, LiveTeam>;
  repos?: Record<string, LiveRepo>;
  secrets?: LiveSecret[];
  variables?: LiveVariable[];
  webhooks?: LiveWebhook[];
}
