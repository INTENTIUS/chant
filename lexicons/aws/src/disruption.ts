/**
 * Replacement semantics for a pending update (#1665).
 *
 * CloudFormation already knows this and says so in the Registry schema:
 * `createOnlyProperties` is the type's complete list of properties that cannot
 * be updated without building a new resource, and `replacementStrategy` says
 * whether the new one is created before the old is removed or after. The
 * codegen compiles both into `lexicon-aws.json` alongside the types, which is
 * why this is a lookup rather than a rule anyone maintains by hand.
 *
 * `conditionalCreateOnlyProperties` is the interesting case: the schema is
 * saying "depends on the value", which is not an answer, so it degrades to
 * `unknown` with the property named. That is the whole point of the contract
 * having an `unknown` — a maybe reported as `in-place` is worse than no
 * report.
 *
 * `rolling` is not produced here. Nothing in the Registry schema expresses a
 * workload roll; that verdict belongs to a lexicon whose spec does.
 */
import { createRequire } from "module";
import type { DisruptionQuery, DisruptionVerdict } from "@intentius/chant/lexicon";

const require = createRequire(import.meta.url);

/** The slice of a `lexicon-aws.json` entry that carries replacement semantics. */
export interface DisruptionSpec {
  resourceType: string;
  kind: string;
  /** Read-only attributes (TS key → CF attr name). An output changing is a symptom, never a cause. */
  attrs?: Record<string, string>;
  createOnly?: string[];
  conditionalCreateOnly?: string[];
  replacementStrategy?: "delete_then_create" | "create_then_delete";
}

/**
 * Classify one pending update against the type's compiled schema. Pure — the
 * spec table is passed in, so this is testable without generated artifacts.
 */
export function classifyAwsChange(
  query: DisruptionQuery,
  specs: Map<string, DisruptionSpec>,
): DisruptionVerdict {
  const spec = query.type ? specs.get(query.type) : undefined;
  if (!spec || spec.kind !== "resource") {
    return {
      disruption: "unknown",
      detail: query.type
        ? `no CloudFormation registry schema on record for ${query.type}`
        : "the observation reported no resource type",
    };
  }

  const readOnly = readOnlyNames(spec);
  const considered: Array<{ path: string; property: string }> = [];
  for (const delta of query.deltas) {
    const property = propertyName(delta.path);
    if (!property || readOnly.has(property)) continue;
    considered.push({ path: delta.path, property });
  }

  const createOnly = new Set(spec.createOnly?.map(headSegment));
  const forced = considered.filter((c) => createOnly.has(c.property));
  if (forced.length > 0) {
    const names = [...new Set(forced.map((c) => c.property))];
    const destroys = spec.replacementStrategy === "delete_then_create";
    return {
      disruption: destroys ? "destroy" : "replace",
      because: forced.map((c) => c.path),
      detail: destroys
        ? `${names.join(", ")} is create-only and ${spec.resourceType} replaces by deleting first — the resource is gone before the new one exists`
        : `${names.join(", ")} is create-only — CloudFormation builds a new ${spec.resourceType} and removes the old one`,
    };
  }

  const conditional = new Set(spec.conditionalCreateOnly?.map(headSegment));
  const maybe = considered.filter((c) => conditional.has(c.property));
  if (maybe.length > 0) {
    const names = [...new Set(maybe.map((c) => c.property))];
    return {
      disruption: "unknown",
      because: maybe.map((c) => c.path),
      detail: `the schema marks ${names.join(", ")} conditionally create-only — whether this replaces depends on the value, and the schema does not say which way`,
    };
  }

  if (considered.length === 0) {
    return {
      disruption: "in-place",
      detail: "no configured property differs — only status, identity, or read-only attributes changed",
    };
  }

  return {
    disruption: "in-place",
    detail: `no create-only property of ${spec.resourceType} changed`,
  };
}

/**
 * `LexiconPlugin.classifyDisruption` for aws. Loads the compiled registry once
 * and answers every query from it. A registry that cannot be read leaves every
 * change `unknown` — the honest answer, and the one the contract requires.
 */
export function awsDisruption(options: {
  environment: string;
  changes: DisruptionQuery[];
}): Record<string, DisruptionVerdict> {
  const specs = registryByType();
  const out: Record<string, DisruptionVerdict> = {};
  for (const change of options.changes) {
    out[change.name] = classifyAwsChange(change, specs);
  }
  return out;
}

let cached: Map<string, DisruptionSpec> | undefined;

function registryByType(): Map<string, DisruptionSpec> {
  if (cached) return cached;
  try {
    const manifest = require("./generated/lexicon-aws.json") as Record<string, DisruptionSpec>;
    cached = new Map(Object.values(manifest).map((e) => [e.resourceType, e]));
  } catch {
    cached = new Map();
  }
  return cached;
}

/** Every read-only attribute name the schema declares, top segment only. */
function readOnlyNames(spec: DisruptionSpec): Set<string> {
  const names = new Set<string>();
  for (const attr of Object.values(spec.attrs ?? {})) names.add(attr.split(".")[0]);
  return names;
}

/**
 * The property a core delta path names, or undefined when the path is not
 * about a property at all. Core's own observation fields (`status`,
 * `physicalId`, `lastUpdated`) sit at the root of the change and say nothing
 * about configuration; only what is under `attributes.` was read off the
 * resource.
 */
function propertyName(path: string): string | undefined {
  const prefix = "attributes.";
  if (!path.startsWith(prefix)) return undefined;
  const rest = path.slice(prefix.length);
  return rest ? headSegment(rest) : undefined;
}

/** The first segment of a JSON-pointer-ish property path (`Config/Engine` → `Config`). */
function headSegment(path: string): string {
  return path.split(/[/.]/)[0];
}
