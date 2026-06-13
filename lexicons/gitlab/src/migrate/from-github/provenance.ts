/**
 * Per-node provenance for GitHub Actions → GitLab CI migration.
 *
 * Returned as a side channel from `transform()` so the IR stays clean
 * (re-usable by `chant import`) while still capturing per-key migration
 * history for SARIF/Markdown reporting.
 */

export type ProvenanceCategory =
  | "literal"        // direct YAML key rename (env → variables, runs-on → image)
  | "rewrite"        // expression/identifier substitution (github.ref → $CI_COMMIT_REF_NAME)
  | "synthesis"      // emitted GitLab construct with no GH original (inferred stage)
  | "needs-review"   // could not translate; emitted comment + diagnostic
  | "skipped"        // intentionally dropped
  | "action-map";    // a marketplace action mapping fired

export interface ProvenanceRecord {
  /** Where this lives in the output (GitLab IR) — e.g. "jobs.test.script[2]" */
  gitlabPath: string;
  /** Resource logicalId in the GitLab IR, if applicable */
  gitlabLogicalId?: string;
  /** Source file name (for SARIF) */
  sourceFile?: string;
  /** 1-based source line (best effort) */
  sourceLine?: number;
  /** 1-based source column (best effort) */
  sourceColumn?: number;
  /** YAML path in the source (e.g. "jobs.test.steps[1].uses") */
  sourceKey?: string;
  /** What category of translation happened */
  category: ProvenanceCategory;
  /** Rule ID (e.g. "MIG-TRIGGER-001", "ACT-actions-checkout") */
  rule: string;
  /** Free-form explanation for human readers */
  note?: string;
  /** Original action reference (e.g. "actions/checkout@v4") for action-map records */
  actionRef?: string;
  /** Tier 1/2/3 for action-map records */
  mappingTier?: 1 | 2 | 3;
  /** Security classification, when this record concerns a security property. */
  security?: SecurityProvenance;
}

/**
 * Fate of a security property as it crosses the GitHub → GitLab boundary,
 * mirroring the functional provenance categories.
 */
export type SecurityFate = "translated" | "approximated" | "needs-review" | "lost";

/**
 * Security classification attached to a provenance record — tracks whether a
 * security-relevant property survived migration, alongside the functional one.
 */
export interface SecurityProvenance {
  /** Human label for the property (e.g. "Pinned action SHA"). */
  property: string;
  /** What happened to the property across the migration edge. */
  fate: SecurityFate;
  /** Diagnostic severity for this finding. */
  severity: "error" | "warning" | "info";
  /** Cross-reference to the endpoint that re-establishes the property. */
  reestablish?: string;
}

/**
 * Accumulator passed through the transformer pipeline so any step can
 * append to the same provenance list without threading return values.
 */
export class ProvenanceAccumulator {
  private records: ProvenanceRecord[] = [];

  push(record: ProvenanceRecord): void {
    this.records.push(record);
  }

  pushAll(records: ProvenanceRecord[]): void {
    this.records.push(...records);
  }

  all(): ProvenanceRecord[] {
    return [...this.records];
  }

  byCategory(category: ProvenanceCategory): ProvenanceRecord[] {
    return this.records.filter((r) => r.category === category);
  }

  needsReviewCount(): number {
    return this.records.filter((r) => r.category === "needs-review").length;
  }

  /** Records carrying a security classification. */
  securityRecords(): ProvenanceRecord[] {
    return this.records.filter((r) => r.security !== undefined);
  }
}
