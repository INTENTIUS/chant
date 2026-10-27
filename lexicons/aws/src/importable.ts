/**
 * Which CloudFormation types chant can adopt into a stack with an IMPORT
 * change set (#4536; ruled on INTENTIUS/choudoufu#2284 Q5, 2026-10-26).
 *
 * A registry type is importable when its schema has `create` and `read`
 * handlers, which codegen keeps in `lexicon-aws.json` as `handlers`. AWS
 * documents the exceptions on its "Resource type support" page
 * (https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/resource-import-supported-resources.html),
 * and the two short lists below are those exceptions, compared on 2026-10-26
 * against the pinned spec (sha256:398259716cca…): one legacy type with no
 * handlers that the page marks importable, and three types with create and
 * read handlers that the page marks not importable.
 *
 * Adoption also needs to write chant's markers after the import, as a
 * tags-only UPDATE. A type whose tags can only be set at create
 * (`tagging.tagUpdatable` false) is refused by {@link adoptionRefusal},
 * never replaced to mark it.
 */
import { createRequire } from "module";
import { moduleSourceUrl } from "@intentius/chant/module-source";

const require = createRequire(moduleSourceUrl(import.meta.url));

/** The slice of a `lexicon-aws.json` entry this module reads. */
export interface ImportabilityManifestEntry {
  resourceType: string;
  kind: string;
  handlers?: readonly string[];
  primaryIdentifier?: readonly string[];
  tagging?: { taggable: boolean; tagOnCreate?: boolean; tagUpdatable: boolean; tagProperty?: string; tagShape?: "list" | "map" };
}

/** Legacy types (no handlers in the registry schema) that AWS documents as importable. */
export const LEGACY_IMPORTABLE_TYPES: ReadonlySet<string> = new Set(["AWS::IoTEvents::AlarmModel"]);

/** Types with create and read handlers that AWS documents as not importable. */
export const NOT_IMPORTABLE_TYPES: ReadonlySet<string> = new Set([
  "AWS::AppSync::GraphQLApi",
  "AWS::SES::ConfigurationSetEventDestination",
  "AWS::SageMaker::Endpoint",
]);

let cachedManifest: ReadonlyMap<string, ImportabilityManifestEntry> | undefined;

/** The generated registry keyed by type, or an empty map in a checkout that has not generated. */
export function importabilityManifest(): ReadonlyMap<string, ImportabilityManifestEntry> {
  if (cachedManifest) return cachedManifest;
  try {
    const manifest = require("./generated/lexicon-aws.json") as Record<string, ImportabilityManifestEntry>;
    cachedManifest = new Map(Object.values(manifest).filter((e) => e.kind === "resource").map((e) => [e.resourceType, e]));
  } catch {
    cachedManifest = new Map();
  }
  return cachedManifest;
}

/** Whether CloudFormation can import the type into a stack: create and read handlers, or AWS's hand list. */
export function isImportable(type: string, manifest: ReadonlyMap<string, ImportabilityManifestEntry> = importabilityManifest()): boolean {
  if (NOT_IMPORTABLE_TYPES.has(type)) return false;
  if (LEGACY_IMPORTABLE_TYPES.has(type)) return true;
  const handlers = manifest.get(type)?.handlers ?? [];
  return handlers.includes("create") && handlers.includes("read");
}

/**
 * Why chant refuses to adopt the type, or undefined when it can: not a
 * generated type, not importable, or tags that can only be set at create
 * (the marker UPDATE would replace the object). An untaggable type is
 * adopted on the stack's word alone; the caller says so in its review.
 */
export function adoptionRefusal(type: string, manifest: ReadonlyMap<string, ImportabilityManifestEntry> = importabilityManifest()): string | undefined {
  const entry = manifest.get(type);
  if (!entry && !LEGACY_IMPORTABLE_TYPES.has(type)) return `${type} is not a type this aws lexicon generated`;
  if (!isImportable(type, manifest)) {
    return NOT_IMPORTABLE_TYPES.has(type)
      ? `${type} is listed by AWS as not supporting resource import`
      : `${type} has no create and read handlers, so CloudFormation cannot import it`;
  }
  if (entry?.tagging?.taggable && entry.tagging.tagUpdatable === false) {
    return `${type}'s tags can only be set at create, so writing chant's markers would replace it`;
  }
  return undefined;
}
