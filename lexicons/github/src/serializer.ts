/**
 * GitHub Actions YAML serializer.
 *
 * Converts Chant declarables to .github/workflows/*.yml YAML output.
 * Uses kebab-case keys for job properties and snake_case for trigger
 * event names.
 */

import type { Declarable } from "@intentius/chant/declarable";
import { isPropertyDeclarable } from "@intentius/chant/declarable";
import type { Serializer, SerializerResult } from "@intentius/chant/serializer";
import type { LexiconOutput } from "@intentius/chant/lexicon-output";
import { walkValue, type SerializerVisitor } from "@intentius/chant/serializer-walker";
import { INTRINSIC_MARKER } from "@intentius/chant/intrinsic";
import { emitYAML } from "@intentius/chant/yaml";

// ── Key conversion ────────────────────────────────────────────────

/**
 * Convert camelCase property names to kebab-case for YAML output.
 * Examples: timeoutMinutes → timeout-minutes, runsOn → runs-on
 */
function toKebabCase(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

/**
 * Convert camelCase trigger names to snake_case event names.
 * Examples: pullRequest → pull_request, workflowDispatch → workflow_dispatch
 */
function toSnakeCase(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/**
 * Map entity type names to YAML trigger event names.
 */
const TRIGGER_TYPE_TO_EVENT: Record<string, string> = {
  "GitHub::Actions::PushTrigger": "push",
  "GitHub::Actions::PullRequestTrigger": "pull_request",
  "GitHub::Actions::PullRequestTargetTrigger": "pull_request_target",
  "GitHub::Actions::ScheduleTrigger": "schedule",
  "GitHub::Actions::WorkflowDispatchTrigger": "workflow_dispatch",
  "GitHub::Actions::WorkflowCallTrigger": "workflow_call",
  "GitHub::Actions::WorkflowRunTrigger": "workflow_run",
  "GitHub::Actions::RepositoryDispatchTrigger": "repository_dispatch",
};

/** Check if an entity type is a trigger. */
function isTriggerType(entityType: string): boolean {
  return entityType in TRIGGER_TYPE_TO_EVENT;
}

// ── Visitor ───────────────────────────────────────────────────────

function githubVisitor(entityNames: Map<Declarable, string>): SerializerVisitor {
  return {
    attrRef: (name, _attr) => name,
    resourceRef: (name) => toKebabCase(name),
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

// ── Intrinsic preprocessing ───────────────────────────────────────

function preprocessIntrinsics(value: unknown): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === "object" && INTRINSIC_MARKER in value) {
    if ("toYAML" in value && typeof value.toYAML === "function") {
      return (value as { toYAML(): unknown }).toYAML();
    }
  }

  // Leave Declarables untouched
  if (typeof value === "object" && value !== null && "entityType" in value) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(preprocessIntrinsics);
  }

  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = preprocessIntrinsics(v);
    }
    return result;
  }

  return value;
}

function toYAMLValue(value: unknown, entityNames: Map<Declarable, string>): unknown {
  const preprocessed = preprocessIntrinsics(value);
  return walkValue(preprocessed, entityNames, githubVisitor(entityNames));
}

// ── Inline job serialization ──────────────────────────────────────

const JOB_ENTITY_TYPES = new Set([
  "GitHub::Actions::Job",
  "GitHub::Actions::ReusableWorkflowCallJob",
]);

/**
 * Serialize a value from Workflow.props.jobs into a YAML job object.
 *
 * When the value is a Job entity (resource Declarable), its props are inlined
 * directly rather than emitted as a resource reference. This allows callers to
 * pass `new Job({...})` directly inside `Workflow({ jobs: { name: new Job({...}) } })`.
 *
 * Plain objects are accepted too (JSON-style job definitions).
 */
function serializeInlineJob(
  jobValue: unknown,
  entityNames: Map<Declarable, string>,
): Record<string, unknown> | undefined {
  if (!jobValue || typeof jobValue !== "object") return undefined;
  const obj = jobValue as Record<string, unknown>;

  if ("entityType" in obj && "props" in obj && JOB_ENTITY_TYPES.has(obj.entityType as string)) {
    // Job entity: serialize its props inline (not as a resource reference)
    const props = toYAMLValue(obj.props, entityNames);
    return props && typeof props === "object"
      ? convertKeys(props as Record<string, unknown>)
      : undefined;
  }

  // Plain object job definition (JSON-style)
  return convertKeys(convertValueKeys(obj) as Record<string, unknown>);
}

/**
 * Build a jobs section from Workflow.props.jobs entries.
 * Returns undefined when props.jobs is absent or empty.
 */
function buildInlineJobsSection(
  props: Record<string, unknown>,
  entityNames: Map<Declarable, string>,
): Record<string, unknown> | undefined {
  if (!props.jobs || typeof props.jobs !== "object" || Array.isArray(props.jobs)) return undefined;
  const jobsSection: Record<string, unknown> = {};
  for (const [jName, jobValue] of Object.entries(props.jobs as Record<string, unknown>)) {
    const serialized = serializeInlineJob(jobValue, entityNames);
    if (serialized) jobsSection[toKebabCase(jName)] = serialized;
  }
  return Object.keys(jobsSection).length > 0 ? jobsSection : undefined;
}

/**
 * Build a jobs section from standalone top-level Job entity exports.
 * Returns undefined when there are no standalone jobs.
 */
function buildStandaloneJobsSection(
  jobs: Array<[string, Declarable]>,
  entityNames: Map<Declarable, string>,
): Record<string, unknown> | undefined {
  if (jobs.length === 0) return undefined;
  const jobsSection: Record<string, unknown> = {};
  for (const [name, job] of jobs) {
    const jProps = toYAMLValue(
      (job as unknown as Record<string, unknown>).props,
      entityNames,
    ) as Record<string, unknown> | undefined;
    if (jProps) jobsSection[toKebabCase(name)] = convertKeys(jProps);
  }
  return Object.keys(jobsSection).length > 0 ? jobsSection : undefined;
}

// ── Key conversion for YAML output ────────────────────────────────

/**
 * Convert a props object keys from camelCase to kebab-case for job/step properties.
 */
function convertKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    // Zero and false are valid values, but undefined/null should be omitted
    const yamlKey = toKebabCase(key);
    result[yamlKey] = convertValueKeys(value);
  }
  return result;
}

function convertValueKeys(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(convertValueKeys);

  const obj = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    result[toKebabCase(key)] = convertValueKeys(v);
  }
  return result;
}

// ── Serializer ────────────────────────────────────────────────────

/**
 * GitHub Actions YAML serializer implementation.
 */
export const githubSerializer: Serializer = {
  name: "github",
  rulePrefix: "GHA",

  serialize(
    entities: Map<string, Declarable>,
    _outputs?: LexiconOutput[],
  ): string | SerializerResult {
    const entityNames = new Map<Declarable, string>();
    for (const [name, entity] of entities) {
      entityNames.set(entity, name);
    }

    // Categorize entities
    const workflows: Array<[string, Declarable]> = [];
    const jobs: Array<[string, Declarable]> = [];
    const triggers: Array<[string, Declarable]> = [];
    const others: Array<[string, Declarable]> = [];

    for (const [name, entity] of entities) {
      if (isPropertyDeclarable(entity)) continue;

      const entityType = (entity as unknown as Record<string, unknown>).entityType as string;
      if (entityType === "GitHub::Actions::Workflow") {
        workflows.push([name, entity]);
      } else if (entityType === "GitHub::Actions::Job" || entityType === "GitHub::Actions::ReusableWorkflowCallJob") {
        jobs.push([name, entity]);
      } else if (isTriggerType(entityType)) {
        triggers.push([name, entity]);
      } else {
        others.push([name, entity]);
      }
    }

    // If multiple workflows, produce multiple files
    if (workflows.length > 1) {
      return serializeMultiWorkflow(workflows, jobs, triggers, entities, entityNames);
    }

    // Single workflow (or implicit workflow from jobs)
    return serializeSingleWorkflow(workflows, jobs, triggers, entities, entityNames);
  },
};

function serializeSingleWorkflow(
  workflows: Array<[string, Declarable]>,
  jobs: Array<[string, Declarable]>,
  triggers: Array<[string, Declarable]>,
  _entities: Map<string, Declarable>,
  entityNames: Map<Declarable, string>,
): string {
  const doc: Record<string, unknown> = {};

  // Workflow-level properties
  if (workflows.length > 0) {
    const [, wf] = workflows[0];
    const props = toYAMLValue((wf as unknown as Record<string, unknown>).props, entityNames) as Record<string, unknown> | undefined;
    if (props) {
      if (props.name) doc.name = props.name;
      if (props["run-name"] || props.runName) doc["run-name"] = props["run-name"] ?? props.runName;
      if (props.permissions) doc.permissions = convertValueKeys(props.permissions);
      if (props.env) doc.env = props.env;
      if (props.concurrency) doc.concurrency = convertValueKeys(props.concurrency);
      if (props.defaults) doc.defaults = convertValueKeys(props.defaults);

      // Handle 'on' from workflow props
      if (props.on) {
        doc.on = convertTriggerProps(props.on);
      }
    }
  }

  // If triggers exist as separate entities, merge into 'on'
  if (triggers.length > 0) {
    const onSection = (doc.on as Record<string, unknown>) ?? {};
    for (const [, trigger] of triggers) {
      const entityType = (trigger as unknown as Record<string, unknown>).entityType as string;
      const eventName = TRIGGER_TYPE_TO_EVENT[entityType];
      if (!eventName) continue;

      const props = toYAMLValue((trigger as unknown as Record<string, unknown>).props, entityNames) as Record<string, unknown> | undefined;
      if (props && Object.keys(props).length > 0) {
        onSection[eventName] = convertValueKeys(props);
      } else {
        onSection[eventName] = null;
      }
    }
    doc.on = onSection;
  }

  // Jobs: prefer Workflow.props.jobs (raw) when present; fall back to standalone Job exports
  let jobsSection: Record<string, unknown> | undefined;
  if (workflows.length > 0) {
    const rawProps = (workflows[0][1] as unknown as Record<string, unknown>).props as Record<string, unknown>;
    jobsSection = buildInlineJobsSection(rawProps, entityNames);
  }
  if (!jobsSection) jobsSection = buildStandaloneJobsSection(jobs, entityNames);
  if (jobsSection) doc.jobs = jobsSection;

  return emitYAMLDocument(doc);
}

function serializeMultiWorkflow(
  workflows: Array<[string, Declarable]>,
  jobs: Array<[string, Declarable]>,
  triggers: Array<[string, Declarable]>,
  _entities: Map<string, Declarable>,
  entityNames: Map<Declarable, string>,
): SerializerResult {
  const files: Record<string, string> = {};
  let primary = "";

  for (let i = 0; i < workflows.length; i++) {
    const [name, wf] = workflows[i];
    const doc: Record<string, unknown> = {};
    const props = toYAMLValue((wf as unknown as Record<string, unknown>).props, entityNames) as Record<string, unknown> | undefined;

    if (props) {
      if (props.name) doc.name = props.name;
      if (props.on) doc.on = convertTriggerProps(props.on);
      if (props.permissions) doc.permissions = convertValueKeys(props.permissions);
      if (props.env) doc.env = props.env;
      if (props.concurrency) doc.concurrency = convertValueKeys(props.concurrency);
      if (props.defaults) doc.defaults = convertValueKeys(props.defaults);
    }

    // Attach all triggers to first workflow for now
    if (i === 0 && triggers.length > 0) {
      const onSection = (doc.on as Record<string, unknown>) ?? {};
      for (const [, trigger] of triggers) {
        const entityType = (trigger as unknown as Record<string, unknown>).entityType as string;
        const eventName = TRIGGER_TYPE_TO_EVENT[entityType];
        if (!eventName) continue;
        const tProps = toYAMLValue((trigger as unknown as Record<string, unknown>).props, entityNames) as Record<string, unknown> | undefined;
        if (tProps && Object.keys(tProps).length > 0) {
          onSection[eventName] = convertValueKeys(tProps);
        } else {
          onSection[eventName] = null;
        }
      }
      doc.on = onSection;
    }

    // Jobs: use Workflow.props.jobs when defined, otherwise fall back to standalone exports
    // (standalone exports only assigned to first workflow, for backwards compat with composites)
    const rawProps = (wf as unknown as Record<string, unknown>).props as Record<string, unknown>;
    const inlineJobs = buildInlineJobsSection(rawProps, entityNames);
    const jobsSection = inlineJobs ?? (i === 0 ? buildStandaloneJobsSection(jobs, entityNames) : undefined);
    if (jobsSection) doc.jobs = jobsSection;

    const content = emitYAMLDocument(doc);
    const fileName = `${toKebabCase(name)}.yml`;
    files[fileName] = content;

    if (i === 0) primary = content;
  }

  return { primary, files };
}

/**
 * Convert trigger props to YAML-compatible form.
 */
function convertTriggerProps(on: unknown): unknown {
  if (typeof on !== "object" || on === null) return on;
  if (Array.isArray(on)) return on;

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(on as Record<string, unknown>)) {
    const eventName = toSnakeCase(key);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      result[eventName] = convertValueKeys(value as Record<string, unknown>);
    } else {
      result[eventName] = value;
    }
  }
  return result;
}

/**
 * Emit a complete YAML document from a structured object.
 */
function emitYAMLDocument(doc: Record<string, unknown>): string {
  const sections: string[] = [];

  // Emit in canonical order: name, run-name, on, permissions, env, concurrency, defaults, jobs
  const order = ["name", "run-name", "on", "permissions", "env", "concurrency", "defaults", "jobs"];
  const emitted = new Set<string>();

  for (const key of order) {
    if (key in doc && doc[key] !== undefined) {
      emitted.add(key);
      const value = doc[key];
      if (value === null) {
        sections.push(`${key}:`);
      } else if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        sections.push(`${key}: ${yamlScalar(value)}`);
      } else {
        sections.push(`${key}:` + emitYAML(value, 1));
      }
    }
  }

  // Remaining keys
  for (const [key, value] of Object.entries(doc)) {
    if (emitted.has(key) || value === undefined) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      sections.push(`${key}: ${yamlScalar(value)}`);
    } else {
      sections.push(`${key}:` + emitYAML(value, 1));
    }
  }

  return sections.join("\n\n") + "\n";
}

function yamlScalar(value: string | number | boolean): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  // Quote strings that might be ambiguous
  if (/^[\d]|[:#\[\]{}|>&*!%@`]|true|false|null|yes|no/i.test(value)) {
    return `'${value.replace(/'/g, "''")}'`;
  }
  return value;
}
