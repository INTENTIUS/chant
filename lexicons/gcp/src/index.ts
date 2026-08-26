// Typed Op step-builder wrappers (chant #1288 Stage 2) — gcpApply/gcpDelete/
// flociGcpUp/flociGcpDown with authoring-time types derived from this
// lexicon's own *Args interfaces (see ./op/builders.ts's module doc for why
// these live here rather than in core or the temporal barrel). Opt-in:
// `@intentius/chant-lexicon-temporal`'s same-named exports are core's
// original untyped builders, unchanged.
export { gcpApply, gcpDelete, flociGcpUp, flociGcpDown } from "./op/builders";

// Serializer
export { gcpSerializer } from "./serializer";

// Plugin
export { gcpPlugin } from "./plugin";

// Default labels & annotations
export { defaultLabels, defaultAnnotations, isDefaultLabels, isDefaultAnnotations } from "./default-labels";
export { DEFAULT_LABELS_MARKER, DEFAULT_ANNOTATIONS_MARKER } from "./default-labels";

// Pseudo-parameters
export { GCP, ProjectId, Region, Zone } from "./pseudo";

// Variables / annotation constants
export { GcpAnnotations } from "./variables";

// Generated entities — export everything from generated index
// After running `npm run generate`, this re-exports all Config Connector resource classes
export * from "./generated/index";

// Composites
export {
  GkeCluster, CloudRunServiceComposite, CloudSqlInstance, GcsBucket, VpcNetwork,
  PubSubPipeline, CloudFunctionWithTrigger, PrivateService, ManagedCertificate, SecureProject,
  MemorystoreRedis, MultiRegionVpc, GkeCrdbRegion, GpuNodePool,
  GovernanceFoundation, LocationRestriction, OrganizationAuditConfig,
} from "./composites/index";
export type {
  GkeClusterProps,
  CloudRunServiceProps,
  CloudSqlInstanceProps,
  GcsBucketProps,
  VpcNetworkProps, VpcSubnet,
  PubSubPipelineProps,
  CloudFunctionWithTriggerProps,
  PrivateServiceProps,
  ManagedCertificateProps,
  SecureProjectProps,
  MemorystoreRedisProps,
  MultiRegionVpcConfig, MultiRegionVpcRegion,
  GkeCrdbRegionConfig, GkeCrdbRegionNodeConfig,
  GpuNodePoolProps, GpuNodePoolTaint,
  GovernanceFoundationProps, LocationRestrictionProps, OrganizationAuditConfigProps,
} from "./composites/index";

// GCP governance authoring: the desired-state config an external governance
// reconciler applies, and the typed landing-zone authoring layer.
export {
  landingZoneConfig, resourceLocationRestriction,
  DISABLE_SA_KEY_CREATION, SKIP_DEFAULT_NETWORK, AUDIT_ALL_SERVICES, FOUNDATION_FOLDERS,
} from "./governance";
export type { GcpGovernanceConfig, LandingZoneConfigProps, FolderConfig, OrgPolicyConfig, ProjectConfig } from "./governance";

// IAM role constants
export { StorageRoles, ComputeRoles, ContainerRoles, IAMRoles, SQLRoles, RunRoles, PubSubRoles } from "./actions/index";

// Spec utilities (for tooling)
export { fetchCRDBundle, getCachePath, clearCache, KCC_VERSION } from "./spec/fetch";
export { parseGcpCRD, gcpServiceName, gcpShortName, gcpTypeName, stripServicePrefix } from "./spec/parse";
export type { GcpParseResult, ParsedResource, ParsedProperty, ParsedPropertyType, ParsedEnum, GroupVersionKind } from "./spec/parse";

// Code generation pipeline
export { generate, writeGeneratedFiles } from "./codegen/generate";
export { packageLexicon } from "./codegen/package";
export type { PackageOptions, PackageResult } from "./codegen/package";

// LSP providers
export { gcpCompletions } from "./lsp/completions";
export { gcpHover } from "./lsp/hover";
