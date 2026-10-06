/**
 * JSON Schema to TypeScript type text, for code a lexicon generates into a
 * project (`chant generate`): a CRD's `openAPIV3Schema`, a Helm chart's
 * `values.schema.json`.
 *
 * Unlike ./json-schema.ts, which maps the subset of JSON Schema that resource
 * specifications use onto a lexicon's named property types, this renders a
 * whole schema as one type expression, nested object literals inline, plus a
 * named declaration for each `$ref` target. What it handles:
 *
 * - `$ref` into `$defs`, `definitions` or any other JSON pointer in the same
 *   document, including `#` itself; each target becomes one named type, so
 *   recursive schemas terminate. A reference to another document is `unknown`.
 * - Property names that are not identifiers (`app.kubernetes.io/name`,
 *   `use-forwarded-headers`) are quoted, never renamed: a Helm values key or
 *   a CRD field is a literal the consumer reads back.
 * - `additionalProperties` as a schema becomes an index signature, so maps of
 *   objects keep their value type; `false` closes the object. Whether an
 *   object with neither is open is the caller's choice (`openByDefault`): JSON
 *   Schema says open, a Kubernetes structural schema says closed.
 * - `enum` and `const` become literal unions; `oneOf`/`anyOf` unions;
 *   `allOf` intersections; `type` arrays and `nullable` unions with `null`.
 * - `x-kubernetes-int-or-string` and `x-kubernetes-preserve-unknown-fields`.
 */

/** Options for {@link schemaToTypeScript}. */
export interface SchemaToTsOptions {
  /** Make every object member optional, whatever `required` says (a Helm values override sets any subset). */
  allOptional?: boolean;
  /**
   * Whether an object with no `additionalProperties` accepts keys it does not
   * list. Default `true`, JSON Schema's rule. Pass `false` for a Kubernetes
   * structural schema, where only `x-kubernetes-preserve-unknown-fields` (or
   * an object with no `properties` at all) opens one.
   */
  openByDefault?: boolean;
  /** Prefix for the names of `$ref` target declarations. Default none. */
  namePrefix?: string;
  /** The name a `$ref: "#"` resolves to; the caller declares the root type under it. Default `${namePrefix}Root`. */
  rootName?: string;
}

/** A named type a `$ref` target produced. */
export interface SchemaTsDeclaration {
  name: string;
  /** The type expression, at indentation zero. */
  type: string;
  description?: string;
}

/** What {@link schemaToTypeScript} returns. */
export interface SchemaToTsResult {
  /** The root schema's type expression, at indentation zero. */
  type: string;
  /** Declarations the expression (or another declaration) references, in first-reference order. */
  declarations: SchemaTsDeclaration[];
}

type Schema = Record<string, unknown>;

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Quote an object key unless it is a plain identifier. Never renames. */
export function tsPropertyKey(name: string): string {
  return IDENT.test(name) ? name : JSON.stringify(name);
}

/** A JSDoc block for `text` at `indent`, or nothing when there is no text. */
export function jsdocLines(text: unknown, indent: string): string[] {
  if (typeof text !== "string" || text.trim() === "") return [];
  const lines = text.trim().replace(/\*\//g, "*\\/").split(/\r?\n/);
  if (lines.length === 1) return [`${indent}/** ${lines[0]} */`];
  return [`${indent}/**`, ...lines.map((l) => (l.trim() === "" ? `${indent} *` : `${indent} * ${l}`)), `${indent} */`];
}

/** Render a JSON Schema as a TypeScript type expression plus the declarations it references. */
export function schemaToTypeScript(schema: unknown, options: SchemaToTsOptions = {}): SchemaToTsResult {
  const converter = new Converter(schema, options);
  const type = converter.convert(schema, "");
  return { type, declarations: converter.declarations() };
}

class Converter {
  private readonly names = new Map<string, string>();
  private readonly decls = new Map<string, SchemaTsDeclaration>();
  private readonly used = new Set<string>();
  private readonly prefix: string;
  private readonly rootName: string;

  constructor(
    private readonly root: unknown,
    private readonly opts: SchemaToTsOptions,
  ) {
    this.prefix = opts.namePrefix ?? "";
    this.rootName = opts.rootName ?? `${this.prefix}Root`;
    this.used.add(this.rootName);
  }

  declarations(): SchemaTsDeclaration[] {
    return [...this.decls.values()];
  }

  convert(node: unknown, indent: string): string {
    if (node === true || node === undefined) return "unknown";
    if (node === false) return "never";
    if (!isObject(node)) return "unknown";

    if (typeof node.$ref === "string") return this.ref(node.$ref);

    if (node.const !== undefined) return literal(node.const) ?? "unknown";
    if (Array.isArray(node.enum) && node.enum.length > 0) {
      const literals = node.enum.map(literal);
      if (literals.every((l): l is string => l !== undefined)) return union(literals);
    }
    if (node["x-kubernetes-int-or-string"] === true) return "number | string";

    const parts: string[] = [];
    const base = this.baseType(node, indent);
    if (base) parts.push(base);

    const all = shapedBranches(node.allOf);
    for (const branch of all) parts.push(paren(this.convert(branch, indent)));

    const alternatives = shapedBranches(node.oneOf ?? node.anyOf);
    if (alternatives.length > 0) {
      parts.push(paren(union(alternatives.map((b) => this.convert(b, indent)))));
    }

    if (parts.length === 0) return "unknown";
    const type = parts.length === 1 ? unparen(parts[0]) : parts.join(" & ");
    return node.nullable === true && type !== "unknown" ? union([paren(type), "null"]) : type;
  }

  /** The type `type` (or the presence of `properties`/`items`) implies, before combinators. */
  private baseType(node: Schema, indent: string): string | undefined {
    let types: string[];
    if (typeof node.type === "string") types = [node.type];
    else if (Array.isArray(node.type)) types = node.type.filter((t): t is string => typeof t === "string");
    else if (node.properties || node.additionalProperties !== undefined || node.patternProperties) types = ["object"];
    else if (node.items) types = ["array"];
    else if (node["x-kubernetes-preserve-unknown-fields"] === true) types = ["object"];
    else types = [];

    const out = types.map((t) => {
      switch (t) {
        case "string":
          return "string";
        case "integer":
        case "number":
          return "number";
        case "boolean":
          return "boolean";
        case "null":
          return "null";
        case "array":
          return this.arrayType(node, indent);
        case "object":
          return this.objectType(node, indent);
        default:
          return "unknown";
      }
    });
    return out.length > 0 ? union(out) : undefined;
  }

  private arrayType(node: Schema, indent: string): string {
    const items = node.items;
    if (items === undefined || Array.isArray(items)) return "unknown[]";
    const item = this.convert(items, indent);
    return /^[A-Za-z_$][A-Za-z0-9_$.]*$/.test(item) ? `${item}[]` : `Array<${item}>`;
  }

  private objectType(node: Schema, indent: string): string {
    const props = isObject(node.properties) ? node.properties : {};
    const names = Object.keys(props);
    const required = new Set(Array.isArray(node.required) ? node.required.filter((r) => typeof r === "string") : []);
    const inner = indent + "  ";

    // The index signature, if the object accepts keys it does not list.
    let index: string | undefined;
    const additional = node.additionalProperties;
    if (additional === false) {
      index = undefined;
    } else if (isObject(additional)) {
      index = this.convert(additional, inner);
    } else if (additional === true) {
      index = "unknown";
    } else if (isObject(node.patternProperties) && Object.keys(node.patternProperties).length > 0) {
      index = union(Object.values(node.patternProperties).map((p) => this.convert(p, inner)));
    } else if (
      node["x-kubernetes-preserve-unknown-fields"] === true ||
      names.length === 0 ||
      this.opts.openByDefault !== false
    ) {
      index = "unknown";
    }

    if (names.length === 0) {
      return index === undefined ? "Record<string, never>" : `Record<string, ${index}>`;
    }

    const lines = ["{"];
    const memberTypes: string[] = [];
    for (const name of names) {
      const child = props[name];
      const type = this.convert(child, inner);
      const optional = this.opts.allOptional || !required.has(name);
      memberTypes.push(type);
      if (optional) memberTypes.push("undefined");
      lines.push(...jsdocLines(isObject(child) ? child.description : undefined, inner));
      lines.push(`${inner}${tsPropertyKey(name)}${optional ? "?" : ""}: ${type};`);
    }
    if (index !== undefined) {
      // A listed member must be assignable to the index signature, so a typed
      // map that also lists members widens its signature to cover them.
      const signature = index === "unknown" ? index : union([index, ...memberTypes].map(paren));
      lines.push(`${inner}[key: string]: ${signature};`);
    }
    lines.push(`${indent}}`);
    return lines.join("\n");
  }

  private ref(ref: string): string {
    if (ref === "#" || ref === "#/") return this.rootName;
    const existing = this.names.get(ref);
    if (existing) return existing;
    if (!ref.startsWith("#/")) return "unknown";
    const target = resolvePointer(this.root, ref.slice(2));
    if (target === undefined) return "unknown";

    const segments = ref.slice(2).split("/");
    const name = this.uniqueName(this.prefix + pascal(decodePointerSegment(segments[segments.length - 1])));
    this.names.set(ref, name);
    // Reserve the slot before converting, so a self-reference resolves to the name.
    const decl: SchemaTsDeclaration = { name, type: "unknown" };
    if (isObject(target) && typeof target.description === "string") decl.description = target.description;
    this.decls.set(name, decl);
    decl.type = this.convert(target, "");
    return name;
  }

  private uniqueName(base: string): string {
    let name = IDENT.test(base) ? base : `${this.prefix}Def`;
    if (!this.used.has(name)) {
      this.used.add(name);
      return name;
    }
    let i = 2;
    while (this.used.has(`${name}${i}`)) i++;
    name = `${name}${i}`;
    this.used.add(name);
    return name;
  }
}

function isObject(value: unknown): value is Schema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Branches of a combinator that say something about shape; constraint-only branches (`{ required: [...] }`) say nothing a type can. */
function shapedBranches(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (b) =>
      b === false ||
      (isObject(b) &&
        ["type", "$ref", "properties", "items", "enum", "const", "additionalProperties", "allOf", "oneOf", "anyOf"].some(
          (k) => k in b,
        )),
  );
}

function literal(value: unknown): string | undefined {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function union(types: string[]): string {
  const unique = [...new Set(types)];
  if (unique.includes("unknown")) return "unknown";
  return unique.join(" | ");
}

/** Parenthesize a union or intersection so it can be an operand. */
function paren(type: string): string {
  return hasTopLevelOperator(type) ? `(${type})` : type;
}

/** Strip one pair of parentheses that wraps the whole expression. */
function unparen(type: string): string {
  if (!type.startsWith("(") || closingIndex(type, 0) !== type.length - 1) return type;
  return type.slice(1, -1);
}

/** Whether `type` has a `|` or `&` outside any brackets or string literal. */
function hasTopLevelOperator(type: string): boolean {
  let depth = 0;
  for (let i = 0; i < type.length; i++) {
    const c = type[i];
    if (c === '"') i = stringEnd(type, i);
    else if (c === "/" && type[i + 1] === "*") i = commentEnd(type, i);
    else if (c === "(" || c === "{" || c === "[" || c === "<") depth++;
    else if (c === ")" || c === "}" || c === "]" || c === ">") depth--;
    else if (depth === 0 && (c === "|" || c === "&")) return true;
  }
  return false;
}

/** Index of the bracket closing the one at `open`, or -1. */
function closingIndex(type: string, open: number): number {
  let depth = 0;
  for (let i = open; i < type.length; i++) {
    const c = type[i];
    if (c === '"') i = stringEnd(type, i);
    else if (c === "/" && type[i + 1] === "*") i = commentEnd(type, i);
    else if (c === "(" || c === "{" || c === "[" || c === "<") depth++;
    else if (c === ")" || c === "}" || c === "]" || c === ">") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Index of the `/` closing the block comment that opens at `start`. */
function commentEnd(type: string, start: number): number {
  const end = type.indexOf("*/", start + 2);
  return end === -1 ? type.length : end + 1;
}

/** Index of the quote closing the JSON string literal that opens at `start`. */
function stringEnd(type: string, start: number): number {
  for (let i = start + 1; i < type.length; i++) {
    if (type[i] === "\\") i++;
    else if (type[i] === '"') return i;
  }
  return type.length;
}

function decodePointerSegment(segment: string): string {
  let s = segment;
  try {
    s = decodeURIComponent(s);
  } catch {
    // Not percent-encoded; use as is.
  }
  return s.replace(/~1/g, "/").replace(/~0/g, "~");
}

function resolvePointer(root: unknown, pointer: string): unknown {
  let node: unknown = root;
  for (const raw of pointer.split("/")) {
    if (raw === "") continue;
    const key = decodePointerSegment(raw);
    if (Array.isArray(node)) node = node[Number(key)];
    else if (isObject(node)) node = node[key];
    else return undefined;
    if (node === undefined) return undefined;
  }
  return node;
}

/** PascalCase an arbitrary definition name into an identifier fragment. */
function pascal(name: string): string {
  const out = name
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("");
  return /^[0-9]/.test(out) ? `_${out}` : out;
}
