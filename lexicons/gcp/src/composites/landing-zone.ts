/**
 * Landing-zone bootstrap composites (#791, epic #787 C1) — the GCP slice.
 *
 * Fixed-shape resources for greenfield creation of the recommended
 * governance foundation through a Config Connector management stack. The
 * evaluability rules (EVL002/004) require composites to declare a fixed set
 * of resources, so these carry the foundation only; arbitrary folder/project
 * trees are authored as config with `landingZoneConfig()` (../governance.ts)
 * and reconciled by the GCP cloud warden, and further folders/projects are
 * declared as ordinary resources.
 *
 * The pieces compose:
 *   const lz = GovernanceFoundation({ orgId: "123456789012" });
 *   const lr = LocationRestriction({ orgId: "123456789012", locations: ["in:eu-locations"] });
 *   const ac = OrganizationAuditConfig({ orgId: "123456789012" });
 * There is no OrganizationRoot analog — GCP organizations come from Cloud
 * Identity / Workspace, not the resource API, so greenfield and brownfield
 * both start from an existing org id.
 */

import { Composite } from "@intentius/chant";
import { IAMAuditConfig, OrgpolicyPolicy, ResourcemanagerFolder } from "../generated";
import {
  AUDIT_ALL_SERVICES,
  DISABLE_SA_KEY_CREATION,
  SKIP_DEFAULT_NETWORK,
  resourceLocationRestriction,
  type OrgPolicyConfig,
} from "../governance";

/** "organizations/123" and "123" are both accepted everywhere an org id appears. */
function orgNumber(orgId: string): string {
  return orgId.replace(/^organizations\//, "");
}

function labels(component: string): Record<string, string> {
  return {
    "app.kubernetes.io/managed-by": "chant",
    "app.kubernetes.io/component": component,
  };
}

function orgPolicy(
  metaName: string,
  policy: OrgPolicyConfig,
  orgId: string,
  namespace?: string,
): InstanceType<typeof OrgpolicyPolicy> {
  return new OrgpolicyPolicy({
    metadata: {
      name: metaName,
      ...(namespace && { namespace }),
      labels: labels("org-policy"),
    },
    resourceID: policy.constraint,
    organizationRef: { external: orgNumber(orgId) },
    spec: { rules: policy.rules },
  } as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// GovernanceFoundation — the recommended foundation
// ---------------------------------------------------------------------------

export interface GovernanceFoundationProps {
  /** The organization to hang the foundation off ("123456789012" or "organizations/123456789012"). */
  orgId: string;
  /** Namespace for all resources. */
  namespace?: string;
}

export type GovernanceFoundationResult = {
  folderSecurity: InstanceType<typeof ResourcemanagerFolder>;
  folderInfrastructure: InstanceType<typeof ResourcemanagerFolder>;
  folderSandbox: InstanceType<typeof ResourcemanagerFolder>;
  folderWorkloads: InstanceType<typeof ResourcemanagerFolder>;
  policyDisableSaKeyCreation: InstanceType<typeof OrgpolicyPolicy>;
  policySkipDefaultNetwork: InstanceType<typeof OrgpolicyPolicy>;
};

/**
 * Security / Infrastructure / Sandbox / Workloads folders with
 * `disable-sa-key-creation` and `skip-default-network` enforced at the
 * organization root — the same baseline `landingZoneConfig()` declares.
 */
export const GovernanceFoundation = Composite<GovernanceFoundationProps, GovernanceFoundationResult>((props) => {
  const { orgId, namespace } = props;
  const folder = (metaName: string, displayName: string): InstanceType<typeof ResourcemanagerFolder> =>
    new ResourcemanagerFolder({
      metadata: {
        name: metaName,
        ...(namespace && { namespace }),
        labels: labels("folder"),
      },
      displayName,
      organizationRef: { external: orgNumber(orgId) },
    } as Record<string, unknown>);

  return {
    folderSecurity: folder("security", "Security"),
    folderInfrastructure: folder("infrastructure", "Infrastructure"),
    folderSandbox: folder("sandbox", "Sandbox"),
    folderWorkloads: folder("workloads", "Workloads"),
    policyDisableSaKeyCreation: orgPolicy("disable-sa-key-creation", DISABLE_SA_KEY_CREATION, orgId, namespace),
    policySkipDefaultNetwork: orgPolicy("skip-default-network", SKIP_DEFAULT_NETWORK, orgId, namespace),
  };
}, "GovernanceFoundation");

// ---------------------------------------------------------------------------
// LocationRestriction — optional root guardrail
// ---------------------------------------------------------------------------

export interface LocationRestrictionProps {
  /** The organization the policy binds to. */
  orgId: string;
  /** The only locations resources may be created in (value groups like "in:eu-locations" work). */
  locations: string[];
  /** Namespace for all resources. */
  namespace?: string;
}

export type LocationRestrictionResult = {
  policyResourceLocations: InstanceType<typeof OrgpolicyPolicy>;
};

export const LocationRestriction = Composite<LocationRestrictionProps, LocationRestrictionResult>((props) => {
  const policyResourceLocations = orgPolicy(
    "resource-location-restriction",
    resourceLocationRestriction(props.locations),
    props.orgId,
    props.namespace,
  );
  return { policyResourceLocations };
}, "LocationRestriction");

// ---------------------------------------------------------------------------
// OrganizationAuditConfig — the audit sink
// ---------------------------------------------------------------------------

export interface OrganizationAuditConfigProps {
  /** The organization audit logging is enabled on. */
  orgId: string;
  /** Defaults to "allServices". */
  service?: string;
  /** Defaults to ADMIN_READ / DATA_READ / DATA_WRITE. */
  logTypes?: string[];
  /** Namespace for all resources. */
  namespace?: string;
}

export type OrganizationAuditConfigResult = {
  auditConfig: InstanceType<typeof IAMAuditConfig>;
};

export const OrganizationAuditConfig = Composite<OrganizationAuditConfigProps, OrganizationAuditConfigResult>(
  (props) => {
    const auditConfig = new IAMAuditConfig({
      metadata: {
        name: "organization-audit",
        ...(props.namespace && { namespace: props.namespace }),
        labels: labels("audit"),
      },
      resourceRef: {
        kind: "Organization",
        external: `organizations/${orgNumber(props.orgId)}`,
      },
      service: props.service ?? AUDIT_ALL_SERVICES.service,
      auditLogConfigs: (props.logTypes ?? [...AUDIT_ALL_SERVICES.logTypes]).map((logType) => ({ logType })),
    } as Record<string, unknown>);
    return { auditConfig };
  },
  "OrganizationAuditConfig",
);
