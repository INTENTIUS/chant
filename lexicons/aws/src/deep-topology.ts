/**
 * Deep-read sources for the EC2 topology types (#1269).
 *
 * chant's distinguishing answers are folds over topology: `internetFacing`
 * resolves subnet -> route table -> internet gateway, `effectiveIngress`
 * resolves rules across attached security groups, and the default-VPC
 * classification (`defaults.ts`) reads the provider's own markers. The inputs
 * to all of them are the types this file covers — with only the original four
 * kinds readable, a deep snapshot of an EC2 estate carried almost no
 * properties, and a snapshot-backed query could answer identity questions but
 * not a single fold question.
 *
 * Two sources, chosen per type:
 *
 * - The container types (VPC, subnet, route table, internet gateway) read
 *   through the EC2 describes. The fold facts live there and nowhere else:
 *   `IsDefault`, `DefaultForAz` and a subnet's live `MapPublicIpOnLaunch` are
 *   not part of the CloudFormation resource model, so Cloud Control cannot
 *   report them. The describes are also bulk (one call per type for the whole
 *   stack) and are implemented by the emulators that do not serve Cloud
 *   Control's `GetResource`.
 *
 * - The join types (route, association, gateway attachment) and the two whose
 *   describes do not fit a flat bulk join (instance rows nest inside
 *   reservations; launch-template data lives in a separate versions call) read
 *   through Cloud Control, which returns their model in the declared side's
 *   own shape.
 *
 * Each type carries its normalization entries alongside (#1269's note: adding
 * a type without them trades a hole for a false positive, which is worse).
 * They are merged into the tables in `deep-observe.ts`.
 */

import type { DeepSource } from "./deep-observe";

/**
 * `describe-vpcs` -> the `AWS::EC2::VPC` resource model, plus `IsDefault`.
 *
 * `IsDefault` is the provider's own marker for the VPC nobody wrote — the fact
 * the default classification reads — and it exists only on this surface.
 * Carried even though the model does not name it; the diff subtracts it as a
 * service default (`false`, gated on source silence) so a CloudFormation-made
 * VPC does not report it as undeclared drift.
 */
export function vpcToModel(row: Record<string, unknown>): Record<string, unknown> {
  return {
    // The schema's readOnlyProperties prune the id after the ownership check.
    ...(typeof row.VpcId === "string" ? { VpcId: row.VpcId } : {}),
    ...(typeof row.CidrBlock === "string" ? { CidrBlock: row.CidrBlock } : {}),
    ...(typeof row.InstanceTenancy === "string" ? { InstanceTenancy: row.InstanceTenancy } : {}),
    ...(typeof row.IsDefault === "boolean" ? { IsDefault: row.IsDefault } : {}),
    ...nonEmptyTags(row),
  };
}

/**
 * `describe-subnets` -> the `AWS::EC2::Subnet` resource model, plus
 * `DefaultForAz`.
 *
 * `MapPublicIpOnLaunch` is half of `internetFacing`; `DefaultForAz` is the
 * provider's default-subnet marker, off the model for the same reason as a
 * VPC's `IsDefault` and handled the same way.
 */
export function subnetToModel(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(typeof row.SubnetId === "string" ? { SubnetId: row.SubnetId } : {}),
    ...(typeof row.VpcId === "string" ? { VpcId: row.VpcId } : {}),
    ...(typeof row.CidrBlock === "string" ? { CidrBlock: row.CidrBlock } : {}),
    ...(typeof row.AvailabilityZone === "string" ? { AvailabilityZone: row.AvailabilityZone } : {}),
    ...(typeof row.AvailabilityZoneId === "string" ? { AvailabilityZoneId: row.AvailabilityZoneId } : {}),
    ...(typeof row.MapPublicIpOnLaunch === "boolean" ? { MapPublicIpOnLaunch: row.MapPublicIpOnLaunch } : {}),
    ...(typeof row.AssignIpv6AddressOnCreation === "boolean"
      ? { AssignIpv6AddressOnCreation: row.AssignIpv6AddressOnCreation }
      : {}),
    ...(typeof row.EnableDns64 === "boolean" ? { EnableDns64: row.EnableDns64 } : {}),
    ...(typeof row.Ipv6Native === "boolean" ? { Ipv6Native: row.Ipv6Native } : {}),
    ...(typeof row.DefaultForAz === "boolean" ? { DefaultForAz: row.DefaultForAz } : {}),
    ...nonEmptyTags(row),
  };
}

/**
 * `describe-route-tables` -> the `AWS::EC2::RouteTable` resource model.
 *
 * The row also carries `Routes` and `Associations`, and this mapping drops
 * them on purpose: a template declares each route as its own
 * `AWS::EC2::Route` and each association as its own
 * `AWS::EC2::SubnetRouteTableAssociation`, both covered below, so carrying
 * them here would report every declared route twice — once as an undeclared
 * array on the table and once through its own resource.
 */
export function routeTableToModel(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(typeof row.RouteTableId === "string" ? { RouteTableId: row.RouteTableId } : {}),
    ...(typeof row.VpcId === "string" ? { VpcId: row.VpcId } : {}),
    ...nonEmptyTags(row),
  };
}

/** `describe-internet-gateways` -> the `AWS::EC2::InternetGateway` model, which is tags and nothing else. */
export function internetGatewayToModel(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(typeof row.InternetGatewayId === "string" ? { InternetGatewayId: row.InternetGatewayId } : {}),
    ...nonEmptyTags(row),
  };
}

/**
 * An empty tag set is the absence of tags, not a value. EC2 always sends the
 * key, so carrying it through reports `Tags: <undeclared> -> []` on every
 * untagged resource — agreement rendered as drift. Same rule as the
 * security-group mapping.
 */
function nonEmptyTags(row: Record<string, unknown>): Record<string, unknown> {
  return Array.isArray(row.Tags) && row.Tags.length > 0 ? { Tags: row.Tags } : {};
}

/**
 * The topology types' entries for `DEEP_SOURCES`.
 *
 * The routing-chain joins are addressed by their physical id — for a
 * registry-backed type CloudFormation's physical id *is* the Cloud Control
 * identifier (`rtb-…|0.0.0.0/0` for a route) — so Cloud Control's
 * one-get-per-resource shape fits them exactly and returns the declared
 * model's own field names.
 */
export const EC2_TOPOLOGY_SOURCES: Record<string, DeepSource> = {
  "AWS::EC2::VPC": {
    via: "ec2",
    argv: ["ec2", "describe-vpcs"],
    idFlag: "--vpc-ids",
    key: "Vpcs",
    id: "VpcId",
    toModel: vpcToModel,
  },
  "AWS::EC2::Subnet": {
    via: "ec2",
    argv: ["ec2", "describe-subnets"],
    idFlag: "--subnet-ids",
    key: "Subnets",
    id: "SubnetId",
    toModel: subnetToModel,
  },
  "AWS::EC2::RouteTable": {
    via: "ec2",
    argv: ["ec2", "describe-route-tables"],
    idFlag: "--route-table-ids",
    key: "RouteTables",
    id: "RouteTableId",
    toModel: routeTableToModel,
  },
  "AWS::EC2::InternetGateway": {
    via: "ec2",
    argv: ["ec2", "describe-internet-gateways"],
    idFlag: "--internet-gateway-ids",
    key: "InternetGateways",
    id: "InternetGatewayId",
    toModel: internetGatewayToModel,
  },
  // The `0.0.0.0/0` -> igw edge `internetFacing` walks.
  "AWS::EC2::Route": { via: "cloud-control" },
  // Subnet -> route table.
  "AWS::EC2::SubnetRouteTableAssociation": { via: "cloud-control" },
  // Igw -> VPC.
  "AWS::EC2::VPCGatewayAttachment": { via: "cloud-control" },
  // Subnet, security groups, launch template — the instance end of both folds.
  "AWS::EC2::Instance": { via: "cloud-control" },
  // The indirect security-group hop `effectiveIngress` resolves through.
  "AWS::EC2::LaunchTemplate": { via: "cloud-control" },
};

/**
 * Service defaults for the topology types, merged into
 * `AWS_SERVICE_DEFAULTS`. Subtracted on the live side only where source never
 * declared the property — which is how the fold facts (`IsDefault`,
 * `DefaultForAz`, a live `MapPublicIpOnLaunch`) stay in the snapshot for a
 * query to read while never surfacing as drift on a resource CloudFormation
 * itself created.
 */
export const EC2_TOPOLOGY_SERVICE_DEFAULTS: Record<string, Record<string, unknown>> = {
  "AWS::EC2::VPC": {
    InstanceTenancy: "default",
    IsDefault: false,
  },
  "AWS::EC2::Subnet": {
    MapPublicIpOnLaunch: false,
    AssignIpv6AddressOnCreation: false,
    EnableDns64: false,
    Ipv6Native: false,
    DefaultForAz: false,
  },
  "AWS::EC2::Instance": {
    Tenancy: "default",
    Monitoring: false,
    EbsOptimized: false,
    SourceDestCheck: true,
    DisableApiTermination: false,
  },
};

/**
 * Values the service picks when the template does not supply one, merged into
 * `AWS_GENERATED_NAMES`. A subnet that names no availability zone gets one
 * assigned — a different one is real placement drift only when the template
 * had an opinion, which is exactly the counterpart gate.
 */
export const EC2_TOPOLOGY_GENERATED_NAMES: Record<string, ReadonlySet<string>> = {
  "AWS::EC2::Subnet": new Set(["AvailabilityZone", "AvailabilityZoneId"]),
  "AWS::EC2::Instance": new Set(["AvailabilityZone"]),
};

/**
 * Declared properties a type's source cannot see (#1269).
 *
 * `describe-vpcs` does not return the DNS attributes — they live behind
 * `describe-vpc-attribute` — and neither describe returns the IPAM inputs,
 * which are consumed at creation. A declared value for one of these has
 * nothing live to stand against, so the diff would report `value -> <absent>`
 * on every clean apply: a blind spot rendered as drift. Pruned on the
 * declared side, and only where the live tree is silent, so a source that
 * does report the field (Cloud Control, some day) is still compared.
 */
export const AWS_DEEP_BLIND_SPOTS: Record<string, ReadonlySet<string>> = {
  "AWS::EC2::VPC": new Set([
    "EnableDnsSupport",
    "EnableDnsHostnames",
    "Ipv4IpamPoolId",
    "Ipv4NetmaskLength",
  ]),
  "AWS::EC2::Subnet": new Set([
    "Ipv6CidrBlock",
    "Ipv4IpamPoolId",
    "Ipv4NetmaskLength",
    "Ipv6IpamPoolId",
    "Ipv6NetmaskLength",
  ]),
};
