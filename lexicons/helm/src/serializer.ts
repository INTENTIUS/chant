/**
 * Helm chart serializer.
 *
 * Converts Chant declarables into a complete Helm chart directory structure
 * returned as a SerializerResult with a files map:
 *
 *   Chart.yaml, values.yaml, values.schema.json, .helmignore,
 *   templates/_helpers.tpl, templates/<resource>.yaml, templates/NOTES.txt,
 *   templates/tests/test-connection.yaml
 *
 * The serializer detects `__helm_tpl` markers in walked values and emits
 * raw Go template expressions instead of YAML-quoting them. It also
 * detects `__helm_if` markers to wrap entire resources in conditionals.
 */

import type { Declarable } from "@intentius/chant/declarable";
import { isPropertyDeclarable } from "@intentius/chant/declarable";
import { INTRINSIC_MARKER } from "@intentius/chant/intrinsic";
import type { Serializer, SerializerResult } from "@intentius/chant/serializer";
import type { LexiconOutput } from "@intentius/chant/lexicon-output";
import { walkValue, type SerializerVisitor } from "@intentius/chant/serializer-walker";
import { HELM_TPL_KEY, HELM_IF_KEY, HELM_RANGE_KEY, HELM_WITH_KEY, RUNTIME_SLOT_KEY, type HelmConditional } from "./intrinsics";
import { generateHelpers } from "./helpers";

// ── GVK resolution for K8s resources ──────────────────────

/**
 * Well-known K8s API group → apiVersion mappings.
 * Used to resolve K8s entity types to apiVersion/kind for YAML emission.
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
};

function resolveK8sGVK(entityType: string): { apiVersion: string; kind: string } | null {
  const parts = entityType.split("::");
  if (parts.length !== 3 || parts[0] !== "K8s") return null;
  const group = parts[1];
  const kind = parts[2];
  const apiVersion = API_GROUP_VERSIONS[group];
  if (!apiVersion) return null;
  return { apiVersion, kind };
}

// ── Helm visitor ──────────────────────────────────────────

function helmVisitor(): SerializerVisitor {
  return {
    attrRef: (name, _attr) => name,
    resourceRef: (name) => name,
    propertyDeclarable: (entity, walk) => {
      if (!("props" in entity) || typeof entity.props !== "object" || entity.props === null) {
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

// ── YAML emission with Helm template support ──────────────

/**
 * Emit an else chain, detecting nested `__helm_if` markers to produce
 * `{{- else if <cond> }}` instead of `{{- else }}\n{{- if <cond> }}`.
 */
function emitElseChain(elseBody: unknown, indent: number): string {
  if (typeof elseBody === "object" && elseBody !== null && HELM_IF_KEY in (elseBody as Record<string, unknown>)) {
    const nested = elseBody as Record<string, unknown>;
    const nestedCond = nested[HELM_IF_KEY] as string;
    const nestedBody = nested.body;
    const nestedElse = nested.else;
    let result = `\n{{- else if ${nestedCond} }}\n${emitHelmYAML(nestedBody, indent)}`;
    if (nestedElse !== undefined) {
      result += emitElseChain(nestedElse, indent);
    }
    return result;
  }
  return `\n{{- else }}\n${emitHelmYAML(elseBody, indent)}`;
}

/**
 * Emit a YAML value, detecting __helm_tpl markers and emitting them
 * as raw Go template expressions.
 *
 * @param valuesContext - When true, HelmTpl intrinsics are emitted as empty
 *   string placeholders instead of raw Go template expressions. values.yaml
 *   is not processed as a Go template by Helm, so {{ .Values.x }} is invalid
 *   there. Actual values are provided via -f override files at deploy time.
 */
function emitHelmYAML(value: unknown, indent: number, valuesContext: boolean = false): string {
  const prefix = "  ".repeat(indent);

  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);

  // Detect HelmTpl / Intrinsic objects via INTRINSIC_MARKER before string check
  if (typeof value === "object" && value !== null && INTRINSIC_MARKER in value) {
    const tplObj = value as { toJSON(): unknown };
    if (valuesContext) {
      // In values.yaml context: emit empty placeholder — actual value comes from override files
      return "''";
    }
    const json = tplObj.toJSON() as Record<string, unknown>;
    if (typeof json === "object" && json !== null && HELM_TPL_KEY in json) {
      return json[HELM_TPL_KEY] as string;
    }
    return "''";
  }

  if (typeof value === "string") {
    // Check if this is a raw template expression that was already inlined
    if (value.startsWith("{{") && value.endsWith("}}")) {
      return value;
    }
    if (
      value === "" || value === "true" || value === "false" || value === "null" ||
      value === "yes" || value === "no" ||
      value.includes(": ") || value.includes("#") ||
      value.startsWith("*") || value.startsWith("&") || value.startsWith("!") ||
      value.startsWith("{") || value.startsWith("[") ||
      value.startsWith("'") || value.startsWith('"') || value.startsWith("$") ||
      /^\d/.test(value)
    ) {
      return `'${value.replace(/'/g, "''")}'`;
    }
    return value;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const lines: string[] = [];
    for (const item of value) {
      if (typeof item === "object" && item !== null && !Array.isArray(item)) {
        const entries = Object.entries(item as Record<string, unknown>);
        if (entries.length > 0) {
          const [firstKey, firstVal] = entries[0];
          const firstEmitted = emitHelmYAML(firstVal, indent + 2, valuesContext);
          if (firstEmitted.startsWith("\n")) {
            lines.push(`${prefix}- ${firstKey}:${firstEmitted}`);
          } else {
            lines.push(`${prefix}- ${firstKey}: ${firstEmitted}`);
          }
          for (let i = 1; i < entries.length; i++) {
            const [key, val] = entries[i];
            const emitted = emitHelmYAML(val, indent + 2, valuesContext);
            if (emitted.startsWith("\n")) {
              lines.push(`${prefix}  ${key}:${emitted}`);
            } else {
              lines.push(`${prefix}  ${key}: ${emitted}`);
            }
          }
        }
      } else {
        lines.push(`${prefix}- ${emitHelmYAML(item, indent + 1, valuesContext).trimStart()}`);
      }
    }
    return "\n" + lines.join("\n");
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;

    // Detect __helm_tpl marker → emit raw template expression (not valid in valuesContext)
    if (HELM_TPL_KEY in obj && typeof obj[HELM_TPL_KEY] === "string") {
      if (valuesContext) return "''";
      return obj[HELM_TPL_KEY] as string;
    }

    // Detect __helm_if marker → emit conditional block
    if (HELM_IF_KEY in obj) {
      const condition = obj[HELM_IF_KEY] as string;
      const body = obj.body;
      const elseBody = obj.else;
      let result = `{{- if ${condition} }}\n${emitHelmYAML(body, indent, valuesContext)}`;
      if (elseBody !== undefined) {
        result += emitElseChain(elseBody, indent);
      }
      result += "\n{{- end }}";
      return result;
    }

    // Detect __helm_range marker → emit range loop
    if (HELM_RANGE_KEY in obj) {
      const list = obj[HELM_RANGE_KEY] as string;
      const body = obj.body;
      return `{{- range ${list} }}\n${emitHelmYAML(body, indent, valuesContext)}\n{{- end }}`;
    }

    // Detect __helm_with marker → emit with scope
    if (HELM_WITH_KEY in obj) {
      const scope = obj[HELM_WITH_KEY] as string;
      const body = obj.body;
      return `{{- with ${scope} }}\n${emitHelmYAML(body, indent, valuesContext)}\n{{- end }}`;
    }

    const entries = Object.entries(obj);
    if (entries.length === 0) return "{}";
    const lines: string[] = [];
    for (const [key, val] of entries) {
      const emitted = emitHelmYAML(val, indent + 1, valuesContext);
      if (emitted.startsWith("\n")) {
        lines.push(`${prefix}${key}:${emitted}`);
      } else {
        lines.push(`${prefix}${key}: ${emitted}`);
      }
    }
    return "\n" + lines.join("\n");
  }

  return String(value);
}

/**
 * Emit a top-level key-value pair in Helm YAML.
 */
function emitKeyValue(key: string, value: unknown, valuesContext: boolean = false): string {
  const yamlStr = emitHelmYAML(value, 1, valuesContext);
  if (yamlStr.startsWith("\n")) {
    return `${key}:${yamlStr}`;
  }
  return `${key}: ${yamlStr}`;
}

// ── Serializer ────────────────────────────────────────────

/**
 * Specless K8s types whose properties live directly on the manifest.
 */
const SPECLESS_TYPES = new Set([
  "ConfigMap", "Secret", "Namespace", "ServiceAccount",
]);

/**
 * Convert a logical name to a kebab-case filename stem.
 */
function toFileName(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
    .toLowerCase();
}

/**
 * Generate Chart.yaml content from Helm::Chart entity props.
 */
function emitChartYaml(props: Record<string, unknown>): string {
  const orderedKeys = [
    "apiVersion", "name", "version", "kubeVersion", "description", "type",
    "keywords", "home", "sources", "icon", "maintainers", "deprecated",
    "annotations", "condition", "tags", "appVersion",
  ];
  const lines: string[] = [];

  for (const key of orderedKeys) {
    if (props[key] !== undefined) {
      lines.push(emitKeyValue(key, props[key]));
    }
  }

  for (const [key, val] of Object.entries(props)) {
    if (!orderedKeys.includes(key) && val !== undefined) {
      lines.push(emitKeyValue(key, val));
    }
  }

  return lines.join("\n") + "\n";
}

/**
 * Generate values.yaml content from Helm::Values entity props.
 * HelmTpl intrinsics are emitted as empty placeholders since values.yaml
 * is not processed as a Go template by Helm.
 */
function emitValuesYaml(props: Record<string, unknown>): string {
  if (Object.keys(props).length === 0) return "{}\n";
  const lines: string[] = [];
  for (const [key, val] of Object.entries(props)) {
    lines.push(emitKeyValue(key, val, true));
  }
  return lines.join("\n") + "\n";
}

// ── RuntimeSlot helpers ───────────────────────────────────

/**
 * Represents the tree structure built from runtime slot paths.
 * Leaves are description strings; branches are nested SlotTree objects.
 */
type SlotTree = { [key: string]: SlotTree | string };

/**
 * Collect all RuntimeSlot instances from a props tree.
 * Returns the path (as array of keys) and description for each slot.
 */
function collectRuntimeSlots(
  props: unknown,
  path: string[],
): { path: string[]; description: string }[] {
  const result: { path: string[]; description: string }[] = [];
  if (props === null || props === undefined) return result;

  if (typeof props === "object" && INTRINSIC_MARKER in (props as object)) {
    const json = (props as { toJSON(): unknown }).toJSON() as Record<string, unknown>;
    if (typeof json === "object" && json !== null && RUNTIME_SLOT_KEY in json) {
      result.push({ path, description: json[RUNTIME_SLOT_KEY] as string });
    }
    return result;
  }

  if (typeof props === "object" && !Array.isArray(props)) {
    for (const [key, value] of Object.entries(props as Record<string, unknown>)) {
      result.push(...collectRuntimeSlots(value, [...path, key]));
    }
  }

  return result;
}

/**
 * Build a nested tree from flat path+description pairs.
 */
function buildSlotTree(slots: { path: string[]; description: string }[]): SlotTree {
  const tree: SlotTree = {};
  for (const { path, description } of slots) {
    let node = tree;
    for (let i = 0; i < path.length - 1; i++) {
      const key = path[i];
      if (typeof node[key] !== "object") {
        node[key] = {};
      }
      node = node[key] as SlotTree;
    }
    node[path[path.length - 1]] = description;
  }
  return tree;
}

/**
 * Emit a slot tree as YAML lines with description comments before leaves.
 */
function emitSlotTreeYaml(tree: SlotTree, indent: number): string {
  const prefix = "  ".repeat(indent);
  const lines: string[] = [];
  for (const [key, value] of Object.entries(tree)) {
    if (typeof value === "string") {
      if (value) {
        lines.push(`${prefix}# ${value}`);
      }
      lines.push(`${prefix}${key}: ''`);
    } else {
      lines.push(`${prefix}${key}:`);
      const nested = emitSlotTreeYaml(value, indent + 1);
      if (nested) lines.push(nested);
    }
  }
  return lines.join("\n");
}

/**
 * Generate values-runtime-slots.yaml from collected RuntimeSlot instances.
 * Returns empty string if no slots found.
 */
function emitRuntimeSlotsYaml(slots: { path: string[]; description: string }[]): string {
  if (slots.length === 0) return "";
  const tree = buildSlotTree(slots);
  return "# Generated by chant — fill these in before running helm upgrade\n" +
    emitSlotTreeYaml(tree, 0) + "\n";
}

/**
 * Description inference — static map from common Helm value key names.
 */
const KEY_DESCRIPTIONS: Record<string, string> = {
  replicaCount: "Number of pod replicas",
  image: "Container image configuration",
  repository: "Image repository",
  tag: "Image tag (empty defaults to Chart.appVersion)",
  pullPolicy: "Image pull policy",
  port: "Service port number",
  enabled: "Whether this feature is enabled",
  resources: "Container resource requests and limits",
  service: "Kubernetes Service configuration",
  type: "Service type",
  ingress: "Ingress configuration",
  className: "Ingress class name",
  hosts: "Ingress host rules",
  tls: "Ingress TLS configuration",
  autoscaling: "Horizontal pod autoscaling configuration",
  minReplicas: "Minimum number of replicas",
  maxReplicas: "Maximum number of replicas",
  targetCPUUtilizationPercentage: "Target CPU utilization for autoscaling",
  targetMemoryUtilizationPercentage: "Target memory utilization for autoscaling",
  serviceAccount: "Service account configuration",
  create: "Whether to create the resource",
  name: "Resource name override",
  annotations: "Additional annotations",
  nodeSelector: "Node selector constraints",
  tolerations: "Pod tolerations",
  affinity: "Pod affinity rules",
  podSecurityContext: "Pod-level security context",
  securityContext: "Container-level security context",
  livenessProbe: "Liveness probe configuration",
  readinessProbe: "Readiness probe configuration",
  persistence: "Persistent storage configuration",
  size: "Storage size",
  storageClass: "Storage class name",
  config: "Application configuration",
  schedule: "Cron schedule expression",
  fullnameOverride: "Override the full release name",
  nameOverride: "Override the chart name",
};

/**
 * Enum detection — known string enums keyed by `parentKey.key` or just `key`.
 */
const KEY_ENUMS: Record<string, string[]> = {
  pullPolicy: ["Always", "IfNotPresent", "Never"],
  "service.type": ["ClusterIP", "NodePort", "LoadBalancer", "ExternalName"],
  "ingress.pathType": ["Prefix", "Exact", "ImplementationSpecific"],
  restartPolicy: ["Always", "OnFailure", "Never"],
  "updateStrategy.type": ["RollingUpdate", "Recreate"],
};

/**
 * Numeric constraints keyed by key name.
 */
const KEY_NUMERIC_CONSTRAINTS: Record<string, { minimum?: number; maximum?: number }> = {
  replicaCount: { minimum: 0 },
  port: { minimum: 1, maximum: 65535 },
  containerPort: { minimum: 1, maximum: 65535 },
  minReplicas: { minimum: 1 },
  maxReplicas: { minimum: 1 },
  targetCPUUtilizationPercentage: { minimum: 1, maximum: 100 },
  targetMemoryUtilizationPercentage: { minimum: 1, maximum: 100 },
};

/**
 * Generate values.schema.json from values defaults.
 */
function generateValuesSchema(props: Record<string, unknown>): string {
  function inferType(
    value: unknown,
    includeDefault: boolean = true,
    keyName?: string,
    parentKeyName?: string,
  ): Record<string, unknown> {
    if (value === null || value === undefined) return { type: "null" };

    if (typeof value === "boolean") {
      const schema: Record<string, unknown> = { type: "boolean" };
      if (includeDefault) schema.default = value;
      if (keyName && KEY_DESCRIPTIONS[keyName]) schema.description = KEY_DESCRIPTIONS[keyName];
      return schema;
    }

    if (typeof value === "number") {
      const schema: Record<string, unknown> = {
        type: Number.isInteger(value) ? "integer" : "number",
      };
      if (includeDefault) schema.default = value;
      if (keyName && KEY_DESCRIPTIONS[keyName]) schema.description = KEY_DESCRIPTIONS[keyName];
      if (keyName && KEY_NUMERIC_CONSTRAINTS[keyName]) {
        const constraints = KEY_NUMERIC_CONSTRAINTS[keyName];
        if (constraints.minimum !== undefined) schema.minimum = constraints.minimum;
        if (constraints.maximum !== undefined) schema.maximum = constraints.maximum;
      }
      return schema;
    }

    if (typeof value === "string") {
      const schema: Record<string, unknown> = { type: "string" };
      if (includeDefault && value !== "") schema.default = value;
      if (keyName && KEY_DESCRIPTIONS[keyName]) schema.description = KEY_DESCRIPTIONS[keyName];

      // Check enum — qualified key first, then bare key
      const qualifiedKey = parentKeyName ? `${parentKeyName}.${keyName}` : undefined;
      const enumValues = (qualifiedKey && KEY_ENUMS[qualifiedKey]) || (keyName && KEY_ENUMS[keyName]);
      if (enumValues) schema.enum = enumValues;

      return schema;
    }

    if (Array.isArray(value)) {
      const schema: Record<string, unknown> = {
        type: "array",
        items: value.length > 0 ? inferType(value[0], false) : {},
      };
      if (includeDefault && value.length > 0) schema.default = value;
      if (keyName && KEY_DESCRIPTIONS[keyName]) schema.description = KEY_DESCRIPTIONS[keyName];
      return schema;
    }

    if (typeof value === "object" && value !== null && INTRINSIC_MARKER in value) {
      // HelmTpl / Intrinsic — actual value provided via -f override; accept any type
      return {};
    }

    if (typeof value === "object") {
      const obj = value as Record<string, unknown>;
      const properties: Record<string, unknown> = {};
      const requiredFields: string[] = [];

      for (const [k, v] of Object.entries(obj)) {
        properties[k] = inferType(v, true, k, keyName);
        // Non-null, non-empty-string defaults suggest the field is expected
        if (v !== null && v !== undefined && v !== "" && v !== false) {
          requiredFields.push(k);
        }
      }

      const schema: Record<string, unknown> = {
        type: "object",
        properties,
      };
      if (keyName && KEY_DESCRIPTIONS[keyName]) schema.description = KEY_DESCRIPTIONS[keyName];
      if (requiredFields.length > 0) {
        schema.required = requiredFields;
      }
      return schema;
    }

    return {};
  }

  const topLevel = inferType(props, false, undefined, undefined) as Record<string, unknown>;
  return JSON.stringify(
    { $schema: "http://json-schema.org/draft-07/schema#", ...topLevel },
    null,
    2,
  ) + "\n";
}

/**
 * Emit a K8s resource as a Helm template YAML file.
 */
function emitK8sTemplate(
  name: string,
  entityType: string,
  props: Record<string, unknown>,
  entityNames: Map<Declarable, string>,
  hookAnnotations?: Record<string, string>,
): string {
  let gvk = resolveK8sGVK(entityType);

  // Fallback: extract apiVersion/kind from props for CRD-based resources
  if (!gvk && props.apiVersion && props.kind) {
    gvk = {
      apiVersion: props.apiVersion as string,
      kind: props.kind as string,
    };
  }
  if (!gvk) return "";

  const walked = walkValue(props, entityNames, helmVisitor()) as Record<string, unknown>;
  if (!walked) return "";

  const manifest: Record<string, unknown> = {
    apiVersion: gvk.apiVersion,
    kind: gvk.kind,
  };

  // Build metadata
  const metadata: Record<string, unknown> = walked.metadata as Record<string, unknown> ?? {};
  if (!metadata.name) {
    metadata.name = toFileName(name);
  }

  // Add hook annotations
  if (hookAnnotations) {
    const existing = (metadata.annotations ?? {}) as Record<string, unknown>;
    metadata.annotations = { ...existing, ...hookAnnotations };
  }

  manifest.metadata = metadata;

  // Build spec / specless body
  if (SPECLESS_TYPES.has(gvk.kind)) {
    for (const [key, value] of Object.entries(walked)) {
      if (key !== "metadata") manifest[key] = value;
    }
  } else if (walked.spec !== undefined) {
    manifest.spec = walked.spec;
    for (const [key, value] of Object.entries(walked)) {
      if (key !== "metadata" && key !== "spec") manifest[key] = value;
    }
  } else {
    const spec: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(walked)) {
      if (key !== "metadata") spec[key] = value;
    }
    if (Object.keys(spec).length > 0) manifest.spec = spec;
  }

  // Emit as YAML
  const orderedKeys = ["apiVersion", "kind", "metadata", "spec"];
  const lines: string[] = [];

  for (const key of orderedKeys) {
    if (manifest[key] !== undefined) {
      lines.push(emitKeyValue(key, manifest[key]));
    }
  }
  for (const [key, value] of Object.entries(manifest)) {
    if (!orderedKeys.includes(key) && value !== undefined) {
      lines.push(emitKeyValue(key, value));
    }
  }

  return lines.join("\n") + "\n";
}

/**
 * Generate .helmignore content.
 */
function emitHelmignore(): string {
  return `# Patterns to ignore when building packages.
.DS_Store
.git
.gitignore
.bzr
.bzrignore
.hg
.hgignore
.svn
*.swp
*.bak
*.tmp
*.orig
*~
.project
.idea
*.tmproj
.vscode
`;
}

// ── Conditional / intrinsic detection ──────────────────────

/**
 * Check if a value is a HelmConditional (If wrapper).
 */
function isHelmConditional(value: unknown): value is HelmConditional {
  if (typeof value !== "object" || value === null) return false;
  return INTRINSIC_MARKER in value && "condition" in value && "body" in value;
}

/**
 * Check if a value is a Declarable with an entityType.
 */
function hasEntityType(value: unknown): value is Record<string, unknown> & { entityType: string } {
  return typeof value === "object" && value !== null && "entityType" in value &&
    typeof (value as Record<string, unknown>).entityType === "string";
}

/**
 * Emit a Chart.yaml dependencies block from HelmDependency property entities.
 */
/**
 * Key mapping for dependency props that differ between JS and YAML.
 */
const DEP_KEY_MAP: Record<string, string> = {
  importValues: "import-values",
};

function emitDependencies(deps: Record<string, unknown>[]): string {
  const lines: string[] = ["dependencies:"];
  for (const dep of deps) {
    const orderedKeys = ["name", "version", "repository", "condition", "tags", "enabled", "importValues", "alias"];
    const entries: [string, unknown][] = [];
    for (const key of orderedKeys) {
      if (dep[key] !== undefined) entries.push([DEP_KEY_MAP[key] ?? key, dep[key]]);
    }
    for (const [key, val] of Object.entries(dep)) {
      if (!orderedKeys.includes(key) && val !== undefined) entries.push([key, val]);
    }
    if (entries.length > 0) {
      const [firstKey, firstVal] = entries[0];
      lines.push(`  - ${firstKey}: ${emitHelmYAML(firstVal, 2).trimStart()}`);
      for (let i = 1; i < entries.length; i++) {
        const [key, val] = entries[i];
        const emitted = emitHelmYAML(val, 2);
        if (emitted.startsWith("\n")) {
          lines.push(`    ${key}:${emitted}`);
        } else {
          lines.push(`    ${key}: ${emitted}`);
        }
      }
    }
  }
  return lines.join("\n") + "\n";
}

/**
 * Emit a Chart.yaml maintainers block from HelmMaintainer property entities.
 */
function emitMaintainers(maintainers: Record<string, unknown>[]): string {
  const lines: string[] = ["maintainers:"];
  for (const m of maintainers) {
    const orderedKeys = ["name", "email", "url"];
    const entries: [string, unknown][] = [];
    for (const key of orderedKeys) {
      if (m[key] !== undefined) entries.push([key, m[key]]);
    }
    for (const [key, val] of Object.entries(m)) {
      if (!orderedKeys.includes(key) && val !== undefined) entries.push([key, val]);
    }
    if (entries.length > 0) {
      const [firstKey, firstVal] = entries[0];
      lines.push(`  - ${firstKey}: ${emitHelmYAML(firstVal, 2).trimStart()}`);
      for (let i = 1; i < entries.length; i++) {
        const [key, val] = entries[i];
        const emitted = emitHelmYAML(val, 2);
        if (emitted.startsWith("\n")) {
          lines.push(`    ${key}:${emitted}`);
        } else {
          lines.push(`    ${key}: ${emitted}`);
        }
      }
    }
  }
  return lines.join("\n") + "\n";
}

/**
 * Helm chart serializer implementation.
 */
export const helmSerializer: Serializer = {
  name: "helm",
  rulePrefix: "WHM",

  serialize(entities: Map<string, Declarable>, _outputs?: LexiconOutput[]): SerializerResult {
    const entityNames = new Map<Declarable, string>();
    for (const [name, entity] of entities) {
      entityNames.set(entity, name);
    }

    const files: Record<string, string> = {};

    let chartName = "my-chart";
    let chartProps: Record<string, unknown> = {};
    let valuesProps: Record<string, unknown> = {};
    let hasValues = false;
    let notesContent: string | undefined;
    const dependencies: Record<string, unknown>[] = [];
    const maintainers: Record<string, unknown>[] = [];
    const valuesOverrides: { filename: string; values: Record<string, unknown> }[] = [];

    // First pass: extract Helm-specific resources and collect metadata
    for (const [_name, entity] of entities) {
      if (!hasEntityType(entity)) continue;
      const entityType = entity.entityType;

      if (entityType === "Helm::Chart") {
        const props = (entity as Record<string, unknown>).props as Record<string, unknown>;
        chartProps = props ?? {};
        chartName = (chartProps.name as string) ?? chartName;
      } else if (entityType === "Helm::Values") {
        const props = (entity as Record<string, unknown>).props as Record<string, unknown>;
        valuesProps = props ?? {};
        hasValues = true;
      } else if (entityType === "Helm::Notes") {
        const props = (entity as Record<string, unknown>).props as Record<string, unknown>;
        notesContent = (props?.content as string) ?? "";
      } else if (entityType === "Helm::Dependency") {
        const props = (entity as Record<string, unknown>).props as Record<string, unknown>;
        if (props) dependencies.push(props);
      } else if (entityType === "Helm::Maintainer") {
        const props = (entity as Record<string, unknown>).props as Record<string, unknown>;
        if (props) maintainers.push(props);
      } else if (entityType === "Helm::CRD") {
        const props = (entity as Record<string, unknown>).props as Record<string, unknown>;
        if (props?.content) {
          const filename = (props.filename as string) ?? `${toFileName(_name)}.yaml`;
          files[`crds/${filename}`] = props.content as string;
        }
      } else if (entityType === "Helm::ValuesOverride") {
        const props = (entity as Record<string, unknown>).props as Record<string, unknown>;
        if (props?.filename && props?.values) {
          valuesOverrides.push({
            filename: props.filename as string,
            values: props.values as Record<string, unknown>,
          });
        }
      }
    }

    // Emit Chart.yaml
    if (!chartProps.apiVersion) chartProps.apiVersion = "v2";
    if (!chartProps.name) chartProps.name = chartName;
    if (!chartProps.version) chartProps.version = "0.1.0";
    if (!chartProps.type) chartProps.type = "application";

    // Inject collected maintainers into chart props for ordered emission
    if (maintainers.length > 0) {
      chartProps.maintainers = maintainers;
    }
    let chartYaml = emitChartYaml(chartProps);
    if (dependencies.length > 0) {
      chartYaml += emitDependencies(dependencies);
    }
    files["Chart.yaml"] = chartYaml;

    // Emit values.yaml
    files["values.yaml"] = emitValuesYaml(valuesProps);

    // Emit values-runtime-slots.yaml if any RuntimeSlot instances found
    if (hasValues) {
      const slots = collectRuntimeSlots(valuesProps, []);
      if (slots.length > 0) {
        files["values-runtime-slots.yaml"] = emitRuntimeSlotsYaml(slots);
      }
    }

    // Emit ValuesOverride files
    for (const override of valuesOverrides) {
      files[`${override.filename}.yaml`] = emitValuesYaml(override.values);
    }

    // Emit values.schema.json if we have values
    if (hasValues && Object.keys(valuesProps).length > 0) {
      files["values.schema.json"] = generateValuesSchema(valuesProps);
    }

    // Emit .helmignore
    files[".helmignore"] = emitHelmignore();

    // Emit _helpers.tpl
    files["templates/_helpers.tpl"] = generateHelpers({ chartName });

    // Second pass: emit K8s resources as templates
    for (const [name, entity] of entities) {
      const raw = entity as unknown;

      // Handle resource-level If(condition, resource) — HelmConditional wrapping a Declarable
      if (isHelmConditional(raw)) {
        const conditional = raw;
        const innerEntity = conditional.body;
        if (hasEntityType(innerEntity) && (innerEntity.entityType as string).startsWith("K8s::")) {
          const entityType = innerEntity.entityType as string;
          const props = (innerEntity as Record<string, unknown>).props as Record<string, unknown>;
          if (props) {
            const fileName = toFileName(name);
            const templateContent = emitK8sTemplate(name, entityType, props, entityNames);
            if (templateContent) {
              files[`templates/${fileName}.yaml`] =
                `{{- if ${conditional.condition} }}\n${templateContent}{{- end }}\n`;
            }
          }
        }
        continue;
      }

      if (!hasEntityType(raw)) continue;
      const entityType = (raw as Record<string, unknown>).entityType as string;

      if (isPropertyDeclarable(entity)) continue;

      // Skip Helm-specific resources (already handled)
      if (entityType.startsWith("Helm::")) continue;

      // Handle K8s resources
      if (entityType.startsWith("K8s::")) {
        const props = (raw as Record<string, unknown>).props as Record<string, unknown>;
        if (!props) continue;

        const fileName = toFileName(name);
        const templateContent = emitK8sTemplate(name, entityType, props, entityNames);
        if (templateContent) {
          files[`templates/${fileName}.yaml`] = templateContent;
        }
      }
    }

    // Handle Helm::Test resources
    for (const [name, entity] of entities) {
      if (!hasEntityType(entity)) continue;
      const entityType = (entity as Record<string, unknown>).entityType as string;
      if (entityType === "Helm::Test") {
        const props = (entity as Record<string, unknown>).props as Record<string, unknown>;
        if (!props) continue;

        const fileName = toFileName(name);

        // If the test has a nested K8s Declarable as `resource`, use it
        const resource = props.resource;
        if (hasEntityType(resource) && (resource.entityType as string).startsWith("K8s::")) {
          const resType = resource.entityType as string;
          const resProps = (resource as Record<string, unknown>).props as Record<string, unknown>;
          if (resProps) {
            const templateContent = emitK8sTemplate(name, resType, resProps, entityNames, { "helm.sh/hook": "test" });
            if (templateContent) {
              files[`templates/tests/${fileName}.yaml`] = templateContent;
            }
          }
        } else {
          // Treat props directly as Pod spec
          const templateContent = emitK8sTemplate(
            name,
            "K8s::Core::Pod",
            props,
            entityNames,
            { "helm.sh/hook": "test" },
          );
          if (templateContent) {
            files[`templates/tests/${fileName}.yaml`] = templateContent;
          }
        }
      }
    }

    // Handle Helm::Hook property wrappers (property kind, but we iterate all)
    for (const [name, entity] of entities) {
      if (!hasEntityType(entity)) continue;
      const entityType = (entity as Record<string, unknown>).entityType as string;
      if (entityType === "Helm::Hook") {
        const props = (entity as Record<string, unknown>).props as Record<string, unknown>;
        if (!props) continue;

        const hook = props.hook as string;
        const weight = props.weight as number | undefined;
        const deletePolicy = props.deletePolicy as string | undefined;
        const resource = props.resource as Declarable | undefined;

        if (resource && hasEntityType(resource)) {
          const resType = resource.entityType as string;
          const resProps = (resource as Record<string, unknown>).props as Record<string, unknown>;
          if (resProps && resType) {
            const hookAnnotations: Record<string, string> = {
              "helm.sh/hook": hook,
            };
            if (weight !== undefined) hookAnnotations["helm.sh/hook-weight"] = String(weight);
            if (deletePolicy) hookAnnotations["helm.sh/hook-delete-policy"] = deletePolicy;

            const fileName = toFileName(name);
            const templateContent = emitK8sTemplate(name, resType, resProps, entityNames, hookAnnotations);
            if (templateContent) {
              files[`templates/${fileName}.yaml`] = templateContent;
            }
          }
        }
      }
    }

    // Emit NOTES.txt
    if (notesContent) {
      files["templates/NOTES.txt"] = notesContent;
    }

    // Primary content is Chart.yaml (used as the build output identifier)
    return {
      primary: files["Chart.yaml"],
      files,
    };
  },
};
