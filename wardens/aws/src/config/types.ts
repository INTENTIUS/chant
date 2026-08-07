/**
 * The desired-state governance tree the aws warden reconciles.
 *
 * Deliberately REDECLARED from `@intentius/chant-lexicon-aws`'s governance
 * module rather than imported: the uniform rule (#789) is that no lexicon is
 * ever required to run a warden, and an imported type would put the lexicon
 * into this package's published type graph. `config/types.test.ts` holds the
 * two declarations mutually assignable at compile time (the lexicon is a
 * devDependency), so they cannot drift silently.
 */

/** An SCP definition, keyed by name in `AwsGovernanceConfig.scps`. */
export interface ScpConfig {
  description?: string;
  /** The policy document (SCP JSON). */
  document: Record<string, unknown>;
}

/** A member account declared inside an OU. */
export interface AccountConfig {
  name: string;
  email: string;
}

/** One OU: its guardrails, accounts, and child OUs, keyed by OU name. */
export interface OuConfig {
  /** Names of SCPs (from `scps`) attached to this OU. */
  scps?: string[];
  accounts?: AccountConfig[];
  children?: Record<string, OuConfig>;
}

/** An IAM Identity Center permission set, keyed by name in `IdentityConfig.permissionSets`. */
export interface PermissionSetConfig {
  description?: string;
  /** ISO-8601 session duration, e.g. "PT8H". Omitted → the provider default (PT1H). */
  sessionDuration?: string;
  /** Managed policy ARNs attached to the set. */
  managedPolicies?: string[];
  /** Inline policy document attached to the set. */
  inlinePolicy?: Record<string, unknown>;
}

/** One permission-set grant to an identity-store principal on member accounts. */
export interface AssignmentConfig {
  /** Identity-store principal: a group's DisplayName or a user's UserName. */
  principal: string;
  principalType: "GROUP" | "USER";
  /** Permission-set name from `IdentityConfig.permissionSets`. */
  permissionSet: string;
  /** Account names (as declared in the OU tree) the grant applies to. */
  accounts: string[];
}

/** IAM Identity Center desired state — the `identity-assignment` verb (#792). */
export interface IdentityConfig {
  /** Permission-set definitions, keyed by the names assignments reference. */
  permissionSets: Record<string, PermissionSetConfig>;
  assignments?: AssignmentConfig[];
  /**
   * The named break-glass admin grant. Implicitly desired (reconcile keeps
   * it) and protected by the break-glass-admin guardrail: no plan may remove
   * this assignment or its permission set.
   */
  breakGlass?: AssignmentConfig;
}

/** The desired-state governance tree for one AWS organization. */
export interface AwsGovernanceConfig {
  organization: {
    /** SCP names attached at the organization root. */
    scps?: string[];
  };
  /** Top-level OUs under the root, keyed by OU name. */
  ous: Record<string, OuConfig>;
  /** SCP definitions, keyed by the names the tree attaches. */
  scps: Record<string, ScpConfig>;
  /** IAM Identity Center permission sets and account assignments. */
  identity?: IdentityConfig;
  /** Where audit evidence flows. */
  auditSinks?: {
    cloudtrail?: { bucket: string; multiRegion: boolean };
  };
}
