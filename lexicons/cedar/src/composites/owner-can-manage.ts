/**
 * OwnerCanManage — the ownership grant, written once.
 *
 * "The owner of a thing may act on it" is the most-repeated shape in every
 * Cedar policy set, and hand-writing it per entity type is where the two
 * classic mistakes get made: the `when` guard names an attribute the schema
 * spells differently, or the grant is written wide and the scoping clause is
 * forgotten. Cedar itself cannot help — it has no functions, no modules, and
 * templates carry exactly two slots. A TypeScript factory is the only place
 * this abstraction can live.
 *
 * The composite emits a permit whose resource scope is pinned with `is` and
 * whose ownership test is a `when` clause, so both halves arrive together or
 * neither does.
 */

import type { Declarable } from "@intentius/chant/declarable";
import { Policy } from "../generated/index";
import type { EntityTypeName, PolicyRef, PolicyScope } from "../generated/index";

export interface OwnerCanManageOpts {
  /** The entity type owners act on, e.g. `"App::Document"`. */
  entityType: EntityTypeName;
  /**
   * Actions the owner is granted. A single action is emitted as `== A`, several
   * as `in [A, …]`, and none leaves the action position unconstrained — which
   * is a wide grant, so it has to be asked for by omitting the field.
   */
  actions?: PolicyRef | PolicyRef[];
  /**
   * The attribute on the resource that holds the owner. Defaults to `owner`,
   * the name the bundled schema and most Cedar examples use.
   */
  ownerAttribute?: string;
  /**
   * Narrow the principal beyond "anyone". A bare entity type string becomes
   * `principal is T`; a full scope is passed through.
   */
  principal?: EntityTypeName | PolicyScope;
  /** Extra `when` clauses, appended after the ownership test. */
  when?: string[];
  /** `unless` clauses. An MFA requirement is the usual one. */
  unless?: string[];
  /** Merged over the generated annotations; an explicit `id` wins. */
  annotations?: Record<string, string>;
}

function actionScope(actions: OwnerCanManageOpts["actions"]): PolicyScope {
  if (actions === undefined) return {};
  if (Array.isArray(actions)) {
    return actions.length === 1 ? { eq: actions[0] } : { in: actions };
  }
  return { eq: actions };
}

function principalScope(principal: OwnerCanManageOpts["principal"]): PolicyScope {
  if (principal === undefined) return {};
  return typeof principal === "string" ? { is: principal } : principal;
}

/**
 * One permit: the owner of an `entityType` may take `actions` on it.
 */
export function OwnerCanManage(opts: OwnerCanManageOpts): Declarable {
  const ownerAttribute = opts.ownerAttribute ?? "owner";

  return new Policy({
    effect: "permit",
    principal: principalScope(opts.principal),
    action: actionScope(opts.actions),
    resource: { is: opts.entityType },
    when: [`resource.${ownerAttribute} == principal`, ...(opts.when ?? [])],
    ...(opts.unless && opts.unless.length > 0 ? { unless: opts.unless } : {}),
    annotations: {
      composite: "OwnerCanManage",
      scopedTo: opts.entityType,
      ...(opts.annotations ?? {}),
    },
  });
}
