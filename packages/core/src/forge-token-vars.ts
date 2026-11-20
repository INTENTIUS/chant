/**
 * The forge token variables' names, in a module of their own so the
 * pull-request loop's bundle takes the list without the rest of
 * `./ci-handover` (#5416, `pr-loop-bundle.test.ts`). No imports.
 */

/**
 * The variables a runner, a job or a secret may hold a forge token in.
 * A step that runs the change's code starts without them. The list is
 * terragucci's `STEP_TOKEN_VARS` (render.ts:1787) with chant's own names
 * (`FORGE_TOKEN_ENV` in ./pr-forge.ts) and GitLab's added.
 */
export const FORGE_TOKEN_VARS = [
  "CHANT_FORGE_TOKEN",
  "CHANT_GITHUB_TOKEN",
  "CHANT_FORGEJO_TOKEN",
  "CHANT_GITLAB_TOKEN",
  "CHANT_CHECKOUT_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "FORGEJO_TOKEN",
  "GITEA_TOKEN",
  "GITLAB_TOKEN",
  "CI_JOB_TOKEN",
  "ACTIONS_RUNTIME_TOKEN",
] as const;
