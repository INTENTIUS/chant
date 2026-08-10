/**
 * Macro authoring, and the default library as calls rather than operators.
 *
 * Upstream's policy grammar carries the macro system in the parser, not in the
 * docs:
 *
 * ```
 * def_decl = { kw_def ~ def_kind ~ ident ~ "(" ~ param_list? ~ ")" ~ "{" ~ block_inner ~ "}" ~ ";" }
 * def_kind = { kw_def_cedar | kw_def_temporal }
 * ```
 *
 * A `cedar` macro's body is a Cedar expression; a `temporal` macro's body is a
 * temporal condition *or* a bare aggregation value (upstream's
 * `temporal_macro_body_entry` tries `agg_expr` first, which is why
 * `count_within` can expand into a `count …` that the call site compares).
 *
 * Two sigils, and they are not interchangeable. `?p` splices the call-site
 * argument literally. `$t` is a fresh binder the macro introduces, gensym'd at
 * every expansion. Both are legal *only* inside a macro body — upstream's
 * well-formedness pass rejects them anywhere else — which is why they are
 * validated here at definition time rather than at render time.
 *
 * The four wrappers at the bottom are the default library
 * (`configuration/default_macros.dw`). They are calls, not operators. A caller
 * who passes `--macros` replaces that library entirely, so a policy built on
 * them is built on an assumption about the other end; {@link defaultMacroLibrary}
 * exists so a project can emit the same definitions itself and stop assuming.
 */

import {
  call,
  interval,
  renderCondition,
  renderTerm,
  sigilCondition,
  varRef,
  type CallNode,
  type SigilCondition,
  type TemporalCondition,
  type TemporalTerm,
  type TermText,
} from "./temporal";
import { windowParam, type WindowLike, type WindowParam } from "./window";

/** `?w` — a value parameter, spliced from the call site. */
const PARAM = /^\?[A-Za-z_][A-Za-z0-9_]*$/;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Which sub-parser reads the body: Cedar's, or the temporal sub-language's. */
export type MacroKind = "cedar" | "temporal";

/** One `def <kind> <name>(<params>) { <body> };` declaration. */
export interface MacroDefinition {
  readonly kind: MacroKind;
  readonly name: string;
  /** Parameter names, each carrying the `?` sigil. */
  readonly params: readonly string[];
  /** Rendered body text. */
  readonly body: string;
  /** Emitted as `// …` lines above the definition. */
  readonly comment?: string;
}

function assertMacroName(name: string): string {
  if (!IDENT.test(name)) throw new Error(`dogwood: a macro name must be an identifier — got "${name}"`);
  return name;
}

function assertParams(params: readonly string[]): readonly string[] {
  for (const p of params) {
    if (!PARAM.test(p)) {
      throw new Error(`dogwood: a macro parameter carries the "?" sigil — got "${p}" (write "?${p.replace(/^\?/, "")}")`);
    }
  }
  return params;
}

/**
 * `def temporal name(?a, ?b) { … };`
 *
 * The body may be a condition or an aggregation term, matching upstream's
 * `temporal_macro_body_entry`; `sum_within` is an aggregation-bodied macro and
 * `once` is a condition-bodied one.
 */
export function defTemporalMacro(
  name: string,
  params: string[],
  body: TemporalCondition | TemporalTerm,
  comment?: string,
): MacroDefinition {
  return {
    kind: "temporal",
    name: assertMacroName(name),
    params: assertParams(params),
    body: isTermBody(body) ? renderTerm(body) : renderCondition(body),
    comment,
  };
}

function isTermBody(body: TemporalCondition | TemporalTerm): body is TemporalTerm {
  return body.op === "term" || body.op === "array" || body.op === "count" || body.op === "sum";
}

/**
 * `def cedar name(?a) { … };` — the body is Cedar expression text.
 *
 * Cedar's expression grammar is the policy language itself, so it stays a
 * string here for the same reason `Cedar::Policy`'s `when` does.
 */
export function defCedarMacro(
  name: string,
  params: string[],
  body: string,
  comment?: string,
): MacroDefinition {
  return { kind: "cedar", name: assertMacroName(name), params: assertParams(params), body, comment };
}

// ── The sigils, in the three positions they appear ────────────────

/**
 * `within ?w` — the window a macro body defers to its call site.
 *
 * The call site supplies a bare interval (`once(1h, …)`), not a `within`
 * clause: the keyword belongs to the operator, so it stays in the body.
 */
export function macroWindow(param: string): WindowParam {
  return windowParam(param);
}

/** `?s` standing for an entire condition, spliced from the call site. */
export function macroCondition(param: string): SigilCondition {
  if (!PARAM.test(param)) throw new Error(`dogwood: a condition parameter carries the "?" sigil — got "${param}"`);
  return sigilCondition(param);
}

/** `?a` / `$t` in term or binder position. */
export function macroTerm(sigil: string): TermText {
  if (!/^[?$][A-Za-z_][A-Za-z0-9_]*$/.test(sigil)) {
    throw new Error(`dogwood: a macro term carries a "?" or "$" sigil — got "${sigil}"`);
  }
  return varRef(sigil);
}

/** One definition as `.dw` source. */
export function renderMacroDefinition(def: MacroDefinition): string {
  const lines: string[] = [];
  if (def.comment) {
    for (const line of def.comment.split("\n")) lines.push(`// ${line}`.trimEnd());
  }
  lines.push(`def ${def.kind} ${def.name}(${def.params.join(", ")}) {`);
  lines.push(`    ${def.body}`);
  lines.push("};");
  return lines.join("\n");
}

/** A whole library — the file `--macros` points at, or a policy set's own prelude. */
export function renderMacroLibrary(defs: readonly MacroDefinition[]): string {
  return defs.map(renderMacroDefinition).join("\n\n") + "\n";
}

// ── The default library, as calls ─────────────────────────────────

/** The macro names `configuration/default_macros.dw` ships at the pinned revision. */
export const DEFAULT_MACRO_NAMES = ["count_within", "sum_within", "count_distinct_within", "bind"] as const;

/**
 * `count_within(?w, ?s)` — timepoints in the window at which `?s` held.
 *
 * A default-library call, not an operator. See this module's header.
 */
export function countWithin(w: WindowLike, condition: TemporalCondition): CallNode {
  return call("count_within", [interval(w), condition]);
}

/** `sum_within(?a, ?w, ?body)` — `over` names the sum's bound variable. */
export function sumWithin(over: string, w: WindowLike, body: TemporalCondition): CallNode {
  return call("sum_within", [varRef(over), interval(w), body]);
}

/** `count_distinct_within(?k, ?w, ?s)` — distinct String keys `k` for which `s` held. */
export function countDistinctWithin(key: string, w: WindowLike, condition: TemporalCondition): CallNode {
  return call("count_distinct_within", [varRef(key), interval(w), condition]);
}

/** `bind(?n, ?A, ?B)` — names an aggregate result so it can be compared. */
export function bind(name: string, aggregate: TemporalCondition, body: TemporalCondition): CallNode {
  return call("bind", [varRef(name), aggregate, body]);
}

/**
 * The default library's four definitions, verbatim from upstream's
 * `dogwood-language/configuration/default_macros.dw` at the pinned revision.
 *
 * Emitting these into a project's own `macros.dw` turns an assumption about
 * the callee's `--macros` into a file the project controls.
 */
export function defaultMacroLibrary(): MacroDefinition[] {
  return [
    {
      kind: "temporal",
      name: "count_within",
      params: ["?w", "?s"],
      body: "count for ($t: Timepoint). where (formerly within ?w (?s && tp($t)))",
      comment: "Counts the timepoints within window `?w` at which condition `?s` held.",
    },
    {
      kind: "temporal",
      name: "sum_within",
      params: ["?a", "?w", "?body"],
      body: "sum ?a for (?a: Long), ($t: Timepoint). where (formerly within ?w (?body && tp($t)))",
      comment: "Sums the numeric value `?a` over occurrences of `?body` within window `?w`.",
    },
    {
      kind: "temporal",
      name: "count_distinct_within",
      params: ["?k", "?w", "?s"],
      body: "count for (?k: String). where (formerly within ?w ?s)",
      comment: "Counts the distinct key values `?k` for which `?s` held within window `?w`.",
    },
    {
      kind: "temporal",
      name: "bind",
      params: ["?n", "?A", "?B"],
      body: "exists (?n: Long). (?A == ?n && ?B)",
      comment: 'A "let"-style binder: names an aggregate result `?n` and uses it in `?B`.',
    },
  ];
}
