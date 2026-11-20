/**
 * A delivery pipeline's promote jobs → Forgejo Actions workflow (#5324).
 *
 * The github workflow ({@link buildGithubPromoteDoc}) under the Forgejo
 * dialect: action refs rewritten, `permissions:` dropped, and each stage's
 * `environment:` dropped with a header line saying so, since Forgejo Actions
 * has no environments. `runner` is a label or a list of labels.
 */

import { buildGithubPromoteDoc } from "@intentius/chant-lexicon-github/components/generate-pipeline-promote";
import { emitOpPipelineYAML } from "@intentius/chant-lexicon-github/components/generate-op-pipeline";
import { assertRunnerLabels } from "@intentius/chant/ci-jobs";
import type { PipelinePromoteInput } from "@intentius/chant/lexicon";
import type { ForgejoDialectOptions } from "../dialect";
import { forgejoWorkflowDoc } from "./ci-jobs";

/** Render a pipeline's promote jobs as one Forgejo Actions workflow, `<pipeline>-promote.yml`. */
export function generateForgejoPipelinePromote(input: PipelinePromoteInput, dialectOptions: ForgejoDialectOptions = {}): Array<{ name: string; yaml: string }> {
  assertRunnerLabels(`Pipeline "${input.pipeline}" promote`, "runner", input.runner, "Forgejo");
  const built = buildGithubPromoteDoc(input, { forge: "forgejo" });
  const dropped = input.stages.filter((s) => s.environment).map((s) => `${s.name} -> ${s.environment!.name}`);
  const header =
    dropped.length > 0
      ? [
          `# chant dropped the environment of each of these stages: ${dropped.join(", ")}.`,
          "# Forgejo Actions has no environments, so nothing on the forge holds these jobs.",
          "# The promote's own chant checks hold the release; nothing else gates it here.",
        ]
      : undefined;
  return [{ name: `${input.pipeline}-promote.yml`, yaml: emitOpPipelineYAML(forgejoWorkflowDoc(built, dialectOptions, header)) }];
}
