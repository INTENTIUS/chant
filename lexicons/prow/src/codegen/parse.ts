/**
 * Parses the vendored job config schema (../spec/job-config.schema.json)
 * into the lexicon's entities.
 *
 * The three job kinds Prow loads, Presubmit, Postsubmit and Periodic, are
 * resources: each declaration is one job in the job config. Every other
 * definition in the schema (the pod spec and its containers, the decoration
 * config, refs, the reporter config) is a property entity, a value nested in
 * a job. One field is chant's and not Prow's: a presubmit's or postsubmit's
 * `repo`, the `owner/name` key the job config lists it under, which the
 * serializer takes off the job. JobConfig is chant's too: the comment the
 * built file starts with.
 */

import type { PropertyConstraints } from "@intentius/chant/codegen/json-schema";
import { extractConstraints, primaryType, type JsonSchemaProperty } from "@intentius/chant/codegen/json-schema";

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

export interface ProwParseResult {
  resource: ParsedResource;
  propertyTypes: ParsedPropertyType[];
  enums: ParsedEnum[];
  isProperty?: boolean;
}

interface SchemaNode {
  type?: string | string[];
  description?: string;
  properties?: Record<string, SchemaNode>;
  required?: string[];
  enum?: string[];
  $ref?: string;
  items?: SchemaNode;
  anyOf?: SchemaNode[];
  additionalProperties?: boolean | SchemaNode;
}

interface JobConfigSchema {
  definitions: Record<string, SchemaNode>;
}

/** The job kinds, in the order the job config lists them. */
export const JOB_KINDS = ["Presubmit", "Postsubmit", "Periodic"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

const KIND_DESCRIPTIONS: Record<JobKind, string> = {
  Presubmit: "A Prow presubmit: a job that runs on a pull request, listed under its repository in the job config's presubmits",
  Postsubmit: "A Prow postsubmit: a job that runs on a push to a branch, listed under its repository in the job config's postsubmits",
  Periodic: "A Prow periodic: a job that runs on a schedule, an interval or a cron, listed in the job config's periodics",
};

/** chant's `repo` field on a presubmit and a postsubmit. */
export const REPO_FIELD: ParsedProperty = {
  name: "repo",
  tsType: "string",
  required: true,
  description:
    "The repository the job runs for, as owner/name (or host/owner/name): the key the job config lists the job under. chant's field, not Prow's; the built job does not carry it.",
  constraints: {},
};

/** chant's JobConfig: the comment written above the jobs. */
const JOB_CONFIG: ProwParseResult = {
  resource: {
    typeName: "Prow::JobConfig",
    description: "The job config file itself: the comment chant writes above the jobs. chant's, not Prow's; declare at most one",
    properties: [
      {
        name: "header",
        tsType: "string",
        required: false,
        description: "Comment lines written at the top of the file, each as written (a line that does not start with # gets one), then a blank line before the jobs.",
        constraints: {},
      },
    ],
    attributes: [],
    deprecatedProperties: [],
  },
  propertyTypes: [],
  enums: [],
};

function refName(ref: string): string {
  return ref.slice(ref.lastIndexOf("/") + 1);
}

/** The TypeScript type of one schema node: a definition by its class name, else the plain type. */
export function tsTypeOf(node: SchemaNode | undefined): string {
  if (!node) return "any";
  if (node.$ref) return refName(node.$ref);
  if (node.anyOf) {
    const parts = [...new Set(node.anyOf.map(tsTypeOf))];
    return parts.includes("any") ? "any" : parts.join(" | ");
  }
  if (node.enum?.length) return node.enum.map((v) => JSON.stringify(v)).join(" | ");
  switch (primaryType(node.type)) {
    case "string":
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "array": {
      const item = tsTypeOf(node.items);
      return item.includes(" | ") ? `(${item})[]` : `${item}[]`;
    }
    case "object":
      if (node.additionalProperties && typeof node.additionalProperties === "object") return `Record<string, ${tsTypeOf(node.additionalProperties)}>`;
      return "Record<string, any>";
    default:
      return "any";
  }
}

function properties(node: SchemaNode): ParsedProperty[] {
  const required = new Set(node.required ?? []);
  return Object.entries(node.properties ?? {}).map(([name, prop]) => ({
    name,
    tsType: tsTypeOf(prop),
    required: required.has(name),
    description: prop.description,
    enum: prop.enum,
    constraints: extractConstraints(prop as JsonSchemaProperty),
  }));
}

/** Every entity of the schema: the three job kinds, JobConfig, then the property entities by name. */
export function parseJobConfigSchema(data: Buffer | string): ProwParseResult[] {
  const schema = JSON.parse(data.toString()) as JobConfigSchema;
  const out: ProwParseResult[] = [];
  for (const kind of JOB_KINDS) {
    const def = schema.definitions[kind];
    if (!def) throw new Error(`job-config.schema.json has no ${kind}`);
    const props = properties(def);
    out.push({
      resource: {
        typeName: `Prow::${kind}`,
        description: KIND_DESCRIPTIONS[kind],
        properties: kind === "Periodic" ? props : [REPO_FIELD, ...props],
        attributes: [],
        deprecatedProperties: [],
      },
      propertyTypes: [],
      enums: [],
    });
  }
  out.push(JOB_CONFIG);
  for (const [name, def] of Object.entries(schema.definitions).sort(([a], [b]) => a.localeCompare(b))) {
    if ((JOB_KINDS as readonly string[]).includes(name)) continue;
    out.push({
      resource: {
        typeName: `Prow::${name}`,
        description: def.description?.split("\n")[0],
        properties: properties(def),
        attributes: [],
        deprecatedProperties: [],
      },
      propertyTypes: [],
      enums: [],
      isProperty: true,
    });
  }
  return out;
}

/** "Prow::PodSpec" to "PodSpec". */
export function prowShortName(typeName: string): string {
  return typeName.split("::").pop() ?? typeName;
}

/** One flat service. */
export function prowServiceName(_typeName: string): string {
  return "Prow";
}
