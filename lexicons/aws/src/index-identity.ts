/**
 * The aws lexicon's identity rule for indexed resources (#4523, rule written
 * out on INTENTIUS/behold#1025's design comment).
 *
 * The same evidence the stack read's identity fallback uses (#1647,
 * ./identity-observe.ts): the CloudFormation schema's `primaryIdentifier`,
 * which codegen compiled into `lexicon-aws.json`, read off the declared
 * props and `|`-joined the way Cloud Control spells an identifier. behold's
 * lister (behold#1029) writes that Cloud Control `Identifier` as each indexed
 * node's `nativeId`, so a never-deployed bucket declared with `BucketName`
 * and a role declared with `RoleName` match their indexed objects by value.
 *
 * What cannot match:
 * - an identifier part the schema lists in `readOnlyProperties` is assigned
 *   by the service (`InstanceId` for `AWS::EC2::Instance`, `QueueUrl` for
 *   `AWS::SQS::Queue`), so no declaration states it: `no-binding`;
 * - a part the declaration leaves out or spells with a Ref or an intrinsic:
 *   `no-binding`, "identity is not in the declaration";
 * - a type with no primary identifier on record: `unsupported-kind`.
 *
 * Global types are the prefixes behold's aws lister lists once per account at
 * location `global` (behold src/cloud-lister/aws.ts, `isGlobalAwsType`).
 */
import { createRequire } from "module";
import { moduleSourceUrl } from "@intentius/chant/module-source";
import type { DeclaredIdentity, IndexIdentity } from "@intentius/chant/lifecycle/identity-match";

const require = createRequire(moduleSourceUrl(import.meta.url));

/** One `lexicon-aws.json` entry, the fields this rule reads. */
export interface IdentityManifestEntry {
  resourceType: string;
  kind: string;
  primaryIdentifier?: string[];
  /** GetAtt name -> CloudFormation attribute: the schema's `readOnlyProperties`. */
  attrs?: Record<string, string>;
}

const GLOBAL_TYPE_PREFIXES = ["AWS::IAM::", "AWS::CloudFront::", "AWS::Route53::", "AWS::Organizations::", "AWS::GlobalAccelerator::"];

/** True for a type behold's lister indexes at location `global`. */
export function isGlobalAwsType(type: string): boolean {
  return GLOBAL_TYPE_PREFIXES.some((p) => type.startsWith(p));
}

let cachedManifest: ReadonlyMap<string, IdentityManifestEntry> | undefined;

/** The manifest keyed by type, or an empty one in a checkout that has not generated (every type is then `unsupported-kind`). */
function defaultManifest(): ReadonlyMap<string, IdentityManifestEntry> {
  if (cachedManifest) return cachedManifest;
  try {
    const manifest = require("./generated/lexicon-aws.json") as Record<string, IdentityManifestEntry>;
    cachedManifest = new Map(Object.values(manifest).filter((e) => e.kind === "resource").map((e) => [e.resourceType, e]));
  } catch {
    cachedManifest = new Map();
  }
  return cachedManifest;
}

/**
 * The identifier an aws declaration spells for the index, or why it spells
 * none. `manifest` is the generated `lexicon-aws.json` keyed by type; a test
 * passes a table.
 */
export function awsDeclaredIdentity(
  entityType: string,
  props: Record<string, unknown>,
  manifest: ReadonlyMap<string, IdentityManifestEntry> = defaultManifest(),
): DeclaredIdentity {
  const entry = manifest.get(entityType);
  const parts = entry?.primaryIdentifier;
  if (!entry || entry.kind !== "resource" || !parts || parts.length === 0) {
    return { kind: "unmatchable", reason: "unsupported-kind", detail: `${entityType} has no primary identifier on record` };
  }
  const readOnly = new Set(Object.values(entry.attrs ?? {}));
  const serverAssigned = parts.filter((p) => readOnly.has(p));
  if (serverAssigned.length > 0) {
    return {
      kind: "unmatchable",
      reason: "no-binding",
      detail: `the identity of ${entityType} (${parts.join(", ")}) is assigned by the service (${serverAssigned.join(", ")}), so no declaration states it`,
    };
  }
  const values: string[] = [];
  for (const part of parts) {
    const v = props[part];
    if ((typeof v !== "string" && typeof v !== "number") || String(v) === "") {
      return { kind: "unmatchable", reason: "no-binding", detail: `identity is not in the declaration (${entityType} ${part})` };
    }
    values.push(String(v));
  }
  return { kind: "identifier", listedType: entityType, identifier: values.join("|"), global: isGlobalAwsType(entityType) };
}

export const awsIndexIdentity: IndexIdentity = {
  substrate: "aws",
  declaredIdentity: (entityType, props) => awsDeclaredIdentity(entityType, props),
};
