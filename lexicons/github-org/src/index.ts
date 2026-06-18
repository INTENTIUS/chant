// Config types
export type {
  GovernanceConfig,
  OrgConfig,
  OrgSettings,
  TeamConfig,
  TeamMember,
  TeamRepo,
  TeamRole,
  TeamRepoPermission,
  MemberConfig,
  OrgMemberRole,
  RepoConfig,
  BranchProtectionConfig,
} from "./config/types.js";

// Config loader
export { loadGovernanceConfig, GovernanceConfigError } from "./config/load.js";

// GitHub App auth client
export type { MintOptions, InstallationToken, AppClientOptions, AppClient } from "./auth/app-client.js";
export { mintInstallationToken, createAppClient, AppAuthError } from "./auth/app-client.js";

// Reconcile: plan/diff primitive
export type {
  ChangeKind,
  ChangeSetEntry,
  ChangeSet,
  FieldChange,
  DiffOptions,
  LiveOrgSettings,
  LiveTeamMember,
  LiveTeamRepo,
  LiveTeamConfig,
  LiveMemberConfig,
  LiveBranchProtectionConfig,
  LiveRepoConfig,
  LiveOrgState,
} from "./reconcile/diff.js";
export { diff, summarizeChangeSet, renderChangeSet } from "./reconcile/diff.js";

// Reconcile: guardrails
export type {
  GuardrailDiagnostic,
  GuardrailResult,
  RemovalDeltaCapOptions,
  AdminFloorOptions,
  RequiredAdminsOptions,
  RequireSelfOptions,
  GuardrailConfig,
} from "./reconcile/guardrails.js";
export {
  resolveRenames,
  removalDeltaCap,
  adminFloor,
  requiredAdmins,
  requireSelf,
  runGuardrails,
} from "./reconcile/guardrails.js";
