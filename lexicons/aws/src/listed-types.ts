/**
 * Cloud Control's type names as aws lexicon kinds (#4521).
 *
 * behold#1029 lists AWS through Cloud Control `ListResources`, which names
 * each object by its CloudFormation type (`AWS::S3::Bucket`), and the aws
 * lexicon's kinds are those same names. So the mapping is the identity, kept
 * to the types the lexicon generated: a type outside `lexicon-aws.json` (one
 * newer than the pinned registry, or a third-party type) has no kind here and
 * stays an unknown-kind node. Cloud Control returns the CloudFormation
 * resource model, which is the tree the deep reader returns too
 * (./deep-observe.ts), so no reshaping.
 */
import { createRequire } from "module";
import { moduleSourceUrl } from "@intentius/chant/module-source";
import type { ListedTypeMapping } from "@intentius/chant/lifecycle/type-listing";

const require = createRequire(moduleSourceUrl(import.meta.url));

const CFN_TYPE = /^AWS::[A-Za-z0-9]+::[A-Za-z0-9]+$/;

let cachedKinds: ReadonlySet<string> | null | undefined;

/** The resource kinds `chant generate` wrote, or null in a checkout that has not generated. */
function generatedKinds(): ReadonlySet<string> | null {
  if (cachedKinds !== undefined) return cachedKinds;
  try {
    const manifest = require("./generated/lexicon-aws.json") as Record<string, { resourceType: string; kind: string }>;
    cachedKinds = new Set(Object.values(manifest).filter((e) => e.kind === "resource").map((e) => e.resourceType));
  } catch {
    cachedKinds = null;
  }
  return cachedKinds;
}

/**
 * The aws kind for a Cloud Control type, or undefined. With no kind set (no
 * generated registry) every well-formed CloudFormation type maps, which is
 * what the rest of the lexicon assumes before `chant generate` has run.
 */
export function awsKindForListedType(listedType: string, kinds: ReadonlySet<string> | null = generatedKinds()): string | undefined {
  if (!CFN_TYPE.test(listedType)) return undefined;
  if (kinds && !kinds.has(listedType)) return undefined;
  return listedType;
}

/** The inverse, for tests and for a reader naming what to list: the same name. */
export function awsListedTypeForKind(kind: string): string {
  return kind;
}

export const awsListedTypes: ListedTypeMapping = {
  substrate: "aws",
  kindFor: (listedType) => awsKindForListedType(listedType),
};
