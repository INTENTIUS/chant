/**
 * template.yml, version 1 (#4651, ruling B of #4642): what a template asks
 * for when someone requests an app or an add-on from it. The file sits in
 * the template's signed release; a form shows one field per input, and an
 * agent or a command line reads the same list.
 *
 * Each input has an engine-neutral kind (`string`, `number`, `bool`,
 * `list`, `map`, `object`, with `of` naming a list's or map's element kind).
 * Core checks request values against the kind and never parses an engine's
 * own type syntax; an engine maps the kinds to its types (the terraform
 * lexicon, #4652).
 */

import schema from "./template.schema.json" with { type: "json" };
import { parseYAMLDocument, YAMLParseError } from "../yaml";
import { schemaProblems } from "./validate";

/** The template.yml `$schema`, when the file names one. */
export const TEMPLATE_SPEC_SCHEMA_ID: string = schema.$id;

/** The template.yml contract version. */
export const TEMPLATE_SPEC_CONTRACT = 1;

/** A kind whose values are JSON scalars. */
export type TemplateScalarKind = "string" | "number" | "bool";

/** An input's engine-neutral kind. */
export type TemplateInputKind = TemplateScalarKind | "list" | "map" | "object";

/** Every input kind, in the order the schema lists them. */
export const TEMPLATE_INPUT_KINDS: readonly TemplateInputKind[] = ["string", "number", "bool", "list", "map", "object"];

/** One input of a template. */
export interface TemplateInput {
  name: string;
  kind: TemplateInputKind;
  /** For a list or a map: the kind of each element or value. Absent: any JSON value. */
  of?: TemplateScalarKind;
  /** The form field's label. Absent: the name. */
  label?: string;
  description?: string;
  /** The value a request that gives none takes. */
  default?: unknown;
  /** Absent: true when there is no default. */
  required?: boolean;
  /** A secret, which a request never carries. */
  sensitive?: boolean;
}

/** A parsed template.yml. */
export interface TemplateSpec {
  $schema?: string;
  contract: 1;
  /** Absent: `app`. */
  kind?: "app" | "addon";
  description: string;
  inputs: TemplateInput[];
}

/** Thrown when a template.yml is not valid, with one line per problem. */
export class TemplateSpecError extends Error {
  constructor(public readonly problems: string[]) {
    super(`template.yml is not valid: ${problems.join("; ")}`);
    this.name = "TemplateSpecError";
  }
}

/** Whether a request must give `input`: its own `required`, else true when it has no default. */
export function inputRequired(input: TemplateInput): boolean {
  return input.required ?? !("default" in input);
}

/** The JSON type a value has, as a problem line names it. */
export function jsonKindOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "list";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "object") return "object";
  return typeof value;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function scalarFits(kind: TemplateScalarKind, value: unknown): boolean {
  if (kind === "string") return typeof value === "string";
  if (kind === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === "boolean";
}

/**
 * Why `value` is not of `input`'s kind, or undefined when it is. A null is
 * never of a kind: a request that wants the default leaves the input out.
 */
export function inputKindProblem(input: Pick<TemplateInput, "kind" | "of">, value: unknown): string | undefined {
  const want = input.of ? `${input.kind} of ${input.of}` : input.kind;
  const bad = (detail?: string) => `is ${detail ?? jsonKindOf(value)}, and the input is a ${want}`;
  switch (input.kind) {
    case "string":
    case "number":
    case "bool":
      return scalarFits(input.kind, value) ? undefined : bad();
    case "list": {
      if (!Array.isArray(value)) return bad();
      if (!input.of) return undefined;
      const at = value.findIndex((v) => !scalarFits(input.of!, v));
      return at < 0 ? undefined : bad(`a list whose element ${at} is ${jsonKindOf(value[at])}`);
    }
    case "map": {
      if (!isPlainObject(value)) return bad();
      if (!input.of) return undefined;
      const key = Object.keys(value).find((k) => !scalarFits(input.of!, value[k]));
      return key === undefined ? undefined : bad(`a map whose ${JSON.stringify(key)} is ${jsonKindOf(value[key])}`);
    }
    case "object":
      return isPlainObject(value) ? undefined : bad();
  }
}

/**
 * Every problem with a template.yml document, one line each: the schema's,
 * then two inputs with one name, a default that is not of its input's kind,
 * and an input both required and given a default.
 */
export function templateSpecProblems(doc: unknown): string[] {
  const problems = schemaProblems(TEMPLATE_SPEC_SCHEMA_ID, doc);
  if (problems.length > 0) return problems;
  const spec = doc as TemplateSpec;
  const seen = new Set<string>();
  spec.inputs.forEach((input, i) => {
    const where = `/inputs/${i} (${input.name})`;
    if (seen.has(input.name)) problems.push(`${where} repeats the name ${JSON.stringify(input.name)}`);
    seen.add(input.name);
    if ("default" in input) {
      const p = inputKindProblem(input, input.default);
      if (p) problems.push(`${where} default ${p}`);
      if (input.required === true) problems.push(`${where} is required and has a default; an input with a default is optional`);
    }
  });
  return problems;
}

/**
 * Read a template.yml from its YAML text or its parsed value. Throws
 * {@link TemplateSpecError} when it does not parse or is not valid.
 */
export function parseTemplateSpec(text: string | unknown): TemplateSpec {
  let doc: unknown = text;
  if (typeof text === "string") {
    try {
      doc = parseYAMLDocument(text);
    } catch (e) {
      if (e instanceof YAMLParseError) throw new TemplateSpecError([`not YAML: ${e.message}`]);
      throw e;
    }
  }
  const problems = templateSpecProblems(doc);
  if (problems.length > 0) throw new TemplateSpecError(problems);
  return doc as TemplateSpec;
}
