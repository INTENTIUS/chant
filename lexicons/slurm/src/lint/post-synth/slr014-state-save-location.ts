/**
 * SLR014: StateSaveLocation should be on shared/NFS storage
 *
 * If StateSaveLocation points to local disk (e.g. /tmp or /var/spool/slurm
 * without NFS), controller failover loses all job state. Shared paths
 * (under /nfs, /shared, /mnt, /efs, /fsx, /scratch) survive head node
 * replacement. This check warns for paths that look local-only.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";

// Paths that suggest shared/NFS storage
const SHARED_PREFIXES = ["/nfs", "/shared", "/mnt", "/efs", "/fsx", "/lustre", "/scratch", "/home"];

export const slr014: PostSynthCheck = {
  id: "SLR014",
  description: "StateSaveLocation should be on shared/NFS storage for controller failover",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [lexicon, output] of ctx.outputs) {
      if (lexicon !== "slurm") continue;
      const content = typeof output === "string" ? output : output.primary;

      const match = content.match(/^StateSaveLocation=(.+)$/m);
      if (!match) continue;

      const path = match[1].trim();
      const isShared = SHARED_PREFIXES.some((prefix) => path.startsWith(prefix));

      if (!isShared) {
        diagnostics.push({
          checkId: "SLR014",
          severity: "warning",
          message: `StateSaveLocation="${path}" appears to be local storage — use a shared path for controller failover`,
          lexicon: "slurm",
        });
      }
    }

    return diagnostics;
  },
};
