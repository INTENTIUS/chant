/**
 * ContainerAppNetwork and ContainerAppSite composites: a website on Azure
 * Container Apps and the network it sits in.
 *
 * Split the way the aws lexicon splits VpcDefault from FargateAlb, so several
 * sites can share one network. Container Apps brings its own ingress and load
 * balancing, so there is no load balancer to declare.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import {
  VirtualNetwork,
  Subnet,
  LogAnalyticsWorkspace,
  ManagedIdentity,
  managedEnvironments,
  containerApps,
} from "../generated";

export interface ContainerAppNetworkProps {
  /** Network name prefix: the VNet is `<name>-vnet`, its subnet `apps`. */
  name: string;
  /** Azure region (default: resource group location). */
  location?: string;
  /** VNet address space (default: "10.0.0.0/16"). */
  addressSpace?: string;
  /** The environment subnet's prefix, a /23 or larger (default: "10.0.0.0/23"). */
  subnetPrefix?: string;
  /** Resource tags. */
  tags?: Record<string, string>;
  /** Per-member defaults. */
  defaults?: {
    virtualNetwork?: Partial<ConstructorParameters<typeof VirtualNetwork>[0]>;
    subnet?: Partial<ConstructorParameters<typeof Subnet>[0]>;
  };
}

export interface ContainerAppNetworkResult {
  virtualNetwork: InstanceType<typeof VirtualNetwork>;
  subnet: InstanceType<typeof Subnet>;
}

/**
 * A VNet with a subnet delegated to `Microsoft.App/environments`, for
 * ContainerAppSite environments to sit in.
 *
 * @example
 * ```ts
 * import { ContainerAppNetwork } from "@intentius/chant-lexicon-azure";
 *
 * export const network = ContainerAppNetwork({ name: "web" });
 * ```
 */
export const ContainerAppNetwork = Composite((props: ContainerAppNetworkProps) => {
  const {
    name,
    location = "[resourceGroup().location]",
    addressSpace = "10.0.0.0/16",
    subnetPrefix = "10.0.0.0/23",
    tags = {},
    defaults,
  } = props;

  const mergedTags = { "managed-by": "chant", ...tags };
  const vnetName = `${name}-vnet`;
  const delegations = [{ name: "apps", properties: { serviceName: "Microsoft.App/environments" } }];

  // The subnet is also listed inline, as VnetDefault does, so a later
  // deployment of the VNet does not try to remove it.
  const virtualNetwork = new VirtualNetwork(mergeDefaults({
    name: vnetName,
    location,
    tags: mergedTags,
    addressSpace: { addressPrefixes: [addressSpace] },
    subnets: [{ name: "apps", properties: { addressPrefix: subnetPrefix, delegations } }],
  }, defaults?.virtualNetwork), { apiVersion: "2023-05-01" });

  const subnet = new Subnet(mergeDefaults({
    name: `${vnetName}/apps`,
    addressPrefix: subnetPrefix,
    delegations,
  }, defaults?.subnet), { apiVersion: "2023-05-01" });

  return { virtualNetwork, subnet };
}, "ContainerAppNetwork");

export interface ContainerAppSiteProps {
  /** Environment name; the workspace is `<name>-logs` and the identity `<name>-<app>`. */
  name: string;
  /** Container app name. */
  app: string;
  /** Subnet resource ID for the environment, such as a ContainerAppNetwork's `subnet.id`. */
  subnetId: string;
  /** Azure region (default: resource group location). */
  location?: string;
  /** Container image (default: "mcr.microsoft.com/k8se/quickstart:latest"). */
  image?: string;
  /** Port the container listens on; ingress forwards to it (default: 80). */
  port?: number;
  /** Fixed replica count (default: 1). */
  replicas?: number;
  /** Make the environment reachable only from its VNet (default: false). */
  internal?: boolean;
  /** Resource tags. */
  tags?: Record<string, string>;
  /** Per-member defaults. */
  defaults?: {
    workspace?: Partial<ConstructorParameters<typeof LogAnalyticsWorkspace>[0]>;
    identity?: Partial<ConstructorParameters<typeof ManagedIdentity>[0]>;
    environment?: Partial<ConstructorParameters<typeof managedEnvironments>[0]>;
    containerApp?: Partial<ConstructorParameters<typeof containerApps>[0]>;
  };
}

export interface ContainerAppSiteResult {
  workspace: InstanceType<typeof LogAnalyticsWorkspace>;
  identity: InstanceType<typeof ManagedIdentity>;
  environment: InstanceType<typeof managedEnvironments>;
  containerApp: InstanceType<typeof containerApps>;
}

/**
 * A Container Apps environment in a subnet, shipping logs to its own Log
 * Analytics workspace, with one app running as a user-assigned identity.
 *
 * @example
 * ```ts
 * import { ContainerAppNetwork, ContainerAppSite } from "@intentius/chant-lexicon-azure";
 *
 * export const network = ContainerAppNetwork({ name: "web" });
 * export const site = ContainerAppSite({
 *   name: "web",
 *   app: "frontend",
 *   subnetId: network.subnet.id,
 *   image: "nginx:1.27",
 * });
 * ```
 */
export const ContainerAppSite = Composite((props: ContainerAppSiteProps) => {
  const {
    name,
    app,
    subnetId,
    location = "[resourceGroup().location]",
    image = "mcr.microsoft.com/k8se/quickstart:latest",
    port = 80,
    replicas = 1,
    internal = false,
    tags = {},
    defaults,
  } = props;

  const mergedTags = { "managed-by": "chant", ...tags };
  const workspaceName = `${name}-logs`;
  const identityName = `${name}-${app}`;
  const workspaceId = `resourceId('Microsoft.OperationalInsights/workspaces', '${workspaceName}')`;

  const workspace = new LogAnalyticsWorkspace(mergeDefaults({
    name: workspaceName,
    location,
    tags: mergedTags,
    // A workspace's sku sits inside its properties, not beside them, so it is
    // passed there rather than hoisted to the resource like other skus.
    properties: { sku: { name: "PerGB2018" } },
    retentionInDays: 30,
  }, defaults?.workspace), { apiVersion: "2023-09-01" });

  const identity = new ManagedIdentity(mergeDefaults({
    name: identityName,
    location,
    tags: mergedTags,
  }, defaults?.identity), { apiVersion: "2023-01-31" });

  const environment = new managedEnvironments(mergeDefaults({
    name,
    location,
    tags: mergedTags,
    vnetConfiguration: { infrastructureSubnetId: subnetId, internal },
    appLogsConfiguration: {
      destination: "log-analytics",
      logAnalyticsConfiguration: {
        customerId: `[reference(${workspaceId}, '2023-09-01').customerId]`,
        sharedKey: `[listKeys(${workspaceId}, '2023-09-01').primarySharedKey]`,
      },
    },
    workloadProfiles: [{ name: "Consumption", workloadProfileType: "Consumption" }],
  }, defaults?.environment), { apiVersion: "2024-03-01" });

  const containerApp = new containerApps(mergeDefaults({
    name: app,
    location,
    tags: mergedTags,
    identity: {
      type: "UserAssigned",
      userAssignedIdentities: {
        [`[resourceId('Microsoft.ManagedIdentity/userAssignedIdentities', '${identityName}')]`]: {},
      },
    },
    managedEnvironmentId: environment.id,
    workloadProfileName: "Consumption",
    configuration: { ingress: { external: true, targetPort: port, transport: "auto" } },
    template: {
      containers: [{ name: app, image, resources: { cpu: 0.25, memory: "0.5Gi" } }],
      scale: { minReplicas: replicas, maxReplicas: replicas },
    },
  }, defaults?.containerApp), { apiVersion: "2024-03-01" });

  return { workspace, identity, environment, containerApp };
}, "ContainerAppSite");
