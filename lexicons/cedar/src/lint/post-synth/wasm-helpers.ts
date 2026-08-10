/**
 * The `cedar-wasm` seam for the cedar post-synth checks.
 *
 * Cedar's real parser and validator ship as `@cedar-policy/cedar-wasm`, which
 * runs in-process — no CLI on PATH, no Docker. Everything the checks need from
 * it goes through this module so the traps live in one place. The traps, all
 * of them empirically verified against 4.12.0 (chant #1648):
 *
 * 1. **`type: "success"` does not mean valid.** `failure` means the *call*
 *    failed; `success` means validation *ran*, and can carry any number of
 *    `validationErrors`. {@link validatePolicySet} asserts both.
 * 2. **`validationErrors` ordering is non-deterministic** — the validator
 *    parallelizes across policies and never re-sorts. Forty identical calls
 *    produced six distinct orderings. Everything this module returns is sorted
 *    by `policyId` then `message`, so a check's output is stable.
 * 3. **Malformed input throws instead of returning a failure answer.** Missing
 *    fields on a call struct raise a bare serde `Error` whose `line 1 column N`
 *    refers to the internal call struct, not to anything the user wrote — it is
 *    meaningless to surface. {@link call} wraps every entry point and normalizes
 *    both channels into one result type.
 * 4. **A bare-string policy set gets synthesized ids** (`policy0`, `policy1`),
 *    and `@id` annotations do *not* become the policy id. Everything here
 *    passes `staticPolicies` as a `Record<PolicyId, Policy>` keyed by chant's
 *    own ids, so a diagnostic names something a reader can find.
 * 5. **Only `strict` validation mode exists** in this build; any other value
 *    throws. The settings are left at their default rather than passed.
 *
 * Only the `/nodejs` flavor is imported. The root/`esm` flavor imports the
 * `.wasm` as an ES module, which Bun cannot start (`__wbindgen_start is not a
 * function`) and Node only supports behind an experimental warning printed on
 * every run; `/web` needs an explicit `initSync`. `/nodejs` is the one flavor
 * that loads under `node`, `tsx`, `vitest`, and `bun` alike.
 *
 * Excluded from check auto-discovery by the "helper" filename filter.
 */
import { createRequire } from "module";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import type * as CedarWasm from "@cedar-policy/cedar-wasm/nodejs";
import {
  isRecord,
  type CedarPolicyJson,
  type CedarPolicySet,
  type CedarPolicySetDoc,
} from "./cedar-helpers";

// ── Loading ───────────────────────────────────────────────────────

type Wasm = typeof CedarWasm;

let cached: Wasm | undefined;
let loadError: string | undefined;

/**
 * The wasm module, loaded on first use.
 *
 * Lazy and `require`-based on purpose. The post-synth barrel is imported
 * statically by `plugin.ts`, and every `chant lint`/`chant audit` run loads
 * every active lexicon's plugin — a top-level import would pull 4 MB of wasm
 * into any build that merely has cedar installed. `check()` is synchronous, so
 * `await import()` is not available; `createRequire` is. The `/nodejs` flavor
 * is CommonJS with a synchronous `readFileSync` init, so there is nothing to
 * await anyway.
 */
export function loadWasm(): Wasm | undefined {
  if (cached || loadError) return cached;
  try {
    const require = createRequire(import.meta.url);
    cached = require("@cedar-policy/cedar-wasm/nodejs") as Wasm;
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
  }
  return cached;
}

/** Why the wasm could not be loaded, if it could not be. */
export function wasmLoadError(): string | undefined {
  loadWasm();
  return loadError;
}

/** Reset the module cache. Test-only — lets a test exercise the load-failure path. */
export function resetWasmCache(): void {
  cached = undefined;
  loadError = undefined;
}

// ── Calling ───────────────────────────────────────────────────────

export type WasmResult<T> = { ok: true; value: T } | { ok: false; message: string };

/**
 * Run a wasm call, turning a thrown serde error into a result rather than an
 * exception (trap 3 above). The thrown message is deliberately not passed
 * through verbatim: its positions point into the internal call struct.
 */
export function call<T>(what: string, fn: () => T): WasmResult<T> {
  try {
    return { ok: true, value: fn() };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    // Strip the internal `at line 1 column 42` suffix — it locates a field in
    // the serialized call struct, never anything in the user's policy.
    const message = raw.replace(/\s+at line \d+ column \d+\.?$/, "");
    return { ok: false, message: `${what} could not be run by cedar-wasm: ${message}` };
  }
}

/** The first line of a Cedar `DetailedError`, with its `help` when it has one. */
export function describeError(error: { message: string; help?: string | null }): string {
  return error.help ? `${error.message} (${error.help})` : error.message;
}

// ── Condition bodies ──────────────────────────────────────────────

/**
 * chant's serializer carries a `when`/`unless` body as Cedar expression
 * *source* under a `__expr` key, because the authored model holds expression
 * strings until schema-driven codegen (#1650) makes them typed trees. `__expr`
 * is not part of Cedar's JSON policy grammar — the deserializer rejects it
 * ("unknown variant `__expr`") — so anything handed to the wasm has to have
 * those bodies parsed into real expression JSON first.
 *
 * There is no expression-level entry point in the package, so the expression
 * is parsed inside a throwaway policy and the resulting condition body lifted
 * back out. A source expression that does not parse is the finding CEDC011
 * reports.
 */
export const EXPR_KEY = "__expr";

export interface ExpressionFailure {
  /** The policy key the clause belongs to. */
  key: string;
  /** `when` or `unless`, as the document spelled it. */
  kind: string;
  /** The expression source that failed. */
  expression: string;
  message: string;
}

export interface NormalizedPolicySet {
  /** A policy set the wasm will accept, keyed by chant's own policy ids. */
  policySet: CedarWasm.PolicySet;
  /** Condition bodies whose expression source did not parse. */
  expressionFailures: ExpressionFailure[];
}

function parseExpression(wasm: Wasm, expression: string): WasmResult<unknown> {
  const answer = call("condition expression", () =>
    wasm.policyToJson(`permit(principal, action, resource) when { ${expression} };`),
  );
  if (!answer.ok) return answer;
  if (answer.value.type === "failure") {
    return { ok: false, message: answer.value.errors.map(describeError).join("; ") };
  }
  const conditions = answer.value.json.conditions;
  const body = Array.isArray(conditions) && isRecord(conditions[0]) ? conditions[0].body : undefined;
  if (body === undefined) return { ok: false, message: "expression parsed to no condition body" };
  return { ok: true, value: body };
}

/** Replace every `__expr` body in a policy set with parsed expression JSON. */
export function normalizePolicySet(wasm: Wasm, set: CedarPolicySet): NormalizedPolicySet {
  const staticPolicies: Record<string, unknown> = {};
  const templates: Record<string, unknown> = {};
  const expressionFailures: ExpressionFailure[] = [];

  for (const entry of set.entries) {
    const target = entry.template ? templates : staticPolicies;
    target[entry.key] = normalizePolicy(wasm, entry.key, entry.policy, expressionFailures);
  }

  const doc: CedarPolicySetDoc = set.doc ?? {};
  const policySet = {
    staticPolicies,
    templates,
    templateLinks: Array.isArray(doc.templateLinks) ? doc.templateLinks : [],
  } as unknown as CedarWasm.PolicySet;

  return { policySet, expressionFailures };
}

function normalizePolicy(
  wasm: Wasm,
  key: string,
  policy: CedarPolicyJson,
  failures: ExpressionFailure[],
): CedarPolicyJson {
  if (!Array.isArray(policy.conditions)) return policy;

  const conditions = policy.conditions.map((clause) => {
    if (!isRecord(clause) || !isRecord(clause.body)) return clause;
    const expression = clause.body[EXPR_KEY];
    if (typeof expression !== "string") return clause;

    const parsed = parseExpression(wasm, expression);
    if (!parsed.ok) {
      failures.push({
        key,
        kind: typeof clause.kind === "string" ? clause.kind : "when",
        expression,
        message: parsed.message,
      });
      // Leave a body the deserializer accepts so the rest of the set still
      // validates — the unparseable clause is reported by CEDC011, not by a
      // cascade of confusing structural errors from every other check.
      return { ...clause, body: { Value: true } };
    }
    return { ...clause, body: parsed.value };
  });

  return { ...policy, conditions };
}

// ── Schema discovery ──────────────────────────────────────────────

/** A Cedar schema found beside the policies in the build output. */
export interface DiscoveredSchema {
  /** Human-readable `.cedarschema` source, or a parsed JSON schema object. */
  schema: CedarWasm.Schema;
  /** The filename it came from. */
  source: string;
}

/**
 * The project's Cedar schema, if the build emitted one beside the policies.
 *
 * Two forms, both of which the wasm accepts — but only as the right JS type: a
 * `string` is *always* read as human-readable `.cedarschema`, never as JSON, so
 * a `.cedarschema.json` file has to be `JSON.parse`d into a live object first
 * or the parser reports "unexpected token `{`" against perfectly valid JSON.
 *
 * Reads `ctx.outputs` only. Nothing emits a schema today — schema-driven
 * codegen is #1650 — which is exactly why CEDE010 says so out loud instead of
 * passing silently.
 */
export function findSchema(ctx: PostSynthContext): DiscoveredSchema | undefined {
  for (const [, output] of ctx.outputs) {
    if (typeof output === "string") continue;
    for (const [filename, content] of Object.entries(output.files ?? {})) {
      if (typeof content !== "string") continue;
      if (filename.endsWith(".cedarschema.json")) {
        try {
          const parsed: unknown = JSON.parse(content);
          if (isRecord(parsed)) return { schema: parsed as CedarWasm.Schema, source: filename };
        } catch {
          continue; // a schema that is not JSON is not a schema we can use
        }
      } else if (filename.endsWith(".cedarschema")) {
        return { schema: content, source: filename };
      }
    }
  }
  return undefined;
}

// ── Validation ────────────────────────────────────────────────────

/** One validator finding, already flattened and safe to sort. */
export interface ValidationFinding {
  policyId: string;
  message: string;
}

export interface ValidationOutcome {
  /** Sorted by `policyId` then `message` — the wasm's own order is not stable. */
  errors: ValidationFinding[];
  /** Same sort. */
  warnings: ValidationFinding[];
  /** Set when the call itself failed (a parse error, a malformed call struct). */
  failure?: string;
}

function sortFindings(findings: ValidationFinding[]): ValidationFinding[] {
  return [...findings].sort(
    (a, b) => a.policyId.localeCompare(b.policyId) || a.message.localeCompare(b.message),
  );
}

function flatten(errors: CedarWasm.ValidationError[]): ValidationFinding[] {
  return errors.map((e) => ({ policyId: e.policyId, message: describeError(e.error) }));
}

/** Validate a normalized policy set against a schema. Never throws. */
export function validatePolicySet(
  wasm: Wasm,
  policySet: CedarWasm.PolicySet,
  schema: CedarWasm.Schema,
): ValidationOutcome {
  const answer = call("validate", () => wasm.validate({ schema, policies: policySet }));
  if (!answer.ok) return { errors: [], warnings: [], failure: answer.message };

  if (answer.value.type === "failure") {
    return {
      errors: [],
      warnings: [],
      failure: answer.value.errors.map(describeError).join("; "),
    };
  }

  // `success` only means validation RAN. The findings are in the arrays.
  return {
    errors: sortFindings(flatten(answer.value.validationErrors)),
    warnings: sortFindings(flatten(answer.value.validationWarnings)),
  };
}

/** Parse-only gate, for when there is no schema to validate against. */
export function parsePolicySet(wasm: Wasm, policySet: CedarWasm.PolicySet): WasmResult<string[]> {
  const answer = call("checkParsePolicySet", () => wasm.checkParsePolicySet(policySet));
  if (!answer.ok) return answer;
  if (answer.value.type === "failure") {
    return { ok: true, value: answer.value.errors.map(describeError).sort() };
  }
  return { ok: true, value: [] };
}
