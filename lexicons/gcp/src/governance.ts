/**
 * GCP governance authoring (#791, epic #787 C1): the desired-state config
 * shape the GCP cloud warden reconciles, and `landingZoneConfig()` — the
 * typed authoring layer that emits it.
 *
 * This is deliberately NOT a composite. The evaluability rules (EVL002/004,
 * #916/#952) require composites to declare a fixed set of resources, so a
 * data-driven folder tree walker cannot be one. The split mirrors the AWS
 * slice (lexicons/aws/src/governance.ts): authoring emits config (this
 * module, arbitrary cardinality); resources for greenfield bootstrap are the
 * fixed-shape composites in `composites/landing-zone.ts`; the warden
 * consumes only the config.
 *
 * GCP has no OrganizationRoot analog — organizations are created through
 * Cloud Identity / Workspace, never through the resource API.
 */

// ---------------------------------------------------------------------------
// The desired-state config shape the GCP cloud warden consumes
// ---------------------------------------------------------------------------

/** An org-policy definition, keyed by name in `GcpGovernanceConfig.orgPolicies`. */
export interface OrgPolicyConfig {
  description?: string;
  /** The constraint the policy binds, e.g. "iam.disableServiceAccountKeyCreation". */
  constraint: string;
  /** OrgPolicyPolicy `spec.rules` entries (enforce / values.allowedValues / …). */
  rules: Array<Record<string, unknown>>;
}

/** A project declared inside a folder. */
export interface ProjectConfig {
  name: string;
  /** Defaults to `name`. */
  projectId?: string;
}

/** One folder: its guardrails, projects, and child folders, keyed by display name. */
export interface FolderConfig {
  /** Names of org policies (from `orgPolicies`) attached to this folder. */
  orgPolicies?: string[];
  projects?: ProjectConfig[];
  children?: Record<string, FolderConfig>;
}

/**
 * The desired-state governance tree for one GCP organization. This is the
 * shape the GCP cloud warden loads as config — the GCP counterpart of
 * `AwsGovernanceConfig`. Cycles map onto the governance verbs (#790): the
 * folder/project tree is `org-unit`, org policies are `policy-guardrail`,
 * audit configuration is `audit-sink`.
 */
export interface GcpGovernanceConfig {
  organization: {
    /** Org-policy names enforced at the organization root. */
    orgPolicies?: string[];
  };
  /** Top-level folders under the organization, keyed by display name. */
  folders: Record<string, FolderConfig>;
  /** Org-policy definitions, keyed by the names the tree attaches. */
  orgPolicies: Record<string, OrgPolicyConfig>;
  /** Where audit evidence flows. */
  auditSinks?: {
    auditConfig?: { service: string; logTypes: string[] };
  };
}

// ---------------------------------------------------------------------------
// Baseline guardrails (shared with the bootstrap composites)
// ---------------------------------------------------------------------------

export const DISABLE_SA_KEY_CREATION: OrgPolicyConfig = {
  description: "User-managed service account keys cannot be created.",
  constraint: "iam.disableServiceAccountKeyCreation",
  rules: [{ enforce: "TRUE" }],
};

export const SKIP_DEFAULT_NETWORK: OrgPolicyConfig = {
  description: "New projects do not get the auto-mode default VPC.",
  constraint: "compute.skipDefaultNetworkCreation",
  rules: [{ enforce: "TRUE" }],
};

/** Allow resource creation only in `locations` (value-group syntax like "in:us-locations" works too). */
export function resourceLocationRestriction(locations: readonly string[]): OrgPolicyConfig {
  return {
    description: `Resources may only be created in [${locations.join(", ")}].`,
    constraint: "gcp.resourceLocations",
    rules: [{ values: { allowedValues: [...locations] } }],
  };
}

/** The audit-log coverage `auditAllServices` declares. */
export const AUDIT_ALL_SERVICES = {
  service: "allServices",
  logTypes: ["ADMIN_READ", "DATA_READ", "DATA_WRITE"],
} as const;

/**
 * The recommended foundation folder structure. Exported so callers can
 * extend it rather than restate it.
 */
export const FOUNDATION_FOLDERS: Record<string, FolderConfig> = {
  Security: {},
  Infrastructure: {},
  Sandbox: {},
  Workloads: {},
};

// ---------------------------------------------------------------------------
// Authoring
// ---------------------------------------------------------------------------

export interface LandingZoneConfigProps {
  /**
   * Start from the recommended foundation: Security / Infrastructure /
   * Sandbox / Workloads folders with `disable-sa-key-creation` and
   * `skip-default-network` enforced at the organization root. Default true;
   * your `folders`/`orgPolicies` merge over it (same-name keys win).
   */
  foundation?: boolean;
  /** Adds a root resource-location org policy allowing only these locations. */
  allowedLocations?: string[];
  /** Folder tree, merged over the foundation's. Greenfield (full tree) and brownfield (partial subtree) are both just this map. */
  folders?: Record<string, FolderConfig>;
  /** Org-policy definitions, merged over the foundation's. */
  orgPolicies?: Record<string, OrgPolicyConfig>;
  /** Extra org-policy names to enforce at the organization root. */
  rootOrgPolicies?: string[];
  /** Declare organization-wide audit logging (allServices, all three log types). */
  auditAllServices?: boolean;
}

/**
 * Author the desired-state tree the GCP cloud warden reconciles. Pure.
 * Throws when the tree attaches an org-policy name with no definition; only
 * policies the tree actually attaches are included in the output.
 */
export function landingZoneConfig(props: LandingZoneConfigProps = {}): GcpGovernanceConfig {
  const foundation = props.foundation ?? true;
  const orgPolicies: Record<string, OrgPolicyConfig> = {
    ...(foundation
      ? { "disable-sa-key-creation": DISABLE_SA_KEY_CREATION, "skip-default-network": SKIP_DEFAULT_NETWORK }
      : {}),
    ...(props.allowedLocations?.length
      ? { "resource-location-restriction": resourceLocationRestriction(props.allowedLocations) }
      : {}),
    ...props.orgPolicies,
  };
  const folders = { ...(foundation ? FOUNDATION_FOLDERS : {}), ...props.folders };
  const rootOrgPolicies = [
    ...(foundation ? ["disable-sa-key-creation", "skip-default-network"] : []),
    ...(props.allowedLocations?.length ? ["resource-location-restriction"] : []),
    ...(props.rootOrgPolicies ?? []),
  ];

  const attached = new Set(rootOrgPolicies);
  const collect = (tree: Record<string, FolderConfig>): void => {
    for (const node of Object.values(tree)) {
      for (const p of node.orgPolicies ?? []) attached.add(p);
      if (node.children) collect(node.children);
    }
  };
  collect(folders);
  for (const name of attached) {
    if (!orgPolicies[name]) {
      throw new Error(`landingZoneConfig: org policy "${name}" is attached but not defined in orgPolicies`);
    }
  }

  return {
    organization: rootOrgPolicies.length ? { orgPolicies: rootOrgPolicies } : {},
    folders,
    orgPolicies: Object.fromEntries(Object.entries(orgPolicies).filter(([n]) => attached.has(n))),
    ...(props.auditAllServices
      ? { auditSinks: { auditConfig: { service: AUDIT_ALL_SERVICES.service, logTypes: [...AUDIT_ALL_SERVICES.logTypes] } } }
      : {}),
  };
}
