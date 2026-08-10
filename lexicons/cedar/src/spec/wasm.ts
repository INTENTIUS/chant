/**
 * The one place `@cedar-policy/cedar-wasm` is called from.
 *
 * Three findings from the 4.12.0 verification (#1648) are encoded here rather
 * than left to each caller to remember:
 *
 * 1. **Only the `/nodejs` flavor.** The root ESM build imports the `.wasm` as
 *    an ES module, which Bun cannot start (`wasm.__wbindgen_start is not a
 *    function`) and Node only supports behind an experimental warning printed
 *    on every run. `/nodejs` loads the binary with `readFileSync` and works
 *    under node CJS, node ESM, vitest and bun alike.
 *
 * 2. **`schemaToJsonWithResolvedTypes` takes a string and means it.** A JS
 *    object traps the wasm with `memory access out of bounds` — not a failure
 *    answer, a memory fault. The `typeof === "string"` guard below is the
 *    difference between a readable error and a trap.
 *
 * 3. **The `Answer` union is not the whole error channel.** Malformed input
 *    throws a bare serde `Error` from inside the wasm instead of returning
 *    `{type:"failure"}`, and the `line 1 column N` in those messages refers to
 *    the internal call struct, not to anything the user wrote. Both channels
 *    are normalized into one result type here.
 */

import { createRequire } from "module";
import type * as CedarWasm from "@cedar-policy/cedar-wasm/nodejs";

/**
 * Loaded on first use, not at import.
 *
 * The wasm binary is 4.2 MB and costs ~13 MB RSS to instantiate. Importing
 * this package is something a user's `chant.config.ts` does purely to bring
 * the `cedar` key into `ChantConfig`, and every `chant build` in a project
 * with a policy set loads the serializer — neither touches the validator. A
 * top-level import would charge all of them for it.
 */
let wasm: typeof CedarWasm | undefined;

function cedar(): typeof CedarWasm {
  if (!wasm) {
    // `require`, not `import()`: the `/nodejs` flavor is CommonJS, and this
    // keeps the call sites synchronous, which is what every consumer here
    // wants. See the flavor note above for why the root ESM build is not an
    // option.
    wasm = createRequire(import.meta.url)("@cedar-policy/cedar-wasm/nodejs") as typeof CedarWasm;
  }
  return wasm;
}

/** A namespace body in the resolved schema JSON. */
export interface ResolvedNamespace {
  commonTypes?: Record<string, ResolvedType>;
  entityTypes?: Record<string, ResolvedEntityType>;
  actions?: Record<string, ResolvedAction>;
  annotations?: Record<string, string>;
}

export interface ResolvedEntityType {
  memberOfTypes?: string[];
  shape?: ResolvedType;
  tags?: ResolvedType;
  enum?: string[];
  annotations?: Record<string, string>;
}

export interface ResolvedAction {
  memberOf?: Array<{ id: string; type?: string }>;
  appliesTo?: {
    principalTypes?: string[];
    resourceTypes?: string[];
    context?: ResolvedType;
  };
  annotations?: Record<string, string>;
}

/**
 * A type in the *resolved* schema JSON.
 *
 * `schemaToJson` emits `{type:"EntityOrCommon", name}` for every named type,
 * which cannot tell an entity reference from a primitive from a common-type
 * alias. `schemaToJsonWithResolvedTypes` collapses that to `{type:"Entity"}`
 * for entity references and to the primitive name otherwise — except for
 * common types, which stay as a bare qualified `{type:"App::TagSet"}` and are
 * resolved against `commonTypes` by the emitter.
 */
export interface ResolvedType {
  type: string;
  name?: string;
  element?: ResolvedType;
  attributes?: Record<string, ResolvedType>;
  required?: boolean;
  enum?: string[];
}

/** The `SchemaJson` shape, keyed by namespace (`""` is the empty namespace). */
export type ResolvedSchemaJson = Record<string, ResolvedNamespace>;

export type WasmResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** The Cedar *language* version this build of the package implements. */
export function langVersion(): string {
  return cedar().getCedarLangVersion();
}

/** The `@cedar-policy/cedar-wasm` package version. */
export function packageVersion(): string {
  return cedar().getCedarVersion();
}

/**
 * Resolve a human-readable `.cedarschema` into fully-qualified schema JSON.
 *
 * Returns a result rather than throwing so a bad project schema reads as a
 * message about the project schema, not as a stack trace out of a wasm module.
 */
export function resolveSchema(schemaText: unknown): WasmResult<ResolvedSchemaJson> {
  if (typeof schemaText !== "string") {
    // Guarded, not attempted: a non-string traps the instance rather than
    // returning a failure answer (#1648 §5.4).
    return {
      ok: false,
      error: `schemaToJsonWithResolvedTypes takes the human-readable schema as a string; got ${typeof schemaText}`,
    };
  }

  let answer: unknown;
  try {
    answer = cedar().schemaToJsonWithResolvedTypes(schemaText);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  if (!answer || typeof answer !== "object") {
    return { ok: false, error: "cedar-wasm returned no answer" };
  }

  const record = answer as { type?: string; json?: unknown; errors?: unknown };
  if (record.type !== "success") {
    return { ok: false, error: formatWasmErrors(record.errors) };
  }
  if (!record.json || typeof record.json !== "object") {
    return { ok: false, error: "cedar-wasm reported success with no schema JSON" };
  }

  return { ok: true, value: record.json as ResolvedSchemaJson };
}

// ── Policy conversion ─────────────────────────────────────────────

/** One Cedar policy in Cedar's own JSON policy format. */
export type PolicyJson = CedarWasm.PolicyJson;

/** The two halves `policySetTextToParts` splits a `.cedar` document into. */
export interface PolicySetParts {
  /** Verbatim source text of each static policy, in source order. */
  policies: string[];
  /** Verbatim source text of each template, in source order. */
  templates: string[];
}

/**
 * Run one wasm call and collapse both of its error channels into a result.
 *
 * The `Answer` union is not the whole error channel — malformed input throws a
 * bare serde `Error` from inside the module, and the `line 1 column N` those
 * messages carry points at the internal call struct rather than at anything
 * the user wrote (#1648 §5.3). Both land here as `{ ok: false }`.
 */
function wasmCall<T>(
  what: string,
  run: () => unknown,
  extract: (answer: Record<string, unknown>) => T | undefined,
): WasmResult<T> {
  let answer: unknown;
  try {
    answer = run();
  } catch (err) {
    return { ok: false, error: `${what}: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!answer || typeof answer !== "object") {
    return { ok: false, error: `${what}: cedar-wasm returned no answer` };
  }

  const record = answer as { type?: string; errors?: unknown };
  if (record.type !== "success") {
    return { ok: false, error: formatWasmErrors(record.errors) };
  }

  const value = extract(answer as Record<string, unknown>);
  if (value === undefined) {
    return { ok: false, error: `${what}: cedar-wasm reported success with no result` };
  }
  return { ok: true, value };
}

/**
 * Split a `.cedar` document into its policies and its templates.
 *
 * The strings that come back are the **verbatim source** of each policy —
 * annotations, line breaks and all — in source order, which is what lets the
 * importer recover a condition body exactly as it was written rather than as
 * the JSON leg would re-render it. Comments are dropped: they are not part of
 * any grammar the module round-trips.
 */
export function splitPolicySet(text: unknown): WasmResult<PolicySetParts> {
  if (typeof text !== "string") {
    return { ok: false, error: `policySetTextToParts takes policy text as a string; got ${typeof text}` };
  }
  return wasmCall("policySetTextToParts", () => cedar().policySetTextToParts(text), (answer) => {
    const { policies, policy_templates: templates } = answer as {
      policies?: unknown;
      policy_templates?: unknown;
    };
    if (!Array.isArray(policies) || !Array.isArray(templates)) return undefined;
    return { policies: policies as string[], templates: templates as string[] };
  });
}

/** Convert one *static* policy (text or JSON) into Cedar's JSON policy format. */
export function policyToJson(policy: string | PolicyJson): WasmResult<PolicyJson> {
  return wasmCall("policyToJson", () => cedar().policyToJson(policy), (answer) => answer.json as PolicyJson | undefined);
}

/**
 * Convert one *template* (text or JSON) into Cedar's JSON policy format.
 *
 * A policy carrying `?principal`/`?resource` is a template, and `policyToJson`
 * refuses it outright ("expected a static policy, got a template containing
 * the slot ?resource") — the two entry points are not interchangeable.
 */
export function templateToJson(template: string | PolicyJson): WasmResult<PolicyJson> {
  return wasmCall(
    "templateToJson",
    () => cedar().templateToJson(template),
    (answer) => answer.json as PolicyJson | undefined,
  );
}

/**
 * Render one policy's JSON back to Cedar text.
 *
 * Only ever used to recover an *expression* body that has no source text to
 * quote — an imported JSON policy set. The output is single-line and defensively
 * parenthesized (`((context.mfa) == true)`), and `formatPolicies` does not undo
 * that, so it is never the source of a human-facing `.cedar` artifact: those are
 * laid out by the serializer.
 */
export function policyToText(policy: PolicyJson): WasmResult<string> {
  return wasmCall("policyToText", () => cedar().policyToText(policy), (answer) => answer.text as string | undefined);
}

/**
 * Does this value parse as a Cedar policy set?
 *
 * `checkParsePolicySet` throws — rather than answering `failure` — for a
 * document carrying keys it does not know, which is precisely the shape a
 * foreign lexicon's JSON has, so the throw is a match rejection here.
 */
export function parsesAsPolicySet(value: unknown): boolean {
  try {
    return cedar().checkParsePolicySet(value as CedarWasm.PolicySet).type === "success";
  } catch {
    return false;
  }
}

/**
 * Flatten a `DetailedError[]` into one line.
 *
 * `code`, `url` and `severity` are `null` on every error this package emits
 * (#1648 §5.6), so only `message` and `help` carry anything.
 */
export function formatWasmErrors(errors: unknown): string {
  if (!Array.isArray(errors) || errors.length === 0) return "cedar-wasm reported a failure with no detail";
  return errors
    .map((e) => {
      if (typeof e === "string") return e;
      const detail = e as { message?: string; help?: string };
      return detail.help ? `${detail.message} (${detail.help})` : String(detail.message ?? e);
    })
    .join("; ");
}
