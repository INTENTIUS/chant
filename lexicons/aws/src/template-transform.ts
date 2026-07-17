/**
 * Template Transform — declares a top-level CloudFormation `Transform` macro
 * for the synthesized template (e.g. `AWS::SecretsManager-2020-07-23` for a
 * Secrets Manager `HostedRotationLambda`, or `AWS::LanguageExtensions`).
 *
 * CloudFormation's `Transform` is a template-level directive, not a resource
 * property, so it can't be expressed as a normal Declarable's attributes. A
 * project (or composite) exports a `templateTransform(...)` declaration and the
 * serializer lifts it to the template's top-level `Transform` at synthesis time.
 * Multiple declarations are merged and de-duplicated into a `Transform` list.
 *
 * Modeled exactly like `./default-tags.ts` — a marker-tagged Declarable the
 * serializer detects and consumes rather than emitting as a resource.
 */

import { DECLARABLE_MARKER, type Declarable } from "@intentius/chant/declarable";

/** Marker symbol for template-transform identification. */
export const TEMPLATE_TRANSFORM_MARKER = Symbol.for("chant.aws.templateTransform");

/**
 * A template-transform declaration — wraps a macro name into a Declarable the
 * serializer lifts to the template's top-level `Transform`.
 */
export interface TemplateTransform extends Declarable {
  readonly [TEMPLATE_TRANSFORM_MARKER]: true;
  readonly [DECLARABLE_MARKER]: true;
  readonly lexicon: "aws";
  readonly entityType: "chant:aws:templateTransform";
  readonly transform: string;
}

/** Type guard for TemplateTransform. */
export function isTemplateTransform(value: unknown): value is TemplateTransform {
  return (
    typeof value === "object" &&
    value !== null &&
    TEMPLATE_TRANSFORM_MARKER in value &&
    (value as Record<symbol, unknown>)[TEMPLATE_TRANSFORM_MARKER] === true
  );
}

/**
 * Declare a top-level CloudFormation `Transform` macro for the synthesized
 * template. The serializer collects every `templateTransform(...)` in the
 * project and emits their de-duplicated union as the template's `Transform`
 * (a single string when there is one, a list when there are several).
 *
 * @param transform - The macro name, e.g. `"AWS::SecretsManager-2020-07-23"`.
 * @returns A TemplateTransform Declarable.
 *
 * @example
 * ```ts
 * import { templateTransform } from "@intentius/chant-lexicon-aws";
 *
 * // Required whenever a resource uses SecretsManager HostedRotationLambda.
 * export const rotationTransform = templateTransform("AWS::SecretsManager-2020-07-23");
 * ```
 */
export function templateTransform(transform: string): TemplateTransform {
  return {
    [TEMPLATE_TRANSFORM_MARKER]: true,
    [DECLARABLE_MARKER]: true,
    lexicon: "aws",
    entityType: "chant:aws:templateTransform",
    transform,
  };
}
