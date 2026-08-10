/**
 * `exportResources()` against an AVP policy store (#1652).
 *
 * `describeResources` returns scrubbed metadata for diffing — you cannot
 * regenerate a policy from "STATIC, last updated Tuesday". This is the other
 * half: the live statement, parsed back into the props a `Cedar::Policy`
 * declaration carries, as `TemplateIR` so it feeds `templateGenerator()`
 * unchanged. The scrubbing boundary stays single-purpose; nothing here is
 * reachable from the lifecycle paths, which consume the lexicon through
 * `ObservationLexicon` and cannot see this method at all.
 *
 * ## The parse is the import parser's
 *
 * The live-export guide's third step is "map to `TemplateIR` by reusing your
 * import parser", and #1653 shipped one. So a live statement goes through
 * `CedarTemplateParser` — the same code path `chant import policies.cedar`
 * takes — rather than a second reader that would have to re-derive scope
 * mapping, clause-text recovery and template detection, and would drift the
 * first time either side changed. This module's job is the AVP half: bind the
 * store, enumerate it, decide what is server-written, and apply the filters.
 *
 * ## What is server-written here
 *
 * The live-export guide says strip to the declared shape by default and keep
 * the rest under `verbatim`. For AVP the split is unusually clean, because the
 * only thing a user authors is the statement. Everything else on the record —
 * `policyId` (service-assigned), `policyStoreId`, `policyType`, `createdDate`,
 * `lastUpdatedDate`, and the derived `principal`/`resource` summaries AVP
 * computes from the statement — is server-written and stripped by default.
 * `Description` is stripped too: chant's marker lives in it, so exporting it
 * verbatim into regenerated source would bake one environment's ownership stamp
 * into the code that produces every environment.
 *
 * `verbatim: true` puts all of it back under an `avp` key, raw description
 * included.
 */

import type { ExportedTemplate, ResourceSelector } from "@intentius/chant/lexicon";
import type { ResourceIR } from "@intentius/chant/import/parser";
import { CedarTemplateParser } from "../import/adapter";
import { credentialsAvailable, storeDoesNotExist, type AvpClientOptions } from "./client";
import { descriptionIsOwned } from "./ownership";
import { loadLivePolicies, resolvePolicyStoreId, type AvpLivePolicy } from "./store";

export interface ExportAvpOptions {
  environment: string;
  selector?: ResourceSelector;
  /** Restrict to policies carrying chant's description marker. */
  owned?: boolean;
  /** Keep the server-written AVP record alongside the authored props. */
  verbatim?: boolean;
  policyStoreId?: string;
  entities?: Map<string, { entityType: string; props: Record<string, unknown> }>;
  client?: AvpClientOptions;
  env?: Record<string, string | undefined>;
}

/** The server-written AVP record, kept only under `verbatim`. */
export interface AvpRecord {
  policyId: string;
  policyStoreId: string;
  policyType: string;
  description?: string;
  createdDate?: string;
  lastUpdatedDate?: string;
  statement: string;
}

/**
 * One live policy as import IR, or `undefined` when its statement could not be
 * read or parsed.
 *
 * The parse is `CedarTemplateParser`'s — one policy is a policy set of one, so
 * the same reader `chant import` uses answers here, including whether Cedar
 * read it as a static policy or as a template (`Cedar::Policy` vs
 * `Cedar::Template`, decided by whether it carries a slot). The `logicalId` it
 * assigns is the Cedar policy id; turning that into a TypeScript identifier is
 * `CedarGenerator`'s job downstream, and doing it here too would apply the
 * transform twice.
 *
 * Dropping an unparseable policy is deliberate. A regenerated policy set that
 * silently lost a `forbid` reads as a working export and is an authorization
 * hole; a missing entry is visible.
 */
export function policyToResourceIR(
  policy: AvpLivePolicy,
  options: { verbatim?: boolean } = {},
): ResourceIR | undefined {
  if (!policy.statement) return undefined;

  let parsed;
  try {
    parsed = new CedarTemplateParser().parse(policy.statement);
  } catch {
    return undefined;
  }
  const resource = parsed.resources[0];
  if (!resource) return undefined;

  const properties: Record<string, unknown> = { ...resource.properties };

  if (options.verbatim) {
    const record: AvpRecord = {
      policyId: policy.policyId,
      policyStoreId: policy.policyStoreId,
      policyType: policy.policyType,
      ...(policy.description !== undefined ? { description: policy.description } : {}),
      ...(policy.createdDate ? { createdDate: policy.createdDate } : {}),
      ...(policy.lastUpdatedDate ? { lastUpdatedDate: policy.lastUpdatedDate } : {}),
      statement: policy.statement,
    };
    properties.avp = record;
  }

  return {
    ...resource,
    properties,
    metadata: { ...resource.metadata, avpPolicyId: policy.policyId },
  };
}

/**
 * Read a live policy store as full-fidelity import IR.
 *
 * Unlike the observation, this throws when it cannot read: `chant import` has
 * no tri-state to degrade into, and an empty template returned from a failed
 * read would generate a source tree that deletes every policy. The one
 * exception is a store that does not exist, which is an honest empty estate.
 */
export async function exportAvpResources(options: ExportAvpOptions): Promise<ExportedTemplate> {
  const env = options.env ?? process.env;
  const policyStoreId = resolvePolicyStoreId({
    environment: options.environment,
    ...(options.policyStoreId ? { policyStoreId: options.policyStoreId } : {}),
    ...(options.entities ? { entities: options.entities } : {}),
    env,
  });

  if (!policyStoreId) {
    throw new Error(
      `no AVP policy store for environment "${options.environment}" — set CEDAR_AVP_POLICY_STORE_ID or pass policyStoreId`,
    );
  }
  if (!credentialsAvailable(env)) {
    throw new Error("no AWS credentials and no endpoint override — cannot export from AVP");
  }

  let policies: AvpLivePolicy[];
  try {
    policies = await loadLivePolicies({
      policyStoreId,
      ...(options.client ? { client: options.client } : {}),
      withStatements: true,
    });
  } catch (err) {
    if (storeDoesNotExist(err)) policies = [];
    else throw err;
  }

  const resources: ResourceIR[] = [];
  for (const policy of policies) {
    // Ownership is read on this path, which is what lets it be declared in
    // `ownershipChannel.reads` (chant #1348).
    if (options.owned && !descriptionIsOwned(policy.description)) continue;

    const ir = policyToResourceIR(policy, { ...(options.verbatim ? { verbatim: true } : {}) });
    if (!ir) continue;
    // The type is compared against what the parser decided, not a constant:
    // a policy carrying a `?principal`/`?resource` slot comes back as
    // `Cedar::Template`, and `--type Cedar::Policy` should not sweep it up.
    if (options.selector?.type !== undefined && options.selector.type !== ir.type) continue;
    if (options.selector?.name !== undefined && ir.logicalId !== options.selector.name) continue;
    resources.push(ir);
  }

  // Stable order: the store's enumeration order is not a contract, and an
  // import that reshuffles the file on every run is unusable as a diff.
  resources.sort((a, b) => a.logicalId.localeCompare(b.logicalId));

  return {
    resources,
    parameters: [],
    metadata: { lexicon: "cedar", policyStoreId },
  };
}
