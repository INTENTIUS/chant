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
 * A project adds its own templates in `.chant/templates.json`, in the same
 * shape (behold#1142). {@link templateCatalog} reads it from the workspace
 * root, or from the project root when there is no workspace, and lists its
 * entries after chant's with `origin: "project"`. An entry that does not hold
 * to the entry kind, or that reuses one of chant's ids, is refused alone and
 * listed under `refused`, so one bad entry never takes the rest with it: a
 * reader such as choudoufu refuses a whole list on one bad entry.
 *
 * Filling in: a path template's `{{<input>}}` is replaced by the input's
 * value, the resource's id for `{{node}}`. A Cypher template takes its inputs
 * as query parameters, never spliced into the text: the resource's key is
 * `$key` and every other input is `$<name>`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findProjectRoot, findWorkspaceRoot } from "../project-root";
import { NEXT_RELEASE } from "../release-floors";
import data from "./templates.json" with { type: "json" };

/** The first chant whose capabilities document carries `templates` (#4531). */
export const CAPABILITY_TEMPLATES_FLOOR = "0.124.54";

/**
 * The first chant whose capabilities document lists a project's own templates
 * from `.chant/templates.json`, marks each entry's `origin`, may carry `kinds`,
 * and lists refused project entries under `refused` (behold issue 1142).
 */
export const PROJECT_TEMPLATES_FLOOR = NEXT_RELEASE;

/** Where a project declares its own templates, relative to the workspace or project root. */
export const PROJECT_TEMPLATES_FILE = ".chant/templates.json";

/** chant's own templates file, as a refusal names it. */
export const CHANT_TEMPLATES_FILE = "@intentius/chant/capabilities/templates.json";

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
  /** The node kinds it applies to, as the graph holds them (`aws_s3_bucket`, `AWS::S3::Bucket`); absent means every kind. */
  kinds?: string[];
  inputs: TemplateInput[];
  reads: TemplateReads;
  query: { kind: TemplateQueryKind; text: string };
  /** What it does not answer, said where it is offered. */
  note?: string;
}

/** Where a catalog entry came from: chant's own file, or the project's `.chant/templates.json`. */
export type TemplateOrigin = "chant" | "project";

/** An entry of the catalog the capabilities document lists. */
export interface CatalogTemplate extends TemplateEntry {
  origin: TemplateOrigin;
}

/** A project entry left out of the catalog, and why. */
export interface RefusedTemplate {
  /** The entry's id, when it has a usable one. */
  id?: string;
  /** The file it was read from, relative to the workspace or project root. */
  file: string;
  /** The field at fault, such as `templates[2].query.text`; absent when the file is not JSON. */
  field?: string;
  /** What is wrong, naming the file and the field. */
  message: string;
}

/** What {@link templateCatalog} found: chant's templates, then the project's, and the project entries it refused. */
export interface TemplateCatalog {
  templates: CatalogTemplate[];
  refused: RefusedTemplate[];
}

/**
 * A templates file or entry that does not hold to the entry kind, naming the
 * template. `field` is the path to the field at fault and `file` the file it
 * was read from, when known.
 */
export class TemplateCatalogError extends Error {
  constructor(
    message: string,
    readonly field?: string,
    readonly file?: string,
  ) {
    super(message);
  }
}

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
 * input used. The first entry that does not hold is thrown.
 */
export function parseTemplates(raw: unknown, file?: string): TemplateEntry[] {
  const { templates, refused } = checkTemplates(raw, file);
  if (refused.length > 0) throw refused[0];
  return templates;
}

/**
 * Check a templates file entry by entry: the entries that hold, and a
 * {@link TemplateCatalogError} for each that does not. A file whose shape is
 * wrong (not an object, another version, no list) is thrown whole. An id
 * defined twice keeps its first entry.
 */
export function checkTemplates(raw: unknown, file?: string): { templates: TemplateEntry[]; refused: TemplateCatalogError[] } {
  const doc = raw as { version?: unknown; templates?: unknown };
  const whole = (m: string, field?: string): never => {
    throw new TemplateCatalogError(file ? `${file}${field ? ` ${field}` : ""}: ${m}` : m, field, file);
  };
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) whole("a templates file is an object");
  if (doc.version !== TEMPLATES_DATA_VERSION) whole(`templates file version ${String(doc.version)} is not ${TEMPLATES_DATA_VERSION}`, "version");
  if (!Array.isArray(doc.templates)) whole("templates is a list", "templates");
  const seen = new Set<string>();
  const templates: TemplateEntry[] = [];
  const refused: TemplateCatalogError[] = [];
  (doc.templates as unknown[]).forEach((t, i) => {
    try {
      templates.push(checkEntry(t, i, seen, file));
    } catch (e) {
      if (!(e instanceof TemplateCatalogError)) throw e;
      refused.push(e);
    }
  });
  return { templates, refused };
}

/** One entry, checked; `seen` holds the ids before it. */
function checkEntry(t: unknown, i: number, seen: Set<string>, file?: string): TemplateEntry {
  const e = t as Partial<TemplateEntry>;
  const at = `templates[${i}]`;
  const where = str(e?.id) ? `template ${e.id}` : `template ${i}`;
  const fail = (m: string, field = ""): never => {
    const path = `${at}${field}`;
    throw new TemplateCatalogError(file ? `${file} ${path}: ${where}: ${m}` : `${where}: ${m}`, path, file);
  };
  if (!e || typeof e !== "object" || Array.isArray(e)) fail("is not an object");
  if (!str(e.id) || !ID.test(e.id)) fail("needs an id of lowercase letters, digits and -", ".id");
  if (seen.has(e.id!)) fail("is defined twice", ".id");
  seen.add(e.id!);
  if (!str(e.title)) fail("needs a title", ".title");
  if (!str(e.question)) fail("needs the question it answers", ".question");
  if (!READS.includes(e.reads as TemplateReads)) fail(`reads is one of ${READS.join(", ")}`, ".reads");
  if (e.sources !== undefined && (!Array.isArray(e.sources) || !e.sources.every(str))) fail("sources is a list of source kinds", ".sources");
  if (e.kinds !== undefined && (!Array.isArray(e.kinds) || e.kinds.length === 0 || !e.kinds.every(str))) fail("kinds is a list of node kinds, or absent for every kind", ".kinds");
  if (e.note !== undefined && !str(e.note)) fail("a note is text", ".note");
  if (!Array.isArray(e.inputs)) fail("needs its inputs", ".inputs");
  const names = new Set<string>();
  e.inputs!.forEach((input, j) => {
    const f = `.inputs[${j}]`;
    if (!input || !str(input.name) || !INPUT_NAME.test(input.name)) fail("an input needs a name", `${f}.name`);
    if (names.has(input.name)) fail(`input ${input.name} is listed twice`, `${f}.name`);
    names.add(input.name);
    if (!INPUT_KINDS.includes(input.kind)) fail(`input ${input.name}'s kind is one of ${INPUT_KINDS.join(", ")}`, `${f}.kind`);
    if (!str(input.description)) fail(`input ${input.name} needs a description`, `${f}.description`);
  });
  const resources = e.inputs!.filter((x) => x.kind === "resource");
  if (resources.length !== 1 || e.inputs![0] !== resources[0]) fail("takes one resource input, first", ".inputs");
  const q = e.query;
  if (!q || typeof q !== "object") fail(`query is { kind: ${KINDS.join(" | ")}, text }`, ".query");
  if (!KINDS.includes(q!.kind)) fail(`query is { kind: ${KINDS.join(" | ")}, text }`, ".query.kind");
  if (!str(q!.text)) fail(`query is { kind: ${KINDS.join(" | ")}, text }`, ".query.text");
  const text = ".query.text";
  const resource = resources[0].name;
  if (q!.kind === "path") {
    if (/\$[A-Za-z_]/.test(q!.text)) fail("a path pattern takes {{input}} placeholders, not $parameters", text);
    const used = new Set([...q!.text.matchAll(PLACEHOLDER)].map((m) => m[1]));
    for (const u of used) if (!names.has(u)) fail(`{{${u}}} names no input`, text);
    // A scope is where the query is read, not part of its text.
    for (const input of e.inputs!) if (input.kind !== "scope" && !used.has(input.name)) fail(`the path pattern never uses ${input.name}`, text);
  } else {
    if (/\{\{/.test(q!.text)) fail("a Cypher query takes $parameters, never spliced {{input}} text", text);
    if (!/^\s*(MATCH|OPTIONAL MATCH|WITH|CALL|UNWIND)\b/i.test(q!.text)) fail("a Cypher query starts with a reading clause", text);
    if (/\b(CREATE|MERGE|DELETE|DETACH|SET|REMOVE|DROP)\b/i.test(q!.text)) fail("a Cypher query only reads", text);
    if (!balanced(q!.text)) fail("its brackets do not balance", text);
    const params = new Set([...q!.text.matchAll(PARAM)].map((m) => m[1]));
    if (!params.has("key")) fail("a Cypher query binds the resource as $key", text);
    for (const p of params) if (p !== "key" && !names.has(p)) fail(`$${p} names no input`, text);
    for (const input of e.inputs!) if (input.name !== resource && input.kind !== "scope" && !params.has(input.name)) fail(`the query never uses $${input.name}`, text);
  }
  return e as TemplateEntry;
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

/** The directory a project's templates file is read in: the workspace root, or the project root when `dir` is in no workspace. */
export function templatesRoot(dir: string): string {
  return findWorkspaceRoot(dir)?.dir ?? findProjectRoot(dir);
}

/**
 * The template catalog for the project at `dir` (behold#1142): chant's
 * templates, then the project's own from {@link PROJECT_TEMPLATES_FILE} at
 * {@link templatesRoot}, each marked with its origin. A workspace member's
 * own file is not read. A project entry that does not hold to the entry kind,
 * or whose id is one of chant's, is left out and listed under `refused`, and
 * the others load. A file that cannot be read as a templates file is refused
 * whole, as one entry. No file means chant's templates alone.
 */
export function templateCatalog(dir: string): TemplateCatalog {
  const chant: CatalogTemplate[] = investigationTemplates().map((t) => ({ ...t, origin: "chant" }));
  const file = PROJECT_TEMPLATES_FILE;
  let text: string;
  try {
    text = readFileSync(join(templatesRoot(dir), file), "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { templates: chant, refused: [] };
    return { templates: chant, refused: [{ file, message: `${file}: cannot be read: ${(e as Error).message}` }] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { templates: chant, refused: [{ file, message: `${file}: is not JSON: ${(e as Error).message}` }] };
  }
  let checked: ReturnType<typeof checkTemplates>;
  try {
    checked = checkTemplates(raw, file);
  } catch (e) {
    if (!(e instanceof TemplateCatalogError)) throw e;
    return { templates: chant, refused: [refusal(e, file)] };
  }
  const refused = checked.refused.map((e) => refusal(e, file, (raw as { templates: unknown[] }).templates));
  const chantIds = new Set(chant.map((t) => t.id));
  const own: CatalogTemplate[] = [];
  for (const t of checked.templates) {
    if (chantIds.has(t.id)) {
      const i = (raw as { templates: unknown[] }).templates.indexOf(t);
      const field = `templates[${i}].id`;
      refused.push({
        id: t.id,
        file,
        field,
        message: `${file} ${field}: template ${t.id}: ${CHANT_TEMPLATES_FILE} already defines ${t.id}, and an id keeps chant's meaning; rename this one`,
      });
      continue;
    }
    own.push({ ...t, origin: "project" });
  }
  return { templates: [...chant, ...own], refused };
}

function refusal(e: TemplateCatalogError, file: string, entries?: unknown[]): RefusedTemplate {
  const index = e.field?.match(/^templates\[(\d+)\]/)?.[1];
  const id = index !== undefined ? (entries?.[Number(index)] as { id?: unknown } | undefined)?.id : undefined;
  return {
    ...(typeof id === "string" && ID.test(id) ? { id } : {}),
    file,
    ...(e.field ? { field: e.field } : {}),
    message: e.message,
  };
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
