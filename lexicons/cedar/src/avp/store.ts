/**
 * Binding a chant environment to an AVP policy store, and reading it (#1652).
 *
 * Everything that talks to a store needs the same two things first: which store
 * this environment means, and the store's policies indexed by the Cedar id a
 * chant entity resolves to. Both live here so `describeResources`,
 * `observeAmbient` and `exportResources` cannot disagree about either.
 */

import { boundedConcurrently } from "@intentius/chant/observation";
import {
  getPolicy,
  listPolicies,
  type AvpClientOptions,
  type AvpPolicySummary,
} from "./client";
import { decodeOwnershipDescription } from "./ownership";
import { policyIdFromStatement } from "./statement";

/** The env var an environment's policy store is named in when config does not name it. */
export const AVP_POLICY_STORE_ENV = "CEDAR_AVP_POLICY_STORE_ID";

/** Per-environment override: `CEDAR_AVP_POLICY_STORE_ID_PROD`. */
export function policyStoreEnvKey(environment: string): string {
  return `${AVP_POLICY_STORE_ENV}_${environment.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

export interface StoreBindingOptions {
  environment: string;
  /** Explicit store id from the caller — wins over everything. */
  policyStoreId?: string;
  /** Declared entities, read for a `policyStoreId` prop (the entity-prop pass-through). */
  entities?: Map<string, { entityType: string; props: Record<string, unknown> }>;
  env?: Record<string, string | undefined>;
}

/**
 * Which policy store this environment means.
 *
 * Resolution order, most specific first:
 *
 *   1. an explicit `policyStoreId` from the caller;
 *   2. a `policyStoreId` prop on a declared policy — the entity-prop
 *      pass-through the observation guide recommends for finding the cloud-side
 *      identifier, and the form a project uses when it declares the store in the
 *      same build;
 *   3. `CEDAR_AVP_POLICY_STORE_ID_<ENV>`, then `CEDAR_AVP_POLICY_STORE_ID`.
 *
 * `undefined` means no binding, and every caller turns that into `no-binding`
 * rather than an empty read. An empty read would say the store holds nothing,
 * which is a claim about an estate nobody looked at.
 */
export function resolvePolicyStoreId(options: StoreBindingOptions): string | undefined {
  if (options.policyStoreId) return options.policyStoreId;

  for (const [, entity] of options.entities ?? new Map()) {
    const declared = (entity.props as { policyStoreId?: unknown }).policyStoreId;
    if (typeof declared === "string" && declared.length > 0) return declared;
  }

  const env = options.env ?? process.env;
  const scoped = env[policyStoreEnvKey(options.environment)];
  if (scoped) return scoped;
  return env[AVP_POLICY_STORE_ENV] || undefined;
}

/** One live policy, with whatever chant could learn about which entity it belongs to. */
export interface AvpLivePolicy extends AvpPolicySummary {
  /** The Cedar `@id` — the link back to a chant entity. Undefined when unrecoverable. */
  cedarPolicyId?: string;
  /** The policy text, when it was fetched (see `withStatements`). */
  statement?: string;
  /** The author's description, marker segment removed. */
  authoredDescription: string;
  /** Whether the description carried chant's ownership marker. */
  marked: boolean;
}

export interface LoadPoliciesOptions {
  policyStoreId: string;
  client?: AvpClientOptions;
  /**
   * Fetch each policy's statement.
   *
   * The thin observation does not need one: a marked policy's description
   * already names its Cedar id, and `describeResources` returns scrubbed
   * metadata rather than config. Ambient discovery and live export both do, so
   * they ask for them.
   */
  withStatements?: boolean;
}

/**
 * Every policy in the store, each resolved to its Cedar id where possible.
 *
 * The marker is the cheap path: `ListPolicies` returns descriptions, so a
 * chant-stamped policy is identified in the enumeration itself. Anything
 * unmarked — a console edit, another tool's policy — costs one `GetPolicy` to
 * read the `@id` out of its statement, run through the shared bounded pool so a
 * store of two hundred policies is not two hundred serial round trips.
 *
 * A per-policy `GetPolicy` failure leaves that policy without a statement and
 * without a Cedar id rather than sinking the enumeration: the caller then treats
 * the entity it would have matched as not-observed, which is the honest verdict.
 */
export async function loadLivePolicies(options: LoadPoliciesOptions): Promise<AvpLivePolicy[]> {
  const summaries = await listPolicies(options.policyStoreId, options.client);

  const live: AvpLivePolicy[] = summaries.map((summary) => {
    const decoded = decodeOwnershipDescription(summary.description);
    return {
      ...summary,
      ...(decoded.policyId ? { cedarPolicyId: decoded.policyId } : {}),
      authoredDescription: decoded.text,
      marked: decoded.marked,
    };
  });

  const needsStatement = live.filter(
    (policy) => options.withStatements || policy.cedarPolicyId === undefined,
  );

  await boundedConcurrently(needsStatement, async (policy) => {
    try {
      const detail = await getPolicy(options.policyStoreId, policy.policyId, options.client);
      policy.statement = detail.statement;
      if (policy.cedarPolicyId === undefined) {
        const fromStatement = policyIdFromStatement(detail.statement);
        if (fromStatement) policy.cedarPolicyId = fromStatement;
      }
    } catch {
      // One unreadable policy is not a verdict about the store. It stays in the
      // list without a statement, so anything that depended on reading it
      // reports a hole instead of an absence.
    }
  });

  return live;
}

/** Index live policies by the Cedar id a chant entity resolves to. */
export function indexByCedarId(policies: readonly AvpLivePolicy[]): Map<string, AvpLivePolicy> {
  const index = new Map<string, AvpLivePolicy>();
  for (const policy of policies) {
    if (policy.cedarPolicyId === undefined) continue;
    // First wins: two policies claiming one id is a live-side collision, and
    // silently preferring the later one would make the observation depend on
    // enumeration order.
    if (!index.has(policy.cedarPolicyId)) index.set(policy.cedarPolicyId, policy);
  }
  return index;
}
