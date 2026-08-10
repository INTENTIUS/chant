import { NamingStrategy, type NamingConfig, type NamingInput } from "@intentius/chant/codegen/naming";

/**
 * The name of the policy resource every generated bundle carries.
 *
 * It is not schema-derived — a Cedar schema declares entity types and actions,
 * never policies — so it is claimed as a priority name before any schema type
 * gets to contest a short name. A project whose schema declares its own
 * `Policy` entity type therefore gets `AppPolicy` (or whatever its namespace
 * is), and the authoring class keeps the name users import.
 */
export const POLICY_TS_NAME = "Policy";

/** The `entityType` of the policy resource, matching the serializer. */
export const POLICY_TYPE = "Cedar::Policy";

/** `read` → `Read`; `service-account` → `ServiceAccount`. */
export function pascalCase(value: string): string {
  return value
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
}

/** Split `App::Action::"read"` into its action id, or null for a non-action. */
export function actionIdOf(typeName: string): string | null {
  const match = /(?:^|::)Action::"(.*)"$/.exec(typeName);
  return match ? match[1] : null;
}

/**
 * Naming configuration for the cedar lexicon.
 *
 * Two shapes go through this rather than one: `App::User` (an entity type) and
 * `App::Action::"read"` (an action). Both are entities in Cedar's model, so
 * both are contested in the same pool — a schema with an entity type called
 * `Read` and an action called `read` collides, and phase 4 qualifies the loser
 * with its namespace rather than one silently overwriting the other.
 */
export const namingConfig: NamingConfig = {
  priorityNames: {
    [POLICY_TYPE]: POLICY_TS_NAME,
  },

  priorityAliases: {},

  priorityPropertyAliases: {},

  serviceAbbreviations: {},

  /**
   * Actions get an `Action` suffix. Without it `read`/`write`/`delete` become
   * `Read`/`Write`/`Delete`, which read as entity types at the import site and
   * collide with them in schemas that have both.
   */
  shortName: (typeName: string) => {
    const actionId = actionIdOf(typeName);
    if (actionId !== null) return `${pascalCase(actionId)}Action`;
    return pascalCase(typeName.split("::").pop() ?? typeName);
  },

  /** The namespace — `App::User` → `App`, and the empty namespace → `Cedar`. */
  serviceName: (typeName: string) => {
    const segments = typeName.split("::");
    return segments.length > 1 ? segments[0] : "Cedar";
  },
};

/**
 * Create a NamingStrategy instance from parsed results.
 *
 * `Cedar::Policy` is injected as an input because it has to be *in* the contest
 * to win it: `priorityNames` is applied over the input type names, so a policy
 * type that never appears there cannot claim `Policy` before a schema's own
 * `Policy` entity type takes it in the short-name phase.
 */
export function createNaming(inputs: NamingInput[]): NamingStrategy {
  return new NamingStrategy([{ typeName: POLICY_TYPE, propertyTypes: [] }, ...inputs], namingConfig);
}

/**
 * The names derived from a primary name — the entity's attribute record and
 * the action's context record.
 *
 * These are not contested by `NamingStrategy` (it only names the primary
 * declarations), so they are de-duplicated against everything already taken.
 * The suffix loop is deliberately boring: a schema that manages to collide
 * `UserAttributes` twice gets `UserAttributes2`, which is ugly and correct,
 * rather than one entry silently overwriting the other in the registry.
 */
export function deriveName(base: string, suffix: string, taken: Set<string>): string {
  let candidate = `${base}${suffix}`;
  let n = 2;
  while (taken.has(candidate)) {
    candidate = `${base}${suffix}${n}`;
    n++;
  }
  taken.add(candidate);
  return candidate;
}
