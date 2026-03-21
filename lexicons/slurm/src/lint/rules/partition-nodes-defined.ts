/**
 * SLRC001: Partition references undefined node
 *
 * Every PartitionName stanza that specifies Nodes= must reference a node
 * name (or expression prefix) that appears in at least one NodeName stanza.
 * Undefined nodes cause partitions to go DOWN at startup.
 */

import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";

export const partitionNodesDefined: LintRule = {
  id: "SLRC001",
  severity: "error",
  category: "correctness",
  description: "Partition Nodes= references a node that has no NodeName stanza",

  check(context: LintContext): LintDiagnostic[] {
    const diagnostics: LintDiagnostic[] = [];

    // Collect all defined node name prefixes (strip bracketed ranges)
    const definedNodePrefixes = new Set<string>();
    const partitionsWithNodes: Array<{ name: string; nodes: string }> = [];

    for (const [name, entity] of context.entities) {
      const et = (entity as Record<string, unknown>).entityType as string;
      const props = (entity as { props?: Record<string, unknown> }).props ?? {};

      if (et === "Slurm::Conf::Node" && props.NodeName) {
        // Extract prefix: "node[001-016]" → "node", "gpu-node" → "gpu-node"
        const nodeName = String(props.NodeName);
        const prefix = nodeName.replace(/\[.*\]/, "").trim();
        definedNodePrefixes.add(prefix);
        definedNodePrefixes.add(nodeName); // also add exact name
      }

      if (et === "Slurm::Conf::Partition" && props.Nodes) {
        partitionsWithNodes.push({ name, nodes: String(props.Nodes) });
      }
    }

    for (const { name, nodes } of partitionsWithNodes) {
      // Split node list (comma-separated, may include bracketed ranges)
      const nodeExprs = nodes.split(",").map((n) => n.trim()).filter(Boolean);

      for (const expr of nodeExprs) {
        const prefix = expr.replace(/\[.*\]/, "").trim();
        // Check if any defined node matches by prefix or exact name
        const defined = [...definedNodePrefixes].some(
          (p) => p === prefix || p.startsWith(prefix) || prefix.startsWith(p),
        );
        if (!defined) {
          diagnostics.push({
            ruleId: "SLRC001",
            severity: "error",
            message: `Partition "${name}" references node "${expr}" which has no NodeName stanza`,
            entity: name,
            fix: `Add a Node with NodeName=${expr} (or matching prefix)`,
          });
        }
      }
    }

    return diagnostics;
  },
};
