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
  /** Where audit evidence flows. */
  auditSinks?: {
    cloudtrail?: { bucket: string; multiRegion: boolean };
  };
}
