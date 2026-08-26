/**
 * Plan scenarios (chant #1292): a declared expectation about what a change
 * SHOULD do, checkable offline against a fixture snapshot.
 *
 * Everything else chant validates is about shape — is this declaration
 * well-formed, does this reference resolve. Nothing answers "what will this
 * change do" as something source can assert about itself, until now. A
 * `Scenario` pairs a `given` (a stand-in for live observation) with an
 * `expect` (a claim about the resulting change set) — `chant scenario check`
 * (../cli/handlers/scenario.ts) builds the project, replays `given` in place
 * of a live read, and evaluates `expect` against the resulting `ChangeSet`
 * (./change-set.ts) via `evaluateScenario` (./scenario-eval.ts).
 *
 * Modeled precisely on the other non-resource Declarables (../effect-receipt.ts,
 * ../secret-provenance.ts): discovery collects a `Scenario` like any entity
 * (it is a Declarable), but it carries no resource payload and no serializer
 * ever emits it — `partitionByLexicon` (../build.ts) excludes it from every
 * lexicon's partition, the same way it excludes a secret declaration.
 *
 * This module is pure and does no I/O: `snapshot()` records where the fixture
 * comes from without reading it, and the factory validates and freezes. The
 * CLI handler is where the fixture is actually read, replayed, and compared —
 * the same synthesis/plan split every other lifecycle primitive here follows.
 */

import { DECLARABLE_MARKER, type Declarable } from "../declarable";
import type { Ownership } from "./change-set";

/** Marker symbol identifying a scenario declaration. `Symbol.for` so it
 * survives the entity-wire codec, the same reason ../effect-receipt.ts and
 * ../secret-provenance.ts use `Symbol.for` for their markers. */
export const SCENARIO_MARKER = Symbol.for("chant.scenario");

/** The `entityType` every scenario declaration carries. */
export const SCENARIO_ENTITY_TYPE = "Chant::Scenario";

/**
 * `given: snapshot("fixtures/prod-baseline.json")` — a checked-in fixture, in
 * the same {@link LifecycleSnapshot} JSON shape `chant lifecycle snapshot`
 * writes (a single lexicon's recorded resources). Path-relative to the
 * project root, read at check time — never here.
 */
export interface ScenarioGivenFile {
  readonly kind: "file";
  /** Repo-relative path to the fixture JSON file. */
  readonly path: string;
}

/**
 * `given: snapshot("prod")` — the last snapshot recorded for that environment
 * on the `chant/lifecycle` orphan branch (one file per lexicon, read via
 * `readSnapshot`/`readEnvironmentSnapshots`, ../lifecycle/git.ts), replayed
 * exactly as `chant lifecycle plan` reads its own prior snapshot.
 */
export interface ScenarioGivenEnv {
  readonly kind: "env";
  /** Environment name, matching a `chant.config.ts` `environments` entry. */
  readonly env: string;
}

/** What a scenario's `given` stands in for — a fixture file or a recorded environment. */
export type ScenarioGiven = ScenarioGivenFile | ScenarioGivenEnv;

/**
 * Declare `given` from a single string. Pure and offline: no filesystem
 * access, no git — the factory only classifies the string's SHAPE, never
 * checks whether it exists. That is what keeps `Scenario` foldable under
 * `--sandbox`, the same discipline `declareSecret`'s committed-encrypted path
 * validation follows (../secret-provenance.ts).
 *
 * The classification is structural: a string containing a path separator or
 * ending in `.json` is a fixture file; anything else (a bare token like
 * `"prod"`) is an environment name. A `chant.config.ts` environment name that
 * happens to contain a slash or end in `.json` is not supported by this
 * heuristic — pass `{ kind: "env", env }` directly in that unlikely case.
 */
export function snapshot(source: string): ScenarioGiven {
  if (typeof source !== "string" || source.length === 0) {
    throw new Error("snapshot: `source` must be a non-empty string");
  }
  const looksLikeFile = source.includes("/") || source.includes("\\") || source.toLowerCase().endsWith(".json");
  return looksLikeFile ? { kind: "file", path: source } : { kind: "env", env: source };
}

/** One named delete an `expect.deletes` clause requires — the resource must
 * be proposed for deletion, and with exactly this ownership verdict. */
export interface ScenarioDeleteExpectation {
  /** The change-set entry name (ChangeSetEntry.name) expected to delete. */
  readonly name: string;
  /** The ownership verdict (./change-set.ts's `Ownership`) the delete must carry. */
  readonly ownership: Ownership;
}

/**
 * How a scenario treats the change set's `unobserved` rows (#1089):
 *
 * - `"refuse"` — any unobserved entry fails the scenario. The plan admitting
 *   a hole is never a pass, the same fail-closed instinct
 *   `evaluateUnobservedGate`'s default takes (./unobserved-gate.ts).
 * - `{ allow: [names] }` — the named entities may be unobserved without
 *   failing the scenario; any unobserved entity NOT in the list still fails
 *   it. Unlike `evaluateUnobservedGate`'s policy (which allows by *reason*),
 *   this allows by entity *name* — the natural unit for a scenario written
 *   against one fixture, where "this specific resource has no binding in the
 *   fixture" is a known, accepted gap rather than a class of reason to trust
 *   everywhere.
 */
export type ScenarioUnobservedPolicy = "refuse" | { readonly allow: readonly string[] };

/**
 * The assertion vocabulary (#1292 research, settled shape). Every clause is
 * independently optional and clauses compose within one `expect` object — a
 * scenario can assert `noop`, exact counts, specific named deletes, and an
 * unobserved policy together. At least one clause must be present; an empty
 * `expect` asserts nothing and is refused as a likely mistake.
 */
export interface ScenarioExpect {
  /** The plan proposes no create, update, or delete, and no declared effect
   * receipt (#1832) fires — the majority-value case (refactors, upgrades,
   * no-op deploys). Equivalent to `{ create: 0, update: 0, delete: 0 }` plus
   * "no receipt classifies as `effect`", but reads as the specific claim it
   * is: a pending effect fire is a real proposed action even though it never
   * joins the create/update/delete triad. */
  readonly noop?: true;
  /** Exact count of `create` rows the plan must propose. Omitted = unconstrained. */
  readonly create?: number;
  /** Exact count of `update` rows the plan must propose. Omitted = unconstrained. */
  readonly update?: number;
  /** Exact count of `delete` rows the plan must propose. Omitted = unconstrained. */
  readonly delete?: number;
  /** Exactly these resources must delete, each with the stated ownership —
   * and no OTHER delete may be proposed. The highest-value assertion in the
   * vocabulary: "this plan deletes nothing foreign", made precise per-name. */
  readonly deletes?: readonly ScenarioDeleteExpectation[];
  /** How the scenario treats unobserved rows. Omitted = unconstrained (an
   * unobserved entity neither passes nor fails the scenario on its own). */
  readonly unobserved?: ScenarioUnobservedPolicy;
}

/** Every recognized `expect` clause key — for the excess-key check below and
 * for exhaustiveness at call sites. */
const EXPECT_KEYS = ["noop", "create", "update", "delete", "deletes", "unobserved"] as const;

const OWNERSHIP_VALUES: readonly Ownership[] = ["owned", "foreign", "unknown"];

/**
 * A scenario declaration — a Declarable, so discovery collects it and `chant
 * list` shows it, but it carries no resource payload: `partitionByLexicon`
 * (../build.ts) excludes it from every serializer partition, so no lexicon
 * ever emits it and no apply-bound document ever contains one.
 */
export interface ScenarioDeclaration extends Declarable {
  readonly [SCENARIO_MARKER]: true;
  readonly lexicon: "chant";
  readonly entityType: typeof SCENARIO_ENTITY_TYPE;
  /** The scenario's own name — what `chant scenario check` reports pass/fail against. */
  readonly name: string;
  readonly given: ScenarioGiven;
  readonly expect: ScenarioExpect;
}

/** Factory options for {@link Scenario}. */
export interface ScenarioOptions {
  /** What stands in for live observation — a fixture file or a recorded environment. */
  readonly given: ScenarioGiven;
  /** The claim about the resulting change set. At least one clause required. */
  readonly expect: ScenarioExpect;
}

/**
 * Declare a plan scenario. The returned object is a locked Declarable:
 * declared fields are immutable and nested structures are frozen, the same
 * shape ../effect-receipt.ts and ../secret-provenance.ts lock down; the
 * top-level object stays extensible so discovery can still stamp its own
 * symbol-keyed metadata.
 */
export function Scenario(name: string, options: ScenarioOptions): ScenarioDeclaration {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("Scenario: `name` must be a non-empty string");
  }
  const given = validateGiven(name, options?.given);
  const expect = validateExpect(name, options?.expect);

  const decl: ScenarioDeclaration = {
    [DECLARABLE_MARKER]: true,
    [SCENARIO_MARKER]: true,
    lexicon: "chant",
    entityType: SCENARIO_ENTITY_TYPE,
    name,
    given,
    expect,
  };
  for (const key of Object.keys(decl)) {
    Object.defineProperty(decl, key, { writable: false, configurable: false });
  }
  return decl;
}

function validateGiven(name: string, given: unknown): ScenarioGiven {
  if (typeof given !== "object" || given === null) {
    throw new Error(`Scenario("${name}"): \`given\` is required — use snapshot(path) or snapshot(env)`);
  }
  const g = given as Partial<ScenarioGiven>;
  if (g.kind === "file") {
    if (typeof g.path !== "string" || g.path.length === 0) {
      throw new Error(`Scenario("${name}"): \`given\` of kind "file" requires a non-empty \`path\``);
    }
    return Object.freeze({ kind: "file", path: g.path });
  }
  if (g.kind === "env") {
    if (typeof g.env !== "string" || g.env.length === 0) {
      throw new Error(`Scenario("${name}"): \`given\` of kind "env" requires a non-empty \`env\``);
    }
    return Object.freeze({ kind: "env", env: g.env });
  }
  throw new Error(
    `Scenario("${name}"): \`given\` must come from snapshot(path) or snapshot(env), got kind "${String((g as { kind?: unknown }).kind)}"`,
  );
}

function validateExpect(name: string, expect: unknown): ScenarioExpect {
  if (typeof expect !== "object" || expect === null || Array.isArray(expect)) {
    throw new Error(`Scenario("${name}"): \`expect\` must be a plain object`);
  }
  const e = expect as Record<string, unknown>;
  for (const key of Object.keys(e)) {
    if (!(EXPECT_KEYS as readonly string[]).includes(key)) {
      throw new Error(
        `Scenario("${name}"): unknown \`expect\` clause "${key}" — expected one of ${EXPECT_KEYS.join(", ")}`,
      );
    }
  }
  if (Object.keys(e).length === 0) {
    throw new Error(
      `Scenario("${name}"): \`expect\` must include at least one clause (${EXPECT_KEYS.join(", ")}) — an empty expect asserts nothing`,
    );
  }

  const out: Record<string, unknown> = {};

  if ("noop" in e) {
    if (e.noop !== true) {
      throw new Error(`Scenario("${name}"): \`expect.noop\`, when present, must be exactly \`true\``);
    }
    out.noop = true;
  }
  for (const countKey of ["create", "update", "delete"] as const) {
    if (countKey in e) {
      const v = e[countKey];
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
        throw new Error(`Scenario("${name}"): \`expect.${countKey}\`, when present, must be a non-negative integer`);
      }
      out[countKey] = v;
    }
  }
  if ("deletes" in e) {
    if (!Array.isArray(e.deletes)) {
      throw new Error(`Scenario("${name}"): \`expect.deletes\` must be an array`);
    }
    out.deletes = Object.freeze(
      e.deletes.map((d, i) => {
        if (typeof d !== "object" || d === null) {
          throw new Error(`Scenario("${name}"): \`expect.deletes[${i}]\` must be an object`);
        }
        const { name: deleteName, ownership } = d as Record<string, unknown>;
        if (typeof deleteName !== "string" || deleteName.length === 0) {
          throw new Error(`Scenario("${name}"): \`expect.deletes[${i}].name\` must be a non-empty string`);
        }
        if (!(OWNERSHIP_VALUES as readonly unknown[]).includes(ownership)) {
          throw new Error(
            `Scenario("${name}"): \`expect.deletes[${i}].ownership\` must be one of ${OWNERSHIP_VALUES.join(", ")}`,
          );
        }
        return Object.freeze({ name: deleteName, ownership: ownership as Ownership });
      }),
    );
  }
  if ("unobserved" in e) {
    const u = e.unobserved;
    if (u === "refuse") {
      out.unobserved = "refuse";
    } else if (typeof u === "object" && u !== null && Array.isArray((u as { allow?: unknown }).allow)) {
      const allow = (u as { allow: unknown[] }).allow;
      allow.forEach((entry, i) => {
        if (typeof entry !== "string" || entry.length === 0) {
          throw new Error(`Scenario("${name}"): \`expect.unobserved.allow[${i}]\` must be a non-empty string`);
        }
      });
      out.unobserved = Object.freeze({ allow: Object.freeze([...allow]) });
    } else {
      throw new Error(
        `Scenario("${name}"): \`expect.unobserved\` must be "refuse" or { allow: [names] }`,
      );
    }
  }

  return Object.freeze(out) as ScenarioExpect;
}

/** Type guard for a scenario declaration. */
export function isScenario(value: unknown): value is ScenarioDeclaration {
  return (
    typeof value === "object" &&
    value !== null &&
    SCENARIO_MARKER in value &&
    (value as Record<symbol, unknown>)[SCENARIO_MARKER] === true
  );
}

/**
 * Extract the scenario declarations from a discovered entity map — the read
 * surface `chant scenario check` (../cli/handlers/scenario.ts) uses. Keyed by
 * entity name (export name), the same key `DiscoveryResult.entities` uses.
 */
export function collectScenarios(entities: ReadonlyMap<string, Declarable>): Map<string, ScenarioDeclaration> {
  const out = new Map<string, ScenarioDeclaration>();
  for (const [name, entity] of entities) {
    if (isScenario(entity)) out.set(name, entity);
  }
  return out;
}
