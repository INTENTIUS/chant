/**
 * Cloud Asset Inventory's type names as gcp lexicon kinds (#4521).
 *
 * behold#1029 lists GCP through Cloud Asset `searchAllResources`, which
 * names each object by its asset type, `<service>.googleapis.com/<Type>`
 * (`storage.googleapis.com/Bucket`). The lexicon's kinds are
 * `GCP::<Service>::<Type>` (`GCP::Storage::Bucket`), resolved to Config
 * Connector kinds in ./describe-resources.ts. Most asset types map by rule:
 * the service's first label, capitalized, and the type unchanged. The rest
 * are a table, where the API's service name is not the lexicon's
 * (`sqladmin` is `Sql`) or the asset type is named differently
 * (`cloudfunctions.googleapis.com/CloudFunction` is `GCP::Cloudfunctions::Function`).
 *
 * The mapping says which kind would describe an asset type. Which asset types
 * Cloud Asset actually serves is the API's answer and is not checked here;
 * an asset type with no kind stays an unknown-kind node.
 *
 * A `searchAllResources` result is a summary (`name`, `assetType`,
 * `location`, `additionalAttributes`), not the service's REST resource the
 * deep reader reads (./deep-observe.ts), and no rule turns one into the
 * other. It is passed to the gcp hooks as returned, so their server-field
 * rules apply where the names agree and the summary's own fields stay.
 */
import { createRequire } from "module";
import { moduleSourceUrl } from "@intentius/chant/module-source";
import type { ListedTypeMapping } from "@intentius/chant/lifecycle/type-listing";

const require = createRequire(moduleSourceUrl(import.meta.url));

/** Asset-type services whose lexicon segment is not the service's first label, capitalized. */
const SERVICE_SEGMENTS: Readonly<Record<string, string>> = {
  "sqladmin.googleapis.com": "Sql",
  "cloudresourcemanager.googleapis.com": "Resourcemanager",
  "cloudkms.googleapis.com": "Kms",
  "file.googleapis.com": "Filestore",
  "bigtableadmin.googleapis.com": "Bigtable",
};

/** Asset types whose lexicon kind the rule does not give. */
const TYPE_KINDS: Readonly<Record<string, string>> = {
  "cloudfunctions.googleapis.com/CloudFunction": "GCP::Cloudfunctions::Function",
  "cloudfunctions.googleapis.com/Function": "GCP::Cloudfunctions2::Function",
  "iam.googleapis.com/Role": "GCP::Iam::CustomRole",
};

const ASSET_TYPE = /^([a-z0-9-]+)\.googleapis\.com\/([A-Za-z0-9]+)$/;

/** The kind the rule (and the tables) give an asset type, before any check that the lexicon has it. */
export function gcpKindByRule(assetType: string): string | undefined {
  const table = TYPE_KINDS[assetType];
  if (table) return table;
  const m = ASSET_TYPE.exec(assetType);
  if (!m) return undefined;
  const service = `${m[1]}.googleapis.com`;
  const segment = SERVICE_SEGMENTS[service] ?? m[1].charAt(0).toUpperCase() + m[1].slice(1);
  return `GCP::${segment}::${m[2]}`;
}

/** The asset type a kind answers to: the inverse of {@link gcpKindByRule}. */
export function gcpListedTypeForKind(kind: string): string | undefined {
  for (const [assetType, k] of Object.entries(TYPE_KINDS)) if (k === kind) return assetType;
  const parts = kind.split("::");
  if (parts.length !== 3 || parts[0] !== "GCP") return undefined;
  const [, segment, type] = parts;
  const service =
    Object.entries(SERVICE_SEGMENTS).find(([, s]) => s === segment)?.[0] ?? `${segment.toLowerCase()}.googleapis.com`;
  return `${service}/${type}`;
}

let cachedKinds: ReadonlySet<string> | null | undefined;

/** The resource kinds `chant generate` wrote, or null in a checkout that has not generated. */
function generatedKinds(): ReadonlySet<string> | null {
  if (cachedKinds !== undefined) return cachedKinds;
  try {
    const manifest = require("./generated/lexicon-gcp.json") as Record<string, { resourceType?: string; kind?: string }>;
    cachedKinds = new Set(
      Object.values(manifest)
        .filter((e) => e.kind === undefined || e.kind === "resource")
        .map((e) => e.resourceType)
        .filter((t): t is string => typeof t === "string"),
    );
  } catch {
    cachedKinds = null;
  }
  return cachedKinds;
}

/**
 * The gcp kind for an asset type, or undefined. The rule's answer must be a
 * kind the lexicon has; with no kind set (no generated registry) the rule's
 * answer stands.
 */
export function gcpKindForListedType(assetType: string, kinds: ReadonlySet<string> | null = generatedKinds()): string | undefined {
  const kind = gcpKindByRule(assetType);
  if (kind === undefined) return undefined;
  if (kinds && !kinds.has(kind)) return undefined;
  return kind;
}

export const gcpListedTypes: ListedTypeMapping = {
  substrate: "gcp",
  kindFor: (listedType) => gcpKindForListedType(listedType),
};
