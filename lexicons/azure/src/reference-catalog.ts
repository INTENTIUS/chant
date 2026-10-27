import type { ReferenceCatalog } from "@intentius/chant/graph-refs";

/**
 * Azure reference catalog (#4535): how Azure resources name each other, so
 * chant's catalog pass (`reconstructIndexedEdges`, #4522) draws their edges
 * over an index and over a declared graph, and behold can retire its name
 * matcher (behold#1005).
 *
 * ## Shape
 *
 * The paths are the flattened ARM shape: `properties.*` beside `location`,
 * `sku` and `identity`. That is the tree a Resource Graph row becomes
 * (./listed-types.ts `azureObservedTree`), the tree the deep reader compares
 * (./deep-observe.ts `buildLiveProperties`), and the shape the lexicon's
 * declared props already have, so one rule reads all three. Sub-resources
 * inside a row (`ipConfigurations[]`, `frontendIPConfigurations[]`) keep
 * their own `properties` level, because ARM nests them that way.
 *
 * ## Values are ARM resource ids
 *
 * An Azure reference is a resource id. An indexed node is matched by its
 * native id, which for Azure is the row's `id`, so the targets need no
 * identity rule for it. The identities below are the other values a
 * reference reads: a workspace's `customerId`, an app's FQDN.
 *
 * Over a declared graph the same paths usually hold ARM expressions
 * (`[resourceId(...)]`), which match no node; the lexicon's `graphEdges`
 * hook (./graph-edges.ts) already draws those references from the
 * expressions themselves.
 *
 * ## What this does not do
 *
 * - Matching is exact. ARM compares ids case-insensitively, and a reference
 *   can spell `resourceGroups` where the target's id spells
 *   `resourcegroups`. Such a reference is dangling, never joined to the
 *   wrong node.
 * - `identity.userAssignedIdentities` names its identities in object keys,
 *   which `readPath` cannot read. A Container App's identity edge comes from
 *   `graphEdges` on a declared graph and from nothing over an index.
 * - A subnet's parent VNet is in the subnet's own id. No attribute names it,
 *   so there is no containment rule for it.
 */
export const azureReferenceCatalog: ReferenceCatalog = {
  identities: [
    { kind: "Microsoft.OperationalInsights/workspaces", ids: ["customerId"] },
    { kind: "Microsoft.App/containerApps", ids: ["configuration.ingress.fqdn", "latestRevisionFqdn"] },
    { kind: "Microsoft.App/managedEnvironments", ids: ["defaultDomain", "staticIp"] },
    { kind: "Microsoft.Network/publicIPAddresses", ids: ["ipAddress", "dnsSettings.fqdn"] },
    { kind: "Microsoft.Web/sites", ids: ["defaultHostName"] },
  ],
  refs: [
    // ── containment (→ boundary boxes) ──
    { from: "Microsoft.App/managedEnvironments", path: "vnetConfiguration.infrastructureSubnetId", targetKind: "Microsoft.Network/virtualNetworks_subnets", relation: "containment", label: "in subnet" },
    { from: "Microsoft.App/containerApps", path: "managedEnvironmentId", targetKind: "Microsoft.App/managedEnvironments", relation: "containment", label: "in environment" },
    // The newer API versions write the same id under this name too.
    { from: "Microsoft.App/containerApps", path: "environmentId", targetKind: "Microsoft.App/managedEnvironments", relation: "containment", label: "in environment" },
    { from: "Microsoft.Network/networkInterfaces", path: "ipConfigurations[].properties.subnet.id", targetKind: "Microsoft.Network/virtualNetworks_subnets", relation: "containment", label: "in subnet" },
    { from: "Microsoft.Network/privateEndpoints", path: "subnet.id", targetKind: "Microsoft.Network/virtualNetworks_subnets", relation: "containment", label: "in subnet" },
    { from: "Microsoft.ContainerService/managedClusters", path: "agentPoolProfiles[].vnetSubnetID", targetKind: "Microsoft.Network/virtualNetworks_subnets", relation: "containment", label: "in subnet" },
    { from: "Microsoft.Web/sites", path: "virtualNetworkSubnetId", targetKind: "Microsoft.Network/virtualNetworks_subnets", relation: "containment", label: "in subnet" },
    { from: "Microsoft.ContainerInstance/containerGroups", path: "subnetIds[].id", targetKind: "Microsoft.Network/virtualNetworks_subnets", relation: "containment", label: "in subnet" },
    { from: "Microsoft.Network/applicationGateways", path: "gatewayIPConfigurations[].properties.subnet.id", targetKind: "Microsoft.Network/virtualNetworks_subnets", relation: "containment", label: "in subnet" },
    { from: "Microsoft.Network/loadBalancers", path: "frontendIPConfigurations[].properties.subnet.id", targetKind: "Microsoft.Network/virtualNetworks_subnets", relation: "containment", label: "in subnet" },

    // ── references (→ edges) ──
    // A managed environment names its workspace by the workspace's customer
    // id, not its resource id.
    { from: "Microsoft.App/managedEnvironments", path: "appLogsConfiguration.logAnalyticsConfiguration.customerId", targetKind: "Microsoft.OperationalInsights/workspaces", relation: "reference", label: "logs to" },
    { from: "Microsoft.App/containerApps", path: "configuration.registries[].identity", targetKind: "Microsoft.ManagedIdentity/userAssignedIdentities", relation: "reference", label: "pulls as", optional: true },
    { from: "Microsoft.Network/virtualNetworks_subnets", path: "networkSecurityGroup.id", targetKind: "Microsoft.Network/networkSecurityGroups", relation: "reference", label: "nsg" },
    { from: "Microsoft.Network/virtualNetworks_subnets", path: "routeTable.id", targetKind: "Microsoft.Network/routeTables", relation: "reference", label: "routes" },
    { from: "Microsoft.Network/virtualNetworks_subnets", path: "natGateway.id", targetKind: "Microsoft.Network/natGateways", relation: "reference", label: "egress via" },
    // A VNet row from Resource Graph carries its subnets inline.
    { from: "Microsoft.Network/virtualNetworks", path: "subnets[].properties.networkSecurityGroup.id", targetKind: "Microsoft.Network/networkSecurityGroups", relation: "reference", label: "nsg" },
    { from: "Microsoft.Network/virtualNetworks", path: "subnets[].properties.routeTable.id", targetKind: "Microsoft.Network/routeTables", relation: "reference", label: "routes" },
    { from: "Microsoft.Network/networkInterfaces", path: "networkSecurityGroup.id", targetKind: "Microsoft.Network/networkSecurityGroups", relation: "reference", label: "nsg" },
    { from: "Microsoft.Network/networkInterfaces", path: "ipConfigurations[].properties.publicIPAddress.id", targetKind: "Microsoft.Network/publicIPAddresses", relation: "reference", label: "address" },
    { from: "Microsoft.Network/natGateways", path: "publicIpAddresses[].id", targetKind: "Microsoft.Network/publicIPAddresses", relation: "reference", label: "address" },
    { from: "Microsoft.Network/loadBalancers", path: "frontendIPConfigurations[].properties.publicIPAddress.id", targetKind: "Microsoft.Network/publicIPAddresses", relation: "reference", label: "address" },
    { from: "Microsoft.Network/applicationGateways", path: "frontendIPConfigurations[].properties.publicIPAddress.id", targetKind: "Microsoft.Network/publicIPAddresses", relation: "reference", label: "address" },
    { from: "Microsoft.Compute/virtualMachines", path: "networkProfile.networkInterfaces[].id", targetKind: "Microsoft.Network/networkInterfaces", relation: "reference", label: "nic" },
    { from: "Microsoft.Web/sites", path: "serverFarmId", targetKind: "Microsoft.Web/serverfarms", relation: "reference", label: "on plan" },
  ],
};
