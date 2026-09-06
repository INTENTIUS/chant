/**
 * Which declarations does a module scope actually reference (chant #2112)?
 *
 * One pass over every entity's body, collecting the reference forms Terraform
 * writes as expressions: `var.<name>`, `local.<name>`, `data.<type>.<name>`,
 * `module.<name>`, and the `provider = <type>.<alias>` / `providers = { <type>
 * = <type>.<alias> }` meta-arguments. The result is keyed per module scope
 * (`./parse.ts`'s `scopeOfKey`), because Terraform's own namespaces are: a
 * `var.region` inside `module.cdn` is the child module's variable, never the
 * root's, and a rule that pooled the two would call a genuinely unused root
 * variable used.
 *
 * ## It is a string scan, and the rules built on it say so
 *
 * hcl2json gives back an expression as a STRING, with the `${...}` wrapper
 * preserved: `count = length(var.subnets)` arrives as `"${length(var.subnets)}"`
 * and `bucket = var.name` as `"${var.name}"`. There is no expression tree to
 * walk, so this scans the strings with regexes. That reads a reference inside
 * a comment-free body correctly and is deliberately generous at the edges: a
 * name that appears inside a quoted literal (`description = "set var.region"`)
 * counts as a reference, and a reference built dynamically
 * (`lookup(local.by_env, terraform.workspace)` reaching a value nothing names
 * directly) does not. Both directions are why TF020 is report-only and credits
 * tflint's `terraform_unused_declarations` as `overlaps` rather than
 * `equivalent`: it is the same question answered with a coarser instrument.
 *
 * The index records WHICH entity each reference came from, so a check can ask
 * "is anything other than the declaration itself referring to this?". A
 * `variable "port"` whose own `validation` block reads `var.port` is the case
 * that needs it: without the exclusion every validated variable would look
 * used.
 */

import { isResourceDeclarable, type Declarable } from "@intentius/chant/declarable";
import { scopeOfKey, type BlockBody, type TerraformEntity } from "./parse";

/** An identifier as Terraform's grammar allows it: letters, digits, `_`, `-`. */
const NAME = "[A-Za-z_][A-Za-z0-9_-]*";

const VAR_RE = new RegExp(`\\bvar\\.(${NAME})`, "g");
const LOCAL_RE = new RegExp(`\\blocal\\.(${NAME})`, "g");
const DATA_RE = new RegExp(`\\bdata\\.(${NAME})\\.(${NAME})`, "g");
const MODULE_RE = new RegExp(`\\bmodule\\.(${NAME})`, "g");
/** A provider reference once any `${...}` wrapper is off: `aws.west`. */
const PROVIDER_REF_RE = new RegExp(`^(${NAME})\\.(${NAME})$`);
/** hcl2json's wrapper around a bare expression, which a `provider` value always is. */
const INTERPOLATION_RE = /^\$\{(.*)\}$/s;

/**
 * Every reference token in one string, in the vocabulary the index keys by:
 * `var.region`, `local.tags`, `data.aws_ami.ubuntu`, `module.cdn`.
 *
 * `data.` is matched before `local.`/`var.` can see it, and a `module.cdn.url`
 * yields `module.cdn`, since the call is what a reference makes used.
 */
export function collectReferences(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(DATA_RE)) found.add(`data.${m[1]}.${m[2]}`);
  for (const m of text.matchAll(VAR_RE)) found.add(`var.${m[1]}`);
  for (const m of text.matchAll(LOCAL_RE)) found.add(`local.${m[1]}`);
  for (const m of text.matchAll(MODULE_RE)) found.add(`module.${m[1]}`);
  return [...found];
}

/**
 * The `provider`/`providers` meta-argument's own reference form, which is not
 * an interpolation and has no prefix of its own: `provider = aws.west` names
 * the `provider "aws" { alias = "west" }` block. Returned in the index's
 * vocabulary, `provider.aws.west`, so it cannot collide with a resource
 * address that happens to look the same.
 */
export function providerReference(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  const inner = INTERPOLATION_RE.exec(trimmed);
  const m = PROVIDER_REF_RE.exec((inner ? inner[1] : trimmed).trim());
  return m ? `provider.${m[1]}.${m[2]}` : undefined;
}

/** Every reference in one block body, provider meta-arguments included. */
export function referencesInBody(body: BlockBody): string[] {
  const found = new Set<string>();

  const visit = (value: unknown, key: string, depth: number): void => {
    if (depth > 6) return;
    if (typeof value === "string") {
      for (const ref of collectReferences(value)) found.add(ref);
      if (key === "provider") {
        const provider = providerReference(value);
        if (provider) found.add(provider);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key, depth + 1);
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        // `providers = { aws = aws.west }` maps a child module's provider name
        // to the caller's block, so every VALUE under `providers` is a
        // provider reference, whatever its key.
        visit(v, key === "providers" ? "provider" : k, depth + 1);
      }
    }
  };

  visit(body, "", 0);
  return [...found];
}

/**
 * Every reference in one module scope: token to the entity keys whose body
 * mentions it.
 */
export type ScopeReferences = Map<string, Set<string>>;

/** Reference tokens per module scope (`<root>`, `<root>/module.<name>`). */
export interface ReferenceIndex {
  readonly scopes: Map<string, ScopeReferences>;
}

/**
 * Build the index over a whole build's entities. Scopes come from the entity
 * keys, so a root and each of its descended child modules are separate, and
 * two roots never pool.
 */
export function buildReferenceIndex(entities: Map<string, Declarable>): ReferenceIndex {
  const scopes = new Map<string, ScopeReferences>();

  for (const [key, entity] of entities) {
    if (!isResourceDeclarable(entity)) continue;
    const props = (entity as TerraformEntity).props as Partial<TerraformEntity["props"]>;
    const body = (typeof props.body === "object" && props.body !== null ? props.body : {}) as BlockBody;
    const scope = scopeOfKey(key);
    let refs = scopes.get(scope);
    if (!refs) {
      refs = new Map();
      scopes.set(scope, refs);
    }
    for (const ref of referencesInBody(body)) {
      const from = refs.get(ref);
      if (from) from.add(key);
      else refs.set(ref, new Set([key]));
    }
  }

  return { scopes };
}

/** The entity keys in `scope` whose body references `token`. */
export function referencesTo(index: ReferenceIndex, scope: string, token: string): Set<string> {
  return index.scopes.get(scope)?.get(token) ?? new Set();
}

/**
 * Is `token` referenced anywhere in `scope` other than by `declaredBy` itself?
 * The exclusion is what keeps a variable read only by its own `validation`
 * block, or a local read only by its own `locals` block, from looking used.
 */
export function isReferenced(
  index: ReferenceIndex,
  scope: string,
  token: string,
  declaredBy?: string,
): boolean {
  const from = referencesTo(index, scope, token);
  for (const key of from) {
    if (key !== declaredBy) return true;
  }
  return false;
}
