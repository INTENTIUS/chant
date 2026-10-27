/**
 * The aws lexicon's index import seam (#4524, `chant import --index`).
 *
 * behold's lister reads AWS through Cloud Control, which returns each
 * object's CloudFormation resource model, and #4521 normalizes it with this
 * lexicon's deep hooks. So an indexed node's `attrs` already are
 * CloudFormation properties, and the import IR is the one the CloudFormation
 * template parser writes (`{ __intrinsic: "Ref" }` and so on), which
 * `CFGenerator` turns into source.
 *
 * - Properties the schema lists in `readOnlyProperties` (the registry's
 *   `attrs`) are left out, because no declaration can set them. Tags whose
 *   key starts with `aws:` are left out too: CloudFormation sets them and
 *   refuses them in a template.
 * - A value that names another imported resource becomes `Ref` when it is
 *   that resource's Cloud Control identifier (a single-part one; for the
 *   types the catalog joins, Ref returns that identifier), and
 *   `GetAtt(<id>, "Arn")` when it is the resource's ARN and the type has an
 *   `Arn` attribute. Anything else stays a literal.
 * - A masked value becomes a `String` parameter with `NoEcho`.
 */
import { createRequire } from "module";
import { moduleSourceUrl } from "@intentius/chant/module-source";
import type { IRNode } from "@intentius/chant/graph-ir";
import type { IndexImportCodegen, IndexImportTarget } from "@intentius/chant/lifecycle/index-import";
import type { ParameterIR } from "@intentius/chant/import/parser";

const require = createRequire(moduleSourceUrl(import.meta.url));

/** One `lexicon-aws.json` entry, the fields this seam reads. */
export interface ImportManifestEntry {
  resourceType: string;
  kind: string;
  /** GetAtt name -> CloudFormation attribute: the schema's `readOnlyProperties`. */
  attrs?: Record<string, string>;
}

let cachedManifest: ReadonlyMap<string, ImportManifestEntry> | undefined;

/** The generated registry keyed by type, or an empty map in a checkout that has not generated. */
function defaultManifest(): ReadonlyMap<string, ImportManifestEntry> {
  if (cachedManifest) return cachedManifest;
  try {
    const manifest = require("./generated/lexicon-aws.json") as Record<string, ImportManifestEntry>;
    cachedManifest = new Map(Object.values(manifest).filter((e) => e.kind === "resource").map((e) => [e.resourceType, e]));
  } catch {
    cachedManifest = new Map();
  }
  return cachedManifest;
}

const CFN_TYPE = /^AWS::[A-Za-z0-9]+::[A-Za-z0-9]+$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Tags without the `aws:` ones, in either shape CloudFormation uses (a Key/Value list or a map). */
function withoutAwsTags(tags: unknown): unknown {
  if (Array.isArray(tags)) {
    return tags.filter((t) => !(isRecord(t) && typeof t.Key === "string" && t.Key.startsWith("aws:")));
  }
  if (isRecord(tags)) {
    return Object.fromEntries(Object.entries(tags).filter(([k]) => !k.startsWith("aws:")));
  }
  return tags;
}

/** The properties a declaration of `type` can hold, from an indexed node's attrs. */
export function awsImportProperties(
  type: string,
  attrs: Record<string, unknown>,
  manifest: ReadonlyMap<string, ImportManifestEntry> = defaultManifest(),
): Record<string, unknown> {
  const readOnly = new Set(Object.values(manifest.get(type)?.attrs ?? {}).map((a) => a.split(".")[0]));
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(attrs).sort()) {
    if (readOnly.has(key)) continue;
    const value = key === "Tags" ? withoutAwsTags(attrs[key]) : attrs[key];
    if (key === "Tags" && ((Array.isArray(value) && value.length === 0) || (isRecord(value) && Object.keys(value).length === 0))) continue;
    out[key] = value;
  }
  return out;
}

/** True when `type` exposes `Arn` to GetAtt, or when there is no registry to ask. */
function hasArnAttribute(type: string, manifest: ReadonlyMap<string, ImportManifestEntry>): boolean {
  if (manifest.size === 0) return true;
  return Object.values(manifest.get(type)?.attrs ?? {}).includes("Arn");
}

/** `value` as a reference to `target`, or undefined. */
export function awsImportReference(
  value: string,
  target: IndexImportTarget,
  manifest: ReadonlyMap<string, ImportManifestEntry> = defaultManifest(),
): unknown | undefined {
  const node = target.node;
  if (node.nativeId !== undefined && value === node.nativeId && !value.includes("|")) {
    return { __intrinsic: "Ref", name: target.logicalId };
  }
  const isArn = (node.facts?.cloudIds ?? []).some((c) => c.kind === "arn" && c.value === value);
  if (isArn && hasArnAttribute(node.kind, manifest)) {
    return { __intrinsic: "GetAtt", logicalId: target.logicalId, attribute: "Arn" };
  }
  return undefined;
}

/** The resource attributes `chant import --index` writes on every resource it imports (#4536). */
export const ADOPTED_RESOURCE_ATTRIBUTES: Readonly<Record<string, string>> = { DeletionPolicy: "Retain", UpdateReplacePolicy: "Retain" };

export function createAwsIndexImport(manifest?: ReadonlyMap<string, ImportManifestEntry>): IndexImportCodegen {
  const m = () => manifest ?? defaultManifest();
  return {
    resource(node: IRNode) {
      if (!CFN_TYPE.test(node.kind)) return { unsupported: `${node.kind} is not a CloudFormation resource type` };
      // Retain on every imported resource until a person changes it in source
      // (#4536, ruled on choudoufu#2284 Q4): CloudFormation deletes at stack
      // level and reads no per-resource marker, so an adopted object is never
      // deleted on the stack's word alone. Import requires a DeletionPolicy.
      return { type: node.kind, properties: awsImportProperties(node.kind, node.attrs ?? {}, m()), attributes: { ...ADOPTED_RESOURCE_ATTRIBUTES } };
    },
    reference: (value, target) => awsImportReference(value, target, m()),
    secretParameter(name, context): ParameterIR {
      return {
        name,
        type: "String",
        description: `${context.path} of ${context.node.id}, masked in the index`,
        constraints: { NoEcho: true },
      };
    },
    parameterReference: (name) => ({ __intrinsic: "Ref", name }),
    typeLabel(node) {
      const last = node.kind.split("::").pop() ?? "Resource";
      return last.charAt(0).toUpperCase() + last.slice(1);
    },
  };
}

export const awsIndexImport: IndexImportCodegen = createAwsIndexImport();
