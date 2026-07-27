import type { Declarable } from "../../declarable";
import type { SerializerResult } from "../../serializer";
import type { PostSynthContext, PostSynthDiagnostic } from "../../lint/post-synth";
import { decodeEntitySet, encodeEntitySet, type EntitySetWire } from "../entity-wire-codec";
import { scanValueWireSafety, type ConfigWireOffender } from "./config-wire";

/**
 * chant #1131 — what a build result looks like on its way INTO the sandboxed
 * policy child, and what a `PostSynthDiagnostic` must look like on its way back
 * out.
 *
 * A project's `lint.policies` checks are project-authored functions chant calls
 * over the finished build. #1113 put `chant.config.ts` behind the `--sandbox`
 * boundary but could not take the policies with it, because the config declares
 * them as *paths*: the modules were still imported and their `check` functions
 * still invoked in the CLI's own process, with the CLI's filesystem, network,
 * environment and process-spawn access, after discovery was over.
 *
 * The shape of the fix is forced by what a policy is. It is not data that can
 * be evaluated somewhere and carried back — it is a callback over the resolved
 * resources, so it has to run somewhere it can see them. It also cannot run in
 * the #1045 discovery child, because that child only ever sees the run-fallback
 * *subset*: folded files are collected in the parent, and serialization happens
 * in the parent, so no complete view of the build exists on that side. What
 * does exist, after the parent has merged and serialized, is a build result
 * that is *nearly* data already — which is what this module makes explicit.
 *
 * So: one more child, after the merge, handed the encoded build result,
 * importing the policy modules inside the boundary and returning plain
 * diagnostics. Same bundling (`./bundle.ts`), same spawn and `--permission`
 * profile (`./fork.ts`), same error classification (`./child-errors.ts`), same
 * "only JSON crosses, and anything else is named, never dropped" contract
 * (`./config-wire.ts`, whose walk is reused directly).
 *
 * ## What crosses, and what that costs
 *
 * `PostSynthContext` gives a check five things. Four of them are already data:
 * `outputs` (each lexicon's serialized text), `warnings`, `errors`,
 * `sourceFileCount`. The fifth, `entities`, is a live `Map<string, Declarable>`
 * whose cross-entity references are object identity and `WeakRef`s — the exact
 * problem chant #1045 Phase 1 solved for discovery, so this reuses that codec
 * (`../entity-wire-codec.ts`) rather than inventing a second one.
 *
 * That reuse is what makes the round trip cheap AND what defines its limits.
 * `encodeEntitySet`/`decodeEntitySet` is documented as producing entities
 * "behaviorally indistinguishable" from the in-process ones for chant's own
 * consumers (serializers, the dependency graph, cross-lexicon detection), and
 * a policy is a consumer of the same shape. Where it is NOT identical is
 * written down in `docs/.../architecture/sandbox.mdx` and pinned by
 * `./policy-wire.test.ts`:
 *
 *  - An intrinsic (`Sub`, `Ref`, gitlab's `!reference`, …) decodes to a
 *    marker-bearing wrapper exposing `toJSON()`/`toYAML()`, not to an instance
 *    of the lexicon's own intrinsic class.
 *  - A decoded entity is a plain marker-bearing object, not an instance of the
 *    lexicon's resource class, and its `lexicon`/`entityType`/`kind`/`props`/
 *    `attributes` are non-enumerable (so `Object.keys(entity)` sees only the
 *    per-attribute/extra fields). Reads — `entity.props`, `entity.entityType`,
 *    `isDeclarable(entity)`, `instanceof AttrRef` — all still work.
 *  - A `ChildProjectInstance` (`nestedStack()`) has no wire form at all;
 *    `encodeEntitySet` throws rather than mis-encoding it, so a `--sandbox`
 *    build that both uses `nestedStack()` and declares `lint.policies` fails
 *    loudly. (No corpus entry uses `nestedStack()`.)
 *  - `errors` cross as the plain objects `DiscoveryError`/`BuildError`'s own
 *    `toJSON()` produces, not as `Error` instances. In practice this is never
 *    observable: `chant build` runs policies only when the build produced no
 *    errors at all, so the array is always empty at that point.
 *
 * Crucially, the first two are NOT new under `--sandbox`: a sandboxed build
 * already merges decoded entities for every run-fallback file (`./run.ts`), so
 * a policy running in-process on a `--sandbox` build is already looking at
 * decoded entities for part of the set. Encoding is idempotent over a decoded
 * entity (verified in `./policy-wire.test.ts`), so this child widens that from
 * "the run-fallback subset" to "all of them" and changes nothing else.
 */

/** Wire form of one lexicon's serialized output — already data on both sides; carried as-is. */
export type PolicyOutputWire = string | { primary: string; files?: Record<string, string>; warnings?: string[] };

/** A build result as pure JSON, for the sandboxed policy child. */
export interface PolicyBuildResultWire {
  /** `../entity-wire-codec.ts`'s format — the same one the #1045 discovery child returns. */
  entities: EntitySetWire;
  /** `Map` entries as pairs; a `Map` itself JSON-stringifies to `{}`. */
  outputs: Array<[string, PolicyOutputWire]>;
  warnings: string[];
  /** `DiscoveryError`/`BuildError`'s own `toJSON()` output. Always empty in practice — see the module doc. */
  errors: Array<Record<string, unknown>>;
  sourceFileCount: number;
  /** `BuildResult.dependencies` (`Map<string, Set<string>>`) as pairs of arrays. Not part of `PostSynthContext`'s declared surface; carried so `ctx.buildResult` is not silently narrower than the object the in-process path passes. */
  dependencies: Array<[string, string[]]>;
  /** `BuildResult.manifest` — plain data (lexicons, cross-lexicon outputs, deploy order, stack graph). Same "not declared, still carried" reasoning as {@link dependencies}. */
  manifest?: unknown;
  /** `BuildResult.foldDecisions` — plain data. */
  foldDecisions?: unknown[];
  /** `BuildResult.buildParams` — plain data (#1064 provenance records). */
  buildParams?: unknown[];
}

/** The subset of `BuildResult` this module knows how to carry. Structurally satisfied by `../../build.ts`'s `BuildResult`. */
export interface EncodablePolicyBuildResult {
  outputs: Map<string, string | SerializerResult>;
  entities: Map<string, Declarable>;
  warnings: string[];
  errors: ReadonlyArray<{ name: string; message: string; toJSON?: () => unknown }>;
  sourceFileCount: number;
  dependencies?: Map<string, Set<string>>;
  manifest?: unknown;
  foldDecisions?: unknown[];
  buildParams?: unknown[];
}

/**
 * Encode a merged, serialized build result for the policy child.
 *
 * Runs in the PARENT. Throws — never drops — when the result holds something
 * the wire cannot represent: `encodeEntitySet`'s own refusals (a `nestedStack()`
 * child project, an `AttrRef` that never got a logical name) propagate, and the
 * finished payload is walked by `./config-wire.ts`'s scan so a serializer that
 * somehow produced a non-data output is named by key path rather than silently
 * mangled by `JSON.stringify`.
 */
export function encodePolicyBuildResult(result: EncodablePolicyBuildResult): PolicyBuildResultWire {
  const wire: PolicyBuildResultWire = {
    entities: encodeEntitySet(result.entities),
    outputs: [...result.outputs].map(([name, output]) => [name, encodeOutput(output)]),
    warnings: [...result.warnings],
    errors: result.errors.map((err) =>
      typeof err.toJSON === "function"
        ? (err.toJSON() as Record<string, unknown>)
        : { name: err.name, message: err.message },
    ),
    sourceFileCount: result.sourceFileCount,
    dependencies: result.dependencies ? [...result.dependencies].map(([name, deps]) => [name, [...deps]]) : [],
  };
  if (result.manifest !== undefined) wire.manifest = result.manifest;
  if (result.foldDecisions !== undefined) wire.foldDecisions = result.foldDecisions;
  if (result.buildParams !== undefined) wire.buildParams = result.buildParams;

  const offenders = scanValueWireSafety(wire, "buildResult");
  if (offenders.length > 0) {
    throw new Error(formatPolicyWireOffenders("the build result", offenders));
  }
  return wire;
}

function encodeOutput(output: string | SerializerResult): PolicyOutputWire {
  if (typeof output === "string") return output;
  const encoded: { primary: string; files?: Record<string, string>; warnings?: string[] } = { primary: output.primary };
  if (output.files !== undefined) encoded.files = { ...output.files };
  if (output.warnings !== undefined) encoded.warnings = [...output.warnings];
  return encoded;
}

/**
 * Rebuild the `PostSynthContext["buildResult"]` a check expects, from the wire.
 *
 * Runs INSIDE the child. The maps and the live entity graph are reconstructed
 * here (`decodeEntitySet`), so a check sees the same kind of object it sees
 * in-process — `ctx.entities` is a real `Map`, its values are real
 * `Declarable`s, and an `AttrRef` between two of them is a real `AttrRef`
 * carrying its resolved logical name.
 */
export function decodePolicyBuildResult(wire: PolicyBuildResultWire): PostSynthContext["buildResult"] {
  const decoded = {
    outputs: new Map<string, string | SerializerResult>(wire.outputs),
    entities: decodeEntitySet(wire.entities),
    warnings: wire.warnings ?? [],
    errors: (wire.errors ?? []) as unknown as Array<{ message: string; name: string }>,
    sourceFileCount: wire.sourceFileCount ?? 0,
    dependencies: new Map<string, Set<string>>((wire.dependencies ?? []).map(([n, d]) => [n, new Set(d)])),
    manifest: wire.manifest,
    foldDecisions: wire.foldDecisions ?? [],
    buildParams: wire.buildParams ?? [],
  };
  return decoded as unknown as PostSynthContext["buildResult"];
}

/** One thing a policy returned that cannot cross back, with the policy module it came from. */
export interface PolicyDiagnosticOffender extends ConfigWireOffender {
  /** Absolute path of the `lint.policies` module whose check returned it. */
  policy: string;
}

/**
 * Validate what one policy module's checks returned, INSIDE the child, before
 * it goes anywhere near the IPC channel.
 *
 * Two separate questions, both answered here rather than by hoping
 * `JSON.stringify` behaves:
 *
 *  1. Is it data? A `PostSynthDiagnostic` is declared as five plain fields, but
 *     a check is arbitrary project code and can return anything. A function, a
 *     `Date`, a class instance, a circular reference — `JSON.stringify` would
 *     drop or rewrite each of them without a word, and the CLI would print a
 *     diagnostic that is not the one the policy produced.
 *  2. Is it a diagnostic? A missing `checkId`, or a `severity` outside
 *     `error`/`warning`/`info`, is reported here instead of turning into an
 *     undefined-shaped line in the build's error list.
 */
export function scanPolicyDiagnostics(
  diagnostics: unknown,
  policyPath: string,
): PolicyDiagnosticOffender[] {
  const out: PolicyDiagnosticOffender[] = [];
  if (!Array.isArray(diagnostics)) {
    out.push({ policy: policyPath, path: "<return value>", found: describeShape(diagnostics) });
    return out;
  }

  for (const offender of scanValueWireSafety(diagnostics, "")) {
    out.push({ policy: policyPath, ...offender });
  }
  if (out.length > 0) return out;

  const severities = new Set(["error", "warning", "info"]);
  diagnostics.forEach((diag, i) => {
    const d = diag as Partial<PostSynthDiagnostic> | null;
    if (d === null || typeof d !== "object" || Array.isArray(d)) {
      out.push({ policy: policyPath, path: `[${i}]`, found: describeShape(diag) });
      return;
    }
    if (typeof d.checkId !== "string" || d.checkId.length === 0) {
      out.push({ policy: policyPath, path: `[${i}].checkId`, found: "not a non-empty string" });
    }
    if (typeof d.message !== "string") {
      out.push({ policy: policyPath, path: `[${i}].message`, found: "not a string" });
    }
    if (typeof d.severity !== "string" || !severities.has(d.severity)) {
      out.push({ policy: policyPath, path: `[${i}].severity`, found: `not one of "error", "warning", "info"` });
    }
  });
  return out;
}

/**
 * Thrown INSIDE the child by the per-check wrapper `./driver.ts` generates,
 * when a check returns something that cannot cross back. Carries the offenders
 * so the driver can report them as data rather than as a message string it
 * would then have to parse.
 *
 * A class rather than a tagged object because the driver tests it with
 * `instanceof`: both halves come from this one module, bundled once, so there
 * is exactly one class identity inside the child.
 */
export class PolicyWireError extends Error {
  readonly offenders: PolicyDiagnosticOffender[];

  constructor(offenders: PolicyDiagnosticOffender[]) {
    super(formatPolicyWireOffenders("a policy check's return value", offenders));
    this.name = "PolicyWireError";
    this.offenders = offenders;
  }
}

function describeShape(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (value === undefined) return "undefined";
  return `a ${typeof value}`;
}

/** Render offenders as the body of a build error — one line each, naming the policy module. */
export function formatPolicyWireOffenders(
  subject: string,
  offenders: ReadonlyArray<ConfigWireOffender & { policy?: string }>,
): string {
  const lines = offenders.map((o) => {
    const where = o.policy ? `${o.policy}${o.path ? ` ${o.path}` : ""}` : o.path || "<root>";
    return `  ${where}: ${o.found}`;
  });
  return [
    `Cannot run lint.policies inside the --sandbox boundary: ${subject} holds values that are not data.`,
    ...lines,
    `Under --sandbox a policy check runs in an isolated child process and only JSON crosses back, so every value a check returns must be a string, number, boolean, null, array or plain object, and every diagnostic must have a string checkId, a string message, and a severity of "error", "warning" or "info". Return plain diagnostics, or drop --sandbox for this build.`,
  ].join("\n");
}
