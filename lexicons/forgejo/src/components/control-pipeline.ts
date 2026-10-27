/**
 * The control repo's own workflow (#4568) on Forgejo: github's document
 * (`controlGithubDoc`) with the Forgejo dialect applied, the way
 * ./generate-pipeline.ts reuses github's pipeline. Forgejo has no
 * `repository_dispatch`, so a member's dispatch is a workflow dispatch of
 * this file by name.
 */

import {
  controlGithubDoc,
  type ControlPipelineFile,
  type ControlPipelineOptions,
} from "@intentius/chant-lexicon-github/components/control-pipeline";
import { emitWorkflowYAML } from "@intentius/chant-lexicon-github/components/ci-jobs";
import type { ForgejoDialectOptions } from "../dialect";
import { forgejoize } from "./ci-jobs";

/** The control repo's workflow on Forgejo: `.forgejo/workflows/<product>-dependents.yml`. */
export function generateControlPipeline(options: ControlPipelineOptions = {}, dialect: ForgejoDialectOptions = {}): ControlPipelineFile {
  const { doc, path, notes } = controlGithubDoc("forgejo", options);
  const content = emitWorkflowYAML({
    ...doc,
    on: forgejoize(doc.on, dialect),
    jobsDoc: forgejoize(doc.jobsDoc, dialect),
  });
  return { path, content, notes };
}
