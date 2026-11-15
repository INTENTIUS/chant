/**
 * Evaluate a block's arguments from the files a plan reads, per module
 * instance (chant #5117).
 *
 * The reference catalog (`../behaviour/reference-catalog.ts`) matches values
 * written on a node. A declared block mostly holds expressions instead:
 * `account_id = var.name`, where the variable is set by a module call from
 * `each.key`, and `project = var.project_id`, set from another module's
 * output. This module follows those expressions back to a literal where the
 * source alone says what it is, so the catalog has the value to match.
 *
 * It resolves, in one module instance:
 *
 * - `var.<x>` from the call's argument (evaluated in the caller), else the
 *   variable's default; in the root module from the tfvars files
 *   `./instances.ts` reads, then the default;
 * - `local.<x>`, `each.key`, `each.value` and `count.index`;
 * - `module.<call>.<output>`, when the output's value resolves in the child;
 * - `<type>.<name>.<arg>` in the same module, when the block sets `<arg>`;
 * - `"${...}"` interpolation whose every part resolves;
 * - `lookup(map, key, default)`, `toset()`, `length()` and `cond ? a : b`
 *   over a known bool, plus list and object constructors and index steps.
 *
 * Anything else is unknown, and an unknown value carries the first
 * reference that stopped it: a data source (`data.google_organization.org.org_id`),
 * a function (`timestamp()`), an attribute the provider computes
 * (`google_service_account.sa.email`), a variable nothing sets, an operator
 * this reader does not evaluate. A reference inside a child module is named
 * with the module path in front, as Terraform prints addresses
 * (`module.project.data.google_organization.org.org_id`). A sensitive
 * variable or output is unknown, so a value marked sensitive never reaches
 * the graph. No plan, state or provider is read.
 *
 * Pure apart from what it is handed: the parsed entities of one root, its
 * tfvars values, and a module path.
 */

import { isResourceDeclarable, type Declarable } from "@intentius/chant/declarable";
import {
  LOCALS_TYPE,
  MODULE_TYPE,
  OUTPUT_TYPE,
  RESOURCE_TYPE,
  VARIABLE_TYPE,
  scopeOfKey,
  type BlockBody,
  type TerraformEntity,
} from "./parse";

/** A value the source does not determine, and the reference that stopped it. */
export class Unknown {
  constructor(readonly ref: string) {}
}

export const isUnknown = (v: unknown): v is Unknown => v instanceof Unknown;

/** Lists `toset()` made, so `for_each` can tell a set from a list. */
const SETS = new WeakSet<unknown[]>();

/** Whether a value is a set `toset()` made. */
export const isSetValue = (v: unknown): boolean => Array.isArray(v) && SETS.has(v);

/** The first unknown inside a value, depth first, or undefined when the value is wholly known. */
export function firstUnknown(v: unknown, depth = 0): Unknown | undefined {
  if (v instanceof Unknown) return v;
  if (depth > 32) return undefined;
  if (Array.isArray(v)) {
    for (const x of v) {
      const u = firstUnknown(x, depth + 1);
      if (u) return u;
    }
  } else if (typeof v === "object" && v !== null) {
    for (const x of Object.values(v)) {
      const u = firstUnknown(x, depth + 1);
      if (u) return u;
    }
  }
  return undefined;
}

// ── Expressions ──────────────────────────────────────────────────────────────

type Step = { attr: string } | { index: Expr } | { splat: true };

type Expr =
  | { t: "lit"; v: unknown }
  | { t: "tpl"; parts: Array<string | Expr>; text: string }
  | { t: "ref"; root: string; steps: Step[]; text: string }
  | { t: "post"; of: Expr; steps: Step[]; text: string }
  | { t: "call"; name: string; args: Expr[]; text: string }
  | { t: "cond"; c: Expr; a: Expr; b: Expr }
  | { t: "tuple"; items: Expr[] }
  | { t: "object"; entries: Array<[Expr, Expr]> };

/** An expression this reader does not evaluate; `text` names it, cut to 80 characters. */
class Unsupported extends Error {
  readonly text: string;
  constructor(text: string) {
    const flat = text.replace(/\s+/g, " ").trim();
    super(flat);
    this.text = flat.length > 80 ? `${flat.slice(0, 77)}...` : flat;
  }
}

/** Index just past the `}` that closes the `{` at `open`, skipping strings. -1 when unclosed. */
function closeBrace(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '"') {
      i = skipQuoted(s, i) - 1;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i + 1;
  }
  return -1;
}

/** Index just past the string opened at `i`, its interpolations included. */
function skipQuoted(s: string, i: number): number {
  i++;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") i += 2;
    else if (c === "$" && s[i + 1] === "$" && s[i + 2] === "{") i += 3;
    else if (c === "$" && s[i + 1] === "{") {
      const end = closeBrace(s, i + 1);
      if (end === -1) return s.length;
      i = end;
    } else if (c === '"') return i + 1;
    else i++;
  }
  return s.length;
}

/**
 * A template's parts: literal text and the expressions of its `${...}`.
 * `$${` is a literal `${`. A `%{` directive is not read.
 */
function parseTemplate(s: string, unescape: (t: string) => string): Array<string | Expr> {
  const parts: Array<string | Expr> = [];
  let lit = "";
  let i = 0;
  while (i < s.length) {
    if (s.startsWith("$${", i)) {
      lit += "${";
      i += 3;
    } else if (s.startsWith("%%{", i)) {
      lit += "%{";
      i += 3;
    } else if (s.startsWith("%{", i)) {
      throw new Unsupported(s);
    } else if (s.startsWith("${", i)) {
      const end = closeBrace(s, i + 1);
      if (end === -1) throw new Unsupported(s);
      if (lit) parts.push(unescape(lit));
      lit = "";
      parts.push(parseExpression(s.slice(i + 2, end - 1).replace(/^~/, "").replace(/~$/, "")));
      i = end;
    } else {
      lit += s[i];
      i++;
    }
  }
  if (lit) parts.push(unescape(lit));
  return parts;
}

/** The escapes of a quoted HCL string. */
function unescapeQuoted(t: string): string {
  return t.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (_, e: string) => {
    if (e === "n") return "\n";
    if (e === "t") return "\t";
    if (e === "r") return "\r";
    if (e[0] === "u" || e[0] === "U") return String.fromCodePoint(parseInt(e.slice(1), 16));
    return e;
  });
}

type Tok = { k: "id" | "num" | "str" | "p"; v: string; at: number; end: number };

const PUNCT = ["...", "==", "!=", "<=", ">=", "&&", "||", "=>", "(", ")", "[", "]", "{", "}", ",", ".", "?", ":", "=", "*", "!", "+", "-", "/", "%", "<", ">"];

function tokenize(s: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (/\s/.test(c)) {
      i++;
    } else if (c === "#" || s.startsWith("//", i)) {
      while (i < s.length && s[i] !== "\n") i++;
    } else if (s.startsWith("/*", i)) {
      const end = s.indexOf("*/", i + 2);
      i = end === -1 ? s.length : end + 2;
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(s.slice(i))!;
      out.push({ k: "id", v: m[0], at: i, end: i + m[0].length });
      i += m[0].length;
    } else if (/[0-9]/.test(c)) {
      const m = /^[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(s.slice(i))!;
      out.push({ k: "num", v: m[0], at: i, end: i + m[0].length });
      i += m[0].length;
    } else if (c === '"') {
      const end = skipQuoted(s, i);
      out.push({ k: "str", v: s.slice(i + 1, end - 1), at: i, end });
      i = end;
    } else if (s.startsWith("<<", i)) {
      throw new Unsupported(s.trim());
    } else {
      const p = PUNCT.find((x) => s.startsWith(x, i));
      if (!p) throw new Unsupported(s.trim());
      out.push({ k: "p", v: p, at: i, end: i + p.length });
      i += p.length;
    }
  }
  return out;
}

/** Parse the inside of one `${...}`. Throws {@link Unsupported} on a form this reader does not evaluate. */
function parseExpression(src: string): Expr {
  const toks = tokenize(src);
  let pos = 0;
  const peek = (v?: string): Tok | undefined => {
    const t = toks[pos];
    return t && (v === undefined || (t.k === "p" && t.v === v)) ? t : undefined;
  };
  const expect = (v: string): Tok => {
    const t = peek(v);
    if (!t) throw new Unsupported(src.trim());
    pos++;
    return t;
  };
  const textFrom = (start: number): string => src.slice(toks[start]!.at, toks[pos - 1]!.end).trim();

  const steps = (): Step[] => {
    const out: Step[] = [];
    for (;;) {
      if (peek(".")) {
        pos++;
        const t = toks[pos];
        if (t?.k === "id") out.push({ attr: t.v });
        else if (t?.k === "num") out.push({ index: { t: "lit", v: Number(t.v) } });
        else if (t?.k === "p" && t.v === "*") out.push({ splat: true });
        else throw new Unsupported(src.trim());
        pos++;
      } else if (peek("[")) {
        pos++;
        if (peek("*")) {
          pos++;
          out.push({ splat: true });
        } else out.push({ index: expr() });
        expect("]");
      } else return out;
    }
  };

  const primary = (): Expr => {
    const start = pos;
    const t = toks[pos];
    if (!t) throw new Unsupported(src.trim());
    pos++;
    if (t.k === "num") return { t: "lit", v: Number(t.v) };
    if (t.k === "str") return { t: "tpl", parts: parseTemplate(t.v, unescapeQuoted), text: src.slice(t.at, t.end) };
    if (t.k === "id") {
      if (t.v === "true" || t.v === "false") return { t: "lit", v: t.v === "true" };
      if (t.v === "null") return { t: "lit", v: null };
      if (peek("(")) {
        pos++;
        const args: Expr[] = [];
        while (!peek(")")) {
          args.push(expr());
          if (peek("...")) throw new Unsupported(src.trim());
          if (!peek(",")) break;
          pos++;
        }
        expect(")");
        return { t: "call", name: t.v, args, text: textFrom(start) };
      }
      const s = steps();
      return { t: "ref", root: t.v, steps: s, text: textFrom(start) };
    }
    if (t.v === "-" && toks[pos]?.k === "num") {
      pos++;
      return { t: "lit", v: -Number(toks[pos - 1]!.v) };
    }
    if (t.v === "(") {
      const inner = expr();
      expect(")");
      return inner;
    }
    if (t.v === "[") {
      if (toks[pos]?.k === "id" && toks[pos]!.v === "for") throw new Unsupported(src.trim());
      const items: Expr[] = [];
      while (!peek("]")) {
        items.push(expr());
        if (!peek(",")) break;
        pos++;
      }
      expect("]");
      return { t: "tuple", items };
    }
    if (t.v === "{") {
      if (toks[pos]?.k === "id" && toks[pos]!.v === "for") throw new Unsupported(src.trim());
      const entries: Array<[Expr, Expr]> = [];
      while (!peek("}")) {
        const k = toks[pos];
        let key: Expr;
        if (k?.k === "id" && (toks[pos + 1]?.v === "=" || toks[pos + 1]?.v === ":")) {
          key = { t: "lit", v: k.v };
          pos++;
        } else key = expr();
        if (peek("=") || peek(":")) pos++;
        else throw new Unsupported(src.trim());
        entries.push([key, expr()]);
        if (peek(",")) pos++;
      }
      expect("}");
      return { t: "object", entries };
    }
    throw new Unsupported(src.trim());
  };

  const postfix = (): Expr => {
    const start = pos;
    const p = primary();
    if (p.t === "ref") return p;
    const s = steps();
    return s.length === 0 ? p : { t: "post", of: p, steps: s, text: textFrom(start) };
  };

  const expr = (): Expr => {
    const c = postfix();
    const next = toks[pos];
    if (next?.k === "p" && next.v === "?") {
      pos++;
      const a = expr();
      expect(":");
      const b = expr();
      return { t: "cond", c, a, b };
    }
    if (next?.k === "p" && ![")", "]", "}", ",", ":", "...", "="].includes(next.v)) throw new Unsupported(src.trim());
    return c;
  };

  const e = expr();
  if (pos < toks.length) throw new Unsupported(src.trim());
  return e;
}

const parsed = new Map<string, Expr | Unsupported>();

/** A hcl2json string as an expression: a template, or one bare `${...}` whose value is the expression's own. */
function parseValueString(s: string): Expr | Unsupported {
  const hit = parsed.get(s);
  if (hit) return hit;
  let out: Expr | Unsupported;
  try {
    const parts = parseTemplate(s, (t) => t);
    out = parts.length === 1 && typeof parts[0] !== "string" ? parts[0]! : { t: "tpl", parts, text: s };
  } catch (err) {
    out = err instanceof Unsupported ? err : new Unsupported(s);
  }
  if (parsed.size > 20_000) parsed.clear();
  parsed.set(s, out);
  return out;
}

// ── Scopes ───────────────────────────────────────────────────────────────────

/** One module instance: the entity-key scope its blocks sit in and its Terraform path. */
export interface ModulePlace {
  /** The entity-key scope, `estate` or `estate/module.a/module.b`. */
  scope: string;
  /** The module path as Terraform prints it, `""` for the root, `module.a["x"].module.b`. */
  path: string;
  parent?: ModulePlace;
  /** The call's iteration for this instance, when the call is expanded. */
  iteration?: Iteration;
}

/** `each` and `count` for one instance of an expanded block or call. */
export interface Iteration {
  each?: { key: unknown; value: unknown } | Unknown;
  count?: number | Unknown;
}

interface Env {
  place: ModulePlace;
  iteration?: Iteration;
}

const SEGMENT_RE = /^module\.([A-Za-z_][A-Za-z0-9_-]*)(\[(?:[0-9]+|"(?:[^"\\]|\\.)*")\])?(?:\.|$)/;

/** The key text of an instance key, `[0]` or `["a"]`, as a number or a string. */
export function instanceKeyValue(key: string): number | string | undefined {
  const inner = key.slice(1, -1);
  if (/^[0-9]+$/.test(inner)) return Number(inner);
  try {
    const v = JSON.parse(inner) as unknown;
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

function bodyOf(entity: Declarable | undefined): BlockBody {
  const body = entity && isResourceDeclarable(entity) ? (entity as TerraformEntity).props.body : undefined;
  return (typeof body === "object" && body !== null ? body : {}) as BlockBody;
}

const expanded = (body: BlockBody): "count" | "for_each" | undefined => ("count" in body ? "count" : "for_each" in body ? "for_each" : undefined);

/**
 * Evaluates expressions over one root's parsed entities. Build it once per
 * root, after the descent into local modules.
 */
export class RootEvaluator {
  private readonly vars = new Map<string, Map<string, TerraformEntity>>();
  private readonly locals = new Map<string, Map<string, unknown>>();
  private readonly memo = new Map<string, unknown>();
  private readonly places = new Map<string, ModulePlace>();
  private readonly visiting = new Set<string>();
  private depth = 0;

  constructor(
    private readonly entities: ReadonlyMap<string, Declarable>,
    private readonly root: string,
    private readonly tfvars: ReadonlyMap<string, unknown> = new Map(),
  ) {
    for (const [key, e] of entities) {
      if (!(key === root || key.startsWith(`${root}/`)) || !isResourceDeclarable(e)) continue;
      const entity = e as TerraformEntity;
      const scope = scopeOfKey(key);
      if (entity.entityType === VARIABLE_TYPE && entity.props.address.startsWith("var.")) {
        (this.vars.get(scope) ?? this.vars.set(scope, new Map()).get(scope)!).set(entity.props.address.slice(4), entity);
      } else if (entity.entityType === LOCALS_TYPE) {
        const into = this.locals.get(scope) ?? this.locals.set(scope, new Map()).get(scope)!;
        for (const [name, value] of Object.entries(bodyOf(entity))) into.set(name, value);
      }
    }
  }

  /** The root module's place. */
  rootPlace(): ModulePlace {
    return this.placeAt(undefined, this.root, "", undefined);
  }

  private placeAt(parent: ModulePlace | undefined, scope: string, path: string, iteration: Iteration | undefined): ModulePlace {
    const hit = this.places.get(path === "" ? `\u0000${scope}` : path);
    if (hit && hit.scope === scope) return hit;
    const place: ModulePlace = { scope, path, ...(parent ? { parent } : {}), ...(iteration ? { iteration } : {}) };
    this.places.set(path === "" ? `\u0000${scope}` : path, place);
    return place;
  }

  /**
   * The place an instance's scope names (`module.a["x"].module.b`, as
   * `withInstanceNodes` carries it), or undefined when a call on the way is
   * not a module call of this root.
   */
  placeOfInstanceScope(instanceScope: string): ModulePlace | undefined {
    let place = this.rootPlace();
    let rest = instanceScope;
    while (rest !== "") {
      const m = SEGMENT_RE.exec(rest);
      if (!m) return undefined;
      rest = rest.slice(m[0].length);
      const next = this.childPlace(place, m[1]!, m[2] === undefined ? undefined : instanceKeyValue(m[2]));
      if (!next || isUnknown(next)) return undefined;
      place = next;
    }
    return place;
  }

  /**
   * The place of a block-level read of an entity-key scope: every expanded
   * call on the way has an unknown iteration, since the block stands for all
   * of its instances.
   */
  placeOfScope(scope: string): ModulePlace | undefined {
    let place = this.rootPlace();
    if (scope === this.root) return place;
    if (!scope.startsWith(`${this.root}/`)) return undefined;
    for (const segment of scope.slice(this.root.length + 1).split("/")) {
      if (!segment.startsWith("module.")) return undefined;
      const name = segment.slice("module.".length);
      const callKey = `${place.scope}/module.${name}`;
      const call = this.entities.get(callKey);
      if (!call || (call as TerraformEntity).entityType !== MODULE_TYPE) return undefined;
      const how = expanded(bodyOf(call));
      const pathSeg = `module.${name}`;
      const path = place.path ? `${place.path}.${pathSeg}` : pathSeg;
      const iteration: Iteration | undefined = how === "for_each"
        ? { each: new Unknown(prefixed(place, "each.key")) }
        : how === "count" ? { count: new Unknown(prefixed(place, "count.index")) } : undefined;
      place = this.placeAt(place, `${callKey}`, `${path}${how ? "[*]" : ""}`, iteration);
    }
    return place;
  }

  /** A module call's instance place, or an unknown when its key is not known; undefined when there is no such call. */
  private childPlace(place: ModulePlace, name: string, key: number | string | undefined): ModulePlace | Unknown | undefined {
    const callKey = `${place.scope}/module.${name}`;
    const call = this.entities.get(callKey);
    if (!call || (call as TerraformEntity).entityType !== MODULE_TYPE) return undefined;
    const body = bodyOf(call);
    const how = expanded(body);
    const seg = `module.${name}`;
    if (!how) {
      if (key !== undefined) return new Unknown(prefixed(place, `${seg}[${JSON.stringify(key)}]`));
      return this.placeAt(place, callKey, place.path ? `${place.path}.${seg}` : seg, undefined);
    }
    if (key === undefined) return new Unknown(prefixed(place, seg));
    const iteration = this.iterationOf(body, { place }, key);
    const keyText = typeof key === "number" ? `[${key}]` : `[${JSON.stringify(key)}]`;
    return this.placeAt(place, callKey, `${place.path ? `${place.path}.` : ""}${seg}${keyText}`, iteration);
  }

  /** The iteration of one instance of an expanded block, by its key. */
  iterationOf(body: BlockBody, env: Env, key: number | string): Iteration {
    if ("count" in body) return { count: typeof key === "number" ? key : new Unknown(prefixed(env.place, "count.index")) };
    const all = this.value(body.for_each, { place: env.place });
    if (isUnknown(all)) return { each: all };
    if (Array.isArray(all)) return { each: { key, value: key } };
    if (typeof all === "object" && all !== null && typeof key === "string" && key in all) {
      return { each: { key, value: (all as Record<string, unknown>)[key] } };
    }
    return { each: new Unknown(prefixed(env.place, "each.key")) };
  }

  /** The block-level iteration of a block: unknown when it is expanded, none when it is not. */
  blockIteration(body: BlockBody, place: ModulePlace): Iteration | undefined {
    const how = expanded(body);
    if (how === "for_each") return { each: new Unknown(prefixed(place, "each.key")) };
    if (how === "count") return { count: new Unknown(prefixed(place, "count.index")) };
    return undefined;
  }

  /**
   * A value from a parsed body (a literal, a hcl2json `"${...}"` string, or a
   * list or map of those) evaluated in a place. Unknown parts stay
   * {@link Unknown}; a map keeps its known entries beside them.
   */
  value(raw: unknown, env: Env): unknown {
    if (this.depth > 64) return new Unknown("(expression too deep)");
    this.depth++;
    try {
      if (typeof raw === "string") {
        if (!raw.includes("${") && !raw.includes("%{")) return raw;
        const expr = parseValueString(raw);
        if (expr instanceof Unsupported) return new Unknown(prefixed(env.place, expr.text));
        return this.expr(expr, env);
      }
      if (Array.isArray(raw)) return raw.map((v) => this.value(v, env));
      if (typeof raw === "object" && raw !== null) {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(raw)) {
          let key: unknown = k;
          if (k.includes("${")) key = this.value(k, env);
          if (typeof key !== "string") return isUnknown(key) ? key : new Unknown(prefixed(env.place, k));
          out[key] = this.value(v, env);
        }
        return out;
      }
      return raw;
    } finally {
      this.depth--;
    }
  }

  private expr(e: Expr, env: Env): unknown {
    switch (e.t) {
      case "lit":
        return e.v;
      case "tpl": {
        let out = "";
        for (const p of e.parts) {
          if (typeof p === "string") {
            out += p;
            continue;
          }
          const v = this.expr(p, env);
          if (isUnknown(v)) return v;
          if (typeof v === "string") out += v;
          else if (typeof v === "number" || typeof v === "boolean") out += String(v);
          else return new Unknown(prefixed(env.place, e.text));
        }
        return out;
      }
      case "tuple":
        return e.items.map((i) => this.expr(i, env));
      case "object": {
        const out: Record<string, unknown> = {};
        for (const [k, v] of e.entries) {
          const key = this.expr(k, env);
          if (isUnknown(key)) return key;
          if (typeof key !== "string" && typeof key !== "number") return new Unknown(prefixed(env.place, "(object key)"));
          out[String(key)] = this.expr(v, env);
        }
        return out;
      }
      case "cond": {
        const c = this.expr(e.c, env);
        if (isUnknown(c)) return c;
        if (typeof c !== "boolean") return new Unknown(prefixed(env.place, "(condition)"));
        return this.expr(c ? e.a : e.b, env);
      }
      case "call":
        return this.call(e, env);
      case "post":
        return this.steps(this.expr(e.of, env), e.steps, env, e.text);
      case "ref":
        return this.ref(e, env);
    }
  }

  private call(e: Extract<Expr, { t: "call" }>, env: Env): unknown {
    const args = () => e.args.map((a) => this.expr(a, env));
    if (e.name === "lookup" && (e.args.length === 2 || e.args.length === 3)) {
      const [map, key, dflt] = args();
      if (isUnknown(map)) return map;
      if (isUnknown(key)) return key;
      if (typeof map !== "object" || map === null || Array.isArray(map) || typeof key !== "string") return new Unknown(prefixed(env.place, e.text));
      if (key in map) return (map as Record<string, unknown>)[key];
      return e.args.length === 3 ? dflt : new Unknown(prefixed(env.place, e.text));
    }
    if (e.name === "toset" && e.args.length === 1) {
      const [list] = args();
      const u = firstUnknown(list);
      if (u) return u;
      if (!Array.isArray(list)) return new Unknown(prefixed(env.place, e.text));
      const set = list.every((v) => typeof v === "string") ? [...new Set(list as string[])].sort() : [...list];
      SETS.add(set);
      return set;
    }
    if (e.name === "length" && e.args.length === 1) {
      const [v] = args();
      if (isUnknown(v)) return v;
      if (Array.isArray(v)) return v.length;
      if (typeof v === "object" && v !== null) return Object.keys(v).length;
      if (typeof v === "string") return [...v].length;
      return new Unknown(prefixed(env.place, e.text));
    }
    return new Unknown(prefixed(env.place, `${e.name}()`));
  }

  /** Apply traversal steps to a value. `text` names the whole traversal when a step does not apply. */
  private steps(v: unknown, steps: readonly Step[], env: Env, text: string): unknown {
    let cur = v;
    for (const s of steps) {
      if (isUnknown(cur)) return cur;
      if ("splat" in s) return new Unknown(prefixed(env.place, text));
      let key: unknown;
      if ("attr" in s) key = s.attr;
      else {
        key = this.expr(s.index, env);
        if (isUnknown(key)) return key;
      }
      if (Array.isArray(cur) && typeof key === "number" && key >= 0 && key < cur.length) cur = cur[key];
      else if (typeof cur === "object" && cur !== null && !Array.isArray(cur) && (typeof key === "string" || typeof key === "number") && String(key) in cur) {
        cur = (cur as Record<string, unknown>)[String(key)];
      } else return new Unknown(prefixed(env.place, text));
    }
    return cur;
  }

  private ref(e: Extract<Expr, { t: "ref" }>, env: Env): unknown {
    const { place } = env;
    const unknown = () => new Unknown(prefixed(place, e.text));
    const first = e.steps[0];
    const firstAttr = first && "attr" in first ? first.attr : undefined;
    switch (e.root) {
      case "var":
        return firstAttr === undefined ? unknown() : this.steps(this.variable(place, firstAttr), e.steps.slice(1), env, e.text);
      case "local":
        return firstAttr === undefined ? unknown() : this.steps(this.local(place, firstAttr), e.steps.slice(1), env, e.text);
      case "each": {
        const each = env.iteration?.each;
        if (!each || (firstAttr !== "key" && firstAttr !== "value")) return unknown();
        if (isUnknown(each)) return new Unknown(prefixed(place, `each.${firstAttr}`));
        return this.steps(firstAttr === "key" ? each.key : each.value, e.steps.slice(1), env, e.text);
      }
      case "count": {
        const count = env.iteration?.count;
        if (count === undefined || firstAttr !== "index" || e.steps.length !== 1) return unknown();
        return isUnknown(count) ? new Unknown(prefixed(place, "count.index")) : count;
      }
      case "module":
        return firstAttr === undefined ? unknown() : this.moduleOutput(e, env, firstAttr);
      case "data":
      case "path":
      case "terraform":
      case "self":
        return unknown();
      default:
        return firstAttr === undefined ? unknown() : this.resourceArgument(e, env, firstAttr);
    }
  }

  /** `module.<call>[key]?.<output>...`. */
  private moduleOutput(e: Extract<Expr, { t: "ref" }>, env: Env, name: string): unknown {
    let i = 1;
    let key: number | string | undefined;
    const idx = e.steps[1];
    if (idx && "index" in idx) {
      const k = this.expr(idx.index, env);
      if (isUnknown(k)) return k;
      if (typeof k !== "number" && typeof k !== "string") return new Unknown(prefixed(env.place, e.text));
      key = k;
      i = 2;
    }
    const child = this.childPlace(env.place, name, key);
    if (child === undefined) return new Unknown(prefixed(env.place, e.text));
    if (isUnknown(child)) return child;
    const out = e.steps[i];
    if (!out || !("attr" in out)) return new Unknown(prefixed(env.place, e.text));
    const output = this.entities.get(`${child.scope}/output.${out.attr}`);
    if (!output || (output as TerraformEntity).entityType !== OUTPUT_TYPE) return new Unknown(prefixed(env.place, e.text));
    const body = bodyOf(output);
    if (body.sensitive === true) return new Unknown(prefixed(child, `output.${out.attr}`));
    const memoKey = `out\u0000${child.path}\u0000${child.scope}\u0000${out.attr}`;
    const v = this.guarded(memoKey, () => this.value(body.value, { place: child }), () => new Unknown(prefixed(child, `output.${out.attr}`)));
    return this.steps(v, e.steps.slice(i + 1), env, e.text);
  }

  /** `<type>.<name>[key]?.<arg>...` in the same module: the argument as the block sets it. */
  private resourceArgument(e: Extract<Expr, { t: "ref" }>, env: Env, name: string): unknown {
    const address = `${e.root}.${name}`;
    const entity = this.entities.get(`${env.place.scope}/${address}`);
    const unknown = () => new Unknown(prefixed(env.place, e.text));
    if (!entity || (entity as TerraformEntity).entityType !== RESOURCE_TYPE) return unknown();
    const body = bodyOf(entity);
    let i = 1;
    let iteration: Iteration | undefined;
    const how = expanded(body);
    if (how) {
      const idx = e.steps[1];
      if (!idx || !("index" in idx)) return unknown();
      const k = this.expr(idx.index, env);
      if (isUnknown(k)) return k;
      if (typeof k !== "number" && typeof k !== "string") return unknown();
      iteration = this.iterationOf(body, { place: env.place }, k);
      i = 2;
    }
    const arg = e.steps[i];
    if (!arg || !("attr" in arg) || !(arg.attr in body) || ["count", "for_each", "depends_on", "provider", "lifecycle"].includes(arg.attr)) return unknown();
    const memoKey = `res\u0000${env.place.path}\u0000${env.place.scope}\u0000${address}\u0000${JSON.stringify(iteration ?? null, (_, v) => (isUnknown(v) ? `?${v.ref}` : v))}\u0000${arg.attr}`;
    const v = this.guarded(memoKey, () => this.value(body[arg.attr], { place: env.place, ...(iteration ? { iteration } : {}) }), unknown);
    return this.steps(v, e.steps.slice(i + 1), env, e.text);
  }

  /** A variable's value in a place. */
  private variable(place: ModulePlace, name: string): unknown {
    const decl = this.vars.get(place.scope)?.get(name);
    const unknown = () => new Unknown(prefixed(place, `var.${name}`));
    if (!decl) return unknown();
    const body = bodyOf(decl);
    if (body.sensitive === true) return unknown();
    return this.guarded(`var\u0000${place.path}\u0000${place.scope}\u0000${name}`, () => {
      if (place.parent === undefined) {
        const v = this.tfvars.has(name) ? this.tfvars.get(name) : body.default;
        return v === undefined || holdsExpression(v) ? unknown() : v;
      }
      const call = this.entities.get(place.scope);
      const callBody = bodyOf(call);
      if (name in callBody) return this.value(callBody[name], { place: place.parent, ...(place.iteration ? { iteration: place.iteration } : {}) });
      return body.default === undefined || holdsExpression(body.default) ? unknown() : body.default;
    }, unknown);
  }

  /** A local value in a place. */
  private local(place: ModulePlace, name: string): unknown {
    const scoped = this.locals.get(place.scope);
    if (!scoped?.has(name)) return new Unknown(prefixed(place, `local.${name}`));
    return this.guarded(`local\u0000${place.path}\u0000${place.scope}\u0000${name}`, () => this.value(scoped.get(name), { place }), () => new Unknown(prefixed(place, `local.${name}`)));
  }

  /** Memoized, and unknown on a cycle. */
  private guarded(key: string, compute: () => unknown, onCycle: () => Unknown): unknown {
    if (this.memo.has(key)) return this.memo.get(key);
    if (this.visiting.has(key)) return onCycle();
    this.visiting.add(key);
    try {
      const v = compute();
      this.memo.set(key, v);
      return v;
    } finally {
      this.visiting.delete(key);
    }
  }
}

/** A reference named as Terraform prints it from the root: the module path in front. */
function prefixed(place: ModulePlace, ref: string): string {
  return place.path ? `${place.path}.${ref}` : ref;
}

/** Whether a value still holds an expression. */
function holdsExpression(value: unknown): boolean {
  if (typeof value === "string") return value.includes("${");
  if (Array.isArray(value)) return value.some(holdsExpression);
  if (typeof value === "object" && value !== null) return Object.entries(value).some(([k, v]) => k.includes("${") || holdsExpression(v));
  return false;
}

// ── Arguments ────────────────────────────────────────────────────────────────

/**
 * What evaluating one block's arguments gave: the arguments that held an
 * expression and resolved, shaped like the body (a nested block keeps its
 * place in its list), and per argument that did not, the reference that
 * stopped it.
 */
export interface EvaluatedArguments {
  arguments?: Record<string, unknown>;
  stopped?: Record<string, string>;
}

const isBlock = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** True when a value holds an interpolation, `${...}`, anywhere in it. */
export function interpolated(value: unknown, depth = 0): boolean {
  if (depth > 12) return false;
  if (typeof value === "string") return value.includes("${");
  if (Array.isArray(value)) return value.some((v) => interpolated(v, depth + 1));
  if (isBlock(value)) return Object.values(value).some((v) => interpolated(v, depth + 1));
  return false;
}

/**
 * Evaluate the arguments of a block body that hold an expression, walking
 * nested blocks and maps the way the catalog's literal view does.
 */
export function evaluateArguments(body: BlockBody, evaluate: (raw: unknown) => unknown): EvaluatedArguments {
  const stopped: Record<string, string> = {};
  const walk = (obj: Record<string, unknown>, path: string, depth: number): Record<string, unknown> | undefined => {
    let out: Record<string, unknown> | undefined;
    for (const [key, value] of Object.entries(obj)) {
      if (depth > 12) break;
      const at = path ? `${path}.${key}` : key;
      if (isBlock(value)) {
        const inner = walk(value, at, depth + 1);
        if (inner) (out ??= {})[key] = inner;
      } else if (Array.isArray(value) && value.length > 0 && value.every(isBlock)) {
        const inner = value.map((b, i) => walk(b, `${at}[${i}]`, depth + 1));
        if (inner.some((x) => x !== undefined)) (out ??= {})[key] = inner.map((x) => x ?? {});
      } else if (interpolated(value)) {
        const v = evaluate(value);
        const u = firstUnknown(v);
        if (u) stopped[at] = u.ref;
        else (out ??= {})[key] = v;
      }
    }
    return out;
  };
  const resolved = walk(body, "", 0);
  return { ...(resolved ? { arguments: resolved } : {}), ...(Object.keys(stopped).length > 0 ? { stopped } : {}) };
}
