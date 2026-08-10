/**
 * DenyByDefaultSet — a forbid floor under a group of permits.
 *
 * Cedar is already default-deny, so a floor is not about the absence of a
 * permit; it is about the presence of a bad one. A `forbid` beats every
 * `permit` in the same set unconditionally, which makes a forbid the only
 * construct that survives a later, wider grant. The pattern teams write by hand
 * is a guarded forbid at the top of a file and a pile of permits under it, with
 * nothing tying the two together — delete the forbid and the permits keep
 * working, wider than anyone intended.
 *
 * This composite returns both halves from one call, so the floor cannot be
 * dropped without dropping the members with it.
 */

import type { Declarable } from "@intentius/chant/declarable";
import { Policy } from "../generated/index";
import type { EntityTypeName, PolicyRef, PolicyScope } from "../generated/index";

export interface DenyByDefaultSetOpts {
  /**
   * The permits the floor sits under. They are returned unchanged — the floor
   * constrains them at evaluation time, not at construction time.
   */
  policies: Declarable[];
  /**
   * The entity type the floor covers. Omit to make it apply to every resource,
   * which is the strongest form and worth stating deliberately.
   */
  entityType?: EntityTypeName;
  /**
   * Actions the floor forbids. Defaults to every action, i.e. an unconstrained
   * action position.
   */
  actions?: PolicyRef | PolicyRef[];
  /**
   * The conditions under which the denial applies. Required: a forbid with no
   * guard denies everything unconditionally and no permit can lift it, which
   * is a policy set that authorizes nothing.
   */
  when: string[];
  /** Carve-outs from the denial. The break-glass principal usually lives here. */
  unless?: string[];
  /** Narrow the floor's principal. A bare entity type becomes `principal is T`. */
  principal?: EntityTypeName | PolicyScope;
  /** Merged over the generated annotations; an explicit `id` wins. */
  annotations?: Record<string, string>;
}

export interface DenyByDefaultSetResources {
  /** The `forbid` policy. Emitted first in declaration order. */
  floor: Declarable;
  /** The permits, unchanged and in the order given. */
  members: Declarable[];
  /** `[floor, ...members]`, for `export const … = DenyByDefaultSet(…).all`. */
  all: Declarable[];
}

function scope(value: EntityTypeName | PolicyScope | undefined): PolicyScope {
  if (value === undefined) return {};
  return typeof value === "string" ? { is: value } : value;
}

function actionScope(actions: DenyByDefaultSetOpts["actions"]): PolicyScope {
  if (actions === undefined) return {};
  if (Array.isArray(actions)) {
    return actions.length === 1 ? { eq: actions[0] } : { in: actions };
  }
  return { eq: actions };
}

/**
 * A guarded `forbid` plus the permits it governs.
 */
export function DenyByDefaultSet(opts: DenyByDefaultSetOpts): DenyByDefaultSetResources {
  if (opts.when.length === 0) {
    throw new Error(
      "DenyByDefaultSet: `when` must carry at least one condition. An unguarded forbid " +
        "overrides every permit in the set, so the result would authorize nothing.",
    );
  }

  const floor = new Policy({
    effect: "forbid",
    principal: scope(opts.principal),
    action: actionScope(opts.actions),
    resource: scope(opts.entityType),
    when: opts.when,
    ...(opts.unless && opts.unless.length > 0 ? { unless: opts.unless } : {}),
    annotations: {
      composite: "DenyByDefaultSet",
      members: String(opts.policies.length),
      ...(opts.annotations ?? {}),
    },
  });

  return { floor, members: [...opts.policies], all: [floor, ...opts.policies] };
}
