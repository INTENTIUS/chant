/**
 * PROW101: two jobs with one name where Prow's loader refuses them.
 *
 * Prow's config loader refuses two presubmits of one name in one
 * repository, or two postsubmits, when the branches they run on can meet,
 * and two periodics of one name anywhere. A presubmit and a postsubmit may
 * share a name. Branches meet unless both jobs list `branches` with no entry
 * in common, which is the loader's check for literal branch names.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import type { LocatedJob } from "../../job-config";
import { builtJobConfigs, nameOf } from "./prow-helpers";

const branchesOf = (j: LocatedJob): string[] | undefined =>
  Array.isArray(j.job.branches) && j.job.branches.length > 0 && !Array.isArray(j.job.skip_branches) ? j.job.branches.map(String) : undefined;

/** Whether two jobs of one name can run on one branch. */
export function branchesMeet(a: LocatedJob, b: LocatedJob): boolean {
  const x = branchesOf(a);
  const y = branchesOf(b);
  if (!x || !y) return true;
  return x.some((v) => y.includes(v));
}

export const prow101: PostSynthCheck = {
  id: "PROW101",
  description: "Two jobs with one name in a repository (or two periodics with one name), which Prow's config loader refuses",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const out: PostSynthDiagnostic[] = [];
    for (const { source, jobs } of builtJobConfigs(ctx)) {
      const groups = new Map<string, LocatedJob[]>();
      for (const j of jobs) {
        const key = j.type === "periodic" ? `periodic ${nameOf(j)}` : `${j.type} ${j.repo} ${nameOf(j)}`;
        groups.set(key, [...(groups.get(key) ?? []), j]);
      }
      for (const same of groups.values()) {
        const clash = same.some((a, i) => same.slice(i + 1).some((b) => a.type === "periodic" || branchesMeet(a, b)));
        if (same.length < 2 || !clash) continue;
        const j = same[0];
        const where = j.type === "periodic" ? "the periodics" : `${j.repo}'s ${j.type}s`;
        out.push({
          checkId: "PROW101",
          severity: "error",
          message: `${source}: ${where} hold ${same.length} jobs named ${nameOf(j)}, and Prow's config loader refuses a duplicated job name. Rename one${j.type === "periodic" ? "" : ", or give each its own branches"}.`,
          entity: nameOf(j),
          lexicon: "prow",
        });
      }
    }
    return out;
  },
};
