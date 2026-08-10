/**
 * Policies that are simply *there* (#1652, chant #1278).
 *
 * For most lexicons ambient discovery is housekeeping — an unattached security
 * group, an orphaned volume. For an authorization store it is a security
 * finding. A policy in the store that no chant entity declares is a grant
 * nobody in the source tree can see: it was added in the console, or by a
 * previous tool, or by a teammate's script, and it is being evaluated on every
 * request. `describeResources` structurally cannot report it, because it
 * resolves outward from what was declared and this is precisely what was not.
 *
 * The reader reports the policy and its statement. It does not decide that an
 * ambient `permit` is dangerous — that is a conclusion, and putting conclusions
 * in observations is the mistake chant #1271 undid. What it does carry is the
 * `effect`, because "which ambient policies are permits" is the first question
 * anyone asks and re-parsing the statement to answer it is work every consumer
 * would repeat.
 */

import type { ResourceMetadata } from "@intentius/chant/lexicon";
import { CEDAR_POLICY_TYPE } from "../serializer";
import { credentialsAvailable, type AvpClientOptions } from "./client";
import { ownershipFromDescription } from "./ownership";
import { loadLivePolicies, resolvePolicyStoreId } from "./store";
import { effectFromStatement } from "./statement";

/**
 * The kinds this lexicon can enumerate beyond the declared estate.
 *
 * One, and it is the only kind cedar deploys. Declared separately from the
 * reader so `chant search` can say `--ambient` is relevant to a policy query
 * without paying for a scan to find out.
 */
export const AVP_AMBIENT_KINDS: readonly string[] = [CEDAR_POLICY_TYPE];

export interface ObserveAvpAmbientOptions {
  environment: string;
  /** Entity types the project declares — the bound on what to enumerate. */
  kinds: string[];
  /** Already-observed managed resources, to exclude. */
  observed: Record<string, ResourceMetadata>;
  /** Cedar ids the project declares, so a declared-but-unobserved policy is not called ambient. */
  declaredPolicyIds?: Iterable<string>;
  policyStoreId?: string;
  entities?: Map<string, { entityType: string; props: Record<string, unknown> }>;
  client?: AvpClientOptions;
  env?: Record<string, string | undefined>;
}

/**
 * Policies in the store that nothing declares and nothing already observed.
 *
 * Best-effort by contract: ambient discovery is additive, and a failure here
 * must not sink a managed observation that already succeeded, so the whole scan
 * degrades to `{}` rather than throwing. The managed answer is complete without
 * any of this.
 */
export async function observeAvpAmbient(
  options: ObserveAvpAmbientOptions,
): Promise<Record<string, ResourceMetadata>> {
  if (!options.kinds.includes(CEDAR_POLICY_TYPE)) return {};

  const env = options.env ?? process.env;
  const policyStoreId = resolvePolicyStoreId({
    environment: options.environment,
    ...(options.policyStoreId ? { policyStoreId: options.policyStoreId } : {}),
    ...(options.entities ? { entities: options.entities } : {}),
    env,
  });
  if (!policyStoreId || !credentialsAvailable(env)) return {};

  let policies;
  try {
    policies = await loadLivePolicies({
      policyStoreId,
      ...(options.client ? { client: options.client } : {}),
      withStatements: true,
    });
  } catch {
    return {};
  }

  // Two exclusions, because "managed" has two spellings here: the AVP policy id
  // the observation recorded as a physicalId, and the Cedar id the source
  // declares. A declared policy whose read failed has no physicalId, and
  // calling it ambient would turn a hole into a security finding.
  const observedIds = new Set(
    Object.values(options.observed)
      .map((meta) => meta.physicalId)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  );
  const declaredIds = new Set(options.declaredPolicyIds ?? []);

  const ambient: Record<string, ResourceMetadata> = {};
  for (const policy of policies) {
    if (observedIds.has(policy.policyId)) continue;
    if (policy.cedarPolicyId !== undefined && declaredIds.has(policy.cedarPolicyId)) continue;

    const effect = policy.statement ? effectFromStatement(policy.statement) : undefined;

    ambient[`policy/${policy.policyId}`] = {
      type: CEDAR_POLICY_TYPE,
      status: policy.policyType || "STATIC",
      physicalId: policy.policyId,
      ...(policy.lastUpdatedDate ? { lastUpdated: policy.lastUpdatedDate } : {}),
      ownership: ownershipFromDescription(policy.description),
      ambient: true,
      attributes: {
        policyStoreId: policy.policyStoreId,
        policyId: policy.policyId,
        policyType: policy.policyType,
        ...(effect ? { effect } : {}),
        ...(policy.cedarPolicyId ? { cedarPolicyId: policy.cedarPolicyId } : {}),
        ...(policy.authoredDescription ? { description: policy.authoredDescription } : {}),
        // The statement itself, so the consumer can judge the grant rather than
        // trusting a summary this reader invented.
        ...(policy.statement ? { statement: policy.statement } : {}),
        ...(policy.createdDate ? { createdDate: policy.createdDate } : {}),
      },
    };
  }

  return ambient;
}
