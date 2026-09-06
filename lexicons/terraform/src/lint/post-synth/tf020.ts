/**
 * TF020: a `variable`, a `locals` entry, a `data` source or an aliased
 * `provider` that nothing in its module scope references.
 *
 * Scope: root and child modules, each judged on its own. Terraform's
 * namespaces are per module, so `var.region` inside `module.cdn` is the child
 * module's variable and a reference to it in the root proves nothing about
 * the child's. The reference index (`hcl/references.ts`) is keyed the same
 * way, one scope per module, and this check never looks outside the scope the
 * declaration is in.
 *
 * An unused declaration is dead weight rather than a defect, which is why
 * this is report-only. It still earns a finding: a variable nobody reads is
 * usually the leftover of a refactor, and the next reader has to prove that
 * before deleting it. A data source is worse than dead weight, since it is
 * read from the provider's API on every plan whether or not anything uses the
 * result.
 *
 * Two deliberate gaps, both from the index being a string scan rather than an
 * expression tree (see its module doc), and both the reason the credit to
 * tflint's `terraform_unused_declarations` is `overlaps`:
 *
 * - A name mentioned in a string that is not an expression (a `description`
 *   that says "overrides var.region") reads as a reference, so the
 *   declaration is not reported. Quiet, and wrong in the safe direction.
 * - A value reached only dynamically (`lookup(local.by_env, ...)` where the
 *   map is built elsewhere) is a real reference the scan does see, since the
 *   local is still named; but a variable consumed only through
 *   `TF_VAR_`-style external input is not, and a root's variables are
 *   frequently exactly that. Report-only keeps that from failing a build.
 *
 * A `provider` block with no `alias` is never reported: it is the default
 * configuration for its type, used by every resource of that type without
 * naming it. Only an aliased one has to be asked for by name.
 */

import type {
  PostSynthCheck,
  PostSynthContext,
  PostSynthDiagnostic,
} from "@intentius/chant/lint/post-synth";
import { isResourceDeclarable } from "@intentius/chant/declarable";
import {
  DATA_TYPE,
  LOCALS_TYPE,
  PROVIDER_TYPE,
  VARIABLE_TYPE,
  scopeOfKey,
  type BlockBody,
  type TerraformEntity,
} from "../../hcl/parse";
import { buildReferenceIndex, isReferenced } from "../../hcl/references";

/** What a reader is being told to do about each kind of unused declaration. */
const ADVICE: Record<string, string> = {
  variable: "Delete it, or reference it where it was meant to be used.",
  local: "Delete it, or reference it where it was meant to be used.",
  data:
    "Delete it. A data source is read from the provider on every plan, so an unused one costs an API " +
    "call and a permission for a value nothing consumes.",
  provider: "Delete it, or pass it to the resources or modules that were meant to use it.",
};

export const tf020: PostSynthCheck = {
  id: "TF020",
  description: "Declaration is never referenced in its module scope",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];
    const index = buildReferenceIndex(ctx.entities);

    const report = (key: string, kind: keyof typeof ADVICE, what: string): void => {
      diagnostics.push({
        checkId: "TF020",
        severity: "warning",
        message: `${what} is declared and never referenced in its module. ${ADVICE[kind]}`,
        entity: key,
        lexicon: "terraform",
      });
    };

    for (const [key, entity] of ctx.entities) {
      if (!isResourceDeclarable(entity)) continue;
      const props = (entity as TerraformEntity).props as Partial<TerraformEntity["props"]>;
      const body = (typeof props.body === "object" && props.body !== null ? props.body : {}) as BlockBody;
      const address = typeof props.address === "string" ? props.address : key;
      const scope = scopeOfKey(key);

      if (entity.entityType === VARIABLE_TYPE) {
        // Excluding the variable's own key matters here: a `validation` block
        // reads `var.<self>` in its condition, which would otherwise make
        // every validated variable look used.
        if (!isReferenced(index, scope, address, key)) report(key, "variable", `Variable "${address}"`);
        continue;
      }

      if (entity.entityType === LOCALS_TYPE) {
        for (const name of Object.keys(body)) {
          // No self-exclusion: one `locals` block is many declarations, and a
          // local reading another local of the same block is a real use.
          if (!isReferenced(index, scope, `local.${name}`)) report(key, "local", `Local value "local.${name}"`);
        }
        continue;
      }

      if (entity.entityType === DATA_TYPE) {
        if (!isReferenced(index, scope, address, key)) report(key, "data", `Data source "${address}"`);
        continue;
      }

      if (entity.entityType === PROVIDER_TYPE) {
        const alias = typeof body.alias === "string" ? body.alias : undefined;
        if (alias === undefined || alias.trim() === "") continue;
        const type = address.startsWith("provider.") ? address.slice("provider.".length) : address;
        if (!isReferenced(index, scope, `provider.${type}.${alias}`, key)) {
          report(key, "provider", `Aliased provider "${type}.${alias}"`);
        }
      }
    }

    return diagnostics;
  },
};
