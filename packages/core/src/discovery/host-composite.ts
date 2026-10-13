import { isDeclarable, type Declarable } from "../declarable";
import { getProvenance, setPathProvenance, setProvenance } from "../provenance";

/**
 * chant#3598 — a host composite instance's own marker. Non-enumerable and
 * symbol-keyed, like provenance, so nothing that serializes or compares the
 * exports sees it. It carries the composite's name, which the members object
 * otherwise has no record of once it is returned.
 *
 * Only the fold path sets it: a host's registration form (chant#2442) returns
 * the members object the factory built, not a chant `CompositeInstance`, and
 * chant knows the object came from a composite only because the fold resolved
 * the call. A file that runs instead has no such knowledge.
 */
const HOST_COMPOSITE_INSTANCE = Symbol.for("chant.fold.hostCompositeInstance");

function isPlainIndexable(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Mark `members` as the instance a host's composite produced, and return it
 * unchanged.
 *
 * chant#3608 — every declarable member, and every member of a nested host
 * instance, is also stamped with the composite, the way `expandComposite`
 * stamps a chant instance's members. A destructured member is never expanded,
 * so this is the only record it has that a composite wrote it, and without
 * it a path the fold did not attribute reads as authored and so `direct`.
 * `setProvenance` keeps the first writer, and a nested instance was marked
 * when its own call returned, so a member keeps its innermost composite.
 */
export function markHostCompositeInstance(
  members: Record<string, unknown>,
  compositeName: string,
): Record<string, unknown> {
  if (Object.isExtensible(members) && !Object.prototype.hasOwnProperty.call(members, HOST_COMPOSITE_INSTANCE)) {
    Object.defineProperty(members, HOST_COMPOSITE_INSTANCE, {
      value: compositeName,
      enumerable: false,
      configurable: true,
    });
  }
  stampHostCompositeMembers(members, compositeName);
  return members;
}

/** Stamp `composite` on each declarable member of a host instance, descending into nested host instances. */
function stampHostCompositeMembers(members: Record<string, unknown>, compositeName: string): void {
  for (const member of Object.values(members)) {
    if (isDeclarable(member)) setProvenance(member, { composite: compositeName });
    else if (hostCompositeName(member) !== undefined) stampHostCompositeMembers(member as Record<string, unknown>, compositeName);
  }
}

/** The composite name a host composite instance was marked with, or `undefined` for any other value. */
export function hostCompositeName(value: unknown): string | undefined {
  if (!isPlainIndexable(value)) return undefined;
  const name = (value as Record<symbol, unknown>)[HOST_COMPOSITE_INSTANCE];
  return typeof name === "string" ? name : undefined;
}

/**
 * chant#3598, chant#3612 — a host composite instance's members as entities,
 * for `collectEntities`.
 *
 * `collectEntities` is the one place `build()` and `foldProject` turn exports
 * into entities, so expanding here is what makes the two report the same set:
 * `export const archive = Archive({...})` gives `archiveBucket` to both.
 *
 * The members are named and stamped the way `expandComposite` names and stamps
 * a chant instance: `${exportName}${Member}`, a nested host instance expanded
 * in place under its member's name (`siteMainBucket`), with a whole-entity
 * `composite` origin under the paths the fold already attributed. That origin
 * is written before `collectEntities` adds its own record, and the first
 * writer wins, so a path the fold did not attribute is `unknown` rather than
 * `direct`. Every member belongs to the top-level `instance`; its composite is
 * the innermost one, which {@link markHostCompositeInstance} already stamped.
 */
export function expandHostComposite(
  prefix: string,
  members: Record<string, unknown>,
  instance: string = prefix,
): Array<[string, Declarable]> {
  const out: Array<[string, Declarable]> = [];
  const compositeName = hostCompositeName(members) as string;
  for (const [memberName, member] of Object.entries(members)) {
    if (memberName.length === 0) continue;
    const fullName = `${prefix}${memberName[0].toUpperCase()}${memberName.slice(1)}`;
    if (hostCompositeName(member) !== undefined) {
      out.push(...expandHostComposite(fullName, member as Record<string, unknown>, instance));
      continue;
    }
    if (!isDeclarable(member)) continue;
    setProvenance(member, { composite: compositeName, compositeInstance: instance });
    const composite = getProvenance(member)?.composite ?? compositeName;
    setPathProvenance(member, "", { kind: "composite", composite, instance });
    out.push([fullName, member]);
  }
  return out;
}
