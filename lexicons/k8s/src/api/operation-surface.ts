/**
 * Reading the generated operation surface — chant #1074.
 *
 * The table itself is written by `chant generate` (see
 * `../codegen/generate-operations.ts`); this is the runtime side, and it is
 * deliberately the only place in the lexicon that knows how an entity type
 * becomes an API address.
 *
 * Loading mirrors the serializer's handling of `lexicon-k8s.json`: a `require`
 * behind a try/catch, so a checkout that has not run `chant generate` yet
 * degrades to derivation rather than failing to import. Nothing here touches
 * the filesystem at module load (chant #1081) — the first call does, and caches.
 */

import { createRequire } from "module";

const require = createRequire(import.meta.url);

/** One resource's addressing information, as `chant generate` emits it. */
export interface K8sOperationDescriptor {
  /** chant entity type, e.g. `K8s::Apps::Deployment`. */
  entityType: string;
  /** `v1`, `apps/v1`, `ray.io/v1` — what goes in a manifest. */
  apiVersion: string;
  /** `Deployment`, `RayCluster`. */
  kind: string;
  /** Plural path segment the schema documents, e.g. `deployments`. */
  plural: string;
  scope: "Namespaced" | "Cluster";
  /** Verbs the schema documents for the named-object path. */
  verbs: string[];
}

/** The generated file's shape: entity type → descriptor. */
export type K8sOperationTable = Record<string, K8sOperationDescriptor>;

/**
 * Fallback plural for a kind whose schema documented no named-object path.
 *
 * Kubernetes' own pluralization for resource names is the lowercased kind with
 * English plural rules applied — the three cases `kubectl` implements. It only
 * fires for kinds the OpenAPI paths do not cover, and the live client overrides
 * it from the cluster's discovery regardless, so it is a placeholder rather
 * than a second table to maintain.
 */
export function pluralizeKind(kind: string): string {
  const lower = kind.toLowerCase();
  if (/(s|x|z|ch|sh)$/.test(lower)) return `${lower}es`;
  if (/[^aeiou]y$/.test(lower)) return `${lower.slice(0, -1)}ies`;
  return `${lower}s`;
}

/**
 * Well-known API group → apiVersion, for a checkout with no generated table.
 * Deliberately the same list the serializer falls back to, so a lexicon
 * running without generated artifacts addresses what it serializes.
 */
const FALLBACK_GROUP_VERSIONS: Record<string, string> = {
  Core: "v1",
  Apps: "apps/v1",
  Batch: "batch/v1",
  Networking: "networking.k8s.io/v1",
  Policy: "policy/v1",
  Rbac: "rbac.authorization.k8s.io/v1",
  Storage: "storage.k8s.io/v1",
  Autoscaling: "autoscaling/v2",
  Admissionregistration: "admissionregistration.k8s.io/v1",
};

let cached: K8sOperationTable | null = null;

/** The generated table, loaded once. Empty when nothing has been generated. */
export function operationTable(): K8sOperationTable {
  if (cached) return cached;
  try {
    cached = require("../generated/operations.json") as K8sOperationTable;
  } catch {
    cached = {};
  }
  return cached;
}

/** Reset the memoized table. Tests only. */
export function resetOperationTableForTests(): void {
  cached = null;
}

/**
 * How to address a declared entity type over the API.
 *
 * Returns undefined only for a type the generated surface does not carry and
 * whose `K8s::<Group>::<Kind>` shape yields no known group — which is the one
 * case where chant genuinely does not know what to ask for. Every generated
 * resource type, including every CRD baked in at generation time, is in the
 * table; that is the difference between this and the twenty-entry map it
 * replaces.
 */
export function operationFor(entityType: string): K8sOperationDescriptor | undefined {
  const table = operationTable();
  const found = table[entityType];
  if (found) return found;
  return deriveOperation(entityType);
}

/**
 * Last-resort derivation from the entity type's own shape, for a lexicon
 * running without generated artifacts. It cannot invent an API group it has
 * never seen, so an unknown group returns undefined rather than a guess that
 * would address the wrong thing.
 */
export function deriveOperation(entityType: string): K8sOperationDescriptor | undefined {
  const parts = entityType.split("::");
  if (parts.length !== 3 || parts[0] !== "K8s") return undefined;
  const apiVersion = FALLBACK_GROUP_VERSIONS[parts[1]];
  if (!apiVersion) return undefined;
  return {
    entityType,
    apiVersion,
    kind: parts[2],
    plural: pluralizeKind(parts[2]),
    scope: "Namespaced",
    verbs: [],
  };
}

/** Every entity type the generated surface can address. */
export function addressableEntityTypes(): string[] {
  return Object.keys(operationTable()).sort();
}
