/**
 * What a release feature adds to the jobs `chant release workflow` writes
 * (#5196). The cut and publish jobs are a fixed frame (checkout, install, the
 * cut, the publish) with named slots between its lines; each feature, in a
 * file of its own in this directory, says which steps it puts in which slot
 * of which job, and ./index.ts lists the features. A new feature adds a file
 * and a line to that list rather than editing the frame.
 */
import type { OpSetupStep } from "../../lexicon";
import type { MemberTags } from "../../lifecycle/release-tag";
import type { ReleaseGreenSource } from "../../lifecycle/release-green";
import type { ReleasePipelineConfig, ReleaseWorkflowForge, ReleaseWorkflowInput } from "../release-workflow";
import type { ReleaseBuildConfig } from "../release-toolchains";

/** The platform the jobs `chant release workflow` writes run on: GitHub's and Forgejo's `ubuntu-latest`, and a GitLab runner's default (#4876). */
export const RELEASE_RUNNER_PLATFORM = "linux/amd64";

/**
 * The three files the generator writes: `tag`, the publish job on a
 * `release/**` tag; `templated`, the same on the tags a `release.tag`
 * template makes (#5150); `dispatch`, the release started by hand (#4656).
 */
export type ReleaseWorkflowShape = "tag" | "templated" | "dispatch";

/** The settings every feature reads, resolved once per render. */
export interface ReleaseWorkflowContext {
  forge: ReleaseWorkflowForge;
  shape: ReleaseWorkflowShape;
  input: ReleaseWorkflowInput;
  /** `release.workflow`, or an empty one. */
  pipeline: ReleasePipelineConfig;
  /** What runs chant. */
  chant: string;
  /** The workspace root from the repository root, or null at the top. */
  root: string | null;
  /** Under `verified-releases`. */
  verify: boolean;
  /** `release.images` is declared (#4657). */
  images: boolean;
  /** The image archives the cut hands the publish job, from the repository root (dispatch only; empty otherwise). */
  archives: string[];
  /** `release.artifacts` is declared (#5151). */
  artifacts: boolean;
  /** `release.version` is declared (#4840). */
  version: boolean;
  /** `chant release doctor` runs (#5161): on by default in a dispatched release, opt-in on a tag. */
  doctor: boolean;
  /** The publish signs with Sigstore (#5164). */
  signing: boolean;
  /** The green gate the cut checks (#5149). */
  green: ReleaseGreenSource;
  /** `release.workflow.builds` (#5152). */
  builds: ReleaseBuildConfig[];
  /** `release.tag` (#5150), when the shape is `templated`. */
  tags?: MemberTags;
}

/** The two jobs features add steps to. A tag-triggered file has only `publish`. */
export type ReleaseStepJob = "cut" | "publish";

/**
 * The slots of the cut and publish jobs, in the order they run:
 *
 * - `afterCheckout`: GitLab dispatch publish only, before the `cd` into the root.
 * - `prepare`: after the install, the config's setup steps and (on a
 *   templated tag) the label, before the ledger fetch in a cut.
 * - `beforeCut`: a cut, after the fetches, right before `chant release cut`.
 * - `afterCut`: a cut, after the tag is pushed.
 * - `beforeBuild`: a publish, right before its build. On a tag the fetches of
 *   the ci tags and `chant/lifecycle` come before this slot when it holds
 *   anything, since those steps read the release, and after the build when
 *   it is empty.
 * - `afterBuild`: a publish, after its build.
 * - `beforePublish`: a publish, right before `chant release publish`.
 * - `artifactPaths`: GitLab dispatch cut only, lines under its `artifacts: paths:`.
 * - `jobKeys`: GitLab dispatch cut only, lines added to the job's keys.
 * - `idTokens`: GitLab publish job only, entries under its `id_tokens:`
 *   beside `SIGSTORE_ID_TOKEN`, as lines indented four spaces for the name
 *   and six for `aud`.
 */
export type ReleaseStepSlot = "afterCheckout" | "prepare" | "beforeCut" | "afterCut" | "beforeBuild" | "afterBuild" | "beforePublish" | "artifactPaths" | "jobKeys" | "idTokens";

/** A step: a shell line, which the job writes as its forge writes one (`- run: ...`, a script entry), or `lines` placed as they are. */
export type ReleaseStepItem = string | { lines: string[] };

/** Where a feature's steps go, and their order within the slot (lowest first). */
export interface ReleaseStepPlacement {
  slot: ReleaseStepSlot;
  order: number;
  items: ReleaseStepItem[];
}

/** One job of one file, as a feature sees it. */
export interface ReleaseStepContext extends ReleaseWorkflowContext {
  job: ReleaseStepJob;
  /** The release's label as a shell word in this job. */
  label: string;
}

/** A feature of the release workflow. */
export interface ReleaseWorkflowFeature {
  /** The feature's name, for a reader. */
  name: string;
  /** Setup steps of the cut and publish jobs, merged with `release.workflow.setup` (order 20), lowest first. */
  setup?: (c: ReleaseWorkflowContext) => { order: number; steps: OpSetupStep[] } | null;
  /** The feature's steps in one job. */
  steps?: (c: ReleaseStepContext) => ReleaseStepPlacement[];
}
