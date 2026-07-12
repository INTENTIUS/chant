/**
 * gitlab Op activities — resolved by the core activity registry when a project's
 * `chant.config.ts` lists the `gitlab` lexicon. `gitlabPipeline` triggers a
 * pipeline over the GitLab CLI with heartbeat/retry semantics; relocated from the
 * temporal lexicon (#809) so gitlab's imperative activity lives with its product.
 * The `gitlabPipeline` step builder stays in core, re-exported from the temporal
 * Op-authoring barrel like the other core builders.
 */
export { gitlabPipeline } from "./gitlab";
export type { GitlabPipelineArgs } from "./gitlab";
