/**
 * "Which policies cover this resource?" — answered from a build (epic #1645).
 *
 * `src/coverage.ts` next door asks a different question: is every schema
 * declaration reachable from the *generated artifacts*. This one asks whether
 * every schema declaration is reachable from the *policy set*, which is the
 * authorization question. An entity type no policy can ever apply to is a
 * resource nothing grants and nothing denies — under Cedar's default-deny it is
 * inert, and that is either the intent or a hole.
 *
 * The answer comes from `getValidRequestEnvsPolicy`, Cedar's own resolver: it
 * takes one policy and the schema and returns every (principal, action,
 * resource) triple the policy could apply to, having already expanded `is`,
 * `in`, action groups, and `appliesTo`. Reimplementing that against the parsed
 * scope would be a second, worse Cedar; this is why the wasm package is a
 * runtime dependency rather than a dev one.
 */

import {
  getValidRequestEnvsPolicy,
  policySetTextToParts,
  policyToJson,
} from "@cedar-policy/cedar-wasm/nodejs";
import { readSchemaSource, type ResolveSchemaOptions } from "../spec/fetch";
import { parseCedarSchema } from "../spec/parse";

export interface CedarPolicyCoverageItem {
  /** `App::Document` or `App::Action::"read"`. */
  name: string;
  kind: "entity" | "action";
  /** How many policies in the set can apply to it. */
  policies: number;
  /** Ids of the policies that can, in declaration order. */
  policyIds: string[];
  /** True when at least one of those policies is a `permit`. */
  permitted: boolean;
  /** True when at least one of those policies is a `forbid`. */
  forbidden: boolean;
}

export interface CedarPolicyCoverageReport {
  /** Where the schema came from. */
  schemaPath: string;
  isDefaultSchema: boolean;
  /** Policies the set parsed into. */
  policyCount: number;
  entityTypes: number;
  entityTypesCovered: number;
  actions: number;
  actionsCovered: number;
  /** Declarations no policy in the set can apply to. */
  uncovered: string[];
  /** Declarations reachable only from a `forbid` — nothing ever grants them. */
  forbidOnly: string[];
  items: CedarPolicyCoverageItem[];
  /** Policies the resolver could not place, with its reason. */
  unresolved: Array<{ policyId: string; error: string }>;
  /**
   * Ids of policies whose valid request envelope is empty — no request can ever
   * match them.
   *
   * A scope naming an entity type the schema does not declare lands here rather
   * than in {@link unresolved}: `getValidRequestEnvsPolicy` answers "success,
   * nothing" rather than failing, and a policy that can never fire is a real
   * finding either way. It is usually a typo'd entity type.
   */
  inert: string[];
  /**
   * Why the policy set could not be split into policies, when it could not.
   *
   * Without this a set that fails to parse reports zero policies and every
   * declaration uncovered — the same numbers as a project with no policies at
   * all, and the opposite diagnosis.
   */
  parseErrors: string[];
}

export interface CedarPolicyCoverageOptions extends ResolveSchemaOptions {
  /** The emitted `.cedar` policy set text. */
  policySetText: string;
}

/**
 * A policy's id and effect, read from Cedar's own parse rather than from the
 * text.
 *
 * The regex version of this worked on the serializer's output and only on the
 * serializer's output: a hand-formatted policy, an annotation whose value
 * contains the word `forbid`, or an escaped quote inside `@id` each break it.
 * `policyToJson` is already in the package, so there is no reason to guess.
 *
 * `index` supplies the fallback id, because a Cedar policy is not required to
 * annotate one and a report keyed by "" would collapse them together.
 */
function identify(text: string, index: number): { id: string; effect: "permit" | "forbid" } {
  const parsed = policyToJson(text);
  if (parsed.type !== "success") {
    return { id: `policy-${index + 1}`, effect: "permit" };
  }
  const annotated = parsed.json.annotations?.id;
  return {
    id: typeof annotated === "string" && annotated.length > 0 ? annotated : `policy-${index + 1}`,
    effect: parsed.json.effect === "forbid" ? "forbid" : "permit",
  };
}

/**
 * Report which schema declarations the policy set can reach.
 */
export function computePolicyCoverage(options: CedarPolicyCoverageOptions): CedarPolicyCoverageReport {
  const source = readSchemaSource(options);
  const { decls } = parseCedarSchema(source.text);

  const parts = policySetTextToParts(options.policySetText);
  const policies = parts.type === "success" ? parts.policies : [];
  const parseErrors = parts.type === "success" ? [] : parts.errors.map((e) => e.message);

  const hits = new Map<string, { ids: string[]; permitted: boolean; forbidden: boolean }>();
  const unresolved: Array<{ policyId: string; error: string }> = [];
  const inert: string[] = [];

  policies.forEach((text, index) => {
    const { id, effect } = identify(text, index);
    const envs = getValidRequestEnvsPolicy(text, source.text);
    if (envs.type !== "success") {
      unresolved.push({ policyId: id, error: envs.error });
      return;
    }

    const reached = [...envs.principals, ...envs.actions, ...envs.resources];
    if (reached.length === 0) {
      inert.push(id);
      return;
    }

    for (const name of reached) {
      const hit = hits.get(name) ?? { ids: [], permitted: false, forbidden: false };
      if (!hit.ids.includes(id)) hit.ids.push(id);
      if (effect === "permit") hit.permitted = true;
      else hit.forbidden = true;
      hits.set(name, hit);
    }
  });

  const items: CedarPolicyCoverageItem[] = decls
    .map((decl) => {
      const hit = hits.get(decl.typeName);
      return {
        name: decl.typeName,
        kind: decl.kind,
        policies: hit?.ids.length ?? 0,
        policyIds: hit?.ids ?? [],
        permitted: hit?.permitted ?? false,
        forbidden: hit?.forbidden ?? false,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const entities = items.filter((i) => i.kind === "entity");
  const actions = items.filter((i) => i.kind === "action");

  return {
    schemaPath: source.path,
    isDefaultSchema: source.isDefault,
    policyCount: policies.length,
    entityTypes: entities.length,
    entityTypesCovered: entities.filter((i) => i.policies > 0).length,
    actions: actions.length,
    actionsCovered: actions.filter((i) => i.policies > 0).length,
    uncovered: items.filter((i) => i.policies === 0).map((i) => i.name),
    forbidOnly: items.filter((i) => i.policies > 0 && !i.permitted).map((i) => i.name),
    items,
    unresolved,
    inert,
    parseErrors,
  };
}

/** Human-readable summary, for the CLI-shaped callers. */
export function formatPolicyCoverage(report: CedarPolicyCoverageReport): string {
  const lines = [
    `Cedar policy coverage — ${report.policyCount} policy/policies against ` +
      `${report.isDefaultSchema ? "the bundled default schema" : report.schemaPath}`,
    `  Entity types: ${report.entityTypesCovered}/${report.entityTypes}`,
    `  Actions:      ${report.actionsCovered}/${report.actions}`,
  ];

  for (const error of report.parseErrors) {
    lines.push(`  Parse error:  ${error}`);
  }
  if (report.uncovered.length > 0) {
    lines.push(`  Uncovered:    ${report.uncovered.join(", ")}`);
  }
  if (report.forbidOnly.length > 0) {
    lines.push(`  Forbid only:  ${report.forbidOnly.join(", ")}`);
  }
  if (report.inert.length > 0) {
    lines.push(`  Never fires:  ${report.inert.join(", ")}`);
  }
  for (const problem of report.unresolved) {
    lines.push(`  Unresolved:   ${problem.policyId} — ${problem.error}`);
  }

  return lines.join("\n");
}
