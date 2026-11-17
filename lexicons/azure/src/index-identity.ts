/**
 * The azure lexicon's identity rule for indexed resources (#4538, on #4523's
 * matcher, ../../../packages/core/src/lifecycle/identity-match.ts).
 *
 * core's Azure lister (packages/core/src/cloud-lister/azure.ts) lists one
 * subscription through Resource Graph and writes each row as:
 *
 * - `listedType` the ARM type, lowercased as Resource Graph returns it
 *   (`microsoft.network/virtualnetworks/subnets`);
 * - `location` the row's location, lowercased, or `global` when it has none;
 * - `nativeId` the ARM id as returned
 *   (`/subscriptions/s/resourceGroups/rg/providers/Microsoft.Network/virtualNetworks/vnet`);
 * - two `provider-id` cloud ids, that id and its lowercased form.
 *
 * An ARM declaration spells its type and its name (`vnet/apps` for a child
 * declared on its own). It does not spell the subscription, which is the
 * index's own scope, or the resource group, which the deployment target
 * chooses. So a node's key is the provider-relative path of its id, after the
 * last `/providers/` (`microsoft.network/virtualnetworks/vnet/subnets/apps`),
 * and a declaration's identifier is the same path built from its type and
 * name the way ARM's `resourceId()` builds it (./arm-type.ts
 * `armResourcePath`). ARM ids and types are case-insensitive, so both sides
 * are lowercased. Two resource groups holding one name are refused, never
 * guessed between.
 *
 * A literal `location` (`eastus`, or ARM's display spelling `East US`) is
 * looked for there. A declaration with none takes its resource group's
 * location when it is deployed, which the declaration does not state, and a
 * child resource has none at all, so it is looked for at every location.
 *
 * What cannot match (`no-binding`): a name the declaration leaves out (the
 * build then uses the export name, which the declaration's props do not
 * hold) or spells with an ARM expression. A kind the registry does not know
 * reads `unsupported-kind`.
 */
import type { DeclaredIdentity, IndexIdentity } from "@intentius/chant/lifecycle/identity-match";
import { ANY_LOCATION } from "@intentius/chant/lifecycle/identity-match";
import type { NodeIdentityValue } from "@intentius/chant/graph-refs";
import type { IRNode } from "@intentius/chant/graph-ir";
import { armResourcePath } from "./arm-type";
import { azureListedTypeForKind } from "./listed-types";
import { loadApiVersions } from "./serializer";

const PROVIDERS = "/providers/";

const nonEmptyString = (v: unknown): v is string => typeof v === "string" && v !== "";

/** An ARM template expression (`[resourceGroup().location]`) is not a literal. */
const isArmExpression = (v: string) => v.startsWith("[") && v.endsWith("]") && !v.startsWith("[[");

let cachedKinds: ReadonlySet<string> | null | undefined;

/** The kinds the generated registry holds, or null in a checkout that has not generated. */
function generatedKinds(): ReadonlySet<string> | null {
  if (cachedKinds !== undefined) return cachedKinds;
  try {
    cachedKinds = new Set(loadApiVersions().keys());
  } catch {
    cachedKinds = null;
  }
  return cachedKinds;
}

/** The provider-relative path of an ARM id, lowercased: what a declaration's type and name spell. */
export function azureNodeKey(node: Pick<IRNode, "nativeId">): string | undefined {
  const id = node.nativeId;
  if (!id) return undefined;
  const at = id.toLowerCase().lastIndexOf(PROVIDERS);
  if (at < 0) return undefined;
  const path = id.slice(at + PROVIDERS.length).toLowerCase();
  return path === "" ? undefined : path;
}

/** `East US` and `eastus` are one ARM location. */
export function normalizeAzureLocation(location: string): string {
  return location.replace(/\s+/g, "").toLowerCase();
}

/**
 * The identifier an azure declaration spells for the index, or why it spells
 * none. `kinds` is the generated registry's kinds; a test passes a set, and
 * null (no registry) accepts every kind.
 */
export function azureDeclaredIdentity(
  entityType: string,
  props: Record<string, unknown>,
  kinds: ReadonlySet<string> | null = generatedKinds(),
): DeclaredIdentity {
  if (!entityType.includes("/") || (kinds !== null && !kinds.has(entityType))) {
    return { kind: "unmatchable", reason: "unsupported-kind", detail: `${entityType} is not an ARM type on record` };
  }
  const name = props.name;
  if (!nonEmptyString(name) || isArmExpression(name)) {
    return { kind: "unmatchable", reason: "no-binding", detail: `identity is not in the declaration (${entityType} name)` };
  }
  const location = props.location;
  return {
    kind: "identifier",
    listedType: azureListedTypeForKind(entityType),
    identifier: armResourcePath(entityType, name).toLowerCase(),
    global: false,
    location: nonEmptyString(location) && !isArmExpression(location) ? normalizeAzureLocation(location) : ANY_LOCATION,
  };
}

/** The values that name an indexed azure resource: its ARM id as listed and lowercased. */
export function azureNodeIdentities(node: IRNode): NodeIdentityValue[] {
  const out: NodeIdentityValue[] = [];
  const seen = new Set<string>();
  const push = (kind: string, value: string | undefined) => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    out.push({ kind, value });
  };
  push("native-id", node.nativeId);
  for (const c of node.facts?.cloudIds ?? []) if (c.kind === "provider-id") push(c.kind, c.value);
  return out;
}

export function createAzureIndexIdentity(kinds?: ReadonlySet<string> | null): IndexIdentity {
  return {
    substrate: "azure",
    declaredIdentity: (entityType, props) => azureDeclaredIdentity(entityType, props, kinds === undefined ? generatedKinds() : kinds),
    nodeIdentities: azureNodeIdentities,
    nodeKey: azureNodeKey,
  };
}

export const azureIndexIdentity: IndexIdentity = createAzureIndexIdentity();
