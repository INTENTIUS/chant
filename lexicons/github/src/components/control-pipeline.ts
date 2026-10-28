/**
 * The control repo's own workflow (#4568) on GitHub, and on Forgejo through
 * its dialect: a member's dispatch starts it, and it runs the member's
 * dependents with `chant workspace run --dependents-of`. The pieces are
 * core's (`controlPipelineSpec` in `@intentius/chant/control/dispatch`);
 * this file writes them as a workflow. The member's side, the
 * `control-dispatch` job, comes from the pull request loop's `control`
 * option (./generate-pipeline.ts).
 */

import { CI_IMAGE, GITHUB_RUNNER } from "@intentius/chant/ci-jobs";
import { controlPipelineSpec } from "@intentius/chant/control/dispatch";
import type { CiProductWords, CiProductWordsInput } from "@intentius/chant/ci-product-words";
import { CHECKOUT, concurrency, emitWorkflowYAML, type GithubWorkflowDoc } from "./ci-jobs";

/** A control repo's pipeline file: where it goes, its text, and what a person still sets up. */
export interface ControlPipelineFile {
  path: string;
  content: string;
  notes: string[];
}

/** What {@link controlGithubDoc} and the generators take. */
export interface ControlPipelineOptions {
  words?: CiProductWordsInput | CiProductWords;
  /** The image the job runs in. Default chant's CI image. */
  image?: string;
  /** The command the job runs chant with. Default `npx --no-install chant`. */
  command?: string;
}

/** The control repo's workflow document for a GitHub-shaped forge, before emission. Forgejo transforms it first. */
export function controlGithubDoc(forge: "github" | "forgejo", options: ControlPipelineOptions = {}): { doc: GithubWorkflowDoc; path: string; notes: string[] } {
  const spec = controlPipelineSpec(forge, options.words ?? {}, options.command ? { command: options.command } : {});
  const doc: GithubWorkflowDoc = {
    header: spec.header,
    name: spec.path.split("/").pop()!.replace(/\.yml$/, ""),
    on: {
      ...(forge === "github" ? { repository_dispatch: { types: [spec.event] } } : {}),
      workflow_dispatch: { inputs: spec.inputs },
    },
    // #4617: contents: write pushes the record of each dispatch that carries an outcome to chant/lifecycle.
    permissions: { contents: "write" },
    // One run per member at a time, and none cancelled: a later apply of the same member waits for the one running.
    concurrency: concurrency(spec.group),
    jobsDoc: {
      dependents: {
        "runs-on": GITHUB_RUNNER,
        container: options.image ?? CI_IMAGE,
        steps: [
          // The full history, so the job reads and appends to chant/lifecycle (#4617).
          { uses: CHECKOUT, with: { "fetch-depth": 0 } },
          { name: "Run the dependents of the member that applied", shell: "bash", env: spec.env, run: spec.script },
        ],
      },
    },
  };
  return { doc, path: spec.path, notes: spec.notes };
}

/** The control repo's workflow on GitHub: `.github/workflows/<product>-dependents.yml`. */
export function generateControlPipeline(options: ControlPipelineOptions = {}): ControlPipelineFile {
  const { doc, path, notes } = controlGithubDoc("github", options);
  return { path, content: emitWorkflowYAML(doc), notes };
}
