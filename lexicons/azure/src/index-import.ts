/**
 * The azure lexicon's index import seam (#5264, `chant import --index`).
 *
 * core's Azure lister reads a subscription through Resource Graph, whose rows
 * have ARM's resource shape, and the index flattens each row the way the deep
 * reader does (./listed-types.ts, ./deep-observe.ts `buildLiveProperties`):
 * the resource-level fields stay at the top and every `properties.*` field is
 * spread beside them. This seam rebuilds the shape the generated classes
 * declare, which the serializer then flattens again on the way to ARM
 * (./serializer.ts):
 *
 * - The resource-level fields `buildLiveProperties` lifts (`name`,
 *   `location`, `sku`, `kind`, `identity`, `tags`, `zones`, `plan`) stay at
 *   the top when the class declares them. Every other key came from ARM's
 *   `properties`, and goes back under `properties` for a class that takes
 *   that object, or stays at the top for one whose codegen flattened it.
 * - Only names the registry lists as declarable are written (`declarable`,
 *   and `innerDeclarable` for the `properties` object), so a server-filled
 *   name such as a storage account's `statusOfPrimary` is left out. The
 *   registry's read-only `attrs` are left out too. Resource Graph returns
 *   `null` or `""` for a resource-level field the resource does not have;
 *   those are left out.
 * - Tags come from the node's own tags, where the lister keeps them. chant's
 *   own ownership tags are left out, since the build writes them.
 * - A child resource (`Microsoft.Network/virtualNetworks_subnets`) is
 *   declared under its full name, `vnet/apps`, rebuilt from its ARM id, as
 *   ./index-identity.ts matches it.
 * - An `id` on a nested element that names a child of the resource itself
 *   (each inline subnet of a virtual network) is left out: ARM fills it in.
 * - A value that is another imported resource's ARM id becomes
 *   `ResourceId(type, ...names)`, which resolves in the resource group the
 *   template deploys to. Each resource group is its own output group, so the
 *   two always share one.
 * - A masked value becomes a `securestring` parameter, and a required
 *   property the listing did not hold becomes a `string` parameter. Each is
 *   referenced as `[parameters('<name>')]`.
 * - A resource group deploys at subscription scope, and one ARM template
 *   cannot mix scopes (AZR030), so resource groups are written to their own
 *   output group (`subscription`), and every other resource to the group of
 *   its resource group (`rg-<name>`).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { moduleSourceDir } from "@intentius/chant/module-source";
import type { IRNode } from "@intentius/chant/graph-ir";
import type { IndexImportCodegen, IndexImportTarget } from "@intentius/chant/lifecycle/index-import";
import type { ParameterIR } from "@intentius/chant/import/parser";
import { armType } from "./arm-type";
import { AZURE_TAG_OWNERSHIP_KEYS } from "./ownership";

/** One `lexicon-azure.json` resource entry, the fields this seam reads. */
export interface AzureImportEntry {
  resourceType: string;
  kind: string;
  attrs?: Record<string, string>;
  declarable?: string[];
  required?: string[];
  innerDeclarable?: string[];
  innerRequired?: string[];
  deployScopes?: string[];
}

/** The fields `buildLiveProperties` lifts from beside ARM's `properties`. */
const RESOURCE_LEVEL = new Set(["name", "location", "sku", "kind", "identity", "tags", "zones", "plan"]);

/** Tags chant writes on every resource it applies (./ownership.ts, ./op/activities/az-apply.ts). */
const OWNERSHIP_TAGS = new Set([
  AZURE_TAG_OWNERSHIP_KEYS.managedBy,
  AZURE_TAG_OWNERSHIP_KEYS.stack,
  AZURE_TAG_OWNERSHIP_KEYS.env,
  "managed-by",
]);

export const RESOURCE_GROUP_KIND = "Microsoft.Resources/resourceGroups";

let cachedRegistry: ReadonlyMap<string, AzureImportEntry> | undefined;

/** The generated registry keyed by kind, or an empty map in a checkout that has not generated. */
export function azureImportRegistry(): ReadonlyMap<string, AzureImportEntry> {
  if (cachedRegistry) return cachedRegistry;
  const map = new Map<string, AzureImportEntry>();
  let dir: string | undefined;
  try {
    dir = moduleSourceDir(import.meta.url);
  } catch {
    dir = undefined;
  }
  for (const candidate of dir ? [join(dir, "generated", "lexicon-azure.json"), join(dir, "..", "dist", "meta.json")] : []) {
    try {
      const data = JSON.parse(readFileSync(candidate, "utf-8")) as Record<string, AzureImportEntry>;
      for (const entry of Object.values(data)) if (entry.kind === "resource" && entry.resourceType) map.set(entry.resourceType, entry);
      break;
    } catch {
      // Try the next candidate.
    }
  }
  cachedRegistry = map;
  return map;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const lower = (s: string) => s.toLowerCase();

/**
 * The name a declaration of `kind` spells for the resource with ARM id
 * `nativeId`: the name segments after the provider type, joined with `/`
 * (`vnet/apps` for a subnet). A resource group's id has no provider segment.
 */
export function azureDeclaredName(kind: string, nativeId: string): string | undefined {
  if (kind === RESOURCE_GROUP_KIND) {
    const m = /^\/subscriptions\/[^/]+\/resourceGroups\/([^/]+)$/i.exec(nativeId);
    return m?.[1];
  }
  const at = lower(nativeId).lastIndexOf("/providers/");
  if (at < 0) return undefined;
  const segments = nativeId.slice(at + "/providers/".length).split("/");
  // namespace, then type/name pairs.
  const names = segments.slice(1).filter((_, i) => i % 2 === 1);
  return names.length > 0 && names.length * 2 === segments.length - 1 ? names.join("/") : undefined;
}

/** The resource group an ARM id names, lowercased, or undefined. */
export function azureResourceGroupOf(nativeId: string): string | undefined {
  return /^\/subscriptions\/[^/]+\/resourceGroups\/([^/]+)/i.exec(nativeId)?.[1]?.toLowerCase();
}

/** Drop every nested `id` that names a child of `selfId` (ARM fills those in). */
function withoutSelfChildIds(value: unknown, selfId: string): unknown {
  const prefix = `${lower(selfId)}/`;
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!isRecord(v)) return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === "id" && typeof x === "string" && lower(x).startsWith(prefix)) continue;
      out[k] = walk(x);
    }
    return out;
  };
  return walk(value);
}

function withoutOwnershipTags(tags: unknown): unknown {
  if (!isRecord(tags)) return tags;
  return Object.fromEntries(Object.entries(tags).filter(([k]) => !OWNERSHIP_TAGS.has(k)));
}

/**
 * The properties a declaration of the node's kind holds, from its flattened
 * attrs and its tags, and the required ones it lacks as dotted paths. The
 * lister keeps a row's tags beside its properties (`node.tags`, masked by
 * key name), so they are read from there.
 */
export function azureImportProperties(
  node: Pick<IRNode, "kind" | "attrs" | "nativeId" | "tags">,
  registry: ReadonlyMap<string, AzureImportEntry> = azureImportRegistry(),
): { properties: Record<string, unknown>; missing: string[] } {
  const { kind, nativeId } = node;
  const attrs: Record<string, unknown> = { ...(node.attrs ?? {}) };
  if (attrs.tags === undefined && node.tags && Object.keys(node.tags).length > 0) attrs.tags = node.tags;
  const entry = registry.get(kind);
  const readOnly = new Set(Object.keys(entry?.attrs ?? {}).map((a) => a.split(".")[0]));
  const declarable = entry?.declarable ? new Set(entry.declarable) : undefined;
  const nested = declarable?.has("properties") ?? false;
  const inner = entry?.innerDeclarable ? new Set(entry.innerDeclarable) : undefined;

  const top: Record<string, unknown> = {};
  const props: Record<string, unknown> = {};
  for (const key of Object.keys(attrs).sort()) {
    let value = attrs[key];
    if (value === null || value === undefined) continue;
    if (RESOURCE_LEVEL.has(key)) {
      if (value === "") continue;
      if (declarable && !declarable.has(key)) continue;
      if (key === "tags") {
        value = withoutOwnershipTags(value);
        if (isRecord(value) && Object.keys(value).length === 0) continue;
      }
      top[key] = value;
      continue;
    }
    if (readOnly.has(key)) continue;
    if (nested) {
      if (inner && !inner.has(key)) continue;
      props[key] = value;
    } else if (!declarable || declarable.has(key)) {
      top[key] = value;
    }
  }

  if (nativeId) {
    const name = azureDeclaredName(kind, nativeId);
    if (name !== undefined) top.name = name;
  }

  const required = entry?.required ?? [];
  if (nested && (Object.keys(props).length > 0 || required.includes("properties"))) top.properties = props;
  const properties = nativeId ? (withoutSelfChildIds(top, nativeId) as Record<string, unknown>) : top;

  const missing = required.filter((p) => p !== "properties" && properties[p] === undefined);
  if (nested && isRecord(properties.properties)) {
    const held = properties.properties;
    for (const p of entry?.innerRequired ?? []) if (held[p] === undefined) missing.push(`properties.${p}`);
  }
  return { properties, missing: missing.sort() };
}

/** `value` as a reference to `target`: `ResourceId(type, ...names)` when it is the target's ARM id. */
export function azureImportReference(value: string, target: IndexImportTarget): unknown | undefined {
  const id = target.node.nativeId;
  if (!id || lower(value) !== lower(id) || target.node.kind === RESOURCE_GROUP_KIND) return undefined;
  const name = azureDeclaredName(target.node.kind, id);
  if (name === undefined) return undefined;
  return { __intrinsic: "ResourceId", args: [armType(target.node.kind), ...name.split("/")] };
}

/** An ARM parameter reference, as the template spells it. The generator writes parameter `name` as its export. */
export function azureParameterExpression(name: string): string {
  return `[parameters('${name.charAt(0).toLowerCase()}${name.slice(1)}')]`;
}

export function createAzureIndexImport(registry?: ReadonlyMap<string, AzureImportEntry>): IndexImportCodegen {
  const r = () => registry ?? azureImportRegistry();
  return {
    resource(node: IRNode) {
      const reg = r();
      if (reg.size > 0 && !reg.has(node.kind)) return { unsupported: `${node.kind} is not an ARM resource type the azure lexicon generates` };
      const { properties, missing } = azureImportProperties(node, reg);
      const scopes = reg.get(node.kind)?.deployScopes;
      const atResourceGroup = !scopes || scopes.includes("resourceGroup");
      const rg = node.nativeId ? azureResourceGroupOf(node.nativeId) : undefined;
      const partition = node.kind === RESOURCE_GROUP_KIND || !atResourceGroup ? "subscription" : rg ? `rg-${rg}` : undefined;
      const notes =
        partition === "subscription"
          ? ["deploys at subscription scope, so it is written apart from resource-group resources; build this directory as its own project (AZR030)"]
          : [];
      return {
        type: node.kind,
        properties,
        ...(notes.length > 0 ? { notes } : {}),
        ...(missing.length > 0 ? { missing } : {}),
        ...(partition ? { partition } : {}),
      };
    },
    reference: (value, target) => azureImportReference(value, target),
    secretParameter(name, context): ParameterIR {
      return { name, type: "securestring", description: `${context.path} of ${context.node.id}, masked in the index` };
    },
    requiredParameter(name, context): ParameterIR {
      return { name, type: "string", description: `${context.path} of ${context.node.id}, required and not in the index listing` };
    },
    parameterReference: (name) => azureParameterExpression(name),
    typeLabel(node) {
      if (node.kind === RESOURCE_GROUP_KIND) return "ResourceGroup";
      const last = armType(node.kind).split("/").pop() ?? "Resource";
      const singular = last.endsWith("ies") ? `${last.slice(0, -3)}y` : last.endsWith("s") ? last.slice(0, -1) : last;
      return singular.charAt(0).toUpperCase() + singular.slice(1);
    },
  };
}

export const azureIndexImport: IndexImportCodegen = createAzureIndexImport();
