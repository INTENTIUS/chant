/**
 * `--use-composites` orchestrator: walks the registered patterns and
 * applies the first match. Patterns are tried in declaration order
 * (NodePipeline before NodeCI so the 2-job shape wins over the 1-job
 * shape when both could match).
 */

import type { TemplateIR } from "@intentius/chant/import/parser";
import type { ProvenanceRecord } from "../provenance";
import { PATTERNS, type CompositePattern } from "./patterns";

export function applyComposites(
  ir: TemplateIR,
  registry: CompositePattern[] = PATTERNS,
): { ir: TemplateIR; provenance: ProvenanceRecord[] } {
  const provenance: ProvenanceRecord[] = [];
  let current = ir;
  for (const pattern of registry) {
    const match = pattern.match(current);
    if (match) {
      const result = pattern.rewrite(current, match);
      current = result.ir;
      provenance.push(...result.provenance);
      // Only one composite rewrite per migrate run (keeps semantics simple)
      break;
    }
  }
  return { ir: current, provenance };
}
