import type { ChantConfig } from "@intentius/chant";

/**
 * Per-PR preview environments (chant #1223).
 *
 * Three declarations carry the whole story:
 *
 * - `environments` mixes one literal (`local`) with a glob pattern (`pr-*`,
 *   chant #1221). `pr-42`, `pr-1337` — every PR number — is a legal
 *   environment for build, lifecycle, and teardown, with nothing to edit
 *   per PR.
 * - `buildParams.env` is the environment identity as a build parameter. Its
 *   `env: "CHANT_ENV"` fallback means `chant build --env pr-42` and a CI job
 *   exporting `CHANT_ENV=pr-42` both feed the same validated value.
 * - `ownership.env: { param: "env" }` (chant #1396) binds the ownership
 *   marker to that parameter, so every resource a PR build applies is
 *   stamped `chant.intentius.io/env: pr-42`. `chant lifecycle teardown
 *   pr-42 --yes` selects on exactly that marker — stateless, no snapshot,
 *   no state file.
 *
 * The k8s side deploys to whatever cluster the ambient kubeconfig points at
 * (k3d locally, a real cluster from CI via a kubeconfig secret).
 */
export default {
  lexicons: ["k8s", "github", "temporal"],
  sourceDir: "src",
  environments: ["local", "pr-*"],
  ownership: { stack: "pr-preview", env: { param: "env" } },
  buildParams: {
    env: {
      type: "string",
      default: "local",
      env: "CHANT_ENV",
      description: "Environment identity — 'local' or a per-PR 'pr-<n>' name",
    },
  },
} satisfies ChantConfig;
