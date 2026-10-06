/**
 * `CollectorAuditOp`: the otel lexicon's pins against upstream, as an Op
 * with an optional schedule (#3369). It sits at observe, like
 * `WorkflowAuditOp`: one `collectorAudit` step reads the contrib release
 * list against `COLLECTOR_PIN`, each built-in component's stability from its
 * `metadata.yaml`, and `GENAI_SEMCONV_PIN` against the semantic-conventions
 * releases. `onFinding` says what happens with findings: `report` (the
 * default), `issue`, or `pull-request`, which bumps the pins on a proposal
 * branch and opens a pull request. Review and merge of that pull request
 * are the approval.
 *
 * @example
 * ```typescript
 * export const { op } = CollectorAuditOp({ name: "collector-audit", schedule: "0 6 * * 1", onFinding: "pull-request" });
 * ```
 */

import { Op, phase, type OpResource } from "@intentius/chant/op";
import { collectorAudit } from "./builders";
import type { CollectorAuditMode } from "./activities/collector-audit";

export interface CollectorAuditOpConfig {
  /** Op name (kebab-case). */
  name: string;
  /** Cron expression; omit for one-shot `chant run`. */
  schedule?: string;
  /** @default "report" */
  onFinding?: CollectorAuditMode;
  /** The otel lexicon's directory a pull request edits. Default `lexicons/otel`. */
  lexiconDir?: string;
  /** At most this many `metadata.yaml` reads. Default 200. */
  stabilityBudget?: number;
}

export interface CollectorAuditOpResources {
  op: InstanceType<typeof OpResource>;
}

export function CollectorAuditOp(config: CollectorAuditOpConfig): CollectorAuditOpResources {
  const step = collectorAudit({
    mode: config.onFinding ?? "report",
    ...(config.lexiconDir ? { lexiconDir: config.lexiconDir } : {}),
    ...(config.stabilityBudget !== undefined ? { stabilityBudget: config.stabilityBudget } : {}),
  });
  const op = Op({
    name: config.name,
    overview: "Audit the otel lexicon's collector and semantic-convention pins and its components' stability against upstream releases",
    labels: { Audit: "true", Surface: "otel-collector" },
    ...(config.schedule ? { schedule: { cron: config.schedule, overlap: "skip" as const } } : {}),
    phases: [phase("Audit", [{ ...step, outcomeAttribute: { name: "Findings", from: "findings" } }])],
  });
  return { op };
}
