import type { BuildParamProvenance } from "./provenance";

/**
 * Build-time parameter declaration + resolution (chant #1064, follow-up to
 * epic #1019's fold work — see issue #1064's "DECISION: option 1" comment).
 *
 * A build-time parameter is declared in `chant.config.ts`'s `buildParams`
 * (name, type, optional `default`/`enum`/`env` mapping), supplied to `chant
 * build` (a `--param name=value` flag, a `--params-file` JSON file, or a
 * declared `env` var), and referenced from source as `params.<name>` (see
 * ./params.ts) — never as an ambient `process.env` read. This module owns
 * declaration + precedence + validation; ./params.ts is the plain runtime
 * object source references; ../discovery/fold-import.ts is what makes a
 * `params.<name>` reference fold to a literal instead of a symbolic node.
 *
 * This is NOT the deploy-time `Parameter` class (`lexicons/aws/src/parameter.ts`)
 * — that resolves when a CloudFormation stack deploys; this resolves before
 * the template is even synthesized, so its value can change which resources
 * are produced at all. See ./params.ts's module doc for the full distinction.
 */

/** A build-time parameter's resolved (and declared-default/enum) value — always a scalar. */
export type BuildParamValue = string | number | boolean;

/**
 * One declared build-time parameter (`chant.config.ts`'s `buildParams.<name>`).
 */
export interface BuildParamDef {
  /** The value's declared type — supplied strings (CLI flags, env vars, JSON-file strings) are coerced to it. */
  type: "string" | "number" | "boolean";
  /** Value used when no `--param`/`--params-file`/declared `env` var supplies one. Omit to require an explicit value every build. */
  default?: BuildParamValue;
  /**
   * Allowed values — a resolved value outside this list is a build error
   * naming the parameter (never a thrown error from user source). Replaces
   * the hand-written `if (!VALID.includes(raw)) throw ...` pattern a project's
   * own `params.ts` writes before migrating to this mechanism.
   */
  enum?: readonly BuildParamValue[];
  /**
   * Opt-in, EXPLICITLY declared environment-variable fallback — e.g. `env:
   * "LOOM_TIER"`. This is the only place an env var may feed a build-time
   * parameter: reading `process.env` directly from project source is never
   * supported (see ./params.ts's module doc and ../fold/fold.ts's pointed
   * error for a bare `process` reference). Consulted only when no
   * `--param`/`--params-file` value was supplied for this parameter.
   */
  env?: string;
  /**
   * Set `false` to make an unresolved value NOT a build error: `params.<name>`
   * is simply omitted (reads as plain JS `undefined` — a normal, un-erroring
   * property access on an object missing that key), instead of the default
   * behavior of requiring every declared parameter to resolve to something.
   * For a value that is genuinely optional with no meaningful default (an ARN
   * that references an existing resource only on some deploys, a CIDR
   * override, a JSON blob) — the same "unset means the composite decides"
   * shape a hand-written `process.env.X || undefined` used to express.
   * Default `true` (a declared parameter must resolve to a value).
   */
  required?: boolean;
  /** Human-readable description, surfaced in error messages and docs generation. */
  description?: string;
}

/** A project's full set of declared build-time parameters, keyed by name. */
export type BuildParamsConfig = Record<string, BuildParamDef>;

/** Raw, not-yet-validated inputs {@link resolveBuildParams} resolves against a project's declared {@link BuildParamsConfig}. */
export interface BuildParamsInput {
  /** `--param name=value` flags, repeated — highest precedence. */
  cli?: Record<string, string>;
  /** Parsed contents of a `--params-file` JSON file — second precedence. */
  fromFile?: Record<string, unknown>;
  /** The process environment, consulted only for a parameter that declares an `env` mapping, and only once `cli`/`fromFile` have no value for it. */
  env?: Record<string, string | undefined>;
  /**
   * The workspace flags that back parameters in this build's environment
   * (#4024), read by `./flag-params.ts`. A flag-backed parameter takes the
   * flag's value for the environment, recorded with `source: "flag:<id>"`,
   * ahead of its `env` mapping and its default. Absent outside a workspace
   * and without `--env`.
   */
  flags?: BuildParamFlags;
}

/** The flags that back parameters in one environment (#4024). */
export interface BuildParamFlags {
  /** The environment the build is for. */
  env: string;
  /** Each flag-backed parameter by name: the flag's name, and its value in `env` (undefined when the flag gives it none). */
  byParam: Record<string, { flag: string; value: BuildParamValue | undefined }>;
  /**
   * The environment has a gate (#4024's precedence rule): a `--param`,
   * `--params-file` or env-var value for a flag-backed parameter is refused,
   * so no path flips a flag around the gate.
   */
  gated?: boolean;
}

/** Result of resolving a project's declared parameters against one build invocation's inputs. */
export interface BuildParamsResolution {
  /** Every successfully resolved parameter — see {@link BuildParamProvenance}. Empty when the project declares none. */
  provenance: BuildParamProvenance[];
  /**
   * Validation failures, each naming the offending parameter — an unknown
   * `--param`/`--params-file` key, a missing required value, a type mismatch,
   * or a value outside a declared `enum`. Reported by the CLI as a build
   * error (chant #1064's acceptance criterion: "not a thrown error inside
   * user source"); never thrown from here.
   */
  errors: string[];
}

function formatValue(value: unknown): string {
  return typeof value === "string" ? `"${value}"` : String(value);
}

/** Coerce `raw` to `def.type`, appending a located error and returning `undefined` on failure. */
function coerce(name: string, raw: BuildParamValue, def: BuildParamDef, errors: string[]): BuildParamValue | undefined {
  if (def.type === "string") return String(raw);

  if (def.type === "number") {
    const n = typeof raw === "number" ? raw : Number(raw);
    if (Number.isNaN(n)) {
      errors.push(`build parameter "${name}" must be a number, got ${formatValue(raw)}`);
      return undefined;
    }
    return n;
  }

  // def.type === "boolean"
  if (typeof raw === "boolean") return raw;
  if (raw === "true") return true;
  if (raw === "false") return false;
  errors.push(`build parameter "${name}" must be a boolean ("true" or "false"), got ${formatValue(raw)}`);
  return undefined;
}

/**
 * Resolve a project's declared build-time parameters against one build's
 * supplied inputs. Precedence per parameter, most to least specific:
 * `cli` (`--param name=value`) > `fromFile` (`--params-file`) > the
 * parameter's own declared `env` mapping (only if set) > a workspace flag's
 * value for the build's environment (`input.flags`, #4024) > `def.default`.
 * When `input.flags.gated` is set, a flag-backed parameter takes none of the
 * first three: a value from any of them is a build error, so a flag can't be
 * flipped around the environment's gate.
 *
 * A parameter with no declared `default` and no value from any source is a
 * build error, not a silently-`undefined` value — a build-time parameter
 * exists specifically so a project never has an invisible dependency on
 * ambient state; leaving one unresolved would just reintroduce that under a
 * different name. Every failure is collected (not thrown), each naming the
 * offending parameter, so a single invocation reports every problem at once.
 *
 * The one opt-out is `def.required: false` — for a parameter that is
 * genuinely optional with no meaningful default (an ARN that only applies to
 * a reference-existing deploy, a CIDR override), an unresolved value is
 * simply omitted from `provenance`/`params` rather than an error; source
 * reads it as plain `undefined`, same as before migrating off
 * `process.env.X || undefined`.
 */
export function resolveBuildParams(defs: BuildParamsConfig | undefined, input: BuildParamsInput): BuildParamsResolution {
  const declared = defs ?? {};
  const cli = input.cli ?? {};
  const fromFile = input.fromFile ?? {};
  const env = input.env ?? {};
  const errors: string[] = [];
  const provenance: BuildParamProvenance[] = [];

  for (const key of Object.keys(cli)) {
    if (!(key in declared)) {
      errors.push(`unknown build parameter "${key}" (from --param) — not declared in chant.config.ts's buildParams`);
    }
  }
  for (const key of Object.keys(fromFile)) {
    if (!(key in declared)) {
      errors.push(`unknown build parameter "${key}" (from --params-file) — not declared in chant.config.ts's buildParams`);
    }
  }

  const flags = input.flags;
  for (const [name, binding] of Object.entries(flags?.byParam ?? {})) {
    if (!(name in declared)) {
      errors.push(`flag "${binding.flag}" sets build parameter "${name}", which chant.config.ts's buildParams does not declare`);
    }
  }

  for (const [name, def] of Object.entries(declared)) {
    let raw: BuildParamValue | undefined;
    let source: BuildParamProvenance["source"] | undefined;
    const binding = flags?.byParam[name];

    if (binding && flags?.gated) {
      // #4024: in an environment with a gate, the flag record is the only way to set the parameter.
      const around = name in cli ? "--param" : name in fromFile ? "--params-file" : def.env && env[def.env] !== undefined ? `the env var ${def.env}` : null;
      if (around !== null) {
        errors.push(flagGateRefusal(name, binding.flag, flags.env, around));
        continue;
      }
    }

    if (name in cli) {
      raw = cli[name];
      source = "cli";
    } else if (name in fromFile) {
      const fileValue = fromFile[name];
      if (typeof fileValue !== "string" && typeof fileValue !== "number" && typeof fileValue !== "boolean") {
        errors.push(`build parameter "${name}" (from --params-file) must be a string, number, or boolean`);
        continue;
      }
      raw = fileValue;
      source = "params-file";
    } else if (def.env && env[def.env] !== undefined) {
      raw = env[def.env];
      source = "env";
    } else if (binding && binding.value !== undefined) {
      raw = binding.value;
      source = `flag:${binding.flag}`;
    } else if (def.default !== undefined) {
      raw = def.default;
      source = "default";
    }

    if (raw === undefined || source === undefined) {
      if (def.required === false) continue; // omitted entirely — params.<name> reads as undefined, not an error
      const envHint = def.env ? `, set ${def.env}` : "";
      errors.push(
        `build parameter "${name}" has no value — pass --param ${name}=<value>, use --params-file${envHint}, or add a default in chant.config.ts's buildParams`,
      );
      continue;
    }

    const value = coerce(name, raw, def, errors);
    if (value === undefined) continue;

    if (def.enum && !def.enum.includes(value)) {
      errors.push(
        `build parameter "${name}" must be one of ${def.enum.map(formatValue).join(", ")}, got ${formatValue(value)}`,
      );
      continue;
    }

    provenance.push({ name, value, source });
  }

  return { provenance, errors };
}

/**
 * The build error for a flag-backed parameter that `around` (`--param`,
 * `--params-file` or an env var) set in an environment with a gate (#4024).
 */
export function flagGateRefusal(name: string, flag: string, env: string, around: string): string {
  return `build parameter "${name}" is backed by the flag "${flag}", and "${env}" has a gate, so ${around} can't set it; change the flag record and let the change go through the gate`;
}

/** Project the resolved provenance records down to a plain `{ name: value }` map — what actually gets bound to `params.<name>` (see ./params.ts). */
export function buildParamValues(provenance: readonly BuildParamProvenance[]): Record<string, BuildParamValue> {
  return Object.fromEntries(provenance.map((p) => [p.name, p.value]));
}
