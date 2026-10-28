/**
 * The control repo's own pipeline (#4568) on GitLab: a member's pipeline
 * trigger starts it with `CHANT_CONTROL_MEMBER` and `CHANT_CONTROL_OP` set,
 * and its one job runs the member's dependents with `chant workspace run
 * --dependents-of`. The pieces are core's (`controlPipelineSpec` in
 * `@intentius/chant/control/dispatch`); the file is one the control repo's
 * `.gitlab-ci.yml` includes. The member's side, the `control-dispatch` job,
 * comes from the pull request loop's `control` option
 * (./generate-pipeline.ts).
 */

import { CI_IMAGE, GITLAB_FULL_HISTORY } from "@intentius/chant/ci-jobs";
import { controlPipelineSpec } from "@intentius/chant/control/dispatch";
import type { CiProductWords, CiProductWordsInput } from "@intentius/chant/ci-product-words";
import { emitGitlabFile } from "./ci-jobs";

/** A control repo's pipeline file: where it goes, its text, and what a person still sets up. */
export interface ControlPipelineFile {
  path: string;
  content: string;
  notes: string[];
}

/** The control repo's pipeline on GitLab: `.gitlab/<product>-dependents.yml`. */
export function generateControlPipeline(options: { words?: CiProductWordsInput | CiProductWords; image?: string; command?: string } = {}): ControlPipelineFile {
  const spec = controlPipelineSpec("gitlab", options.words ?? {}, options.command ? { command: options.command } : {});
  const job = {
    stage: "deploy",
    image: options.image ?? CI_IMAGE,
    // The full history, so the job reads and appends to chant/lifecycle (#4617).
    variables: { ...GITLAB_FULL_HISTORY },
    rules: [{ if: spec.rule }],
    // One member at a time: two applies upstream should not run the same dependents side by side.
    resource_group: spec.group,
    script: [`bash <<'DEPENDENTS' || exit $?\n${spec.script}\nDEPENDENTS`],
  };
  return { path: spec.path, content: emitGitlabFile([["dependents", job]], spec.header), notes: spec.notes };
}
