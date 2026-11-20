/**
 * Health for a terraform root (#5338), through the provider lexicons.
 *
 * This lexicon reads no provider API. A root's `aws_ecs_service` is the same
 * object the aws lexicon reads as `AWS::ECS::Service`, so `chant lifecycle
 * health` hands it to that reader. What this lexicon adds is the two facts
 * the reader cannot find on its own: which health type the resource is
 * ({@link TERRAFORM_HEALTH_TYPES}), and the id the root's state recorded for
 * it, read by the same state read `describeResources` makes. The aws reader
 * otherwise finds ids through CloudFormation's `describeStackResources`,
 * which knows nothing of a terraform root.
 *
 * A block expanded with `count` or `for_each` is one target per instance,
 * named by its instance node id (`app/aws_ecs_service.api[0]`). A resource
 * of any other type has no health read and is left out, as the provider
 * lexicons leave out the types they do not read.
 */
import type { HealthReadOptions, HealthTarget, HealthTargetsResult, UnobservedEntity } from "@intentius/chant/lexicon";
import type { DescribeResourcesResult } from "@intentius/chant/lexicon";
import { normalizeObservation } from "@intentius/chant/observation";
import { observedInstanceNodeId } from "@intentius/chant/instance-nodes";
import { RESOURCE_TYPE } from "./hcl/parse";

/**
 * Each terraform resource type a provider lexicon reads health for, with
 * that lexicon and its health type. The docs page on health lists the same
 * table.
 */
export const TERRAFORM_HEALTH_TYPES: Readonly<Record<string, { lexicon: string; type: string }>> = {
  aws_route53_health_check: { lexicon: "aws", type: "AWS::Route53::HealthCheck" },
  aws_ecs_service: { lexicon: "aws", type: "AWS::ECS::Service" },
  azurerm_container_app: { lexicon: "azure", type: "Microsoft.App/containerApps" },
  google_cloud_run_v2_service: { lexicon: "gcp", type: "GCP::Run::Service" },
  google_cloud_run_service: { lexicon: "gcp", type: "GCP::Run::Service" },
  google_compute_backend_service: { lexicon: "gcp", type: "GCP::Compute::BackendService" },
  google_compute_region_backend_service: { lexicon: "gcp", type: "GCP::Compute::BackendService" },
  google_project_iam_member: { lexicon: "gcp", type: "GCP::Iam::PolicyMember" },
};

/** The read the targets take their ids from: the lexicon's `describeResources`, at the state depth. */
export type TerraformIdRead = (options: {
  environment: string;
  buildOutput: string;
  entityNames: string[];
  entities: Map<string, { entityType: string; props: Record<string, unknown> }>;
  depth: "state";
}) => Promise<DescribeResourcesResult>;

const defaultRead: TerraformIdRead = async (options) => {
  const { describeResources } = await import("./describe-resources");
  return describeResources(options);
};

/** The terraform resource type of a declared entity, or undefined for a block that is not a `resource`. */
function resourceTypeOf(entity: { entityType: string; props: Record<string, unknown> }): string | undefined {
  if (entity.entityType !== RESOURCE_TYPE) return undefined;
  const type = entity.props.type;
  return typeof type === "string" && type.length > 0 ? type : undefined;
}

/** `LexiconPlugin.healthTargets` for terraform. */
export async function terraformHealthTargets(options: HealthReadOptions, read: TerraformIdRead = defaultRead): Promise<HealthTargetsResult> {
  const covered = new Map<string, { entityType: string; props: Record<string, unknown> }>();
  const kinds = new Map<string, string>();
  for (const [name, entity] of options.entities) {
    const type = resourceTypeOf(entity);
    if (type && TERRAFORM_HEALTH_TYPES[type]) {
      covered.set(name, entity);
      kinds.set(name, type);
    }
  }
  const targets: Record<string, HealthTarget> = {};
  const unobserved: Record<string, UnobservedEntity> = {};
  const absent: string[] = [];
  if (covered.size === 0) return { targets, unobserved, absent };

  const observed = normalizeObservation(await read({
    environment: options.environment,
    buildOutput: options.buildOutput,
    entityNames: [...covered.keys()],
    entities: covered,
    depth: "state",
  }));

  for (const [name] of covered) {
    const engineType = kinds.get(name)!;
    const { lexicon, type } = TERRAFORM_HEALTH_TYPES[engineType]!;
    const target = (physicalId: string): HealthTarget => ({ lexicon, type, engineType, physicalId });
    const hole = observed.unobserved[name];
    const present = observed.resources[name];
    if (hole) {
      unobserved[name] = { type, reason: hole.reason, ...(hole.detail ? { detail: hole.detail } : {}) };
      continue;
    }
    if (!present) {
      absent.push(name);
      continue;
    }
    const instances = present.instances ?? [];
    if (instances.length > 0) {
      for (const inst of instances) {
        const id = observedInstanceNodeId(name, inst) ?? `${name}${inst.key ?? ""}`;
        if (inst.verdict === "absent") absent.push(id);
        else if (inst.verdict !== "present") unobserved[id] = { type, reason: "read-failed", detail: `the state read did not observe ${inst.address}` };
        else if (!inst.physicalId) unobserved[id] = { type, reason: "read-failed", detail: `the state records no id for ${inst.address}` };
        else targets[id] = target(inst.physicalId);
      }
      continue;
    }
    const address = typeof present.attributes?.address === "string" ? present.attributes.address : undefined;
    if (!present.physicalId || present.physicalId === address) {
      unobserved[name] = { type, reason: "read-failed", detail: `the state records no id for ${address ?? name}` };
      continue;
    }
    targets[name] = target(present.physicalId);
  }
  return { targets, unobserved, absent };
}
