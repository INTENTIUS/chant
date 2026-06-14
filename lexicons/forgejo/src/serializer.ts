/**
 * Forgejo Actions YAML serializer.
 *
 * A thin dialect of the github serializer: it applies the Forgejo dialect
 * (see ./dialect) to the entity graph, then delegates emission to the github
 * serializer, which already produces GitHub-Actions-compatible YAML — exactly
 * what Forgejo / Codeberg / Gitea runners execute.
 *
 * The serializer's `name` is "github" on purpose: github-lexicon entities are
 * tagged `lexicon: "github"`, and the build pipeline partitions and looks up
 * serializers by that tag. A forgejo project loads only this serializer, so it
 * claims that partition. The distinct `rulePrefix` ("WFJ") keeps Forgejo lint
 * diagnostics namespaced apart from github's "GHA".
 */

import type { Declarable } from "@intentius/chant/declarable";
import type { Serializer, SerializerResult, SerializeContext } from "@intentius/chant/serializer";
import type { LexiconOutput } from "@intentius/chant/lexicon-output";
import { githubSerializer } from "@intentius/chant-lexicon-github";
import { applyForgejoDialect, type ForgejoDialectOptions } from "./dialect";

/** Extract forgejo dialect options from the resolved project config, if any. */
function readForgejoOptions(config: Record<string, unknown> | undefined): ForgejoDialectOptions {
  const forgejo = config?.forgejo;
  if (!forgejo || typeof forgejo !== "object") return {};
  const obj = forgejo as Record<string, unknown>;
  const options: ForgejoDialectOptions = {};
  if (obj.runnerLabels && typeof obj.runnerLabels === "object") {
    options.runnerLabels = obj.runnerLabels as Record<string, string>;
  }
  if (typeof obj.actionsRoot === "string") {
    options.actionsRoot = obj.actionsRoot;
  }
  return options;
}

/**
 * Forgejo Actions YAML serializer implementation.
 */
export const forgejoSerializer: Serializer = {
  name: "github",
  rulePrefix: "WFJ",

  serialize(
    entities: Map<string, Declarable>,
    outputs?: LexiconOutput[],
    context?: SerializeContext,
  ): string | SerializerResult {
    const options = readForgejoOptions(context?.config);
    const { entities: transformed, warnings } = applyForgejoDialect(entities, options);

    const result = githubSerializer.serialize(transformed, outputs, context);

    if (typeof result === "string") {
      return warnings.length > 0 ? { primary: result, warnings } : result;
    }
    return {
      ...result,
      warnings: [...(result.warnings ?? []), ...warnings],
    };
  },
};
