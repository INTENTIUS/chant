/**
 * gitlab Op activities — resolved by the core activity registry when a project's
 * `chant.config.ts` lists the `gitlab` lexicon. `gitlabPipeline` triggers a
 * pipeline over the GitLab CLI and polls it to completion under the step's
 * profile; relocated from the hosting lexicon (#809) so gitlab's imperative
 * activity lives with its product. The `gitlabPipeline` step builder stays in
 * core and reaches authors through `@intentius/chant/op` like the other core
 * builders.
 */
export { gitlabPipeline } from "./gitlab";
export type { GitlabPipelineArgs } from "./gitlab";
