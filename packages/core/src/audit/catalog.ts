/**
 * Rule catalog — classifies every CI post-synth check the auditor can surface.
 *
 * Two axes drive how a finding is presented:
 *  - `tier`: `merge-worthy` (a security vuln/supply-chain exposure or a hard
 *    correctness bug — worth opening a PR to the target) vs `report-only`
 *    (hygiene/style/perf/deprecation — shown in the report, never a PR title).
 *  - `fixKind`: `deterministic` (a safe mechanical fix can be auto-applied or
 *    diffed) vs `guidance` (needs human/LLM judgment — emit remediation text
 *    only; never auto-applied; never run by the hosted service).
 *
 * Each provider's rule metadata lives in its own lexicon's `auditCatalog()`
 * (#687); this module owns the shared machinery — the `RuleMeta` shape, the
 * `auditRule()` constructor lexicons build entries with, the shared authority
 * citations, and `resolveAuditCatalog()` which merges the lexicons' catalogs
 * over the small static core map (the cross-cutting COR/EXT ids). A drift-guard
 * test asserts the aggregate stays in sync with the lexicons' post-synth checks.
 */

export type Tier = "merge-worthy" | "report-only";

/** deterministic = safe auto-fix/diff; guidance = report text only (needs judgment). */
export type FixKind = "deterministic" | "guidance";

/**
 * What kind of finding this is — orthogonal to `tier` (fix confidence). Lets the
 * report say "N security, M best-practice, K correctness" instead of branding
 * everything "security." `security` = exposure/vuln/supply-chain; `correctness`
 * = a structural bug (broken reference, invalid schema, never-runs); `efficiency`
 * (#444) = waste — redundant work, an oversized execution environment,
 * unintended fan-out, unbounded retention — never a safety/correctness issue,
 * so it is excluded from the security and correctness tallies; everything else
 * is `best-practice` (hygiene/style/deprecation/reliability).
 */
export type Category = "security" | "correctness" | "best-practice" | "efficiency";

export interface Authority {
  name: string;
  url: string;
}

export interface RuleMeta {
  id: string;
  tier: Tier;
  fixKind: FixKind;
  /** What kind of finding this is (security / correctness / best-practice). */
  category: Category;
  title: string;
  /** External backing so a finding isn't just chant's opinion. */
  authority?: Authority[];
  /** One-line fix guidance (always present). */
  remediation: string;
  /**
   * False if the check reads the chant model (`ctx.entities`) rather than the
   * emitted YAML (`ctx.outputs`) — such a check won't fire on audited YAML.
   * All current post-synth checks are output-based, so this is true.
   */
  yamlBased: boolean;
}

// ── Authority references ─────────────────────────────────────────────
export const SCORECARD_TOKEN: Authority = {
  name: "OSSF Scorecard — Token-Permissions",
  url: "https://github.com/ossf/scorecard/blob/main/docs/checks.md#token-permissions",
};
export const GH_TOKEN: Authority = {
  name: "GitHub — Automatic token authentication",
  url: "https://docs.github.com/en/actions/security-for-github-actions/security-guides/automatic-token-authentication",
};
export const SCORECARD_PINNED: Authority = {
  name: "OSSF Scorecard — Pinned-Dependencies",
  url: "https://github.com/ossf/scorecard/blob/main/docs/checks.md#pinned-dependencies",
};
export const GH_THIRD_PARTY: Authority = {
  name: "GitHub — Using third-party actions",
  url: "https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions#using-third-party-actions",
};
export const GH_INJECTION: Authority = {
  name: "GitHub — Understanding the risk of script injections",
  url: "https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions#understanding-the-risk-of-script-injections",
};
export const GH_PWN: Authority = {
  name: "GitHub Security Lab — Preventing pwn requests",
  url: "https://securitylab.github.com/resources/github-actions-preventing-pwn-requests/",
};
export const GH_SECRETS: Authority = {
  name: "GitHub — Using secrets in GitHub Actions",
  url: "https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions",
};
export const GH_OIDC: Authority = {
  name: "GitHub — Security hardening with OpenID Connect",
  url: "https://docs.github.com/en/actions/concepts/security/openid-connect",
};
export const K8S_PSS: Authority = {
  name: "Kubernetes — Pod Security Standards",
  url: "https://kubernetes.io/docs/concepts/security/pod-security-standards/",
};
export const K8S_SECRETS: Authority = {
  name: "Kubernetes — Good practices for Secrets",
  url: "https://kubernetes.io/docs/concepts/security/secrets-good-practices/",
};
export const GH_SECRET_SCANNING: Authority = {
  name: "GitHub — About secret scanning",
  url: "https://docs.github.com/en/code-security/secret-scanning/introduction/about-secret-scanning",
};
export const SCORECARD_VULN: Authority = {
  name: "OSSF Scorecard — Vulnerabilities",
  url: "https://github.com/ossf/scorecard/blob/main/docs/checks.md#vulnerabilities",
};

function meta(
  id: string,
  tier: Tier,
  fixKind: FixKind,
  title: string,
  remediation: string,
  authority?: Authority[],
): RuleMeta {
  // An authority citation is the strongest security signal, so it wins. Otherwise
  // the curated RULE_CATEGORY map (defined below, before RULE_CATALOG runs)
  // decides correctness vs best-practice vs security-without-authority; the drift
  // test guarantees every id is mapped, so the fallback is only a type belt.
  const category: Category = authority && authority.length > 0 ? "security" : RULE_CATEGORY[id] ?? "best-practice";
  return { id, tier, fixKind, category, title, remediation, authority, yamlBased: true };
}

const M = "merge-worthy" as const;
const R = "report-only" as const;
const D = "deterministic" as const;
const G = "guidance" as const;

/**
 * Finding category per rule (#415). Curated: security rules are those that
 * cite an authority or guard an exposure; correctness rules flag structural
 * bugs (broken references, invalid schema, never-runs); the rest are
 * best-practice. A drift test asserts this covers every catalogued rule.
 */
export const RULE_CATEGORY: Record<string, Category> = {
  COR020: "correctness",
  EXT001: "correctness",
  SEC001: "security",
  SEC002: "security",
  SEC003: "security",
  SEC004: "security",
  SEC005: "security",
  SEC006: "security",
  SEC007: "security",
  SEC008: "security",
  SEC009: "security",
  SEC010: "security",
};

/**
 * Core's static portion of the audit catalog — now only the cross-cutting
 * CloudFormation ids (COR/EXT) that aren't owned by a single lexicon. Every
 * per-provider block moved to its lexicon's `auditCatalog()` (#687): WAW→aws,
 * WGC→gcp, AZR→azure, DKRD→docker, WK8/ARGO→k8s, WHM→helm, GHA→github,
 * WGL→gitlab, WFJ→forgejo. `resolveAuditCatalog` merges those over this map.
 */
export const RULE_CATALOG: Record<string, RuleMeta> = {
  COR020: meta("COR020", M, G, "Circular resource dependency", "Break the dependency cycle between resources."),
  EXT001: meta("EXT001", M, G, "Extension constraint violation", "Fix the cross-property constraint flagged by the cfn-lint extension schema."),

  // Secrets & credentials (#443) — lexicon-independent: `secrets.ts` scans the
  // raw text of every candidate file, so these ids apply regardless of which
  // (if any) audit lexicons are installed. `fixKind` is `guidance`: removing
  // a hardcoded credential and rotating it needs a human, never an auto-fix.
  SEC001: meta("SEC001", M, G, "AWS access key ID found", "Remove the key from source, rotate it in IAM, and load it from a secret store or environment variable instead.", [GH_SECRET_SCANNING]),
  SEC002: meta("SEC002", M, G, "AWS secret access key found", "Remove the key from source, rotate it in IAM, and load it from a secret store or environment variable instead.", [GH_SECRET_SCANNING]),
  SEC003: meta("SEC003", M, G, "GitHub token found", "Remove the token from source and revoke it at github.com/settings/tokens; use a GitHub Actions secret instead.", [GH_SECRET_SCANNING]),
  SEC004: meta("SEC004", M, G, "Slack token found", "Remove the token from source and revoke it in the Slack app's OAuth settings.", [GH_SECRET_SCANNING]),
  SEC005: meta("SEC005", M, G, "Google API key found", "Remove the key from source and regenerate it in the Google Cloud Console credentials page.", [GH_SECRET_SCANNING]),
  SEC006: meta("SEC006", M, G, "Stripe live secret key found", "Remove the key from source and roll it in the Stripe dashboard immediately — this is a live-mode key.", [GH_SECRET_SCANNING]),
  SEC007: meta("SEC007", M, G, "Private key block found", "Remove the private key from source, rotate the keypair, and load the key from a secret store instead.", [GH_SECRET_SCANNING]),
  SEC008: meta("SEC008", M, G, "Bearer/authorization token found", "Remove the token from source; if it's long-lived, revoke and reissue it via the issuing service.", [GH_SECRET_SCANNING]),
  SEC009: meta("SEC009", M, G, "Credentials embedded in a connection string", "Move the username/password out of the URI into a secret store, and rotate the credential.", [GH_SECRET_SCANNING]),
  SEC010: meta("SEC010", M, G, "High-entropy string — possible secret", "Confirm whether this is a live credential; if so, remove it from source and rotate it. If it's a false positive, suppress with a `chant-audit-ignore` comment or an allowlist entry.", [GH_SECRET_SCANNING]),
};

/**
 * Build one catalog entry — the lexicon-facing constructor for
 * `LexiconPlugin.auditCatalog()` (#687), so a lexicon can declare its own rules'
 * metadata next to the rules. Unlike the internal `meta()` it takes `category`
 * explicitly (a lexicon owns its rules' categories) rather than reading core's
 * curated `RULE_CATEGORY` map: an authority citation still forces `security`,
 * otherwise the passed `category` (default `best-practice`) applies.
 */
export function auditRule(
  id: string,
  tier: Tier,
  fixKind: FixKind,
  title: string,
  remediation: string,
  opts?: { authority?: Authority[]; category?: Category },
): RuleMeta {
  const category: Category = opts?.authority && opts.authority.length > 0 ? "security" : (opts?.category ?? "best-practice");
  return { id, tier, fixKind, category, title, remediation, authority: opts?.authority, yamlBased: true };
}

/**
 * Resolve the effective audit catalog for a set of lexicons: core's static
 * `RULE_CATALOG` with each active lexicon's contributed `auditCatalog()` merged
 * on top (a lexicon's own entry wins for its ids). This is the aggregation seam
 * (#687, epic #350) that lets per-provider metadata move out of core into the
 * lexicon that owns the rules, while the auditor — which already loads those
 * lexicons to run the rules — reads one merged catalog. Tolerant: a lexicon
 * that can't be loaded or contributes no catalog is skipped.
 */
export async function resolveAuditCatalog(lexicons: string[]): Promise<Record<string, RuleMeta>> {
  const catalog: Record<string, RuleMeta> = { ...RULE_CATALOG };
  // Forgejo workflows are GitHub-dialect: `audit/core.ts` runs github's checks
  // against them, so their GHA* findings need github's catalog too (#687).
  const needed =
    lexicons.includes("forgejo") && !lexicons.includes("github") ? [...lexicons, "github"] : lexicons;
  if (needed.length === 0) return catalog;
  // Lazy import so importing this module doesn't pull in the plugin/config graph
  // (matches ./core.ts's `load` — see #408).
  const { loadPlugins } = await import("../cli/plugins");
  let plugins: Array<{ auditCatalog?(): Record<string, RuleMeta> }>;
  try {
    plugins = await loadPlugins(needed);
  } catch {
    return catalog; // a lexicon package isn't installed — fall back to the static core catalog.
  }
  for (const plugin of plugins) {
    const contributed = plugin?.auditCatalog?.();
    if (contributed) Object.assign(catalog, contributed);
  }
  return catalog;
}

/** Look up catalog metadata for a check id, if known. */
export function ruleMeta(id: string): RuleMeta | undefined {
  return RULE_CATALOG[id];
}

/** Docs path for the audit rules reference (one anchor per rule id). */
export const RULES_DOC_PATH = "/chant/lint-rules/audit-rules/";

/** Absolute URL to a rule's entry in the audit rules reference. */
export function ruleDocUrl(id: string): string {
  return `https://intentius.io${RULES_DOC_PATH}#${id.toLowerCase()}`;
}
