/**
 * Landing-zone bootstrap composites (#791, epic #787 C1) — the Azure slice.
 *
 * Fixed-shape resources for greenfield creation of the recommended
 * governance foundation. The evaluability rules (EVL002/004) require
 * composites to declare a fixed set of resources, so these carry the
 * foundation only; arbitrary management-group/subscription trees are
 * authored as config with `landingZoneConfig()` (../governance.ts) and
 * reconciled by the Azure cloud warden, and further groups/subscriptions
 * are declared as ordinary resources.
 *
 * A single ARM template cannot mix deployment scopes (AZR030, #1545), so
 * unlike the AWS/GCP slices the foundation splits per scope — each
 * composite emits at exactly one scope and belongs in its own project:
 *
 *   // tenant-scope project (management groups + subscription tenant policy)
 *   const lz = GovernanceFoundation({});
 *   // management-group-scope project, deployed to the tenant root group —
 *   // policy resources also deploy at subscription scope, so the project
 *   // pins the scope explicitly
 *   export const scope = deploymentScope("managementGroup");
 *   const gb = GovernanceBaseline({});
 *   const lr = LocationRestriction({ locations: ["westeurope"] });
 *   const al = ActivityLogSink({ workspaceId: "/subscriptions/.../workspaces/audit", location: "westeurope" });
 *
 * There is no OrganizationRoot analog — the tenant and its root management
 * group come from Entra ID, not the resource API, so greenfield and
 * brownfield both start from the existing tenant.
 */

import { Composite } from "@intentius/chant";
import {
  ManagementGroup,
  PolicyAssignment,
  PolicyDefinition,
  policies as SubscriptionTenantPolicy,
} from "../generated";
import {
  ACTIVITY_LOG_TO_LOG_ANALYTICS_DEFINITION_ID,
  DENY_CLASSIC_RESOURCES,
  DENY_UNMANAGED_DISKS,
  locationRestriction,
  type PolicyConfig,
} from "../governance";

function policyDefinition(name: string, policy: PolicyConfig): InstanceType<typeof PolicyDefinition> {
  return new PolicyDefinition({
    name,
    displayName: policy.displayName,
    description: policy.description,
    mode: policy.mode ?? "All",
    policyType: "Custom",
    ...(policy.parameters && { parameters: policy.parameters }),
    policyRule: policy.policyRule,
  });
}

/**
 * The explicit DependsOn (by ARM name) orders the assignment after its
 * definition — the serializer's inference only reads plain resourceId()
 * expressions, not managementGroupResourceId(). Management-group assignment
 * names are capped at 24 characters.
 */
function policyAssignment(
  name: string,
  definitionName: string,
  policy: PolicyConfig,
): InstanceType<typeof PolicyAssignment> {
  return new PolicyAssignment(
    {
      name,
      displayName: policy.displayName,
      policyDefinitionId: `[managementGroupResourceId('Microsoft.Authorization/policyDefinitions', '${definitionName}')]`,
    },
    { DependsOn: definitionName },
  );
}

// ---------------------------------------------------------------------------
// GovernanceFoundation — the management-group hierarchy (tenant scope)
// ---------------------------------------------------------------------------

export interface GovernanceFoundationProps {
  /** Management group the foundation hangs under. Default: the tenant root group. */
  parentId?: string;
  /** Block subscriptions from leaving the tenant (default true). */
  blockSubscriptionsLeavingTenant?: boolean;
}

export type GovernanceFoundationResult = {
  mgSecurity: InstanceType<typeof ManagementGroup>;
  mgInfrastructure: InstanceType<typeof ManagementGroup>;
  mgSandbox: InstanceType<typeof ManagementGroup>;
  mgWorkloads: InstanceType<typeof ManagementGroup>;
  subscriptionTenantPolicy: InstanceType<typeof SubscriptionTenantPolicy>;
};

/**
 * Security / Infrastructure / Sandbox / Workloads management groups with
 * subscriptions blocked from leaving the tenant — the same baseline
 * `landingZoneConfig()` declares. Deploys at tenant scope.
 */
export const GovernanceFoundation = Composite<GovernanceFoundationProps, GovernanceFoundationResult>((props) => {
  const group = (name: string): InstanceType<typeof ManagementGroup> =>
    new ManagementGroup({
      name,
      displayName: name,
      ...(props.parentId && {
        details: { parent: { id: `/providers/Microsoft.Management/managementGroups/${props.parentId}` } },
      }),
    });

  const subscriptionTenantPolicy = new SubscriptionTenantPolicy({
    name: "default",
    blockSubscriptionsLeavingTenant: props.blockSubscriptionsLeavingTenant ?? true,
  });

  return {
    mgSecurity: group("Security"),
    mgInfrastructure: group("Infrastructure"),
    mgSandbox: group("Sandbox"),
    mgWorkloads: group("Workloads"),
    subscriptionTenantPolicy,
  };
}, "GovernanceFoundation");

// ---------------------------------------------------------------------------
// GovernanceBaseline — the baseline guardrails (management-group scope)
// ---------------------------------------------------------------------------

export type GovernanceBaselineProps = Record<string, never>;

export type GovernanceBaselineResult = {
  definitionDenyClassicResources: InstanceType<typeof PolicyDefinition>;
  definitionDenyUnmanagedDisks: InstanceType<typeof PolicyDefinition>;
  assignmentDenyClassicResources: InstanceType<typeof PolicyAssignment>;
  assignmentDenyUnmanagedDisks: InstanceType<typeof PolicyAssignment>;
};

/**
 * `deny-classic-resources` and `deny-unmanaged-disks` defined and assigned
 * at the management group the project deploys to (the tenant root group for
 * the `landingZoneConfig()` baseline). Custom policy definitions cannot
 * deploy at tenant scope, which is why this is not part of
 * GovernanceFoundation.
 */
export const GovernanceBaseline = Composite<GovernanceBaselineProps, GovernanceBaselineResult>(() => {
  return {
    definitionDenyClassicResources: policyDefinition("deny-classic-resources", DENY_CLASSIC_RESOURCES),
    definitionDenyUnmanagedDisks: policyDefinition("deny-unmanaged-disks", DENY_UNMANAGED_DISKS),
    assignmentDenyClassicResources: policyAssignment("deny-classic", "deny-classic-resources", DENY_CLASSIC_RESOURCES),
    assignmentDenyUnmanagedDisks: policyAssignment("deny-unmanaged", "deny-unmanaged-disks", DENY_UNMANAGED_DISKS),
  };
}, "GovernanceBaseline");

// ---------------------------------------------------------------------------
// LocationRestriction — optional root guardrail (management-group scope)
// ---------------------------------------------------------------------------

export interface LocationRestrictionProps {
  /** The only locations resources may be created in ("global" is always excepted). */
  locations: string[];
}

export type LocationRestrictionResult = {
  definitionLocationRestriction: InstanceType<typeof PolicyDefinition>;
  assignmentLocationRestriction: InstanceType<typeof PolicyAssignment>;
};

export const LocationRestriction = Composite<LocationRestrictionProps, LocationRestrictionResult>((props) => {
  const policy = locationRestriction(props.locations);
  return {
    definitionLocationRestriction: policyDefinition("location-restriction", policy),
    assignmentLocationRestriction: policyAssignment("allowed-locations", "location-restriction", policy),
  };
}, "LocationRestriction");

// ---------------------------------------------------------------------------
// ActivityLogSink — the audit sink (management-group scope)
// ---------------------------------------------------------------------------

export interface ActivityLogSinkProps {
  /** Resource id of the Log Analytics workspace activity logs flow into. */
  workspaceId: string;
  /** Region for the assignment's managed identity (DeployIfNotExists remediation). */
  location: string;
}

export type ActivityLogSinkResult = {
  assignmentActivityLogSink: InstanceType<typeof PolicyAssignment>;
};

/**
 * Assigns the built-in DeployIfNotExists policy that streams every
 * subscription's activity log into a Log Analytics workspace — current and
 * future subscriptions under the management group alike.
 */
export const ActivityLogSink = Composite<ActivityLogSinkProps, ActivityLogSinkResult>((props) => {
  const assignmentActivityLogSink = new PolicyAssignment({
    name: "activity-log-sink",
    location: props.location,
    identity: { type: "SystemAssigned" },
    displayName: "Stream activity logs to Log Analytics",
    policyDefinitionId: ACTIVITY_LOG_TO_LOG_ANALYTICS_DEFINITION_ID,
    parameters: { logAnalytics: { value: props.workspaceId } },
  });
  return { assignmentActivityLogSink };
}, "ActivityLogSink");
