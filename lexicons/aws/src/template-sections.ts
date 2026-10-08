/**
 * Template Description and Metadata — the template-level `Description` and
 * `Metadata` sections of the synthesized CloudFormation template.
 *
 * Like `Transform` (./template-transform.ts), these belong to the template,
 * not to a resource, so a project exports a declaration and the serializer
 * lifts it to the top of the template. `chant import` writes them for the
 * sections a template it imports has.
 */

import { DECLARABLE_MARKER, type Declarable } from "@intentius/chant/declarable";

/** Marker symbol for a template description or metadata declaration. */
export const TEMPLATE_SECTION_MARKER = Symbol.for("chant.aws.templateSection");

/** A template-level section the serializer lifts: `Description` or `Metadata`. */
export interface TemplateSection extends Declarable {
  readonly [TEMPLATE_SECTION_MARKER]: true;
  readonly [DECLARABLE_MARKER]: true;
  readonly lexicon: "aws";
  readonly entityType: "chant:aws:templateSection";
  readonly section: "Description" | "Metadata";
  readonly value: unknown;
}

/** Type guard for TemplateSection. */
export function isTemplateSection(value: unknown): value is TemplateSection {
  return (
    typeof value === "object" &&
    value !== null &&
    TEMPLATE_SECTION_MARKER in value &&
    (value as Record<symbol, unknown>)[TEMPLATE_SECTION_MARKER] === true
  );
}

function templateSection(section: TemplateSection["section"], value: unknown): TemplateSection {
  return {
    [TEMPLATE_SECTION_MARKER]: true,
    [DECLARABLE_MARKER]: true,
    lexicon: "aws",
    entityType: "chant:aws:templateSection",
    section,
    value,
  };
}

/**
 * Declare the template's top-level `Description`. One per template.
 *
 * @example
 * ```ts
 * export const description = templateDescription("Queue and its dead-letter queue");
 * ```
 */
export function templateDescription(description: string): TemplateSection {
  return templateSection("Description", description);
}

/**
 * Declare entries in the template's top-level `Metadata`
 * (`AWS::CloudFormation::Interface`, `cfn-lint` settings). Several
 * declarations merge; keys chant writes itself are added after them.
 *
 * @example
 * ```ts
 * export const metadata = templateMetadata({ "cfn-lint": { config: { ignore_checks: ["W3005"] } } });
 * ```
 */
export function templateMetadata(metadata: Record<string, unknown>): TemplateSection {
  return templateSection("Metadata", metadata);
}
