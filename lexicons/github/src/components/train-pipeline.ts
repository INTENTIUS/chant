/**
 * A release train across repositories (#5119) on GitHub, and on Forgejo
 * through its dialect: the two `<product>-train.yml` workflows. The pieces
 * are core's (`trainMemberJobSpec` and `trainControlJobSpec` in
 * `@intentius/chant/control/train`); this file writes them as workflows.
 *
 * - In a member repository, the control repo's dispatch starts the job. It
 *   checks out the release's commit, runs the release with `chant run
 *   --components all --release`, and answers the control repo, whatever the
 *   run did, from a step that alone holds the control repo's token.
 * - In the control repo, a person starts the promote. The job holds one
 *   dispatch token per member repository and nothing else.
 */

import { CI_IMAGE, GITHUB_RUNNER } from "@intentius/chant/ci-jobs";
import { trainControlJobSpec, trainMemberJobSpec, type TrainForge } from "@intentius/chant/control/train";
import type { ControlTarget } from "@intentius/chant/control/dispatch";
import type { CiProductWords, CiProductWordsInput } from "@intentius/chant/ci-product-words";
import { CHECKOUT, concurrency, emitWorkflowYAML, type GithubWorkflowDoc } from "./ci-jobs";
import type { ControlPipelineFile } from "./control-pipeline";

/** What the train workflows take. */
export interface TrainPipelineOptions {
  words?: CiProductWordsInput | CiProductWords;
  /** The image the job runs in. Default chant's CI image. */
  image?: string;
  /** The command the job runs chant with. Default `npx --no-install chant`. */
  command?: string;
}

/** What the member's train workflow takes besides those. */
export interface TrainMemberPipelineOptions extends TrainPipelineOptions {
  /** The directory the run starts in: the workspace root the control repo's `repo` member names. */
  dir?: string;
  /** The install line. Default `npm ci`. */
  install?: string;
  /** Steps that log in to the cloud the run deploys to, under this repository's own identity, put before the run step. */
  login?: Record<string, unknown>[];
  /** The job's `permissions:` besides `contents: write`, such as `id-token: write` for a login that needs it. */
  permissions?: Record<string, string>;
}

/** The member repository's train workflow document, before emission. */
export function trainMemberGithubDoc(forge: TrainForge, control: ControlTarget, options: TrainMemberPipelineOptions = {}): { doc: GithubWorkflowDoc; path: string; notes: string[] } {
  const spec = trainMemberJobSpec(forge, control, {
    ...(options.words ? { words: options.words } : {}),
    ...(options.command ? { command: options.command } : {}),
    ...(options.dir ? { dir: options.dir } : {}),
    ...(options.install ? { install: options.install } : {}),
  });
  const doc: GithubWorkflowDoc = {
    header: spec.header,
    name: spec.path.split("/").pop()!.replace(/\.yml$/, ""),
    on: {
      ...(forge === "github" ? { repository_dispatch: { types: [spec.event] } } : {}),
      workflow_dispatch: { inputs: spec.inputs },
    },
    // contents: write pushes the run's deploy records to chant/lifecycle.
    permissions: { contents: "write", ...(options.permissions ?? {}) },
    concurrency: concurrency(spec.group),
    jobsDoc: {
      train: {
        "runs-on": GITHUB_RUNNER,
        container: options.image ?? CI_IMAGE,
        steps: [
          // The release's commit, with the full history so chant reads chant/lifecycle.
          { uses: CHECKOUT, with: { ref: spec.commit, "fetch-depth": 0 } },
          ...(options.login ?? []),
          { name: spec.run.name, id: "run", shell: "bash", ...(spec.run.workingDirectory ? { "working-directory": spec.run.workingDirectory } : {}), env: spec.run.env, run: spec.run.script },
          // Whatever the run did, unless it was cancelled: the control repo stops the train on anything but applied.
          { name: spec.answer.name, if: "${{ !cancelled() }}", shell: "bash", env: spec.answer.env, run: spec.answer.script },
        ],
      },
    },
  };
  return { doc, path: spec.path, notes: spec.notes };
}

/** The member repository's train workflow on GitHub: `.github/workflows/<product>-train.yml`. */
export function generateTrainMemberPipeline(control: ControlTarget, options: TrainMemberPipelineOptions = {}): ControlPipelineFile {
  const { doc, path, notes } = trainMemberGithubDoc("github", control, options);
  return { path, content: emitWorkflowYAML(doc), notes };
}

/** The control repo's train workflow document, before emission. */
export function trainControlGithubDoc(forge: TrainForge, members: readonly string[], options: TrainPipelineOptions = {}): { doc: GithubWorkflowDoc; path: string; notes: string[] } {
  const spec = trainControlJobSpec(forge, members, { ...(options.words ? { words: options.words } : {}), ...(options.command ? { command: options.command } : {}) });
  const doc: GithubWorkflowDoc = {
    header: spec.header,
    name: spec.path.split("/").pop()!.replace(/\.yml$/, ""),
    on: { workflow_dispatch: { inputs: spec.inputs } },
    // contents: write pushes the train's run records to chant/lifecycle. Nothing else: no id-token, no cloud.
    permissions: { contents: "write" },
    concurrency: concurrency(spec.group),
    jobsDoc: {
      promote: {
        "runs-on": GITHUB_RUNNER,
        container: options.image ?? CI_IMAGE,
        steps: [
          { uses: CHECKOUT, with: { "fetch-depth": 0 } },
          { name: "Dispatch the train's first member repository", shell: "bash", env: spec.env, run: spec.script },
        ],
      },
    },
  };
  return { doc, path: spec.path, notes: spec.notes };
}

/** The control repo's train workflow on GitHub: `.github/workflows/<product>-train.yml`, for the `repo` members it dispatches into. */
export function generateTrainControlPipeline(members: readonly string[], options: TrainPipelineOptions = {}): ControlPipelineFile {
  const { doc, path, notes } = trainControlGithubDoc("github", members, options);
  return { path, content: emitWorkflowYAML(doc), notes };
}
