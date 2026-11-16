/** What the `release.publish` targets need of the jobs on GitHub (#4786). */
import type { ReleasePipelineConfig, ReleaseWorkflowForge, ReleaseWorkflowTarget } from "../release-workflow";
import type { ReleaseWorkflowFeature } from "./types";

/** npm trusted publishing needs this npm or later (#4786). */
export const NPM_TRUSTED_PUBLISHING_MIN = "11.5.1";
/** The npm a publish job installs when the runner's Node bundles one older than {@link NPM_TRUSTED_PUBLISHING_MIN}. */
export const NPM_TRUSTED_PUBLISHING_VERSION = "11.19.0";

/**
 * The shell line that installs {@link NPM_TRUSTED_PUBLISHING_VERSION} when the
 * runner's npm is older than {@link NPM_TRUSTED_PUBLISHING_MIN}, and prints the
 * npm in use.
 */
export const NPM_TRUSTED_PUBLISHING_SETUP = `have="$(npm --version)"; if [ "$(printf '%s\\n' "${NPM_TRUSTED_PUBLISHING_MIN}" "$have" | sort -V | head -n1)" != "${NPM_TRUSTED_PUBLISHING_MIN}" ]; then npm install -g npm@${NPM_TRUSTED_PUBLISHING_VERSION}; fi; npm --version`;

/**
 * What a GitHub release workflow needs for its targets, worked out from them
 * (#4786), so no product wires it by hand:
 *
 * - an `oci` target on `ghcr.io` that names no credentials pushes with the
 *   job's token: `packages: write`, and `OCI_USERNAME` and `OCI_PASSWORD`
 *   from `github.actor` and `github.token`;
 * - an `npm` target on npmjs publishes with trusted publishing, which needs
 *   npm {@link NPM_TRUSTED_PUBLISHING_MIN}: the jobs upgrade npm when the
 *   runner's is older.
 *
 * `release.workflow` wins: a scope, variable or the same setup line it names
 * is not added again. Other forges, and configs without such targets, get
 * nothing.
 */
export function targetExtras(forge: ReleaseWorkflowForge, targets: ReadonlyArray<ReleaseWorkflowTarget>, p: ReleasePipelineConfig): Pick<ReleasePipelineConfig, "permissions" | "env" | "setup"> {
  if (forge !== "github") return {};
  const ghcr = targets.some((t) => t.type === "oci" && /^ghcr\.io\//.test(t.repository ?? "") && !t.usernameEnv && !t.passwordEnv);
  const npm = targets.some((t) => t.type === "npm" && (t.registry === undefined || /^https:\/\/registry\.npmjs\.org\/?$/.test(t.registry)));
  const permissions = ghcr && p.permissions?.packages === undefined ? { packages: "write" as const } : undefined;
  const env = ghcr ? Object.fromEntries((["OCI_USERNAME", "OCI_PASSWORD"] as const).filter((k) => p.env?.[k] === undefined).map((k) => [k, k === "OCI_USERNAME" ? "${{ github.actor }}" : "${{ github.token }}"])) : {};
  const setup = npm && !(p.setup ?? []).some((s) => !("uses" in s) && s.run === NPM_TRUSTED_PUBLISHING_SETUP) ? [{ run: NPM_TRUSTED_PUBLISHING_SETUP }] : [];
  return { ...(permissions ? { permissions } : {}), ...(Object.keys(env).length > 0 ? { env } : {}), ...(setup.length > 0 ? { setup } : {}) };
}

/** The targets' setup after the config's own, so a config that set it by hand renders the same file without it. Their permissions and variables the frame merges. */
export const targetsFeature: ReleaseWorkflowFeature = {
  name: "targets",
  setup: (c) => ({ order: 30, steps: targetExtras(c.forge, c.input.publish ?? [], c.pipeline).setup ?? [] }),
};
