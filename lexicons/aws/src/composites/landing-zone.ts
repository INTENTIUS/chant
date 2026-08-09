/**
 * Landing-zone bootstrap composites.
 *
 * Fixed-shape resources for greenfield creation of the recommended
 * governance foundation through a management-account stack. The evaluability
 * rules (EVL002/004) require composites to declare a fixed set of resources,
 * so these carry the foundation only; arbitrary OU/account trees are
 * authored as config with `landingZoneConfig()` (../governance.ts) and
 * reconciled by an external governance reconciler, and further OUs/accounts are
 * declared as ordinary resources referencing these members' ids.
 *
 * The pieces compose:
 *   const org = OrganizationRoot({});                      // greenfield only
 *   const lz  = GovernanceFoundation({ parentRootId: org.organization.RootId });
 *   const rr  = RegionRestriction({ regions: ["eu-west-1"], targetIds: [org.organization.RootId] });
 *   const at  = OrganizationTrail({ bucket: "acme-org-audit" });
 * Brownfield skips OrganizationRoot and passes the existing root id
 * ("r-...") to GovernanceFoundation.
 */

import { Composite } from "@intentius/chant";
import {
  Organization,
  OrganizationalUnit,
  OrganizationsPolicy,
  Trail,
} from "../generated";
import { DENY_AUDIT_TAMPER, DENY_LEAVE_ORGANIZATION, regionRestriction } from "../governance";

// ---------------------------------------------------------------------------
// OrganizationRoot — greenfield only
// ---------------------------------------------------------------------------

export interface OrganizationRootProps {
  featureSet?: "ALL" | "CONSOLIDATED_BILLING";
}

export type OrganizationRootResult = {
  organization: InstanceType<typeof Organization>;
};

/** Creates the organization itself. Control Tower / existing orgs skip this. */
export const OrganizationRoot = Composite<OrganizationRootProps, OrganizationRootResult>((props) => {
  const organization = new Organization({ FeatureSet: props.featureSet ?? "ALL" });
  return { organization };
}, "OrganizationRoot");

// ---------------------------------------------------------------------------
// GovernanceFoundation — the recommended foundation
// ---------------------------------------------------------------------------

export interface GovernanceFoundationProps {
  /** The organization root to hang the foundation off ("r-..." or `OrganizationRoot(...).organization.RootId`). */
  parentRootId: string;
}

export type GovernanceFoundationResult = {
  ouSecurity: InstanceType<typeof OrganizationalUnit>;
  ouInfrastructure: InstanceType<typeof OrganizationalUnit>;
  ouSandbox: InstanceType<typeof OrganizationalUnit>;
  ouWorkloads: InstanceType<typeof OrganizationalUnit>;
  scpDenyLeaveOrganization: InstanceType<typeof OrganizationsPolicy>;
  scpDenyAuditTamper: InstanceType<typeof OrganizationsPolicy>;
};

/**
 * Security / Infrastructure / Sandbox / Workloads OUs,
 * `deny-leave-organization` attached at the root and `deny-audit-tamper`
 * on the Security OU — the same baseline `landingZoneConfig()` declares.
 */
export const GovernanceFoundation = Composite<GovernanceFoundationProps, GovernanceFoundationResult>((props) => {
  const ouSecurity = new OrganizationalUnit({ Name: "Security", ParentId: props.parentRootId });
  const ouInfrastructure = new OrganizationalUnit({ Name: "Infrastructure", ParentId: props.parentRootId });
  const ouSandbox = new OrganizationalUnit({ Name: "Sandbox", ParentId: props.parentRootId });
  const ouWorkloads = new OrganizationalUnit({ Name: "Workloads", ParentId: props.parentRootId });

  const scpDenyLeaveOrganization = new OrganizationsPolicy({
    Name: "deny-leave-organization",
    Type: "SERVICE_CONTROL_POLICY",
    Content: DENY_LEAVE_ORGANIZATION.document,
    Description: DENY_LEAVE_ORGANIZATION.description,
    TargetIds: [props.parentRootId],
  });
  const scpDenyAuditTamper = new OrganizationsPolicy({
    Name: "deny-audit-tamper",
    Type: "SERVICE_CONTROL_POLICY",
    Content: DENY_AUDIT_TAMPER.document,
    Description: DENY_AUDIT_TAMPER.description,
    TargetIds: [ouSecurity.Id],
  });

  return {
    ouSecurity,
    ouInfrastructure,
    ouSandbox,
    ouWorkloads,
    scpDenyLeaveOrganization,
    scpDenyAuditTamper,
  };
}, "GovernanceFoundation");

// ---------------------------------------------------------------------------
// RegionRestriction — optional root guardrail
// ---------------------------------------------------------------------------

export interface RegionRestrictionProps {
  /** The only regions requests may target (global services excepted). */
  regions: string[];
  /** Root/OU ids the SCP attaches to. */
  targetIds: string[];
}

export type RegionRestrictionResult = {
  scpRegionRestriction: InstanceType<typeof OrganizationsPolicy>;
};

export const RegionRestriction = Composite<RegionRestrictionProps, RegionRestrictionResult>((props) => {
  const policy = regionRestriction(props.regions);
  const scpRegionRestriction = new OrganizationsPolicy({
    Name: "region-restriction",
    Type: "SERVICE_CONTROL_POLICY",
    Content: policy.document,
    Description: policy.description,
    TargetIds: props.targetIds,
  });
  return { scpRegionRestriction };
}, "RegionRestriction");

// ---------------------------------------------------------------------------
// OrganizationTrail — the audit sink
// ---------------------------------------------------------------------------

export interface OrganizationTrailProps {
  /** S3 bucket the organization trail delivers into. */
  bucket: string;
}

export type OrganizationTrailResult = {
  trail: InstanceType<typeof Trail>;
};

export const OrganizationTrail = Composite<OrganizationTrailProps, OrganizationTrailResult>((props) => {
  const trail = new Trail({
    IsLogging: true,
    S3BucketName: props.bucket,
    IsMultiRegionTrail: true,
    IsOrganizationTrail: true,
  });
  return { trail };
}, "OrganizationTrail");
