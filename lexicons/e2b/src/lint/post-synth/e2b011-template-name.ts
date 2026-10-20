/**
 * E2B011: a template's name is one E2B accepts, and only one template has it.
 *
 * E2B names templates with lowercase letters, digits, dashes and underscores;
 * `e2b template build` refuses anything else. The name is also the profile's
 * `template` and the stem of the two files the serializer writes, so two
 * templates with one name would overwrite each other's files.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { templateProps } from "../../resources";

export const TEMPLATE_NAME = /^[a-z0-9][a-z0-9_-]*$/;

export const e2b011: PostSynthCheck = {
  id: "E2B011",
  description: "A Template's name must be lowercase letters, digits, dashes and underscores, and unique",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];
    const seen = new Map<string, string>();
    for (const [entityName, entity] of ctx.entities) {
      const props = templateProps(entity);
      if (!props) continue;
      const name = props.name;
      if (typeof name !== "string" || !TEMPLATE_NAME.test(name)) {
        diagnostics.push({
          checkId: "E2B011",
          severity: "error",
          message: `Template "${entityName}" has name ${JSON.stringify(name)}. E2B template names are lowercase letters, digits, dashes and underscores.`,
          entity: entityName,
          lexicon: "e2b",
        });
        continue;
      }
      const first = seen.get(name);
      if (first !== undefined) {
        diagnostics.push({
          checkId: "E2B011",
          severity: "error",
          message: `Templates "${first}" and "${entityName}" are both named "${name}"; their e2b.${name}.* files would overwrite each other.`,
          entity: entityName,
          lexicon: "e2b",
        });
      } else {
        seen.set(name, entityName);
      }
    }
    return diagnostics;
  },
};
