/**
 * TypeScript generator for `chant import`.
 *
 * Turns the parser's IR back into the authoring source it came from: one
 * `import` line, then an `export const … = new Policy({ … })` per policy.
 *
 * `Policy` is the schema-driven class `chant generate` emits, and the scope
 * refs it accepts are string-literal unions — so `action: { eq: 'App::Action::"read"' }`
 * is already checked against the schema by the compiler, and an action the
 * schema never declared is an error at the import site. Where the generated
 * registry is on hand, an action UID is emitted as the generated *constant*
 * (`ReadAction`) instead, which reads better and survives a rename; without a
 * registry the literal is the fallback, and it typechecks just the same.
 */

import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type { CedarPolicyIR } from "./parser";

/** The package this generated source imports from. */
export const CEDAR_PACKAGE = "@intentius/chant-lexicon-cedar";

/** The authoring class every imported policy is emitted against. */
const POLICY_CLASS = "Policy";

export interface CedarGenerateOptions {
  /**
   * `App::Action::"read"` → `ReadAction`, from the generated registry.
   *
   * Empty by default: the generator is a pure function of its IR, and the
   * adapter is what goes looking for a registry to fill this in.
   */
  actionConstants?: Record<string, string>;
}

export interface CedarGenerateResult {
  source: string;
  warnings: string[];
}

// ── Identifier sanitization ───────────────────────────────────────

/**
 * A word no export may be called. Not the full reserved list — only the ones a
 * policy id plausibly reduces to.
 */
const RESERVED = new Set([
  "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do",
  "else", "enum", "export", "extends", "false", "finally", "for", "function", "if", "import",
  "in", "instanceof", "new", "null", "return", "super", "switch", "this", "throw", "true", "try",
  "typeof", "var", "void", "while", "with", "yield", "let", "static", "await", "interface",
  "package", "private", "protected", "public", "implements",
]);

/**
 * A Cedar policy id as a JavaScript identifier.
 *
 * `allow-alice-read` → `allowAliceRead`, `legacy_policy` → `legacyPolicy`,
 * `SOC2-AC-3` → `soc2AC3`. A leading segment that is already mixed case keeps
 * its shape apart from the first letter; one that is all caps is lowered whole,
 * so an id like `SOC2` does not come back as `sOC2`.
 */
export function sanitizeName(id: string): string {
  const segments = id.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (segments.length === 0) return "policy";

  const [first, ...rest] = segments;
  const head = /[a-z]/.test(first) ? first[0].toLowerCase() + first.slice(1) : first.toLowerCase();
  const tail = rest.map((segment) => segment[0].toUpperCase() + segment.slice(1)).join("");

  let name = head + tail;
  if (/^[0-9]/.test(name)) name = `policy${name[0].toUpperCase()}${name.slice(1)}`;
  if (RESERVED.has(name)) name = `${name}Policy`;
  return name;
}

/** Give every export a distinct name, in a way a second run reproduces. */
function uniqueNames(entities: CedarPolicyIR[]): string[] {
  const taken = new Set<string>();
  return entities.map((entity) => {
    const base = sanitizeName(entity.name);
    let candidate = base;
    let n = 2;
    while (taken.has(candidate)) candidate = `${base}${n++}`;
    taken.add(candidate);
    return candidate;
  });
}

// ── Props emission ────────────────────────────────────────────────

/**
 * A marker no Cedar value can contain, so a substitution cannot be confused
 * for content. The props go through `JSON.stringify` as data; identifiers are
 * swapped in afterwards by matching the encoded marker exactly.
 */
const MARKER = "\u0000chant:";

const SCOPE_KEYS = ["principal", "action", "resource"] as const;

/**
 * Swap recognized action UIDs for their generated constant, in scope positions
 * only.
 *
 * Not inside `when`/`unless`: those are Cedar expression text, where the UID is
 * part of a larger expression the compiler never sees as a ref.
 */
function markScopeConstants(
  props: Record<string, unknown>,
  actionConstants: Record<string, string>,
  used: Set<string>,
): Record<string, unknown> {
  if (Object.keys(actionConstants).length === 0) return props;

  const mark = (value: unknown): unknown => {
    if (typeof value !== "string") return value;
    const constant = actionConstants[value];
    if (!constant) return value;
    used.add(constant);
    return `${MARKER}${constant}`;
  };

  const out: Record<string, unknown> = { ...props };
  for (const key of SCOPE_KEYS) {
    const scope = out[key];
    if (!scope || typeof scope !== "object") continue;
    const marked: Record<string, unknown> = { ...(scope as Record<string, unknown>) };
    if ("eq" in marked) marked.eq = mark(marked.eq);
    if (Array.isArray(marked.in)) marked.in = marked.in.map(mark);
    else if ("in" in marked) marked.in = mark(marked.in);
    out[key] = marked;
  }
  return out;
}

/** `{"effect": "permit"}` → `{ effect: "permit" }`, and markers → identifiers. */
function emitProps(props: Record<string, unknown>): string {
  const json = JSON.stringify(props, null, 2)
    // Unquote keys that are already valid identifiers. A quote inside a string
    // value is escaped as `\"` by `JSON.stringify`, so no value can present the
    // `"ident":` shape this matches.
    .replace(/"([A-Za-z_$][A-Za-z0-9_$]*)":/g, "$1:");

  return json.replace(/"\\u0000chant:([A-Za-z_$][A-Za-z0-9_$]*)"/g, "$1");
}

// ── Generator ─────────────────────────────────────────────────────

export class CedarGenerator {
  private readonly actionConstants: Record<string, string>;

  constructor(options: CedarGenerateOptions = {}) {
    this.actionConstants = options.actionConstants ?? {};
  }

  generate(entities: CedarPolicyIR[]): CedarGenerateResult {
    const warnings: string[] = [];
    const imports = new Set<string>([POLICY_CLASS]);
    const names = uniqueNames(entities);
    const blocks: string[] = [];

    for (const [index, entity] of entities.entries()) {
      const props = markScopeConstants(entity.props, this.actionConstants, imports);

      if (entity.kind === "template") {
        blocks.push(
          "/** Cedar template — its `?principal`/`?resource` slots are filled at link time. */",
        );
      }
      blocks.push(`export const ${names[index]} = new ${POLICY_CLASS}(${emitProps(props)});`);
      blocks.push("");
    }

    if (entities.length === 0) warnings.push("no Cedar policies were found in this document");

    const importLine = `import { ${[...imports].sort().join(", ")} } from "${CEDAR_PACKAGE}";`;
    const source = [importLine, "", ...blocks].join("\n");

    return { source: source.endsWith("\n") ? source : `${source}\n`, warnings };
  }
}

// ── Generated registry lookup ─────────────────────────────────────

/** Filename of the registry `chant generate` writes beside the typed classes. */
const REGISTRY_FILE = "lexicon-cedar.json";

interface RegistryEntry {
  resourceType?: string;
  kind?: string;
}

/**
 * Read `App::Action::"read"` → `ReadAction` out of the generated registry.
 *
 * Best-effort by design: a project that has not run `chant generate` has no
 * registry, and the generator falls back to emitting UID literals — which the
 * `Policy` class accepts and the compiler still checks.
 */
export function loadActionConstants(packageDir?: string): Record<string, string> {
  const base = packageDir ?? dirname(dirname(fileURLToPath(import.meta.url)));
  const path = join(base, "generated", REGISTRY_FILE);
  if (!existsSync(path)) return {};

  try {
    const registry = JSON.parse(readFileSync(path, "utf-8")) as Record<string, RegistryEntry>;
    const constants: Record<string, string> = {};
    for (const [tsName, entry] of Object.entries(registry)) {
      if (entry.kind !== "resource") continue;
      if (typeof entry.resourceType !== "string") continue;
      if (!/::Action::"/.test(entry.resourceType)) continue;
      constants[entry.resourceType] = tsName;
    }
    return constants;
  } catch {
    return {};
  }
}
