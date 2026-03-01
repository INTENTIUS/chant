/**
 * @intentius/chant-lexicon-azure — barrel export
 *
 * Azure Resource Manager lexicon for chant.
 */

// --- Core ---
export { defaultTags, type TagEntry, type DefaultTags } from "./default-tags";
export { azureSerializer } from "./serializer";
export { azurePlugin } from "./plugin";
export { Parameter } from "./parameter";

// --- Intrinsics ---
export {
  ResourceId, ResourceIdIntrinsic,
  Reference, ReferenceIntrinsic,
  Concat, ConcatIntrinsic,
  ResourceGroup, ResourceGroupIntrinsic,
  Subscription, SubscriptionIntrinsic,
  UniqueString, UniqueStringIntrinsic,
  Format, FormatIntrinsic,
  If, IfIntrinsic,
  ListKeys, ListKeysIntrinsic,
} from "./intrinsics";

// --- Pseudo-parameters ---
export {
  Azure,
  ResourceGroupName,
  ResourceGroupLocation,
  ResourceGroupId,
  SubscriptionId,
  TenantId,
  DeploymentName,
} from "./pseudo";

// --- Re-exports from core ---
export { isChildProject, type ChildProjectInstance } from "@intentius/chant/child-project";
export { stackOutput, isStackOutput, type StackOutput } from "@intentius/chant/stack-output";
export { LexiconOutput, output, isLexiconOutput } from "@intentius/chant/lexicon-output";

// --- Generated resource classes ---
export * from "./generated/index";

// --- Composites ---
export {
  StorageAccountSecure, type StorageAccountSecureProps, type StorageAccountSecureResult,
  VnetDefault, type VnetDefaultProps, type VnetDefaultResult,
  VmLinux, type VmLinuxProps, type VmLinuxResult,
  AppService, type AppServiceProps, type AppServiceResult,
  AksCluster, type AksClusterProps, type AksClusterResult,
  SqlDatabase, type SqlDatabaseProps, type SqlDatabaseResult,
  KeyVaultSecure, type KeyVaultSecureProps, type KeyVaultSecureResult,
  ContainerRegistrySecure, type ContainerRegistrySecureProps, type ContainerRegistrySecureResult,
  FunctionApp, type FunctionAppProps, type FunctionAppResult,
  ServiceBusPipeline, type ServiceBusPipelineProps, type ServiceBusPipelineResult,
  CosmosDatabase, type CosmosDatabaseProps, type CosmosDatabaseResult,
  ApplicationGateway, type ApplicationGatewayProps, type ApplicationGatewayResult,
  ContainerInstance, type ContainerInstanceProps, type ContainerInstanceResult,
  RedisCache, type RedisCacheProps, type RedisCacheResult,
  PrivateEndpoint, type PrivateEndpointProps, type PrivateEndpointResult,
} from "./composites/index";

// --- RBAC role constants ---
export {
  StorageRoles,
  ComputeRoles,
  NetworkRoles,
  KeyVaultRoles,
  SqlRoles,
  ContainerRoles,
  AppServiceRoles,
  IdentityRoles,
} from "./actions/index";

// --- Codegen pipeline ---
export { generate, writeGeneratedFiles } from "./codegen/generate";
export { packageLexicon } from "./codegen/package";

// --- Spec utilities ---
export { fetchArmSchemas } from "./spec/fetch";
export { parseArmSchema, armShortName, armServiceName } from "./spec/parse";
