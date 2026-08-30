/**
 * Kubernetes YAML serializer.
 *
 * Converts Chant declarables to multi-document K8s YAML output with
 * apiVersion, kind, metadata, and spec structure.
 */

import { createRequire } from "module";
import type { Declarable } from "@intentius/chant/declarable";
import { isPropertyDeclarable, isResourceDeclarable } from "@intentius/chant/declarable";
import type { Serializer, SerializerResult, SerializeContext } from "@intentius/chant/serializer";
import { ownershipEntries, LABEL_OWNERSHIP_KEYS } from "@intentius/chant/ownership";
import type { LexiconOutput } from "@intentius/chant/lexicon-output";
import { walkValue, type SerializerVisitor } from "@intentius/chant/serializer-walker";
import { emitYAML } from "@intentius/chant/yaml";
import { isDefaultLabels, isDefaultAnnotations, type DefaultLabels, type DefaultAnnotations } from "./default-labels";
import { isRenderedManifestEntity } from "./manifest-entity";
import { isEncryptedSecretFileEntity } from "./sops/entity";

const require = createRequire(import.meta.url);

/**
 * K8s resource kinds whose properties live directly on the manifest
 * (not nested under `spec`). These types use `data`, `stringData`,
 * or have no spec field at all.
 */
const SPECLESS_TYPES = new Set([
  "ConfigMap",
  "Secret",
  "Namespace",
  "ServiceAccount",
  "ClusterRole",
  "ClusterRoleBinding",
  "Role",
  "RoleBinding",
  "StorageClass",
  "PersistentVolume",
  "APIService",
]);

/**
 * GVK mapping entry — loaded from generated lexicon-k8s.json.
 */
interface GVKEntry {
  resourceType: string;
  kind: "resource" | "property";
  apiVersion?: string;
  gvkKind?: string;
}

let cachedGVKMap: Record<string, GVKEntry> | null = null;

function getGVKMap(): Record<string, GVKEntry> {
  if (cachedGVKMap) return cachedGVKMap;
  try {
    cachedGVKMap = require("./generated/lexicon-k8s.json") as Record<string, GVKEntry>;
  } catch {
    cachedGVKMap = {};
  }
  return cachedGVKMap!;
}

/**
 * Resolve entityType to apiVersion and kind.
 */
function resolveGVK(entityType: string): { apiVersion: string; kind: string } | null {
  const gvkMap = getGVKMap();

  // Search for matching entry by resourceType
  for (const entry of Object.values(gvkMap)) {
    if (entry.resourceType === entityType && entry.apiVersion && entry.gvkKind) {
      return { apiVersion: entry.apiVersion, kind: entry.gvkKind };
    }
  }

  // Fallback: derive from entity type string (K8s::Group::Kind → group/v1, Kind)
  return deriveGVKFromType(entityType);
}

/**
 * Well-known K8s API group → apiVersion mappings for fallback when
 * the generated lexicon JSON is not available.
 */
const API_GROUP_VERSIONS: Record<string, string> = {
  Core: "v1",
  Apps: "apps/v1",
  Batch: "batch/v1",
  Networking: "networking.k8s.io/v1",
  Policy: "policy/v1",
  Rbac: "rbac.authorization.k8s.io/v1",
  Storage: "storage.k8s.io/v1",
  Autoscaling: "autoscaling/v2",
  Admissionregistration: "admissionregistration.k8s.io/v1",
  GKE: "cloud.google.com/v1",
  NetworkingGKE: "networking.gke.io/v1",
  NetworkingGKEBeta: "networking.gke.io/v1beta1",
  // Common Kubernetes operator CRDs
  CertManager: "cert-manager.io/v1",
  ExternalSecrets: "external-secrets.io/v1",
  Monitoring: "monitoring.coreos.com/v1",
  // KubeRay operator CRDs
  Ray: "ray.io/v1",
};

function deriveGVKFromType(entityType: string): { apiVersion: string; kind: string } | null {
  // Format: K8s::Group::Kind
  const parts = entityType.split("::");
  if (parts.length !== 3 || parts[0] !== "K8s") return null;

  const group = parts[1];
  const kind = parts[2];
  const apiVersion = API_GROUP_VERSIONS[group];

  if (!apiVersion) return null;
  return { apiVersion, kind };
}

/**
 * The name a resource gets when it does not declare one: the logical name,
 * kebab-cased. Shared with the manifest builder below so a reference and the
 * thing it references cannot derive different names (#1493).
 */
function derivedName(logicalName: string): string {
  return logicalName.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

/**
 * What a cross-resource reference resolves to on this substrate (#1493).
 *
 * Kubernetes YAML has no deploy-time reference mechanism — no `!Ref`, no
 * `Fn::GetAtt`. Whatever a reference is going to mean has to be resolved here,
 * before serialization, or it means nothing at all.
 *
 * This used to return the *logical* name for every attribute, so
 * `claimName: pgClaim.name` emitted `claimName: pgClaim` and the manifest
 * named a resource that does not exist. It applied cleanly and failed on the
 * cluster, which is the failure this whole system exists to remove. The
 * lexicon's own plugin comment already described the intended behaviour —
 * "resolves to metadata.name" — so this brings the code to the documentation
 * rather than the other way round.
 *
 * `uid` is refused rather than resolved: a UID is assigned by the API server
 * at admission, so no build-time value exists and any string emitted here
 * would be a fabrication.
 */
function resolveK8sAttr(entity: Declarable | undefined, logicalName: string, attr: string): unknown {
  if (attr === "uid") {
    throw new Error(
      `Cannot reference "${logicalName}.uid": a Kubernetes UID is assigned by the API server at ` +
        `admission, so it has no build-time value. Reference .name, or carry the UID at runtime ` +
        `with fieldRef: { fieldPath: "metadata.uid" }.`,
    );
  }

  const metadata =
    entity && isResourceDeclarable(entity) && typeof entity.props === "object" && entity.props !== null
      ? ((entity.props as Record<string, unknown>).metadata as Record<string, unknown> | undefined)
      : undefined;

  if (attr === "name") {
    // Same fallback the manifest builder applies, so a reference to a resource
    // that declares no name still resolves to the name it will actually get.
    const declared = metadata?.name;
    return typeof declared === "string" && declared.length > 0 ? declared : derivedName(logicalName);
  }

  if (attr === "namespace") {
    const ns = metadata?.namespace;
    if (typeof ns === "string" && ns.length > 0) return ns;
    throw new Error(
      `Cannot reference "${logicalName}.namespace": it declares no metadata.namespace, and the ` +
        `namespace a manifest lands in is decided at apply time (kubectl -n, or the context's ` +
        `default). Set metadata.namespace on "${logicalName}" if the reference needs to be stable.`,
    );
  }

  throw new Error(
    `Cannot reference "${logicalName}.${attr}": the k8s lexicon resolves .name and .namespace at ` +
      `build time, and Kubernetes YAML has no way to express any other attribute reference.`,
  );
}

/**
 * K8s visitor for the generic serializer walker.
 */
function k8sVisitor(entityNames: Map<Declarable, string>): SerializerVisitor {
  // name → entity, so an AttrRef can reach the resource it points at. The
  // walker hands the visitor a logical name, not the Declarable.
  const byName = new Map<string, Declarable>();
  for (const [entity, name] of entityNames) byName.set(name, entity);

  return {
    attrRef: (name, attr) => resolveK8sAttr(byName.get(name), name, attr),
    resourceRef: (name) => name,
    propertyDeclarable: (entity, walk) => {
      if (!isResourceDeclarable(entity) || typeof entity.props !== "object" || entity.props === null) {
        return undefined;
      }
      const props = entity.props as Record<string, unknown>;
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(props)) {
        if (value !== undefined) {
          result[key] = walk(value);
        }
      }
      return Object.keys(result).length > 0 ? result : undefined;
    },
  };
}

/**
 * Convert a value to YAML-compatible form using the walker.
 */
function toYAMLValue(value: unknown, entityNames: Map<Declarable, string>): unknown {
  return walkValue(value, entityNames, k8sVisitor(entityNames));
}

/**
 * Kubernetes YAML serializer implementation.
 */
export const k8sSerializer: Serializer = {
  name: "k8s",
  rulePrefix: "WK8",
  // The Argo CD and Flux checks are distinct product surfaces this lexicon
  // covers, and their ids are published — renaming them would break every
  // `chant-disable ARGO001` already written (#1349).
  extraRulePrefixes: ["ARGO", "FLUX"],

  serialize(
    entities: Map<string, Declarable>,
    _outputs?: LexiconOutput[],
    context?: SerializeContext,
  ): string | SerializerResult {
    // Build reverse map: entity → name
    const entityNames = new Map<Declarable, string>();
    for (const [name, entity] of entities) {
      entityNames.set(entity, name);
    }

    // Collect default labels and annotations. Ownership markers are stamped as
    // labels, so they seed defaultLabelEntries and flow through the same merge
    // (explicit resource labels still win).
    let defaultLabelEntries: Record<string, unknown> = context?.ownership
      ? { ...ownershipEntries(LABEL_OWNERSHIP_KEYS, context.ownership) }
      : {};
    let defaultAnnotationEntries: Record<string, unknown> = {};

    for (const [, entity] of entities) {
      if (isDefaultLabels(entity)) {
        defaultLabelEntries = { ...defaultLabelEntries, ...(entity as DefaultLabels).labels };
      }
      if (isDefaultAnnotations(entity)) {
        defaultAnnotationEntries = { ...defaultAnnotationEntries, ...(entity as DefaultAnnotations).annotations };
      }
    }

    const namespaceDocs: string[] = [];
    const otherDocs: string[] = [];
    /** Sidecar files — committed ciphertext, copied byte-for-byte. */
    const files: Record<string, string> = {};
    /** Basenames within `files` that must never be JSON.parse round-tripped (chant#1937). */
    const verbatimFiles: string[] = [];
    const warnings: string[] = [];

    for (const [name, entity] of entities) {
      if (isPropertyDeclarable(entity)) continue;
      if (isDefaultLabels(entity) || isDefaultAnnotations(entity)) continue;

      // Committed SOPS ciphertext (epic lex00/iac-cd-bench#6) leaves as a
      // SIDECAR and never as a document in the primary output. That is the
      // load-bearing line: chant's appliers read the primary output, so an
      // undecrypted Secret cannot reach a cluster through them. The bytes are
      // copied exactly as committed — no re-emit, no label merge, no
      // ownership stamp — because re-serializing would break the MAC the
      // `sops` block carries over the plaintext.
      if (isEncryptedSecretFileEntity(entity)) {
        const existing = files[entity.filename];
        if (existing !== undefined && existing !== entity.text) {
          warnings.push(
            `k8s: two committed-encrypted secrets emit the same sidecar filename ` +
              `"${entity.filename}" — the second (${entity.sourcePath}) wins`,
          );
        }
        files[entity.filename] = entity.text;
        if (!verbatimFiles.includes(entity.filename)) verbatimFiles.push(entity.filename);
        continue;
      }

      // A kustomize build root's document (#1548 piece 3) is render-final:
      // the overlay decided every field, so the props ARE the manifest and
      // the spec-inference heuristics below (built for typed declarables)
      // must not reshape it — a doc whose top-level fields aren't `spec`
      // (webhooks, rules on a CRD instance) would otherwise be re-nested.
      // It still gets the exact default-label/annotation merge every
      // discovered resource gets, which is what stamps ownership on it.
      if (isRenderedManifestEntity(entity)) {
        const manifest = { ...entity.props };
        const metadata = { ...((manifest.metadata as Record<string, unknown> | undefined) ?? {}) };
        if (Object.keys(defaultLabelEntries).length > 0) {
          metadata.labels = { ...defaultLabelEntries, ...((metadata.labels ?? {}) as Record<string, unknown>) };
        }
        if (Object.keys(defaultAnnotationEntries).length > 0) {
          metadata.annotations = {
            ...defaultAnnotationEntries,
            ...((metadata.annotations ?? {}) as Record<string, unknown>),
          };
        }
        manifest.metadata = metadata;
        const yamlDoc = emitK8sManifest(manifest);
        if (manifest.kind === "Namespace") {
          namespaceDocs.push(yamlDoc);
        } else {
          otherDocs.push(yamlDoc);
        }
        continue;
      }

      const entityType = (entity as unknown as Record<string, unknown>).entityType as string;
      const gvk = resolveGVK(entityType);
      if (!gvk) continue;

      const props = toYAMLValue(
        isResourceDeclarable(entity) ? entity.props : undefined,
        entityNames,
      ) as Record<string, unknown> | undefined;

      if (!props) continue;

      // Build the K8s manifest structure
      const manifest: Record<string, unknown> = {
        apiVersion: gvk.apiVersion,
        kind: gvk.kind,
      };

      // Build metadata
      const metadata: Record<string, unknown> = props.metadata as Record<string, unknown> ?? {};
      if (!metadata.name) {
        metadata.name = derivedName(name);
      }

      // Merge default labels
      if (Object.keys(defaultLabelEntries).length > 0) {
        const existingLabels = (metadata.labels ?? {}) as Record<string, unknown>;
        metadata.labels = { ...defaultLabelEntries, ...existingLabels };
      }

      // Merge default annotations
      if (Object.keys(defaultAnnotationEntries).length > 0) {
        const existingAnnotations = (metadata.annotations ?? {}) as Record<string, unknown>;
        metadata.annotations = { ...defaultAnnotationEntries, ...existingAnnotations };
      }

      manifest.metadata = metadata;

      // Properties that always belong at the manifest root, never inside
      // spec. apiVersion/kind allow consumers to override the gvk-derived
      // defaults (the "CRD wrapper" trick used to declare arbitrary K8s
      // resources via a generic Declarable class). rules/subjects/roleRef
      // are the top-level fields for RBAC kinds. data/stringData are for
      // ConfigMap/Secret. binaryData covers ConfigMap binary entries.
      const TOP_LEVEL_PROPS = new Set([
        "apiVersion",
        "kind",
        "rules",
        "subjects",
        "roleRef",
        "data",
        "stringData",
        "binaryData",
        "type",
        "immutable",
        "automountServiceAccountToken",
        "secrets",
        "imagePullSecrets",
      ]);

      // The remaining properties go under spec (or directly on the manifest for certain types)
      if (SPECLESS_TYPES.has(gvk.kind)) {
        // These types have their data directly on the manifest (data, stringData, etc.)
        for (const [key, value] of Object.entries(props)) {
          if (key !== "metadata") {
            manifest[key] = value;
          }
        }
      } else if (props.spec !== undefined) {
        // If spec is already set, use it directly
        manifest.spec = props.spec;
        for (const [key, value] of Object.entries(props)) {
          if (key !== "metadata" && key !== "spec") {
            manifest[key] = value;
          }
        }
      } else {
        // Place remaining props under spec — except known top-level fields
        // (apiVersion/kind for CRD-wrapper overrides; rules/subjects for RBAC).
        const spec: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(props)) {
          if (key === "metadata") continue;
          if (TOP_LEVEL_PROPS.has(key)) {
            manifest[key] = value;
          } else {
            spec[key] = value;
          }
        }
        if (Object.keys(spec).length > 0) {
          manifest.spec = spec;
        }
      }

      // Emit as YAML — sort Namespaces first so kubectl apply succeeds
      const yamlDoc = emitK8sManifest(manifest);
      if (gvk.kind === "Namespace") {
        namespaceDocs.push(yamlDoc);
      } else {
        otherDocs.push(yamlDoc);
      }
    }

    const primary = [...namespaceDocs, ...otherDocs].join("\n---\n");
    // A bare string when there is nothing extra to write, so the common case
    // stays byte-identical to what every existing consumer already reads.
    if (Object.keys(files).length === 0 && warnings.length === 0) return primary;
    return {
      primary,
      files,
      ...(verbatimFiles.length > 0 ? { verbatimFiles } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  },
};

/**
 * Emit a K8s manifest object as YAML.
 * Preserves key ordering: apiVersion, kind, metadata, spec, then rest.
 */
/**
 * Emit a key-value pair as YAML. Scalars get ` value` suffix; objects get
 * block-style indented below the key.
 */
function emitKeyValue(key: string, value: unknown): string {
  const yamlStr = emitYAML(value, 1);
  // If the YAML starts with a newline, it's a block value (object/array)
  if (yamlStr.startsWith("\n")) {
    return `${key}:${yamlStr}`;
  }
  return `${key}: ${yamlStr}`;
}

function emitK8sManifest(manifest: Record<string, unknown>): string {
  const orderedKeys = ["apiVersion", "kind", "metadata", "spec"];
  const lines: string[] = [];

  // Emit ordered keys first
  for (const key of orderedKeys) {
    if (manifest[key] !== undefined) {
      lines.push(emitKeyValue(key, manifest[key]));
    }
  }

  // Emit remaining keys
  for (const [key, value] of Object.entries(manifest)) {
    if (!orderedKeys.includes(key) && value !== undefined) {
      lines.push(emitKeyValue(key, value));
    }
  }

  return lines.join("\n") + "\n";
}
