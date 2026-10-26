/**
 * pulumi Op activities (#4494), resolved by the core activity registry when a
 * project's `chant.config.ts` lists the `pulumi` lexicon. `loadActivities`
 * (`packages/core/src/op/activity-registry.ts`) imports
 * `@intentius/chant-lexicon-pulumi/op/activities` and keys every exported
 * function by its name, so this module exports activities and nothing else
 * callable:
 *
 *   - pulumiPreview: `pulumi preview --json` in the member's directory, as
 *     change counts and the plan digest.
 *   - pulumiDrift: one `pulumi refresh --preview-only --json --target <urn>`
 *     per resource (`plunge drift --resource <urn> --stream` on plunge), as
 *     drift counts.
 *
 * Neither changes the stack. See `./pulumi.ts`.
 */
export { pulumiPreview, pulumiDrift } from "./pulumi";
export type { PulumiMemberArgs, PulumiPreviewArgs, PulumiPreviewResult, PulumiDriftArgs, PulumiDriftResult } from "./pulumi";
