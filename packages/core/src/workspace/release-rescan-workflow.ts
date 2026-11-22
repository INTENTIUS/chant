/**
 * The scheduled rescan workflow (#5466): `release.scan.schedule` in
 * `chant.config.ts` names a cron expression, and `chant release workflow`
 * then writes a second file beside the publish workflow whose one job runs
 * `chant release scan --deployed` on that schedule. It reads
 * `chant/lifecycle`, fetches each deployed image's SBOM from its registry
 * with the credentials the `oci` targets name, scans it with the scanner
 * the publish uses, and pushes the `rescanned` line to the publish record.
 *
 * - GitHub and Forgejo: a `schedule` trigger, and `workflow_dispatch` to run
 *   it by hand. The job's token may write `contents`, for the push.
 * - GitLab: the job runs for a pipeline schedule (`$CI_PIPELINE_SOURCE ==
 *   "schedule"`); the file cannot create the schedule, so a comment names
 *   the cron expression to enter under CI/CD, Schedules. The push uses
 *   `CHANT_RELEASE_TOKEN`, a project access token with `write_repository`,
 *   as the dispatch workflow's jobs do.
 */

import { githubSetup, jobExtras, type ReleaseWorkflowForge, type ReleasePipelineConfig } from "./release-workflow";
import { resolveToolchains, toolchainLines } from "./release-toolchains";
import { scanSetup } from "./release-steps/scan";

/** Where each forge's rescan workflow is written, relative to the repository root. */
export const RELEASE_RESCAN_WORKFLOW_FILES: Record<ReleaseWorkflowForge, string> = {
  github: ".github/workflows/chant-release-scan.yml",
  forgejo: ".forgejo/workflows/chant-release-scan.yml",
  gitlab: ".gitlab/chant-release-scan.yml",
};

export interface RescanWorkflowInput {
  forge: ReleaseWorkflowForge;
  /** `release.scan.schedule`. */
  schedule: string;
  chant: string;
  install: string | null;
  /** The member's directory from the repository root, or null. */
  root: string | null;
  pipeline: ReleasePipelineConfig;
  /** The variables the registries' credentials are in (`OCI_USERNAME`, `OCI_PASSWORD`, or what the `oci` targets name), taken from the repository's secrets. */
  registryEnv: readonly string[];
}

/** The variables the `oci` targets of `publish` read their credentials from, once each. */
export function registryEnvOf(publish: ReadonlyArray<{ type: string; usernameEnv?: string; passwordEnv?: string }>): string[] {
  const oci = publish.filter((t) => t.type === "oci");
  return [...new Set(oci.flatMap((t) => [t.usernameEnv ?? "OCI_USERNAME", t.passwordEnv ?? "OCI_PASSWORD"]))];
}

/** The scanner install steps of the publish, without syft: a rescan reads SBOMs and makes none. */
const grype = (forge: ReleaseWorkflowForge, p: ReleasePipelineConfig) => scanSetup(forge, p).filter((s) => JSON.stringify(s).includes("CHANT_GRYPE"));

/** The workflow text, or throws on a variable name that is not one. */
export function renderRescanWorkflow(input: RescanWorkflowInput): string {
  for (const v of input.registryEnv) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(v)) throw new Error(`release.publish: ${JSON.stringify(v)} is not a variable name`);
  const run = `${input.chant} release scan --deployed`;
  const fetchLifecycle = "git fetch origin chant/lifecycle:chant/lifecycle";
  if (input.forge === "gitlab") {
    const cd = input.root ? [`cd ${input.root}`] : [];
    const tools = grype("gitlab", input.pipeline).flatMap((s) => ("run" in s ? [s.run] : []));
    const auth = [
      `chant_auth="$(printf 'oauth2:%s' "$CHANT_RELEASE_TOKEN" | base64 | tr -d '\\n')"`,
      'export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraheader GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $chant_auth"',
      "unset chant_auth",
    ];
    const script = [...cd, ...(input.install ? [input.install] : []), ...tools, ...auth, fetchLifecycle, run];
    return [
      `# Runs for a pipeline schedule: create one under CI/CD, Schedules, with the cron expression ${JSON.stringify(input.schedule)}.`,
      `# CHANT_RELEASE_TOKEN is a project access token with write_repository, as a masked CI/CD variable; ${input.registryEnv.join(" and ") || "the registry's credentials"} are CI/CD variables too.`,
      "chant-release-scan:",
      "  rules:",
      '    - if: $CI_PIPELINE_SOURCE == "schedule"',
      "  variables:",
      '    GIT_DEPTH: "0"',
      "  script:",
      ...script.map((l) => `    - ${JSON.stringify(l)}`),
      "",
    ].join("\n");
  }
  const extra = jobExtras({ ...input.pipeline, setup: grype(input.forge, input.pipeline) }, input.forge);
  const files = new Set(["package.json"]);
  const chantSetup = toolchainLines(resolveToolchains(input.pipeline.toolchains === false ? false : (input.pipeline.toolchains ?? []).filter((t) => (typeof t === "string" ? t : t.name) === "node"), files, input.root, input.pipeline.toolchains !== false));
  const secrets = input.registryEnv.map((v) => `      ${v}: \${{ secrets.${v} }}`);
  return [
    "name: chant release scan",
    "on:",
    "  schedule:",
    `    - cron: ${JSON.stringify(input.schedule)}`,
    "  workflow_dispatch: {}",
    "permissions:",
    "  contents: read",
    "jobs:",
    "  scan:",
    "    runs-on: ubuntu-latest",
    "    permissions:",
    "      contents: write",
    ...(input.forge === "github" ? ["      packages: read"] : []),
    ...(input.root ? ["    defaults:", "      run:", `        working-directory: ${input.root}`] : []),
    ...extra.githubEnv(secrets),
    "    steps:",
    ...githubSetup(undefined, [...chantSetup, ...extra.githubSteps]),
    ...(input.install ? [`      - run: ${input.install}`] : []),
    `      - run: ${fetchLifecycle}`,
    `      - run: ${run}`,
    "",
  ].join("\n");
}
