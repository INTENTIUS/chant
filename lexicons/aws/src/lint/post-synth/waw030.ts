/**
 * WAW030: Missing DependsOn for Known Patterns
 *
 * Detects resources that are likely missing a required DependsOn
 * based on well-known CloudFormation ordering requirements:
 *
 * - ECS Service with LoadBalancers but no DependsOn on a Listener
 * - EC2 Route with GatewayId but no DependsOn on VPCGatewayAttachment
 * - API Gateway Deployment with no DependsOn on any Method
 * - API Gateway V2 Deployment with no DependsOn on any Route
 * - DynamoDB ScalableTarget with no DependsOn on the Table
 * - ECS ScalableTarget with no DependsOn on the ECS Service
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseCFTemplate } from "./cf-refs";

export function checkMissingDependsOn(ctx: PostSynthContext): PostSynthDiagnostic[] {
  const diagnostics: PostSynthDiagnostic[] = [];

  for (const [_lexicon, output] of ctx.outputs) {
    const template = parseCFTemplate(output);
    if (!template?.Resources) continue;

    const resources = template.Resources;

    // Collect logical IDs by type
    const listenerIds: string[] = [];
    const vpcGatewayAttachmentIds: string[] = [];
    const methodIds: string[] = [];
    const deploymentIds: string[] = [];
    const routeV2Ids: string[] = [];
    const deploymentV2Ids: string[] = [];
    const dynamoTableIds: string[] = [];
    const ecsServiceIds: string[] = [];
    const scalableTargetEntries: { logicalId: string; namespace: string }[] = [];

    for (const [logicalId, resource] of Object.entries(resources)) {
      if (resource.Type === "AWS::ElasticLoadBalancingV2::Listener") {
        listenerIds.push(logicalId);
      }
      if (resource.Type === "AWS::EC2::VPCGatewayAttachment") {
        vpcGatewayAttachmentIds.push(logicalId);
      }
      if (resource.Type === "AWS::ApiGateway::Method") {
        methodIds.push(logicalId);
      }
      if (resource.Type === "AWS::ApiGateway::Deployment") {
        deploymentIds.push(logicalId);
      }
      if (resource.Type === "AWS::ApiGatewayV2::Route") {
        routeV2Ids.push(logicalId);
      }
      if (resource.Type === "AWS::ApiGatewayV2::Deployment") {
        deploymentV2Ids.push(logicalId);
      }
      if (resource.Type === "AWS::DynamoDB::Table") {
        dynamoTableIds.push(logicalId);
      }
      if (resource.Type === "AWS::ECS::Service") {
        ecsServiceIds.push(logicalId);
      }
      if (resource.Type === "AWS::ApplicationAutoScaling::ScalableTarget") {
        const props = resource.Properties ?? {};
        const ns = inferScalingNamespace(props);
        if (ns) {
          scalableTargetEntries.push({ logicalId, namespace: ns });
        }
      }
    }

    for (const [logicalId, resource] of Object.entries(resources)) {
      // Pattern 1: ECS Service with LoadBalancers but no DependsOn on Listener
      if (resource.Type === "AWS::ECS::Service" && listenerIds.length > 0) {
        const props = resource.Properties ?? {};
        if (props.LoadBalancers && Array.isArray(props.LoadBalancers) && props.LoadBalancers.length > 0) {
          const deps = getDependsOnSet(resource);
          const hasListenerDep = listenerIds.some((id) => deps.has(id));
          if (!hasListenerDep) {
            diagnostics.push({
              checkId: "WAW030",
              severity: "warning",
              message: `ECS Service "${logicalId}" has LoadBalancers but no DependsOn on a Listener — the Service may fail to create if the Listener isn't ready`,
              entity: logicalId,
              lexicon: "aws",
            });
          }
        }
      }

      // Pattern 2: EC2 Route with GatewayId but no DependsOn on VPCGatewayAttachment
      if (resource.Type === "AWS::EC2::Route" && vpcGatewayAttachmentIds.length > 0) {
        const props = resource.Properties ?? {};
        if (props.GatewayId) {
          const deps = getDependsOnSet(resource);
          const hasAttachmentDep = vpcGatewayAttachmentIds.some((id) => deps.has(id));
          // Also check if any property refs point to the attachment
          const propRefs = collectPropertyRefs(resource);
          const hasAttachmentRef = vpcGatewayAttachmentIds.some((id) => propRefs.has(id));
          if (!hasAttachmentDep && !hasAttachmentRef) {
            diagnostics.push({
              checkId: "WAW030",
              severity: "warning",
              message: `Route "${logicalId}" uses a Gateway but has no dependency on VPCGatewayAttachment — the route may fail if the gateway isn't attached yet`,
              entity: logicalId,
              lexicon: "aws",
            });
          }
        }
      }

      // Pattern 3: API Gateway Deployment with no DependsOn on any Method
      if (resource.Type === "AWS::ApiGateway::Deployment" && methodIds.length > 0) {
        const deps = getDependsOnSet(resource);
        const hasMethodDep = methodIds.some((id) => deps.has(id));
        const propRefs = collectPropertyRefs(resource);
        const hasMethodRef = methodIds.some((id) => propRefs.has(id));
        if (!hasMethodDep && !hasMethodRef) {
          diagnostics.push({
            checkId: "WAW030",
            severity: "warning",
            message: `API Gateway Deployment "${logicalId}" has no DependsOn on any Method — the deployment may fail with "REST API doesn't contain any methods"`,
            entity: logicalId,
            lexicon: "aws",
          });
        }
      }

      // Pattern 4: API Gateway V2 Deployment with no DependsOn on any Route
      if (resource.Type === "AWS::ApiGatewayV2::Deployment" && routeV2Ids.length > 0) {
        const deps = getDependsOnSet(resource);
        const hasRouteDep = routeV2Ids.some((id) => deps.has(id));
        const propRefs = collectPropertyRefs(resource);
        const hasRouteRef = routeV2Ids.some((id) => propRefs.has(id));
        if (!hasRouteDep && !hasRouteRef) {
          diagnostics.push({
            checkId: "WAW030",
            severity: "warning",
            message: `API Gateway V2 Deployment "${logicalId}" has no DependsOn on any Route — the deployment may fail if no routes exist yet`,
            entity: logicalId,
            lexicon: "aws",
          });
        }
      }
    }

    // Pattern 5 & 6: ScalableTarget with no DependsOn on the target resource
    for (const entry of scalableTargetEntries) {
      const resource = resources[entry.logicalId];
      const deps = getDependsOnSet(resource);
      const propRefs = collectPropertyRefs(resource);

      if (entry.namespace === "dynamodb" && dynamoTableIds.length > 0) {
        const hasTableDep = dynamoTableIds.some((id) => deps.has(id));
        const hasTableRef = dynamoTableIds.some((id) => propRefs.has(id));
        if (!hasTableDep && !hasTableRef) {
          diagnostics.push({
            checkId: "WAW030",
            severity: "warning",
            message: `ScalableTarget "${entry.logicalId}" targets DynamoDB but has no DependsOn on any Table — scaling registration may fail if the table doesn't exist yet`,
            entity: entry.logicalId,
            lexicon: "aws",
          });
        }
      }

      if (entry.namespace === "ecs" && ecsServiceIds.length > 0) {
        const hasServiceDep = ecsServiceIds.some((id) => deps.has(id));
        const hasServiceRef = ecsServiceIds.some((id) => propRefs.has(id));
        if (!hasServiceDep && !hasServiceRef) {
          diagnostics.push({
            checkId: "WAW030",
            severity: "warning",
            message: `ScalableTarget "${entry.logicalId}" targets ECS but has no DependsOn on any ECS Service — scaling registration may fail if the service doesn't exist yet`,
            entity: entry.logicalId,
            lexicon: "aws",
          });
        }
      }
    }
  }

  return diagnostics;
}

/** Infer the scaling namespace from a ScalableTarget's properties. */
function inferScalingNamespace(props: Record<string, unknown>): string | null {
  if (typeof props.ServiceNamespace === "string") {
    return props.ServiceNamespace;
  }
  if (typeof props.ScalableDimension === "string") {
    const prefix = props.ScalableDimension.split(":")[0];
    if (prefix) return prefix;
  }
  return null;
}

/** Extract DependsOn entries as a Set of strings. */
function getDependsOnSet(resource: { DependsOn?: string | string[] }): Set<string> {
  if (!resource.DependsOn) return new Set();
  const deps = Array.isArray(resource.DependsOn)
    ? resource.DependsOn
    : [resource.DependsOn];
  return new Set(deps.filter((d): d is string => typeof d === "string"));
}

/** Collect all Ref and Fn::GetAtt target logical IDs from resource properties. */
function collectPropertyRefs(resource: { Properties?: Record<string, unknown> }): Set<string> {
  const refs = new Set<string>();
  if (!resource.Properties) return refs;

  function walk(value: unknown): void {
    if (typeof value !== "object" || value === null) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    const obj = value as Record<string, unknown>;
    if ("Ref" in obj && typeof obj.Ref === "string") {
      refs.add(obj.Ref);
    }
    if ("Fn::GetAtt" in obj) {
      const getAtt = obj["Fn::GetAtt"];
      if (Array.isArray(getAtt) && typeof getAtt[0] === "string") {
        refs.add(getAtt[0]);
      } else if (typeof getAtt === "string") {
        // Dot-delimited form: "LogicalId.Attribute"
        const logicalId = getAtt.split(".")[0];
        if (logicalId) refs.add(logicalId);
      }
    }
    for (const val of Object.values(obj)) walk(val);
  }

  walk(resource.Properties);
  return refs;
}

export const waw030: PostSynthCheck = {
  id: "WAW030",
  description: "Missing DependsOn for known CloudFormation ordering patterns",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return checkMissingDependsOn(ctx);
  },
};
