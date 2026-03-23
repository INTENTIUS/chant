/**
 * SLR011: Every partition must have at least one matching node
 *
 * Partitions without Nodes= are valid Slurm config (Slurm will use ALL
 * nodes), but if Nodes= is set and none of those nodes appear as NodeName=
 * lines, the partition will be DOWN on startup. This check validates
 * cross-references in the serialized output.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";

export const slr011: PostSynthCheck = {
  id: "SLR011",
  description: "Every Partition with Nodes= must match at least one NodeName stanza",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [lexicon, output] of ctx.outputs) {
      if (lexicon !== "slurm") continue;
      const content = typeof output === "string" ? output : output.primary;

      // Extract all defined node name prefixes
      const nodeNames = new Set<string>();
      for (const match of content.matchAll(/^NodeName=(\S+)/gm)) {
        const expr = match[1];
        nodeNames.add(expr.replace(/\[.*\]/, "").trim());
        nodeNames.add(expr);
      }

      // Check each partition's Nodes= value
      for (const match of content.matchAll(/^PartitionName=(\S+)[^\n]*Nodes=(\S+)/gm)) {
        const partName = match[1];
        const nodesExpr = match[2];
        const exprs = nodesExpr.split(",").map((n) => n.trim()).filter(Boolean);

        for (const expr of exprs) {
          const prefix = expr.replace(/\[.*\]/, "").trim();
          const matched = [...nodeNames].some(
            (n) => n === prefix || n.startsWith(prefix) || prefix.startsWith(n),
          );
          if (!matched) {
            diagnostics.push({
              checkId: "SLR011",
              severity: "error",
              message: `Partition "${partName}" Nodes="${expr}" has no matching NodeName stanza`,
              entity: partName,
              lexicon: "slurm",
            });
          }
        }
      }
    }

    return diagnostics;
  },
};
