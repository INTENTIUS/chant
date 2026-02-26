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
import { HELM_TPL_KEY, HELM_IF_KEY, HELM_RANGE_KEY, HELM_WITH_KEY, type HelmConditional } from "./intrinsics";
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
 * Emit a YAML value, detecting __helm_tpl markers and emitting them
 * as raw Go template expressions.
 */
function emitHelmYAML(value: unknown, indent: number): string {
  const prefix = "  ".repeat(indent);

  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);

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
          const firstEmitted = emitHelmYAML(firstVal, indent + 2);
          if (firstEmitted.startsWith("\n")) {
            lines.push(`${prefix}- ${firstKey}:${firstEmitted}`);
          } else {
            lines.push(`${prefix}- ${firstKey}: ${firstEmitted}`);
          }
          for (let i = 1; i < entries.length; i++) {
            const [key, val] = entries[i];
            const emitted = emitHelmYAML(val, indent + 2);
            if (emitted.startsWith("\n")) {
              lines.push(`${prefix}  ${key}:${emitted}`);
            } else {
              lines.push(`${prefix}  ${key}: ${emitted}`);
            }
          }
        }
      } else {
        lines.push(`${prefix}- ${emitHelmYAML(item, indent + 1).trimStart()}`);
      }
    }
    return "\n" + lines.join("\n");
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;

    // Detect __helm_tpl marker → emit raw template expression
    if (HELM_TPL_KEY in obj && typeof obj[HELM_TPL_KEY] === "string") {
      return obj[HELM_TPL_KEY] as string;
    }

    // Detect __helm_if marker → emit conditional block
    if (HELM_IF_KEY in obj) {
      const condition = obj[HELM_IF_KEY] as string;
      const body = obj.body;
      const elseBody = obj.else;
      let result = `{{- if ${condition} }}\n${emitHelmYAML(body, indent)}`;
      if (elseBody !== undefined) {
        result += `\n{{- else }}\n${emitHelmYAML(elseBody, indent)}`;
      }
      result += "\n{{- end }}";
      return result;
    }

    // Detect __helm_range marker → emit range loop
    if (HELM_RANGE_KEY in obj) {
      const list = obj[HELM_RANGE_KEY] as string;
      const body = obj.body;
      return `{{- range ${list} }}\n${emitHelmYAML(body, indent)}\n{{- end }}`;
    }

    // Detect __helm_with marker → emit with scope
    if (HELM_WITH_KEY in obj) {
      const scope = obj[HELM_WITH_KEY] as string;
      const body = obj.body;
      return `{{- with ${scope} }}\n${emitHelmYAML(body, indent)}\n{{- end }}`;
    }

    const entries = Object.entries(obj);
    if (entries.length === 0) return "{}";
    const lines: string[] = [];
    for (const [key, val] of entries) {
      const emitted = emitHelmYAML(val, indent + 1);
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
function emitKeyValue(key: string, value: unknown): string {
  const yamlStr = emitHelmYAML(value, 1);
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
  const orderedKeys = ["apiVersion", "name", "version", "appVersion", "description", "type"];
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
 */
function emitValuesYaml(props: Record<string, unknown>): string {
  if (Object.keys(props).length === 0) return "{}\n";
  const lines: string[] = [];
  for (const [key, val] of Object.entries(props)) {
    lines.push(emitKeyValue(key, val));
  }
  return lines.join("\n") + "\n";
}

/**
 * Generate values.schema.json from values defaults.
 */
function generateValuesSchema(props: Record<string, unknown>): string {
  function inferType(value: unknown, includeDefault: boolean = true): Record<string, unknown> {
    if (value === null || value === undefined) return { type: "null" };

    if (typeof value === "boolean") {
      const schema: Record<string, unknown> = { type: "boolean" };
      if (includeDefault) schema.default = value;
      return schema;
    }

    if (typeof value === "number") {
      const schema: Record<string, unknown> = {
        type: Number.isInteger(value) ? "integer" : "number",
      };
      if (includeDefault) schema.default = value;
      return schema;
    }

    if (typeof value === "string") {
      const schema: Record<string, unknown> = { type: "string" };
      if (includeDefault && value !== "") schema.default = value;
      return schema;
    }

    if (Array.isArray(value)) {
      const schema: Record<string, unknown> = {
        type: "array",
        items: value.length > 0 ? inferType(value[0], false) : {},
      };
      if (includeDefault && value.length > 0) schema.default = value;
      return schema;
    }

    if (typeof value === "object") {
      const obj = value as Record<string, unknown>;
      const properties: Record<string, unknown> = {};
      const requiredFields: string[] = [];

      for (const [k, v] of Object.entries(obj)) {
        properties[k] = inferType(v);
        // Non-null, non-empty-string defaults suggest the field is expected
        if (v !== null && v !== undefined && v !== "" && v !== false) {
          requiredFields.push(k);
        }
      }

      const schema: Record<string, unknown> = {
        type: "object",
        properties,
      };
      if (requiredFields.length > 0) {
        schema.required = requiredFields;
      }
      return schema;
    }

    return {};
  }

  const topLevel = inferType(props, false) as Record<string, unknown>;
  return JSON.stringify(
    { $schema: "https://json-schema.org/draft/2020-12/schema", ...topLevel },
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
  const gvk = resolveK8sGVK(entityType);
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
function emitDependencies(deps: Record<string, unknown>[]): string {
  const lines: string[] = ["dependencies:"];
  for (const dep of deps) {
    const orderedKeys = ["name", "version", "repository", "condition", "alias"];
    const entries: [string, unknown][] = [];
    for (const key of orderedKeys) {
      if (dep[key] !== undefined) entries.push([key, dep[key]]);
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
      }
    }

    // Emit Chart.yaml
    if (!chartProps.apiVersion) chartProps.apiVersion = "v2";
    if (!chartProps.name) chartProps.name = chartName;
    if (!chartProps.version) chartProps.version = "0.1.0";
    if (!chartProps.type) chartProps.type = "application";

    let chartYaml = emitChartYaml(chartProps);
    if (dependencies.length > 0) {
      chartYaml += emitDependencies(dependencies);
    }
    files["Chart.yaml"] = chartYaml;

    // Emit values.yaml
    files["values.yaml"] = emitValuesYaml(valuesProps);

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
