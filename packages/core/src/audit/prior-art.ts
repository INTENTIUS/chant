/**
 * Prior art for chant's audit rules.
 *
 * Most of what `chant audit` checks has been checked before by a dedicated
 * open-source tool: zizmor and poutine for GitHub Actions, hadolint for
 * Dockerfiles, cfn-lint and cfn_nag for CloudFormation, kube-linter and
 * kube-score for Kubernetes manifests, gitleaks for secrets, and so on. chant's
 * rules were written independently against the emitted output, but the ideas
 * are shared, and the people who wrote them down first deserve the credit.
 *
 * A rule declares its lineage as `Lineage[]` on its `RuleMeta` entry: which
 * tool, which upstream rule, where it is documented, and how the two relate.
 * `PRIOR_ART` is the registry those entries key into, so a tool is named,
 * linked and licensed once. The audit rules reference renders both, the
 * markdown and HTML reports credit the tool beside the finding, and the SARIF
 * and JSON outputs carry the entries verbatim for consumers.
 *
 * Lineage is credit, not authority. `authority` (./catalog.ts) is a standard
 * or vendor document that says a finding matters; lineage is a tool that
 * checks the same condition. The two are independent: a rule may have either,
 * both, or neither, and lineage never changes a rule's category or tier.
 */

/** How a chant rule relates to the upstream check it credits. */
export type LineageRelation =
  /** Same condition, same scope. */
  | "equivalent"
  /** The core condition is shared; one side is narrower or broader, or a different dialect of the same control. */
  | "overlaps"
  /** chant checks a strict superset of the upstream check. */
  | "extends";

/** One credit: an upstream tool's rule that checks what this chant rule checks. */
export interface Lineage {
  /** A key of {@link PRIOR_ART}. */
  tool: PriorArtTool;
  /** The upstream rule id or check name, in the tool's own vocabulary (e.g. `template-injection`, `DL3007`, `CKV_AWS_18`). Omitted when the tool has no per-rule ids. */
  rule?: string;
  /** Where the upstream rule is documented. */
  url: string;
  relation: LineageRelation;
}

/** A tool (or, for a few families, a vendor validator) that chant's rules credit. */
export interface PriorArtEntry {
  name: string;
  url: string;
  /** SPDX identifier where confirmed, else "unverified" or "n/a" for documentation. */
  license: string;
  /** What kind of thing this is, so the rendered credit is honest about it. */
  kind: "scanner" | "vendor-validator" | "specification";
}

/**
 * The registry of prior art. Keys are the slugs `Lineage.tool` uses. Populated
 * from the per-family research recorded in the PR that introduced lineage; the
 * prior-art sweep (scripts/prior-art-sweep.ts) reads the same table.
 */
export const PRIOR_ART = {
  "checkov": { name: "Checkov", url: "https://www.checkov.io/", license: "Apache-2.0", kind: "scanner" },
  "kics": { name: "KICS", url: "https://docs.kics.io/", license: "Apache-2.0", kind: "scanner" },
  "zizmor": { name: "zizmor", url: "https://docs.zizmor.sh/", license: "MIT", kind: "scanner" },
  "cfn-nag": { name: "cfn_nag", url: "https://github.com/stelligent/cfn_nag", license: "MIT", kind: "scanner" },
  "gitlab-docs": { name: "GitLab CI/CD YAML reference", url: "https://docs.gitlab.com/ci/yaml/", license: "CC-BY-SA-4.0", kind: "specification" },
  "guard-rules-registry": { name: "AWS Guard Rules Registry", url: "https://github.com/aws-cloudformation/aws-guard-rules-registry", license: "Apache-2.0", kind: "scanner" },
  "polaris": { name: "Fairwinds Polaris", url: "https://polaris.docs.fairwinds.com/", license: "Apache-2.0", kind: "scanner" },
  "kube-linter": { name: "KubeLinter", url: "https://github.com/stackrox/kube-linter", license: "Apache-2.0", kind: "scanner" },
  "kube-score": { name: "kube-score", url: "https://github.com/zegl/kube-score", license: "MIT", kind: "scanner" },
  "psrule-azure": { name: "PSRule for Azure", url: "https://azure.github.io/PSRule.Rules.Azure/", license: "MIT", kind: "scanner" },
  "gcp-policy-library": { name: "Google Cloud Policy Library", url: "https://github.com/GoogleCloudPlatform/policy-library", license: "Apache-2.0", kind: "scanner" },
  "poutine": { name: "poutine", url: "https://boostsecurityio.github.io/poutine/", license: "Apache-2.0", kind: "scanner" },
  "scorecard": { name: "OpenSSF Scorecard", url: "https://github.com/ossf/scorecard", license: "Apache-2.0", kind: "scanner" },
  "cfn-lint": { name: "cfn-lint", url: "https://github.com/aws-cloudformation/cfn-lint", license: "MIT-0", kind: "scanner" },
  "controlplane-docs": { name: "Control Plane reference documentation", url: "https://docs.controlplane.com", license: "n/a", kind: "specification" },
  "gitleaks": { name: "gitleaks", url: "https://github.com/gitleaks/gitleaks", license: "MIT", kind: "scanner" },
  "octoscan": { name: "octoscan", url: "https://github.com/synacktiv/octoscan", license: "GPL-3.0", kind: "scanner" },
  "detect-secrets": { name: "detect-secrets", url: "https://github.com/Yelp/detect-secrets", license: "Apache-2.0", kind: "scanner" },
  "actionlint": { name: "actionlint", url: "https://github.com/rhysd/actionlint", license: "MIT", kind: "scanner" },
  "trufflehog": { name: "TruffleHog", url: "https://github.com/trufflesecurity/trufflehog", license: "AGPL-3.0", kind: "scanner" },
  "gixy-ng": { name: "gixy-ng (maintained Gixy fork)", url: "https://github.com/dvershinin/gixy", license: "MPL-2.0", kind: "scanner" },
  "kubesec": { name: "kubesec", url: "https://kubesec.io/", license: "Apache-2.0", kind: "scanner" },
  "datree": { name: "Datree", url: "https://hub.datree.io/built-in-rules", license: "Apache-2.0", kind: "scanner" },
  "helm-lint": { name: "helm lint", url: "https://helm.sh/docs/helm/helm_lint/", license: "Apache-2.0", kind: "vendor-validator" },
  "cedar-validator": { name: "Cedar policy validator", url: "https://docs.cedarpolicy.com/policies/validation.html", license: "Apache-2.0", kind: "vendor-validator" },
  "flux-docs": { name: "Flux Kustomization API reference", url: "https://fluxcd.io/flux/components/kustomize/kustomizations/", license: "n/a", kind: "specification" },
  "hadolint": { name: "hadolint", url: "https://github.com/hadolint/hadolint", license: "GPL-3.0", kind: "scanner" },
  "agent-audit": { name: "agent-audit", url: "https://github.com/piiiico/agent-audit", license: "MIT", kind: "scanner" },
  "arm-ttk": { name: "ARM Template Toolkit (arm-ttk)", url: "https://github.com/Azure/arm-ttk", license: "MIT", kind: "scanner" },
  "bicep-linter": { name: "Bicep linter", url: "https://learn.microsoft.com/en-us/azure/azure-resource-manager/bicep/linter", license: "MIT", kind: "scanner" },
  "cedar-cli": { name: "Cedar CLI", url: "https://github.com/cedar-policy/cedar/tree/main/cedar-policy-cli", license: "Apache-2.0", kind: "vendor-validator" },
  "dockle": { name: "Dockle", url: "https://github.com/goodwithtech/dockle", license: "Apache-2.0", kind: "scanner" },
  "mcp-audit": { name: "mcp-audit (APIsec)", url: "https://github.com/apisec-inc/mcp-audit", license: "MIT", kind: "scanner" },
  "render-docs": { name: "Render Blueprint YAML reference", url: "https://render.com/docs/blueprint-spec", license: "n/a", kind: "specification" },
  "agent-scan": { name: "Snyk Agent Scan (formerly mcp-scan)", url: "https://github.com/invariantlabs-ai/mcp-scan", license: "Apache-2.0", kind: "scanner" },
  "cedar-docs": { name: "Cedar policy language reference", url: "https://docs.cedarpolicy.com/policies/json-format.html", license: "n/a", kind: "specification" },
  "cedar-policy-crate": { name: "cedar-policy crate (PolicySet loader)", url: "https://docs.rs/cedar-policy/latest/cedar_policy/", license: "Apache-2.0", kind: "vendor-validator" },
  "chart-testing": { name: "chart-testing (ct)", url: "https://github.com/helm/chart-testing", license: "Apache-2.0", kind: "vendor-validator" },
  "fly-docs": { name: "Fly Machines API reference", url: "https://fly.io/docs/machines/api/machines-resource/", license: "n/a", kind: "specification" },
  "gixy": { name: "Gixy", url: "https://github.com/yandex/gixy", license: "MPL-2.0", kind: "scanner" },
  "kube-bench": { name: "kube-bench", url: "https://github.com/aquasecurity/kube-bench", license: "Apache-2.0", kind: "scanner" },
  "pluto": { name: "Pluto", url: "https://github.com/FairwindsOps/pluto", license: "Apache-2.0", kind: "scanner" },
} as const satisfies Record<string, PriorArtEntry>;

export type PriorArtTool = keyof typeof PRIOR_ART;

/**
 * Attach lineage to a catalog in place. A lexicon keeps its lineage in a
 * sibling `audit-lineage.ts` (one `Record<ruleId, Lineage[]>`) and calls this
 * once at the bottom of its `audit-catalog.ts`, so the prose metadata and the
 * credits stay next to each other but the credits can be regenerated by the
 * prior-art sweep without touching the rule text. Throws at module load if the
 * lineage names a rule the catalog does not have: a stale id is a bug, not a
 * silent no-op.
 */
export function applyLineage<T extends { id: string; lineage?: Lineage[] }>(
  catalog: Record<string, T>,
  lineage: Record<string, Lineage[]>,
): void {
  for (const [id, entries] of Object.entries(lineage)) {
    const rule = catalog[id];
    if (!rule) throw new Error(`audit lineage names ${id}, which this catalog does not define`);
    if (entries.length > 0) rule.lineage = entries;
  }
}

/** Render one lineage entry as "tool rule (relation)" for prose contexts. */
export function lineageLabel(l: Lineage): string {
  const tool = (PRIOR_ART as Record<string, PriorArtEntry>)[l.tool]?.name ?? l.tool;
  return l.rule ? `${tool} ${l.rule}` : tool;
}
