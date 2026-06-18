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
