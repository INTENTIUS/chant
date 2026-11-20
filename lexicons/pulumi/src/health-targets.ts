/**
 * Health for a pulumi stack (#5338), through the provider lexicons.
 *
 * A stack's `aws:ecs/service:Service` is the object the aws lexicon reads as
 * `AWS::ECS::Service`, so `chant lifecycle health` hands it to that reader
 * with the id the stack's export recorded. The export is the one the member
 * read in this process loaded (the index store's, else the checked-in
 * `stack-export.json`); nothing else is run. A resource of a type outside
 * {@link PULUMI_HEALTH_TYPES} has no health read and is left out.
 */
import type { HealthReadOptions, HealthTarget, HealthTargetsResult, UnobservedEntity } from "@intentius/chant/lexicon";
import { pulumiNodeKey } from "@intentius/chant/pulumi-urn";
import { lastMemberRead, type PulumiMemberRead } from "./member-report";

/**
 * Each pulumi resource type a provider lexicon reads health for, with that
 * lexicon and its health type. The docs page on health lists the same table.
 */
export const PULUMI_HEALTH_TYPES: Readonly<Record<string, { lexicon: string; type: string }>> = {
  "aws:route53/healthCheck:HealthCheck": { lexicon: "aws", type: "AWS::Route53::HealthCheck" },
  "aws:ecs/service:Service": { lexicon: "aws", type: "AWS::ECS::Service" },
  "azure-native:app:ContainerApp": { lexicon: "azure", type: "Microsoft.App/containerApps" },
  "azure:containerapp/app:App": { lexicon: "azure", type: "Microsoft.App/containerApps" },
  "gcp:cloudrunv2/service:Service": { lexicon: "gcp", type: "GCP::Run::Service" },
  "gcp:cloudrun/service:Service": { lexicon: "gcp", type: "GCP::Run::Service" },
  "gcp:compute/backendService:BackendService": { lexicon: "gcp", type: "GCP::Compute::BackendService" },
  "gcp:compute/regionBackendService:RegionBackendService": { lexicon: "gcp", type: "GCP::Compute::BackendService" },
  "gcp:projects/iAMMember:IAMMember": { lexicon: "gcp", type: "GCP::Iam::PolicyMember" },
};

/** The ids an export records, keyed as the member read keys its entities (`<label>/<urn tail>`). */
export function exportIds(read: Pick<PulumiMemberRead, "label" | "doc">): Map<string, string> {
  const out = new Map<string, string>();
  const doc = read.doc as { deployment?: { resources?: unknown } } | undefined;
  const resources = Array.isArray(doc?.deployment?.resources) ? (doc!.deployment!.resources as unknown[]) : [];
  for (const r of resources) {
    const row = r as { urn?: unknown; id?: unknown; delete?: unknown };
    if (typeof row?.urn !== "string" || typeof row.id !== "string" || row.id === "" || row.delete === true) continue;
    const tail = pulumiNodeKey(row.urn);
    if (tail) out.set(`${read.label}/${tail}`, row.id);
  }
  return out;
}

/** `LexiconPlugin.healthTargets` for pulumi. `read` defaults to the member read this process made. */
export async function pulumiHealthTargets(
  options: HealthReadOptions,
  read: PulumiMemberRead | undefined = lastMemberRead(),
): Promise<HealthTargetsResult> {
  const targets: Record<string, HealthTarget> = {};
  const unobserved: Record<string, UnobservedEntity> = {};
  const absent: string[] = [];
  const ids = read?.doc !== undefined ? exportIds(read) : undefined;
  for (const [name, { entityType }] of options.entities) {
    const mapped = PULUMI_HEALTH_TYPES[entityType];
    if (!mapped) continue;
    if (!ids) {
      unobserved[name] = { type: mapped.type, reason: "no-binding", detail: "no stack export was read, so there is no recorded id to read health by" };
      continue;
    }
    const id = ids.get(name);
    if (id) targets[name] = { lexicon: mapped.lexicon, type: mapped.type, engineType: entityType, physicalId: id };
    else absent.push(name);
  }
  return { targets, unobserved, absent };
}
