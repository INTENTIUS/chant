/**
 * `describeResources()` against an AVP policy store (#1652).
 *
 * The tri-state matters more here than it does for most substrates. A Cedar
 * policy that chant declares and the store does not have is a *missing
 * authorization rule*: reporting it absent proposes a create, which is right.
 * Reporting it absent because the store id was wrong, or because the read
 * failed, proposes creating a permit that already exists — duplicating a grant.
 * So every path that did not actually look says so.
 *
 * Built on core's observer harness (`observeEntities`), which owns the shape:
 * bind-or-not-observe-all with a typed reason, bounded concurrency, a per-entity
 * throw degrading to `read-failed` rather than a silent absence, and collection
 * of the `queried` addresses.
 */

import type { ObservationResult, ResourceMetadata } from "@intentius/chant/lexicon";
import {
  observation,
  observeEntities,
  unobservedAll,
  type DeclaredEntity,
  type EntityObservation,
  type ObserverAdapter,
  type UnobservedReason,
} from "@intentius/chant/observation";
import { CEDAR_POLICY_TYPE, resolvePolicyId } from "../serializer";
import {
  classifyAvpFailure,
  credentialsAvailable,
  policyAddress,
  storeAddress,
  storeDoesNotExist,
  type AvpClientOptions,
} from "./client";
import { ownershipFromDescription } from "./ownership";
import {
  indexByCedarId,
  loadLivePolicies,
  resolvePolicyStoreId,
  type AvpLivePolicy,
} from "./store";

export interface DescribeAvpOptions {
  environment: string;
  entityNames: string[];
  entities: Map<string, { entityType: string; props: Record<string, unknown> }>;
  /** Restrict to policies carrying chant's description marker. */
  owned?: boolean;
  /** Explicit store id; otherwise resolved per {@link resolvePolicyStoreId}. */
  policyStoreId?: string;
  client?: AvpClientOptions;
  /** Environment to read the binding and credentials from. Injectable for tests. */
  env?: Record<string, string | undefined>;
}

/** What `bind()` hands each read: the store, its policies, and the address prefix. */
interface AvpBinding {
  policyStoreId: string;
  byCedarId: Map<string, AvpLivePolicy>;
  region?: string;
}

/** A bind failure that already knows its verdict. */
class AvpBindFailure extends Error {
  constructor(
    readonly reason: UnobservedReason,
    readonly detail: string,
  ) {
    super(detail);
    this.name = "AvpBindFailure";
  }
}

function metadataFor(policy: AvpLivePolicy, ownership: "owned" | "foreign"): ResourceMetadata {
  return {
    type: CEDAR_POLICY_TYPE,
    physicalId: policy.policyId,
    // AVP has no lifecycle state on a policy: it exists or it does not. The
    // policy type is the most useful thing to show, and a template-linked
    // policy differing from a static one IS drift worth seeing.
    status: policy.policyType || "STATIC",
    ...(policy.lastUpdatedDate ? { lastUpdated: policy.lastUpdatedDate } : {}),
    ownership,
    attributes: {
      policyStoreId: policy.policyStoreId,
      policyId: policy.policyId,
      policyType: policy.policyType,
      ...(policy.cedarPolicyId ? { cedarPolicyId: policy.cedarPolicyId } : {}),
      ...(policy.authoredDescription ? { description: policy.authoredDescription } : {}),
      ...(policy.createdDate ? { createdDate: policy.createdDate } : {}),
    },
  };
}

/**
 * Observe the declared policy set against a live AVP store.
 *
 * Never throws for a transport or binding problem — a throw is the
 * whole-lexicon failure and core would mark every entity `read-failed`, which
 * is a worse-shaped version of what this returns directly with the right
 * reason on it.
 */
export async function describeAvpResources(options: DescribeAvpOptions): Promise<ObservationResult> {
  const env = options.env ?? process.env;
  const typesByName: Record<string, string> = {};
  for (const name of options.entityNames) {
    typesByName[name] = options.entities.get(name)?.entityType ?? CEDAR_POLICY_TYPE;
  }

  const policyStoreId = resolvePolicyStoreId({
    environment: options.environment,
    ...(options.policyStoreId ? { policyStoreId: options.policyStoreId } : {}),
    entities: options.entities,
    env,
  });

  if (!policyStoreId) {
    return observation(
      {},
      unobservedAll(
        options.entityNames,
        "no-binding",
        `no AVP policy store for environment "${options.environment}" — set ${"CEDAR_AVP_POLICY_STORE_ID"} or declare policyStoreId on a policy`,
        typesByName,
      ),
    );
  }

  if (!credentialsAvailable(env)) {
    return observation(
      {},
      unobservedAll(
        options.entityNames,
        "no-credentials",
        "no AWS credentials and no endpoint override — the AVP store was not queried",
        typesByName,
      ),
    );
  }

  const region = options.client?.region;
  const declared: DeclaredEntity[] = options.entityNames.map((name) => {
    const entity = options.entities.get(name);
    return {
      name,
      type: entity?.entityType ?? CEDAR_POLICY_TYPE,
      props: entity?.props ?? {},
    };
  });

  const adapter: ObserverAdapter<AvpBinding> = {
    async bind(): Promise<AvpBinding> {
      try {
        const policies = await loadLivePolicies({
          policyStoreId,
          ...(options.client ? { client: options.client } : {}),
        });
        return { policyStoreId, byCedarId: indexByCedarId(policies), ...(region ? { region } : {}) };
      } catch (err) {
        // A store that is not there yet is the pre-first-apply state: nothing
        // is deployed, so every declared policy is genuinely absent and
        // `create` is the right proposal.
        if (storeDoesNotExist(err)) {
          return { policyStoreId, byCedarId: new Map(), ...(region ? { region } : {}) };
        }
        const { reason, detail } = classifyAvpFailure(err);
        throw new AvpBindFailure(reason, `ListPolicies failed for store ${policyStoreId}: ${detail}`);
      }
    },

    classifyBindFailure(err: unknown) {
      if (err instanceof AvpBindFailure) return { reason: err.reason, detail: err.detail };
      const { reason, detail } = classifyAvpFailure(err);
      return { reason, detail: `${storeAddress(policyStoreId, region)}: ${detail}` };
    },

    async read(binding: AvpBinding, entity: DeclaredEntity): Promise<EntityObservation> {
      if (entity.type !== CEDAR_POLICY_TYPE) {
        // Cedar declares one deployable kind. Anything else is a schema entity
        // or action constant, which has no AVP counterpart at all — saying so
        // per entity keeps it out of `lifecycle plan` as a create.
        return {
          unobserved: {
            reason: "unsupported-kind",
            detail: `no AVP reader for ${entity.type} — only ${CEDAR_POLICY_TYPE} is deployed to a policy store`,
          },
        };
      }

      const cedarPolicyId = resolvePolicyId(entity.name, entity.props);
      const queried = policyAddress(binding.policyStoreId, cedarPolicyId, binding.region);
      const policy = binding.byCedarId.get(cedarPolicyId);

      // The store was enumerated and this `@id` is not in it. That is an
      // absence, and the only shape allowed to become a create.
      if (!policy) return { absent: true, queried };

      const ownership = ownershipFromDescription(policy.description);
      if (options.owned && ownership !== "owned") {
        return {
          unobserved: {
            reason: "filtered",
            detail: "live policy carries no chant description marker",
          },
          queried,
        };
      }

      return { present: metadataFor(policy, ownership), queried };
    },
  };

  return observeEntities(declared, adapter);
}
