/**
 * Azure governance authoring (#791, epic #787 C1): the desired-state config
 * shape the Azure cloud warden reconciles, and `landingZoneConfig()` — the
 * typed authoring layer that emits it.
 *
 * This is deliberately NOT a composite. The evaluability rules (EVL002/004,
 * #916/#952) require composites to declare a fixed set of resources, so a
 * data-driven management-group tree walker cannot be one. The split mirrors
 * the AWS/GCP slices (lexicons/{aws,gcp}/src/governance.ts): authoring emits
 * config (this module, arbitrary cardinality); resources for greenfield
 * bootstrap are the fixed-shape composites in `composites/landing-zone.ts`;
 * the warden consumes only the config.
 *
 * Azure has no OrganizationRoot analog — the tenant and its root management
 * group come from Entra ID, never from the resource API. Subscriptions the
 * tree declares reconcile through Microsoft.Subscription/aliases (existing
 * ids are placed, missing ones created from `billingScope`); aliases deploy
 * at tenant scope only (#1545).
 */

// ---------------------------------------------------------------------------
// The desired-state config shape the Azure cloud warden consumes
// ---------------------------------------------------------------------------

/** A custom policy definition, keyed by name in `AzureGovernanceConfig.policies`. */
export interface PolicyConfig {
  description?: string;
  displayName?: string;
  /** The policy definition mode ("All", "Indexed", …). Defaults to "All". */
  mode?: string;
  /** Parameter definitions for parameters used in the policy rule. */
  parameters?: Record<string, unknown>;
  /** The policy rule (if/then). */
  policyRule: Record<string, unknown>;
}

/** A subscription declared inside a management group. */
export interface SubscriptionConfig {
  name: string;
  /** An existing subscription to place. Omitted: the warden creates one via a tenant-scope alias. */
  subscriptionId?: string;
  /** Billing scope for subscriptions the warden creates. */
  billingScope?: string;
  workload?: "Production" | "DevTest";
}

/** One management group: its guardrails, subscriptions, and children, keyed by group id. */
export interface ManagementGroupConfig {
  /** Defaults to the group id (the tree key). */
  displayName?: string;
  /** Names of policies (from `policies`) assigned to this management group. */
  policies?: string[];
  subscriptions?: SubscriptionConfig[];
  children?: Record<string, ManagementGroupConfig>;
}

/**
 * The desired-state governance tree for one Azure tenant. This is the shape
 * the Azure cloud warden loads as config — the Azure counterpart of
 * `AwsGovernanceConfig`/`GcpGovernanceConfig`. Cycles map onto the
 * governance verbs (#790): the management-group/subscription tree is
 * `org-unit`, policy assignments are `policy-guardrail`, the activity-log
 * sink is `audit-sink`.
 */
export interface AzureGovernanceConfig {
  tenant: {
    /** Policy names assigned at the tenant root management group. */
    policies?: string[];
    /** Block subscriptions from leaving the tenant (Microsoft.Subscription/policies). */
    blockSubscriptionsLeavingTenant?: boolean;
  };
  /** Top-level management groups under the tenant root, keyed by group id. */
  managementGroups: Record<string, ManagementGroupConfig>;
  /** Custom policy definitions, keyed by the names the tree assigns. */
  policies: Record<string, PolicyConfig>;
  /** Where audit evidence flows. */
  auditSinks?: {
    activityLog?: { workspaceId: string };
  };
}

// ---------------------------------------------------------------------------
// Baseline guardrails (shared with the bootstrap composites)
// ---------------------------------------------------------------------------

export const DENY_CLASSIC_RESOURCES: PolicyConfig = {
  description: "Classic (ASM) compute, network, and storage resources cannot be created.",
  displayName: "Deny classic resources",
  mode: "All",
  policyRule: {
    if: { field: "type", like: "Microsoft.Classic*" },
    then: { effect: "deny" },
  },
};

export const DENY_UNMANAGED_DISKS: PolicyConfig = {
  description: "Virtual machines and scale sets must use managed disks.",
  displayName: "Deny unmanaged disks",
  mode: "All",
  policyRule: {
    if: {
      anyOf: [
        {
          allOf: [
            { field: "type", equals: "Microsoft.Compute/virtualMachines" },
            { field: "Microsoft.Compute/virtualMachines/osDisk.uri", exists: "true" },
          ],
        },
        {
          allOf: [
            { field: "type", equals: "Microsoft.Compute/virtualMachineScaleSets" },
            {
              anyOf: [
                { field: "Microsoft.Compute/VirtualMachineScaleSets/osDisk.vhdContainers", exists: "true" },
                { field: "Microsoft.Compute/VirtualMachineScaleSets/osdisk.imageUrl", exists: "true" },
              ],
            },
          ],
        },
      ],
    },
    then: { effect: "deny" },
  },
};

/** Allow resource creation only in `locations` ("global" is always excepted). */
export function locationRestriction(locations: readonly string[]): PolicyConfig {
  return {
    description: `Resources may only be created in [${locations.join(", ")}].`,
    displayName: "Allowed locations",
    mode: "Indexed",
    policyRule: {
      if: {
        allOf: [
          { field: "location", notIn: [...locations] },
          { field: "location", notEquals: "global" },
        ],
      },
      then: { effect: "deny" },
    },
  };
}

/**
 * The built-in DeployIfNotExists policy "Configure Azure Activity logs to
 * stream to specified Log Analytics workspace" — the activity-log audit
 * sink is wired by assigning it, not by declaring diagnostic settings in
 * every subscription (Microsoft.Insights/diagnosticSettings is not in the
 * generated surface, and the assignment covers future subscriptions too).
 */
export const ACTIVITY_LOG_TO_LOG_ANALYTICS_DEFINITION_ID =
  "/providers/Microsoft.Authorization/policyDefinitions/2465583e-4e78-4c15-b6be-a36cbc7c8b0f";

/**
 * The recommended foundation management-group structure. Exported so
 * callers can extend it rather than restate it.
 */
export const FOUNDATION_MANAGEMENT_GROUPS: Record<string, ManagementGroupConfig> = {
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
   * Sandbox / Workloads management groups, `deny-classic-resources` and
   * `deny-unmanaged-disks` assigned at the tenant root, and subscriptions
   * blocked from leaving the tenant. Default true; your
   * `managementGroups`/`policies` merge over it (same-name keys win).
   */
  foundation?: boolean;
  /** Adds a root allowed-locations policy allowing only these locations. */
  allowedLocations?: string[];
  /** Management-group tree, merged over the foundation's. Greenfield (full tree) and brownfield (partial subtree) are both just this map. */
  managementGroups?: Record<string, ManagementGroupConfig>;
  /** Policy definitions, merged over the foundation's. */
  policies?: Record<string, PolicyConfig>;
  /** Extra policy names to assign at the tenant root management group. */
  rootPolicies?: string[];
  /** Declare the activity-log audit sink flowing into this Log Analytics workspace (resource id). */
  activityLogWorkspaceId?: string;
}

/**
 * Author the desired-state tree the Azure cloud warden reconciles. Pure.
 * Throws when the tree assigns a policy name with no definition; only
 * policies the tree actually assigns are included in the output.
 */
export function landingZoneConfig(props: LandingZoneConfigProps = {}): AzureGovernanceConfig {
  const foundation = props.foundation ?? true;
  const policies: Record<string, PolicyConfig> = {
    ...(foundation
      ? { "deny-classic-resources": DENY_CLASSIC_RESOURCES, "deny-unmanaged-disks": DENY_UNMANAGED_DISKS }
      : {}),
    ...(props.allowedLocations?.length
      ? { "location-restriction": locationRestriction(props.allowedLocations) }
      : {}),
    ...props.policies,
  };
  const managementGroups = { ...(foundation ? FOUNDATION_MANAGEMENT_GROUPS : {}), ...props.managementGroups };
  const rootPolicies = [
    ...(foundation ? ["deny-classic-resources", "deny-unmanaged-disks"] : []),
    ...(props.allowedLocations?.length ? ["location-restriction"] : []),
    ...(props.rootPolicies ?? []),
  ];

  const assigned = new Set(rootPolicies);
  const collect = (tree: Record<string, ManagementGroupConfig>): void => {
    for (const node of Object.values(tree)) {
      for (const p of node.policies ?? []) assigned.add(p);
      if (node.children) collect(node.children);
    }
  };
  collect(managementGroups);
  for (const name of assigned) {
    if (!policies[name]) {
      throw new Error(`landingZoneConfig: policy "${name}" is assigned but not defined in policies`);
    }
  }

  return {
    tenant: {
      ...(rootPolicies.length ? { policies: rootPolicies } : {}),
      ...(foundation ? { blockSubscriptionsLeavingTenant: true } : {}),
    },
    managementGroups,
    policies: Object.fromEntries(Object.entries(policies).filter(([n]) => assigned.has(n))),
    ...(props.activityLogWorkspaceId
      ? { auditSinks: { activityLog: { workspaceId: props.activityLogWorkspaceId } } }
      : {}),
  };
}
