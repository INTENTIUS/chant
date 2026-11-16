/**
 * A job config for one repository's forge (#5170): `ci: prow` beside
 * `forge: github`.
 *
 * Prow keys presubmits and postsubmits by the repository's `owner/name` on
 * GitHub. A product that knows the forge and the repository, and has its
 * jobs as plain data, hands them here and gets the text Prow loads, written
 * by {@link emitJobConfig}. Periodics are not keyed by a repository and are
 * written as given.
 *
 * This writes the file. Turning chant's pipeline jobs into Prow jobs, as the
 * forge lexicons' pipeline generators do for their CI, is not done here.
 */

import type { ForgeKind } from "@intentius/chant/pr-forge";
import { emitJobConfig } from "./serializer";

type Job = Record<string, unknown>;

/** The forge and repository the jobs run for. */
export interface ProwForgeTarget {
  /** The forge the repository is on. Prow runs jobs for GitHub repositories, so it must be `github`. */
  forge: ForgeKind;
  /** The repository's `owner/name` on the forge. */
  repo: string;
}

/** One repository's jobs, before they are keyed. */
export interface ProwRepoJobs {
  presubmits?: Job[];
  postsubmits?: Job[];
  periodics?: Job[];
}

/** Why Prow cannot run jobs for `target`, or undefined when it can. */
export function prowForgeProblem(target: ProwForgeTarget): string | undefined {
  if (target.forge !== "github") return `ci: prow runs jobs for a repository on github, and this forge is ${target.forge}`;
  if (!/^[^/\s]+\/[^/\s]+$/.test(target.repo)) return `Prow keys a repository's jobs by its owner/name on GitHub, and ${JSON.stringify(target.repo)} is not one`;
  return undefined;
}

/**
 * The job config text for one repository: its presubmits and postsubmits
 * under `target.repo`, then the periodics, with `header` as comment lines
 * above them. Throws when Prow cannot run jobs for the target
 * ({@link prowForgeProblem}).
 */
export function forgeJobConfig(target: ProwForgeTarget, jobs: ProwRepoJobs, options: { header?: string } = {}): string {
  const problem = prowForgeProblem(target);
  if (problem) throw new Error(problem);
  return emitJobConfig(
    {
      ...(jobs.presubmits?.length ? { presubmits: { [target.repo]: jobs.presubmits } } : {}),
      ...(jobs.postsubmits?.length ? { postsubmits: { [target.repo]: jobs.postsubmits } } : {}),
      ...(jobs.periodics?.length ? { periodics: jobs.periodics } : {}),
    },
    options,
  );
}
