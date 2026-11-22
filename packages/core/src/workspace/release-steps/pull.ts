/** The login to each registry `release.images` pulls its bases from (#5457), before the jobs build. */
import type { OpSetupStep } from "../../lexicon";
import type { ReleaseImagePull } from "../../lifecycle/release-images";
import type { ReleasePipelineConfig, ReleaseWorkflowForge } from "../release-workflow";
import type { ReleaseWorkflowFeature } from "./types";

/** The shell that logs docker in to `p.registry` with the username and password its variables hold, the password on standard input. */
export function pullLoginLine(p: ReleaseImagePull): string {
  return `printf '%s' "$${p.passwordEnv}" | docker login ${p.registry} --username "$${p.usernameEnv}" --password-stdin`;
}

/** A repository secret as a GitHub or Forgejo expression. */
const secret = (name: string): string => "${{ secrets." + name + " }}";

/**
 * The variables the cut and publish jobs get for the logins on GitHub and
 * Forgejo: each from the repository's secret of the same name, unless
 * `release.workflow.env` sets it already. They are the jobs' own, so the
 * doctor in the cut sees them too. GitLab gets none: there they are the
 * project's CI/CD variables, which every job has.
 */
export function pullLoginEnv(forge: ReleaseWorkflowForge, p: ReleasePipelineConfig, pulls: readonly ReleaseImagePull[]): Record<string, string> {
  if (forge === "gitlab") return {};
  return Object.fromEntries(pulls.flatMap((r) => [r.usernameEnv, r.passwordEnv]).filter((v) => p.env?.[v] === undefined).map((v) => [v, secret(v)]));
}

/** A forge expression that is the run's own token. */
const RUN_TOKEN = /\$\{\{\s*(github\.token|secrets\.GITHUB_TOKEN)\s*\}\}/;

/**
 * On GitHub, a login to `ghcr.io` whose password is the run's own token
 * (#5486): `github.token`, or the `GITHUB_TOKEN` secret, set in
 * `release.workflow.env` or read from the secret of the same name. That token
 * reads a private package only with `packages: read`.
 */
export function pullsGhcrWithRunToken(forge: ReleaseWorkflowForge, p: ReleasePipelineConfig, pulls: readonly ReleaseImagePull[]): boolean {
  if (forge !== "github") return false;
  return pulls.some((r) => /^ghcr\.io$/i.test(r.registry) && RUN_TOKEN.test(p.env?.[r.passwordEnv] ?? secret(r.passwordEnv)));
}

/**
 * One step per registry that logs docker in before the build, with the
 * username and password its variables hold. The login takes a static pair,
 * such as a registry's pull token, so it needs no OIDC federation.
 */
export function pullLoginSetup(forge: ReleaseWorkflowForge, pulls: readonly ReleaseImagePull[]): OpSetupStep[] {
  return pulls.map((r) => (forge === "gitlab" ? { run: pullLoginLine(r) } : { name: `Log in to ${r.registry}`, run: pullLoginLine(r) }));
}

/** In the cut and publish jobs, which build or check the images, after the config's setup and before the build. */
export const pullFeature: ReleaseWorkflowFeature = {
  name: "pull",
  setup: (c) => {
    const pulls = c.input.pullRegistries ?? [];
    return pulls.length > 0 ? { order: 25, steps: pullLoginSetup(c.forge, pulls) } : null;
  },
};
