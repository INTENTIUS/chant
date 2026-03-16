/**
 * GitHub Actions Workflow JSON Schema parser.
 *
 * Parses the single workflow schema into multiple entity results — one
 * per resource/property entity (Workflow, Job, Step, triggers, etc.).
 */

import type { PropertyConstraints } from "@intentius/chant/codegen/json-schema";
import {
  extractConstraints as coreExtractConstraints,
  constraintsIsEmpty as coreConstraintsIsEmpty,
  primaryType,
  type JsonSchemaProperty,
} from "@intentius/chant/codegen/json-schema";

// ── Types ──────────────────────────────────────────────────────────

export type { PropertyConstraints };
export { coreConstraintsIsEmpty as constraintsIsEmpty };

export interface ParsedProperty {
  name: string;
  tsType: string;
  required: boolean;
  description?: string;
  enum?: string[];
  constraints: PropertyConstraints;
}

export interface ParsedPropertyType {
  name: string;
  defType: string;
  properties: ParsedProperty[];
}

export interface ParsedEnum {
  name: string;
  values: string[];
}

export interface ParsedResource {
  typeName: string;
  description?: string;
  properties: ParsedProperty[];
  attributes: Array<{ name: string; tsType: string }>;
  deprecatedProperties: string[];
}

export interface GitHubParseResult {
  resource: ParsedResource;
  propertyTypes: ParsedPropertyType[];
  enums: ParsedEnum[];
  isProperty?: boolean;
}

// ── Schema types ──────────────────────────────────────────────────

interface SchemaDefinition {
  type?: string | string[];
  description?: string;
  properties?: Record<string, SchemaProperty>;
  required?: string[];
  enum?: string[];
  oneOf?: SchemaProperty[];
  anyOf?: SchemaProperty[];
  $ref?: string;
  items?: SchemaProperty;
  const?: unknown;
  default?: unknown;
  additionalProperties?: boolean | SchemaProperty;
  patternProperties?: Record<string, SchemaProperty>;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
}

interface SchemaProperty extends SchemaDefinition {}

interface WorkflowSchema {
  definitions?: Record<string, SchemaDefinition>;
  properties?: Record<string, SchemaProperty>;
  patternProperties?: Record<string, SchemaProperty>;
  additionalProperties?: boolean | SchemaProperty;
  required?: string[];
  [key: string]: unknown;
}

// ── Entity extraction mapping ──────────────────────────────────────

const RESOURCE_ENTITIES: Array<{
  typeName: string;
  source: string;
  description?: string;
}> = [
  {
    typeName: "GitHub::Actions::Workflow",
    source: "root",
    description: "A GitHub Actions workflow definition",
  },
  {
    typeName: "GitHub::Actions::Job",
    source: "#/definitions/normalJob",
    description: "A standard CI job",
  },
  {
    typeName: "GitHub::Actions::ReusableWorkflowCallJob",
    source: "#/definitions/reusableWorkflowCallJob",
    description: "A reusable workflow call job (uses: workflow reference)",
  },
];

const PROPERTY_ENTITIES: Array<{
  typeName: string;
  source: string;
  description?: string;
}> = [
  { typeName: "GitHub::Actions::Step", source: "normalJob:steps:item", description: "A workflow step" },
  { typeName: "GitHub::Actions::Strategy", source: "normalJob:strategy", description: "Job strategy configuration" },
  { typeName: "GitHub::Actions::Permissions", source: "#/definitions/permissions", description: "Workflow or job permissions" },
  { typeName: "GitHub::Actions::Concurrency", source: "#/definitions/concurrency", description: "Concurrency control" },
  { typeName: "GitHub::Actions::Container", source: "#/definitions/container", description: "Container configuration for a job" },
  { typeName: "GitHub::Actions::Service", source: "service", description: "Service container configuration" },
  { typeName: "GitHub::Actions::Environment", source: "#/definitions/environment", description: "Deployment environment" },
  { typeName: "GitHub::Actions::Defaults", source: "#/definitions/defaults", description: "Default settings for all jobs" },
  { typeName: "GitHub::Actions::PushTrigger", source: "event:push", description: "Push event trigger" },
  { typeName: "GitHub::Actions::PullRequestTrigger", source: "event:pull_request", description: "Pull request event trigger" },
  { typeName: "GitHub::Actions::PullRequestTargetTrigger", source: "event:pull_request_target", description: "Pull request target event trigger" },
  { typeName: "GitHub::Actions::ScheduleTrigger", source: "event:schedule", description: "Schedule event trigger" },
  { typeName: "GitHub::Actions::WorkflowDispatchTrigger", source: "event:workflow_dispatch", description: "Workflow dispatch event trigger" },
  { typeName: "GitHub::Actions::WorkflowCallTrigger", source: "event:workflow_call", description: "Workflow call event trigger" },
  { typeName: "GitHub::Actions::WorkflowRunTrigger", source: "event:workflow_run", description: "Workflow run event trigger" },
  { typeName: "GitHub::Actions::RepositoryDispatchTrigger", source: "event:repository_dispatch", description: "Repository dispatch event trigger" },
  { typeName: "GitHub::Actions::WorkflowInput", source: "workflow_call:input", description: "Reusable workflow input parameter" },
  { typeName: "GitHub::Actions::WorkflowOutput", source: "workflow_call:output", description: "Reusable workflow output" },
  { typeName: "GitHub::Actions::WorkflowSecret", source: "workflow_call:secret", description: "Reusable workflow secret" },
];

// ── Parser ─────────────────────────────────────────────────────────

/**
 * Parse the GitHub Actions Workflow JSON Schema into multiple entity results.
 */
export function parseWorkflowSchema(data: string | Buffer): GitHubParseResult[] {
  const schema: WorkflowSchema = JSON.parse(typeof data === "string" ? data : data.toString("utf-8"));
  const results: GitHubParseResult[] = [];

  for (const entity of RESOURCE_ENTITIES) {
    const result = extractEntity(schema, entity, false);
    if (result) results.push(result);
  }

  for (const entity of PROPERTY_ENTITIES) {
    const result = extractEntity(schema, entity, true);
    if (result) {
      result.isProperty = true;
      results.push(result);
    }
  }

  return results;
}

function extractEntity(
  schema: WorkflowSchema,
  entity: { typeName: string; source: string; description?: string },
  isProperty: boolean,
): GitHubParseResult | null {
  const def = resolveSource(schema, entity.source);
  if (!def) {
    // Create minimal entry for entities we know exist but can't resolve from schema
    return {
      resource: {
        typeName: entity.typeName,
        description: entity.description,
        properties: buildFallbackProperties(entity.typeName),
        attributes: [],
        deprecatedProperties: [],
      },
      propertyTypes: [],
      enums: [],
    };
  }

  const objectDef = findObjectVariant(def, schema);
  const properties = objectDef?.properties
    ? parseProperties(objectDef.properties, new Set(objectDef.required ?? []), schema)
    : buildFallbackProperties(entity.typeName);

  const overrides = PROPERTY_OVERRIDES[entity.typeName];
  if (overrides) {
    for (const prop of properties) {
      if (overrides[prop.name]) {
        prop.tsType = overrides[prop.name];
      }
    }
  }

  return {
    resource: {
      typeName: entity.typeName,
      description: entity.description ?? objectDef?.description ?? def.description,
      properties,
      attributes: [],
      deprecatedProperties: mineDeprecatedProperties(properties),
    },
    propertyTypes: [],
    enums: [],
  };
}

// ── Source resolution ──────────────────────────────────────────────

function resolveSource(schema: WorkflowSchema, source: string): SchemaDefinition | null {
  if (source === "root") {
    return { properties: schema.properties, required: schema.required };
  }

  if (source.startsWith("#/definitions/")) {
    const defName = source.slice("#/definitions/".length);
    return schema.definitions?.[defName] ?? null;
  }

  // normalJob:property — resolve from normalJob definition
  if (source.startsWith("normalJob:")) {
    const segments = source.slice("normalJob:".length).split(":");
    let current: SchemaDefinition | null = schema.definitions?.normalJob ?? null;
    for (const seg of segments) {
      if (!current) return null;
      if (seg === "item") {
        if (!current.items) return null;
        return findObjectVariant(current.items, schema);
      }
      if (!current.properties?.[seg]) return null;
      const prop = current.properties[seg];
      current = prop.$ref ? resolveRef(prop.$ref, schema) : prop;
    }
    return current;
  }

  // event:name — resolve trigger event type
  if (source.startsWith("event:")) {
    const eventName = source.slice("event:".length);
    return resolveEventTrigger(schema, eventName);
  }

  // workflow_call:input/output/secret
  if (source.startsWith("workflow_call:")) {
    const part = source.slice("workflow_call:".length);
    return resolveWorkflowCallPart(schema, part);
  }

  // service — from container definitions
  if (source === "service") {
    // Services are containers with additional properties
    const containerDef = schema.definitions?.container;
    return containerDef ?? null;
  }

  return null;
}

function resolveEventTrigger(schema: WorkflowSchema, eventName: string): SchemaDefinition | null {
  // Try to find in definitions like eventObject, or under "on" properties
  const defName = `eventObject`;
  const eventDef = schema.definitions?.[defName];
  if (eventDef?.properties?.[eventName]) {
    const prop = eventDef.properties[eventName];
    if (prop.$ref) return resolveRef(prop.$ref, schema);
    return prop;
  }

  // Try direct definition names
  const directNames = [
    eventName,
    `${eventName}Event`,
  ];
  for (const name of directNames) {
    if (schema.definitions?.[name]) {
      return schema.definitions[name];
    }
  }

  return null;
}

function resolveWorkflowCallPart(schema: WorkflowSchema, part: string): SchemaDefinition | null {
  // Look in workflow_call trigger definition
  const wcDef = schema.definitions?.["eventObject"]?.properties?.workflow_call;
  if (!wcDef) return null;
  const resolved = wcDef.$ref ? resolveRef(wcDef.$ref, schema) : wcDef;
  if (!resolved) return null;

  const objectDef = findObjectVariant(resolved, schema);
  if (!objectDef?.properties) return null;

  const mapping: Record<string, string> = {
    input: "inputs",
    output: "outputs",
    secret: "secrets",
  };
  const propName = mapping[part] ?? part;
  const prop = objectDef.properties[propName];
  if (!prop) return null;

  // Get the "additionalProperties" or "patternProperties" to find the item schema
  const resolvedProp = prop.$ref ? resolveRef(prop.$ref, schema) : prop;
  if (!resolvedProp) return null;

  if (resolvedProp.patternProperties) {
    const first = Object.values(resolvedProp.patternProperties)[0];
    if (first) return first;
  }
  if (typeof resolvedProp.additionalProperties === "object") {
    return resolvedProp.additionalProperties;
  }

  return resolvedProp;
}

function resolveRef(ref: string, schema: WorkflowSchema): SchemaDefinition | null {
  const prefix = "#/definitions/";
  if (!ref.startsWith(prefix)) return null;
  const defName = ref.slice(prefix.length);
  return schema.definitions?.[defName] ?? null;
}

function findObjectVariant(def: SchemaDefinition, schema?: WorkflowSchema): SchemaDefinition | null {
  if (def.properties) return def;

  const variants = def.oneOf ?? def.anyOf;
  if (!variants) return null;

  const objectVariants: SchemaDefinition[] = [];
  for (const v of variants) {
    let resolved: SchemaDefinition = v;
    if (v.$ref && schema) {
      const r = resolveRef(v.$ref, schema);
      if (r) resolved = r;
      else continue;
    } else if (v.$ref) {
      continue;
    }
    if (resolved.properties) {
      objectVariants.push(resolved);
    }
  }

  if (objectVariants.length === 0) return null;
  if (objectVariants.length === 1) return objectVariants[0];

  // Merge: pick variant with most properties as base
  let best = objectVariants[0];
  let bestCount = Object.keys(best.properties!).length;
  for (let i = 1; i < objectVariants.length; i++) {
    const count = Object.keys(objectVariants[i].properties!).length;
    if (count > bestCount) {
      best = objectVariants[i];
      bestCount = count;
    }
  }

  const mergedProperties: Record<string, SchemaProperty> = { ...best.properties };
  for (const variant of objectVariants) {
    if (variant === best) continue;
    for (const [propName, propDef] of Object.entries(variant.properties!)) {
      if (!(propName in mergedProperties)) {
        mergedProperties[propName] = propDef;
      }
    }
  }

  return { ...best, properties: mergedProperties };
}

// ── Property parsing ──────────────────────────────────────────────

function parseProperties(
  properties: Record<string, SchemaProperty>,
  requiredSet: Set<string>,
  schema: WorkflowSchema,
): ParsedProperty[] {
  const result: ParsedProperty[] = [];
  for (const [name, prop] of Object.entries(properties)) {
    const tsType = resolvePropertyType(prop, schema);
    result.push({
      name,
      tsType,
      required: requiredSet.has(name),
      description: prop.description,
      enum: prop.enum,
      constraints: coreExtractConstraints(prop as JsonSchemaProperty),
    });
  }
  return result;
}

function resolvePropertyType(prop: SchemaProperty, schema: WorkflowSchema): string {
  if (!prop) return "any";

  if (prop.$ref) {
    const def = resolveRef(prop.$ref, schema);
    if (def) {
      if (def.enum && def.enum.length > 0 && !def.properties) {
        return def.enum.map((v) => JSON.stringify(v)).join(" | ");
      }
      if (def.type && !def.properties) {
        return jsonTypeToTs(primaryType(def.type));
      }
      if (def.properties) return "Record<string, any>";
    }
    return "any";
  }

  if (prop.enum && prop.enum.length > 0) {
    return prop.enum.map((v) => JSON.stringify(v)).join(" | ");
  }

  if (prop.oneOf || prop.anyOf) {
    const variants = prop.oneOf ?? prop.anyOf ?? [];
    const types = new Set<string>();
    for (const v of variants) {
      types.add(resolvePropertyType(v, schema));
    }
    const uniqueTypes = [...types].filter((t) => t !== "any");
    if (uniqueTypes.length === 0) return "any";
    if (uniqueTypes.length === 1) return uniqueTypes[0];
    return uniqueTypes.join(" | ");
  }

  const pt = primaryType(prop.type);
  switch (pt) {
    case "string": return "string";
    case "integer":
    case "number": return "number";
    case "boolean": return "boolean";
    case "array":
      if (prop.items) {
        const itemType = resolvePropertyType(prop.items, schema);
        if (itemType.includes(" | ")) return `(${itemType})[]`;
        return `${itemType}[]`;
      }
      return "any[]";
    case "object": return "Record<string, any>";
    default: return "any";
  }
}

function jsonTypeToTs(type: string): string {
  switch (type) {
    case "string": return "string";
    case "integer":
    case "number": return "number";
    case "boolean": return "boolean";
    case "array": return "any[]";
    case "object": return "Record<string, any>";
    default: return "any";
  }
}

// ── Property overrides ────────────────────────────────────────────

const PROPERTY_OVERRIDES: Record<string, Record<string, string>> = {
  "GitHub::Actions::Workflow": {
    on: "Record<string, any>",
    jobs: "Record<string, any>",
    permissions: "Permissions | string",
    concurrency: "Concurrency | string",
    defaults: "Defaults",
    env: "Record<string, string>",
  },
  "GitHub::Actions::Job": {
    steps: "Step[]",
    strategy: "Strategy",
    permissions: "Permissions | string",
    concurrency: "Concurrency | string",
    container: "Container | string",
    services: "Record<string, Service>",
    environment: "Environment | string",
    defaults: "Defaults",
    env: "Record<string, string>",
    needs: "string[]",
    outputs: "Record<string, string>",
    "runs-on": "string | string[]",
    "timeout-minutes": "number",
    "continue-on-error": "boolean",
    "if": "string",
  },
  "GitHub::Actions::Step": {
    env: "Record<string, string>",
    with: "Record<string, string>",
    "if": "string",
    "timeout-minutes": "number",
    "continue-on-error": "boolean",
  },
  "GitHub::Actions::Strategy": {
    matrix: "Record<string, any>",
  },
};

// ── Fallback properties ───────────────────────────────────────────

/**
 * Provide fallback properties for entities that can't be resolved from the schema.
 */
function buildFallbackProperties(typeName: string): ParsedProperty[] {
  const fallbacks: Record<string, Array<{ name: string; tsType: string; required: boolean; description?: string }>> = {
    "GitHub::Actions::Workflow": [
      { name: "name", tsType: "string", required: false, description: "The name of the workflow" },
      { name: "on", tsType: "Record<string, any>", required: true, description: "Event triggers" },
      { name: "jobs", tsType: "Record<string, any>", required: true, description: "Jobs in the workflow" },
      { name: "permissions", tsType: "Permissions | string", required: false, description: "Permissions for the workflow" },
      { name: "env", tsType: "Record<string, string>", required: false, description: "Environment variables" },
      { name: "concurrency", tsType: "Concurrency | string", required: false, description: "Concurrency settings" },
      { name: "defaults", tsType: "Defaults", required: false, description: "Default settings" },
      { name: "run-name", tsType: "string", required: false, description: "Dynamic name for workflow runs" },
    ],
    "GitHub::Actions::Job": [
      { name: "name", tsType: "string", required: false, description: "Job display name" },
      { name: "runs-on", tsType: "string | string[]", required: true, description: "Runner label(s)" },
      { name: "steps", tsType: "Step[]", required: false, description: "Job steps" },
      { name: "needs", tsType: "string[]", required: false, description: "Job dependencies" },
      { name: "if", tsType: "string", required: false, description: "Conditional expression" },
      { name: "permissions", tsType: "Permissions | string", required: false, description: "Permissions" },
      { name: "environment", tsType: "Environment | string", required: false, description: "Deployment environment" },
      { name: "concurrency", tsType: "Concurrency | string", required: false, description: "Concurrency settings" },
      { name: "outputs", tsType: "Record<string, string>", required: false, description: "Job outputs" },
      { name: "env", tsType: "Record<string, string>", required: false, description: "Environment variables" },
      { name: "defaults", tsType: "Defaults", required: false, description: "Default settings" },
      { name: "strategy", tsType: "Strategy", required: false, description: "Strategy (matrix, etc.)" },
      { name: "container", tsType: "Container | string", required: false, description: "Container to run in" },
      { name: "services", tsType: "Record<string, Service>", required: false, description: "Service containers" },
      { name: "timeout-minutes", tsType: "number", required: false, description: "Timeout in minutes" },
      { name: "continue-on-error", tsType: "boolean", required: false, description: "Continue on error" },
    ],
    "GitHub::Actions::ReusableWorkflowCallJob": [
      { name: "uses", tsType: "string", required: true, description: "Reusable workflow reference" },
      { name: "with", tsType: "Record<string, any>", required: false, description: "Inputs for the reusable workflow" },
      { name: "secrets", tsType: "Record<string, any> | string", required: false, description: "Secrets to pass" },
      { name: "needs", tsType: "string[]", required: false, description: "Job dependencies" },
      { name: "if", tsType: "string", required: false, description: "Conditional expression" },
      { name: "permissions", tsType: "Permissions | string", required: false, description: "Permissions" },
      { name: "concurrency", tsType: "Concurrency | string", required: false, description: "Concurrency settings" },
    ],
    "GitHub::Actions::Step": [
      { name: "name", tsType: "string", required: false, description: "Step display name" },
      { name: "uses", tsType: "string", required: false, description: "Action reference" },
      { name: "run", tsType: "string", required: false, description: "Shell command" },
      { name: "with", tsType: "Record<string, string>", required: false, description: "Action inputs" },
      { name: "env", tsType: "Record<string, string>", required: false, description: "Environment variables" },
      { name: "if", tsType: "string", required: false, description: "Conditional expression" },
      { name: "id", tsType: "string", required: false, description: "Step ID for output references" },
      { name: "shell", tsType: "string", required: false, description: "Shell to use" },
      { name: "working-directory", tsType: "string", required: false, description: "Working directory" },
      { name: "timeout-minutes", tsType: "number", required: false, description: "Timeout in minutes" },
      { name: "continue-on-error", tsType: "boolean", required: false, description: "Continue on error" },
    ],
    "GitHub::Actions::Strategy": [
      { name: "matrix", tsType: "Record<string, any>", required: false, description: "Matrix configuration" },
      { name: "fail-fast", tsType: "boolean", required: false, description: "Cancel all jobs if one fails" },
      { name: "max-parallel", tsType: "number", required: false, description: "Max parallel jobs" },
    ],
    "GitHub::Actions::Permissions": [
      { name: "actions", tsType: '"read" | "write" | "none"', required: false },
      { name: "checks", tsType: '"read" | "write" | "none"', required: false },
      { name: "contents", tsType: '"read" | "write" | "none"', required: false },
      { name: "deployments", tsType: '"read" | "write" | "none"', required: false },
      { name: "id-token", tsType: '"write" | "none"', required: false },
      { name: "issues", tsType: '"read" | "write" | "none"', required: false },
      { name: "packages", tsType: '"read" | "write" | "none"', required: false },
      { name: "pages", tsType: '"read" | "write" | "none"', required: false },
      { name: "pull-requests", tsType: '"read" | "write" | "none"', required: false },
      { name: "security-events", tsType: '"read" | "write" | "none"', required: false },
      { name: "statuses", tsType: '"read" | "write" | "none"', required: false },
    ],
    "GitHub::Actions::Concurrency": [
      { name: "group", tsType: "string", required: true, description: "Concurrency group name" },
      { name: "cancel-in-progress", tsType: "boolean", required: false, description: "Cancel in-progress runs" },
    ],
    "GitHub::Actions::Container": [
      { name: "image", tsType: "string", required: true, description: "Docker image" },
      { name: "credentials", tsType: "Record<string, string>", required: false, description: "Registry credentials" },
      { name: "env", tsType: "Record<string, string>", required: false, description: "Environment variables" },
      { name: "ports", tsType: "number[]", required: false, description: "Exposed ports" },
      { name: "volumes", tsType: "string[]", required: false, description: "Volume mounts" },
      { name: "options", tsType: "string", required: false, description: "Docker options" },
    ],
    "GitHub::Actions::Service": [
      { name: "image", tsType: "string", required: true, description: "Docker image" },
      { name: "credentials", tsType: "Record<string, string>", required: false },
      { name: "env", tsType: "Record<string, string>", required: false },
      { name: "ports", tsType: "number[]", required: false },
      { name: "volumes", tsType: "string[]", required: false },
      { name: "options", tsType: "string", required: false },
    ],
    "GitHub::Actions::Environment": [
      { name: "name", tsType: "string", required: true, description: "Environment name" },
      { name: "url", tsType: "string", required: false, description: "Environment URL" },
    ],
    "GitHub::Actions::Defaults": [
      { name: "run", tsType: "Record<string, string>", required: false, description: "Default run settings" },
    ],
    "GitHub::Actions::PushTrigger": [
      { name: "branches", tsType: "string[]", required: false },
      { name: "branches-ignore", tsType: "string[]", required: false },
      { name: "tags", tsType: "string[]", required: false },
      { name: "tags-ignore", tsType: "string[]", required: false },
      { name: "paths", tsType: "string[]", required: false },
      { name: "paths-ignore", tsType: "string[]", required: false },
    ],
    "GitHub::Actions::PullRequestTrigger": [
      { name: "branches", tsType: "string[]", required: false },
      { name: "branches-ignore", tsType: "string[]", required: false },
      { name: "paths", tsType: "string[]", required: false },
      { name: "paths-ignore", tsType: "string[]", required: false },
      { name: "types", tsType: "string[]", required: false },
    ],
    "GitHub::Actions::PullRequestTargetTrigger": [
      { name: "branches", tsType: "string[]", required: false },
      { name: "branches-ignore", tsType: "string[]", required: false },
      { name: "paths", tsType: "string[]", required: false },
      { name: "paths-ignore", tsType: "string[]", required: false },
      { name: "types", tsType: "string[]", required: false },
    ],
    "GitHub::Actions::ScheduleTrigger": [
      { name: "cron", tsType: "string", required: true, description: "POSIX cron expression" },
    ],
    "GitHub::Actions::WorkflowDispatchTrigger": [
      { name: "inputs", tsType: "Record<string, any>", required: false },
    ],
    "GitHub::Actions::WorkflowCallTrigger": [
      { name: "inputs", tsType: "Record<string, any>", required: false },
      { name: "outputs", tsType: "Record<string, any>", required: false },
      { name: "secrets", tsType: "Record<string, any>", required: false },
    ],
    "GitHub::Actions::WorkflowRunTrigger": [
      { name: "workflows", tsType: "string[]", required: false },
      { name: "types", tsType: "string[]", required: false },
      { name: "branches", tsType: "string[]", required: false },
      { name: "branches-ignore", tsType: "string[]", required: false },
    ],
    "GitHub::Actions::RepositoryDispatchTrigger": [
      { name: "types", tsType: "string[]", required: false },
    ],
    "GitHub::Actions::WorkflowInput": [
      { name: "description", tsType: "string", required: false },
      { name: "required", tsType: "boolean", required: false },
      { name: "default", tsType: "string", required: false },
      { name: "type", tsType: '"string" | "boolean" | "number" | "choice" | "environment"', required: false },
      { name: "options", tsType: "string[]", required: false },
    ],
    "GitHub::Actions::WorkflowOutput": [
      { name: "description", tsType: "string", required: false },
      { name: "value", tsType: "string", required: true },
    ],
    "GitHub::Actions::WorkflowSecret": [
      { name: "description", tsType: "string", required: false },
      { name: "required", tsType: "boolean", required: false },
    ],
  };

  const props = fallbacks[typeName];
  if (!props) return [];
  return props.map((p) => ({
    ...p,
    constraints: {},
  }));
}

// ── Helpers ───────────────────────────────────────────────────────

const DEPRECATION_RE = /\bDeprecated\b|\bdeprecated\b|\blegacy\b|no longer (available|recommended|used|supported)/i;

function mineDeprecatedProperties(properties: ParsedProperty[]): string[] {
  const deprecated: string[] = [];
  for (const prop of properties) {
    if (prop.description && DEPRECATION_RE.test(prop.description)) {
      deprecated.push(prop.name);
    }
  }
  return deprecated;
}

/**
 * Extract short name: "GitHub::Actions::Job" → "Job"
 */
export function githubShortName(typeName: string): string {
  const parts = typeName.split("::");
  return parts[parts.length - 1];
}

/**
 * Extract service name: "GitHub::Actions::Job" → "Actions"
 */
export function githubServiceName(typeName: string): string {
  const parts = typeName.split("::");
  return parts.length >= 2 ? parts[1] : "Actions";
}
