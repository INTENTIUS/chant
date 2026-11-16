/**
 * PROW105: a presubmit on a build cluster that holds credentials.
 *
 * A presubmit runs a pull request's code. A build cluster holds credentials
 * when a job in the config runs there with one: a Secret its pod reads, or a
 * service account the cluster can bind to a cloud identity (GKE Workload
 * Identity, EKS IRSA or Pod Identity, AKS Workload Identity). The change's
 * code then runs beside them, where a pod escape, a shared node or a
 * mis-scoped role reaches them. Run presubmits on a cluster that holds none,
 * and keep the credentials on a cluster only postsubmits and periodics use.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import type { LocatedJob } from "../../job-config";
import { builtJobConfigs, clusterOf, nameOf, secretMounts, serviceAccountOf } from "./prow-helpers";

/** What a job holds on its cluster, as short descriptions. */
function holds(j: LocatedJob): string[] {
  const sa = serviceAccountOf(j.job);
  return [...secretMounts(j.job), ...(sa ? [`service account ${sa}`] : [])];
}

export const prow105: PostSynthCheck = {
  id: "PROW105",
  description: "A presubmit, which runs pull request code, on a build cluster where jobs hold credentials",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const out: PostSynthDiagnostic[] = [];
    for (const { source, jobs } of builtJobConfigs(ctx)) {
      const holders = new Map<string, string[]>();
      for (const j of jobs) {
        const h = holds(j);
        if (h.length > 0) holders.set(clusterOf(j), [...(holders.get(clusterOf(j)) ?? []), `${j.type} ${nameOf(j)} (${h.join(", ")})`]);
      }
      for (const j of jobs) {
        if (j.type !== "presubmit") continue;
        const there = holders.get(clusterOf(j));
        if (!there) continue;
        out.push({
          checkId: "PROW105",
          severity: "warning",
          message: `${source}: presubmit ${nameOf(j)} on ${j.repo} runs pull request code on build cluster ${clusterOf(j)}, where ${there.join("; ")} hold credentials. Run presubmits on a cluster that holds none.`,
          entity: nameOf(j),
          lexicon: "prow",
        });
      }
    }
    return out;
  },
};
