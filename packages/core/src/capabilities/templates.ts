/**
 * Investigation templates (#4531): the capability catalog's second kind of
 * entry, after the capabilities themselves (behold#1022 contract 3).
 *
 * A template is a fixed query with the resource filled in, so a click in
 * behold, choudoufu's `investigate` (choudoufu#2280) and an agent run the
 * same query. Each says which language it expands to (behold#1022 ruling Q4):
 * a `chant search` path pattern where one can express the question, Cypher
 * otherwise. A path template needs nothing beyond chant search, so it keeps
 * working where behold's optional LadybugDB peer is missing; a Cypher one
 * needs behold's graph pane.
 *
 * The catalog lives here, beside the capability rules (ruling Q5), and is
 * data: `templates.json` beside this module, shipped as
 * `@intentius/chant/capabilities/templates.json` and carried as `templates`
 * on the capabilities document (`chant search --capabilities --json`).
 * behold and choudoufu read it as data. The initial set is the one behold#1027
 * stubbed in behold's src/graph-db/templates.ts.
 *
 * Filling in: a path template's `{{<input>}}` is replaced by the input's
 * value, the resource's id for `{{node}}`. A Cypher template takes its inputs
 * as query parameters, never spliced into the text: the resource's key is
 * `$key` and every other input is `$<name>`.
 */
import data from "./templates.json" with { type: "json" };

/** The first chant whose capabilities document carries `templates` (#4531). */
export const CAPABILITY_TEMPLATES_FLOOR = "0.124.54";

/** The version of templates.json's shape. */
export const TEMPLATES_DATA_VERSION = 1;

export type TemplateQueryKind = "path" | "cypher";

/** What answering reads: the declared source, a live read, recorded snapshots, or only the session's loaded graph. */
export type TemplateReads = "source" | "live" | "snapshots" | "session";

/**
 * resource: the node the template is about, given as a name, an IR id, a
 * block address or a cloud ID, and resolved to one node before expanding.
 * scope: an environment or estate the query is read in. term: one search
 * term, such as a kind or a capability call.
 */
export type TemplateInputKind = "resource" | "scope" | "term";

export interface TemplateInput {
  name: string;
  kind: TemplateInputKind;
  description: string;
}

export interface TemplateEntry {
  id: string;
  title: string;
  /** The question it answers, in people's words. */
  question: string;
  /** The sources whose nodes it applies to (behold's source kinds); absent means every source. */
  sources?: string[];
  inputs: TemplateInput[];
  reads: TemplateReads;
  query: { kind: TemplateQueryKind; text: string };
  /** What it does not answer, said where it is offered. */
  note?: string;
}

/** A templates file that does not hold to the entry kind, naming the template. */
export class TemplateCatalogError extends Error {}

const ID = /^[a-z][a-z0-9-]*$/;
const INPUT_NAME = /^[a-z][A-Za-z0-9_]*$/;
const KINDS: readonly TemplateQueryKind[] = ["path", "cypher"];
const READS: readonly TemplateReads[] = ["source", "live", "snapshots", "session"];
const INPUT_KINDS: readonly TemplateInputKind[] = ["resource", "scope", "term"];
const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;
const PARAM = /\$([A-Za-z_][A-Za-z0-9_]*)/g;

const str = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/**
 * Read a templates file, checking each entry against the entry kind: a
 * unique id, exactly one resource input first, a query of a known kind
 * whose placeholders (path) or parameters (Cypher) are its inputs, and every
 * input used.
 */
export function parseTemplates(raw: unknown): TemplateEntry[] {
  const doc = raw as { version?: unknown; templates?: unknown };
  if (!doc || typeof doc !== "object") throw new TemplateCatalogError("a templates file is an object");
  if (doc.version !== TEMPLATES_DATA_VERSION) throw new TemplateCatalogError(`templates file version ${String(doc.version)} is not ${TEMPLATES_DATA_VERSION}`);
  if (!Array.isArray(doc.templates)) throw new TemplateCatalogError("templates is a list");
  const seen = new Set<string>();
  return doc.templates.map((t, i) => {
    const e = t as Partial<TemplateEntry>;
    const where = str(e?.id) ? `template ${e.id}` : `template ${i}`;
    const fail = (m: string): never => {
      throw new TemplateCatalogError(`${where}: ${m}`);
    };
    if (!e || typeof e !== "object") fail("is not an object");
    if (!str(e.id) || !ID.test(e.id)) fail("needs an id of lowercase letters, digits and -");
    if (seen.has(e.id!)) fail("is defined twice");
    seen.add(e.id!);
    if (!str(e.title)) fail("needs a title");
    if (!str(e.question)) fail("needs the question it answers");
    if (!READS.includes(e.reads as TemplateReads)) fail(`reads is one of ${READS.join(", ")}`);
    if (e.sources !== undefined && (!Array.isArray(e.sources) || !e.sources.every(str))) fail("sources is a list of source kinds");
    if (e.note !== undefined && !str(e.note)) fail("a note is text");
    if (!Array.isArray(e.inputs)) fail("needs its inputs");
    const names = new Set<string>();
    for (const input of e.inputs!) {
      if (!input || !str(input.name) || !INPUT_NAME.test(input.name)) fail("an input needs a name");
      if (names.has(input.name)) fail(`input ${input.name} is listed twice`);
      names.add(input.name);
      if (!INPUT_KINDS.includes(input.kind)) fail(`input ${input.name}'s kind is one of ${INPUT_KINDS.join(", ")}`);
      if (!str(input.description)) fail(`input ${input.name} needs a description`);
    }
    const resources = e.inputs!.filter((x) => x.kind === "resource");
    if (resources.length !== 1 || e.inputs![0] !== resources[0]) fail("takes one resource input, first");
    const q = e.query;
    if (!q || !KINDS.includes(q.kind) || !str(q.text)) fail(`query is { kind: ${KINDS.join(" | ")}, text }`);
    const resource = resources[0].name;
    if (q!.kind === "path") {
      if (/\$[A-Za-z_]/.test(q!.text)) fail("a path pattern takes {{input}} placeholders, not $parameters");
      const used = new Set([...q!.text.matchAll(PLACEHOLDER)].map((m) => m[1]));
      for (const u of used) if (!names.has(u)) fail(`{{${u}}} names no input`);
      // A scope is where the query is read, not part of its text.
      for (const input of e.inputs!) if (input.kind !== "scope" && !used.has(input.name)) fail(`the path pattern never uses ${input.name}`);
    } else {
      if (/\{\{/.test(q!.text)) fail("a Cypher query takes $parameters, never spliced {{input}} text");
      if (!/^\s*(MATCH|OPTIONAL MATCH|WITH|CALL|UNWIND)\b/i.test(q!.text)) fail("a Cypher query starts with a reading clause");
      if (/\b(CREATE|MERGE|DELETE|DETACH|SET|REMOVE|DROP)\b/i.test(q!.text)) fail("a Cypher query only reads");
      if (!balanced(q!.text)) fail("its brackets do not balance");
      const params = new Set([...q!.text.matchAll(PARAM)].map((m) => m[1]));
      if (!params.has("key")) fail("a Cypher query binds the resource as $key");
      for (const p of params) if (p !== "key" && !names.has(p)) fail(`$${p} names no input`);
      for (const input of e.inputs!) if (input.name !== resource && input.kind !== "scope" && !params.has(input.name)) fail(`the query never uses $${input.name}`);
    }
    return e as TemplateEntry;
  });
}

/** Whether (), [] and {} nest, outside quoted strings. */
function balanced(text: string): boolean {
  const open: string[] = [];
  const pair: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  let quote: string | undefined;
  for (const c of text) {
    if (quote) {
      if (c === quote) quote = undefined;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === "(" || c === "[" || c === "{") open.push(c);
    else if (c in pair && open.pop() !== pair[c]) return false;
  }
  return open.length === 0 && !quote;
}

let cache: TemplateEntry[] | undefined;

/** The templates chant ships, checked. */
export function investigationTemplates(): TemplateEntry[] {
  cache ??= parseTemplates(data);
  return cache;
}

/** A value spliced into a path pattern is one search term: letters, digits and `_ : . - / * ( ) , [ ]` only. */
const TERM_VALUE = /^[A-Za-z0-9_:.\-/*(),[\]]+$/;

export interface ExpandedTemplate {
  template: string;
  kind: TemplateQueryKind;
  reads: TemplateReads;
  /** path: the chant search query. cypher: the statement, unchanged. */
  text: string;
  /** cypher: the parameters, the resource as `key`. */
  params?: Record<string, string>;
  /** The scope inputs given, which say where the query is read. */
  scope?: Record<string, string>;
}

/**
 * Fill one template. `inputs` holds every input by name, the resource input
 * as the resolved node's id (path) or key (Cypher). A value that would make
 * a second search term is refused.
 */
export function expandTemplate(t: TemplateEntry, inputs: Record<string, string>): ExpandedTemplate {
  for (const i of t.inputs) if (!inputs[i.name]) throw new TemplateCatalogError(`${t.id} needs ${i.name}: ${i.description}`);
  for (const k of Object.keys(inputs)) if (!t.inputs.some((i) => i.name === k)) throw new TemplateCatalogError(`${t.id} takes no input ${k}`);
  const scopes = t.inputs.filter((i) => i.kind === "scope");
  const scope = scopes.length ? Object.fromEntries(scopes.map((i) => [i.name, inputs[i.name]!])) : undefined;
  const head = { template: t.id, kind: t.query.kind, reads: t.reads, ...(scope ? { scope } : {}) };
  if (t.query.kind === "cypher") {
    const resource = t.inputs[0].name;
    const params: Record<string, string> = { key: inputs[resource]! };
    for (const i of t.inputs) if (i.name !== resource && i.kind !== "scope") params[i.name] = inputs[i.name]!;
    return { ...head, text: t.query.text, params };
  }
  const text = t.query.text.replace(PLACEHOLDER, (_, name: string) => {
    const v = inputs[name]!;
    if (!TERM_VALUE.test(v)) throw new TemplateCatalogError(`${t.id}: ${name} ${JSON.stringify(v)} is not one search term`);
    return v;
  });
  return { ...head, text };
}
