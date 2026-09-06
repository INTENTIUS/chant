/**
 * Root scope or child scope, and the `Callers:` chain that says which call
 * reached a finding (chant #2112).
 *
 * Since the parse descends into local modules, `ctx.entities` holds two kinds
 * of block: the root module's own, keyed `<root>/<address>`, and a child
 * module's, keyed `<root>/module.<name>/<address>` with the call chain on
 * `props.callers`. Every check has to say which it applies to, and the three
 * shapes that answer live here:
 *
 * - {@link isRootScoped} for a check about how a ROOT is assembled (TF001's
 *   backend, TF002's `required_providers`): a child module has no backend and
 *   no provider requirements of its own to judge, and reading one as if it
 *   were the root's is how a root with a perfectly good backend gets flagged
 *   because a module beneath it has none.
 * - {@link isChildScoped} for the mirror, the two rules that are ONLY about
 *   child modules (TF014, TF015).
 * - {@link callersNote} for the sentence appended to a finding inside a
 *   child, naming each call site with the file and line it sits on. tflint
 *   prints the same thing as a `Callers:` block under the diagnostic
 *   (https://github.com/terraform-linters/tflint/blob/master/docs/user-guide/calling-modules.md);
 *   a `PostSynthDiagnostic` carries no ranges, so the chain goes in the
 *   message, where a reader of any output format sees it.
 *
 * A check with no opinion (most of them: an unset `type` on a variable is the
 * same finding wherever the variable lives) needs nothing from this module and
 * runs over both scopes, which is what tflint does with its own language rules
 * under `--call-module-type=local`.
 */

import type { PostSynthCheck, PostSynthContext } from "@intentius/chant/lint/post-synth";
import { isResourceDeclarable, type Declarable } from "@intentius/chant/declarable";
import { callersOfKey, type TerraformEntity } from "../../hcl/parse";

/** The `module.<name>` chain on an entity, outermost first. Empty for a root block. */
export function callersOf(entity: Declarable): readonly string[] {
  if (!isResourceDeclarable(entity)) return [];
  const props = (entity as TerraformEntity).props as Partial<TerraformEntity["props"]>;
  return Array.isArray(props.callers) ? props.callers : [];
}

/** Was this block declared in the root module itself? */
export function isRootScoped(entity: Declarable): boolean {
  return callersOf(entity).length === 0;
}

/** Was this block declared in a child module the root calls? */
export function isChildScoped(entity: Declarable): boolean {
  return callersOf(entity).length > 0;
}

/**
 * The `Callers:` sentence for a finding on `key`, or `""` when the finding is
 * in the root module.
 *
 * The call sites are the key's own prefixes: a finding on
 * `app/module.cdn/module.bucket/aws_s3_bucket.assets` was reached through
 * `app/module.cdn` and then `app/module.cdn/module.bucket`, both of them
 * `module` block entities in `ctx.entities`, so the file and line each was
 * parsed from are already recorded. A prefix with no entity (a hand-built
 * context in a test) renders as the bare call name.
 */
export function callersNote(ctx: PostSynthContext, key: string): string {
  const callers = callersOfKey(key);
  if (callers.length === 0) return "";

  const root = key.slice(0, key.indexOf("/"));
  const hops = callers.map((caller, i) => {
    const callSite = [root, ...callers.slice(0, i + 1)].join("/");
    const entity = ctx.entities.get(callSite);
    if (!entity || !isResourceDeclarable(entity)) return caller;
    const props = (entity as TerraformEntity).props as Partial<TerraformEntity["props"]>;
    const file = typeof props.file === "string" ? props.file : "";
    if (file === "") return caller;
    return typeof props.line === "number" ? `${caller} (${file}:${props.line})` : `${caller} (${file})`;
  });

  return ` Callers: ${[root, ...hops].join(" -> ")}.`;
}

/**
 * Wrap every check so a finding inside a child module carries its
 * {@link callersNote}, whichever rule produced it.
 *
 * Done once, here, rather than in each rule's message: a reader of a finding
 * on `module.cdn`'s bucket needs to know which call reached that code no
 * matter which of the twenty-odd checks reported it, and a rule that forgot
 * to append the chain would be a silent gap. The wrapper is what
 * `terraformPlugin.postSynthChecks()` returns; a rule's own `check()` is
 * unchanged, which is what its unit tests call.
 *
 * A message that already names the chain is left alone, so a rule with
 * something more specific to say about its callers can say it.
 */
export function withCallersChain(checks: readonly PostSynthCheck[]): PostSynthCheck[] {
  return checks.map((check) => ({
    ...check,
    check(ctx: PostSynthContext) {
      return check.check(ctx).map((diagnostic) => {
        if (typeof diagnostic.entity !== "string") return diagnostic;
        if (diagnostic.message.includes("Callers:")) return diagnostic;
        const note = callersNote(ctx, diagnostic.entity);
        return note === "" ? diagnostic : { ...diagnostic, message: diagnostic.message + note };
      });
    },
  }));
}
