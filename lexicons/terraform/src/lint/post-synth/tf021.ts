/**
 * TF021: `count` used where `for_each` is safer, judged narrowly.
 *
 * Scope: root and child modules. A resource is a resource wherever it is
 * declared, and the failure mode below does not depend on the scope.
 *
 * `count` addresses its instances by position: `aws_instance.web[0]`,
 * `[1]`, `[2]`. Delete the middle element of the list the count was derived
 * from and every instance after it shifts down one, so Terraform plans to
 * destroy and recreate them all, in order, to move each one's identity onto
 * the next index. `for_each` addresses by key instead, and removing one
 * element removes exactly one instance.
 *
 * The narrow part is which counts get reported. Two conditions must both
 * hold:
 *
 * 1. The count is plural and derived, not a switch. A numeric literal of two
 *    or more, or `length(var.x)` / `length(local.x)`. `count = 0`, `count =
 *    1` and `count = var.enabled ? 1 : 0` are the conditional-resource idiom,
 *    which `for_each` does not replace, and they are never reported.
 * 2. The resource uses `count.index` to build something that carries the
 *    instance's identity: a name, a bucket, a key, a `tags.Name`. That is what
 *    makes a shift destructive; a `count.index` used only to pick a subnet out
 *    of a list is reindexed silently and harmlessly.
 *
 * Redeploy's `terraform_prefer_for_each` reports every `count` over a
 * collection, which is a broader rule and a noisier one, so the credit is
 * `overlaps` rather than `equivalent`. choudoufu's `RuleCountIndex`
 * (`internal/live/lint/count_index.go`) is the survey's deepest treatment of
 * the identity-bearing question, and it is credited the same way. Report-only
 * either way: a `count` with a stable list behind it is fine forever, and
 * only the person who knows whether that list is stable can say.
 */

import type {
  PostSynthCheck,
  PostSynthContext,
  PostSynthDiagnostic,
} from "@intentius/chant/lint/post-synth";
import { isResourceDeclarable } from "@intentius/chant/declarable";
import { RESOURCE_TYPE, type BlockBody, type TerraformEntity } from "../../hcl/parse";
import { walkAttributes } from "./blocks";

/** `length(var.x)` or `length(local.x)`, as hcl2json renders the expression. */
const LENGTH_OF = /^\$\{?\s*length\(\s*(var|local)\.[A-Za-z_][A-Za-z0-9_-]*\s*\)\s*\}?$/;

/**
 * Attribute names whose value IS the instance's identity to the provider: a
 * rename destroys and recreates. Matched on the last path segment, so
 * `tags.Name` and `labels.name` are covered without listing every container.
 */
const IDENTITY_ATTRIBUTES = new Set([
  "name",
  "bucket",
  "key",
  "identifier",
  "hostname",
  "domain",
  "domain_name",
  "display_name",
  "resource_name",
  "alias",
  "prefix",
  "path",
  "topic",
  "queue_name",
  "function_name",
  "db_name",
  "repository",
]);

/** The `count` value, when it is one this rule reports on. */
export function pluralCount(body: BlockBody): string | undefined {
  const count = body.count;
  if (typeof count === "number") return count >= 2 ? String(count) : undefined;
  if (typeof count !== "string") return undefined;
  if (LENGTH_OF.test(count.trim())) return count.replace(/^\$\{?/, "").replace(/\}$/, "");
  const literal = /^\$\{?\s*(\d+)\s*\}?$/.exec(count.trim());
  return literal && Number(literal[1]) >= 2 ? literal[1] : undefined;
}

/** Identity-bearing attributes of this body whose value is built from `count.index`. */
export function identityUsesOfCountIndex(body: BlockBody): string[] {
  const out: string[] = [];
  for (const attr of walkAttributes(body)) {
    if (typeof attr.value !== "string" || !attr.value.includes("count.index")) continue;
    if (!IDENTITY_ATTRIBUTES.has(attr.name.toLowerCase())) continue;
    out.push(attr.path);
  }
  return out;
}

export const tf021: PostSynthCheck = {
  id: "TF021",
  description: "count builds instance identities from count.index where for_each is safer",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [key, entity] of ctx.entities) {
      if (entity.entityType !== RESOURCE_TYPE || !isResourceDeclarable(entity)) continue;
      const props = (entity as TerraformEntity).props as Partial<TerraformEntity["props"]>;
      const body = (typeof props.body === "object" && props.body !== null ? props.body : {}) as BlockBody;

      const count = pluralCount(body);
      if (count === undefined) continue;
      const uses = identityUsesOfCountIndex(body);
      if (uses.length === 0) continue;

      const address = typeof props.address === "string" ? props.address : key;
      diagnostics.push({
        checkId: "TF021",
        severity: "warning",
        message:
          `Resource "${address}" has \`count = ${count}\` and builds ${uses.sort().join(", ")} from ` +
          "`count.index`, so each instance's identity is its position in the list. Removing an element " +
          "shifts every later instance down one index, and Terraform destroys and recreates all of them " +
          "to match. Use `for_each` over a map or set so each instance is addressed by a stable key.",
        entity: key,
        lexicon: "terraform",
      });
    }

    return diagnostics;
  },
};
