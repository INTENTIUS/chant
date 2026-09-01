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
export const CF_WORKERS_DEV: Authority = {
  name: "Cloudflare Workers — workers.dev",
  url: "https://developers.cloudflare.com/workers/configuration/routing/workers-dev/",
};
export const CF_SECRETS: Authority = {
  name: "Cloudflare Workers — Secrets",
  url: "https://developers.cloudflare.com/workers/configuration/secrets/",
};
export const CF_ROUTES: Authority = {
  name: "Cloudflare Workers — Routes",
  url: "https://developers.cloudflare.com/workers/configuration/routing/routes/",
};
export const CF_ENVIRONMENTS: Authority = {
  name: "Cloudflare Workers — Wrangler environments",
  url: "https://developers.cloudflare.com/workers/wrangler/configuration/#environments",
};
export const CF_STATIC_ASSETS: Authority = {
  name: "Cloudflare Workers — Static assets",
  url: "https://developers.cloudflare.com/workers/static-assets/",
};
export const MOZILLA_TLS: Authority = {
  name: "Mozilla — Server Side TLS",
  url: "https://wiki.mozilla.org/Security/Server_Side_TLS",
};
export const CWE_DIR_LISTING: Authority = {
  name: "CWE-548 — Exposure of Information Through Directory Listing",
  url: "https://cwe.mitre.org/data/definitions/548.html",
};
export const GIXY_ALIAS: Authority = {
  name: "Gixy — alias traversal",
  url: "https://github.com/yandex/gixy/blob/master/docs/en/plugins/aliastraversal.md",
};
export const NGINX_STUB_STATUS: Authority = {
  name: "nginx — ngx_http_stub_status_module",
  url: "https://nginx.org/en/docs/http/ngx_http_stub_status_module.html",
};
export const CWE_HARDCODED_CREDS: Authority = {
  name: "CWE-798 — Use of Hard-coded Credentials",
  url: "https://cwe.mitre.org/data/definitions/798.html",
};
export const CWE_CLEARTEXT: Authority = {
  name: "CWE-319 — Cleartext Transmission of Sensitive Information",
  url: "https://cwe.mitre.org/data/definitions/319.html",
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
 * An AGT (agent-configuration) rule. Unlike every other family in the catalog
 * these do not run against emitted YAML — they run against the agent config
 * discovered on a machine (`packages/core/src/agents/`), so `yamlBased` is
 * false: feeding a workflow file to the auditor will never produce one.
 *
 * All eight are `guidance`. There is no safe mechanical fix for any of them —
 * pinning someone's MCP server picks a version on their behalf, and narrowing a
 * permission grant requires knowing which commands they actually run.
 */
function agentMeta(id: string, tier: Tier, title: string, remediation: string, authority?: Authority[]): RuleMeta {
  const category: Category = authority && authority.length > 0 ? "security" : RULE_CATEGORY[id] ?? "best-practice";
  return { id, tier, fixKind: G, category, title, remediation, authority, yamlBased: false };
}

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
  WRG001: "security",
  WRG002: "security",
  WRG003: "best-practice",
  WRG004: "security",
  WRG005: "security",
  WRG006: "security",
  // NGX — nginx config audit (#1979), lexicon-independent like SEC/WRG.
  NGX001: "security",
  NGX002: "security",
  NGX003: "security",
  NGX004: "security",
  NGX005: "security",
  NGX006: "best-practice",
  NGX007: "best-practice",
  // AGT — agent configuration (`chant audit --agents`). Core-owned like COR/EXT:
  // these run against the machine's own agent config, not against any one
  // lexicon's emitted output, so no lexicon ships them.
  AGT001: "security",
  AGT002: "security",
  AGT003: "security",
  AGT004: "security",
  AGT005: "security",
  AGT006: "best-practice",
  AGT007: "correctness",
  AGT008: "best-practice",
};

/**
 * Core's static portion of the audit catalog — now only the cross-cutting
 * CloudFormation ids (COR/EXT) that aren't owned by a single lexicon. Every
 * per-provider block moved to its lexicon's `auditCatalog()` (#687): WAW→aws,
 * WGC→gcp, AZR→azure, DKRD→docker, WK8/ARGO→k8s, WHM→helm, GHA→github,
 * WGL→gitlab, WFJ→forgejo. `resolveAuditCatalog` merges those over this map,
 * alongside the lexicon-independent SEC/WRG/AGT families core owns outright.
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

  // Wrangler config audit (#446) — lexicon-independent, same shape as the SEC
  // family above: `wrangler.ts` scans every `wrangler.toml` it finds
  // regardless of which (if any) audit lexicons are installed.
  WRG001: meta("WRG001", M, G, "Production environment exposed on *.workers.dev", "Remove workers_dev (or set it to false) for this environment and rely on its custom domain/route instead of the shared public subdomain.", [CF_WORKERS_DEV]),
  WRG002: meta("WRG002", M, G, "Credential-shaped key stored in [vars]", "Move the value out of [vars] and into `wrangler secret put <name>` so it isn't committed to source or visible in `wrangler dev`/the dashboard.", [CF_SECRETS]),
  WRG003: meta("WRG003", R, G, "Observability explicitly disabled", "Set observability.enabled = true (or remove the override) so Workers Logs are recorded for this deployment."),
  WRG004: meta("WRG004", M, G, "Unscoped wildcard route", "Scope the route pattern to the intended zone (e.g. \"example.com/*\") instead of a bare \"*\" or \"*/*\" that matches every zone on the account.", [CF_ROUTES]),
  WRG005: meta("WRG005", M, G, "Non-production environment shares a data store with production", "Give the non-production environment its own KV namespace/R2 bucket/D1 database id instead of reusing production's.", [CF_ENVIRONMENTS]),
  WRG006: meta("WRG006", M, G, "Static assets served from the project root", "Point [site].bucket / [assets].directory at a dedicated public output folder, not the project root, so non-public files (config, source maps, .git) aren't served.", [CF_STATIC_ASSETS]),

  // nginx config audit (#1979, the #446 follow-up) — lexicon-independent,
  // same shape as SEC/WRG: `nginx.ts` scans every nginx config it detects
  // regardless of which (if any) audit lexicons are installed.
  NGX001: meta("NGX001", M, G, "Deprecated TLS protocol enabled", "Remove SSLv2/SSLv3/TLSv1/TLSv1.1 from ssl_protocols and serve TLSv1.2 and TLSv1.3 only.", [MOZILLA_TLS]),
  NGX002: meta("NGX002", M, G, "Weak cipher suite enabled", "Remove the RC4/DES/MD5/NULL/EXPORT-class entries from ssl_ciphers and use a modern cipher list (e.g. Mozilla's intermediate configuration).", [MOZILLA_TLS]),
  NGX003: meta("NGX003", M, G, "Directory listing enabled", "Remove `autoindex on` (or scope it to a directory that is genuinely meant to be enumerated) so file listings aren't served to anyone who asks.", [CWE_DIR_LISTING]),
  NGX004: meta("NGX004", M, G, "alias path traversal", "End the location prefix with \"/\" so it matches the trailing slash of the alias target — without it, a request for \"<prefix>../\" escapes the aliased directory.", [GIXY_ALIAS]),
  NGX005: meta("NGX005", M, G, "Status endpoint with no access restriction", "Restrict the stub_status location with allow/deny (or auth_basic/auth_request) so connection metrics aren't public reconnaissance.", [NGINX_STUB_STATUS]),
  NGX006: meta("NGX006", R, G, "Server version disclosure", "Add `server_tokens off;` in the http block so nginx stops advertising its exact version in the Server header and error pages."),
  NGX007: meta("NGX007", R, G, "Access logging disabled at server scope", "Re-enable access_log at http/server scope (silencing a single noisy location is fine) so requests are recorded for incident investigation."),

  // ── Agent configuration (`chant audit --agents`) ──────────────────
  AGT001: agentMeta(
    "AGT001",
    M,
    "MCP server runs an unpinned package",
    "Pin the package spec to an exact version (`server@1.2.3`), so a new upstream release can't execute on this machine unreviewed.",
    [SCORECARD_PINNED],
  ),
  AGT002: agentMeta(
    "AGT002",
    M,
    "Literal credential in agent config",
    "Replace the value with an environment reference (`${TOKEN}`) and keep the secret in a secret store — agent config files sync, back up, and get shared.",
    [CWE_HARDCODED_CREDS],
  ),
  AGT003: agentMeta(
    "AGT003",
    M,
    "MCP server reached over cleartext HTTP",
    "Use an https:// endpoint. Tool arguments and results — including data the agent read locally — otherwise cross the network in the clear.",
    [CWE_CLEARTEXT],
  ),
  AGT004: agentMeta(
    "AGT004",
    M,
    "Remote skill or plugin is unpinned",
    "Pin the source to a tag or commit sha, so the instructions the agent follows can't change upstream without a local edit.",
    [SCORECARD_PINNED],
  ),
  AGT005: agentMeta(
    "AGT005",
    M,
    "Tool permission granted without constraint",
    "Scope the grant to the specific commands you run (`Bash(git status:*)`), and re-enable the confirmation prompt for dangerous operations.",
  ),
  AGT006: agentMeta(
    "AGT006",
    R,
    "User-scope config applies to every project",
    "Move project-specific instructions, MCP servers, and skills to that project's own config so they don't follow you into unrelated repos.",
  ),
  AGT007: agentMeta(
    "AGT007",
    R,
    "MCP server declared in multiple files",
    "Delete the shadowed declarations. The harness silently picks one, so the file you read may not be the one that decides what runs.",
  ),
  AGT008: agentMeta(
    "AGT008",
    R,
    "Instruction file exceeds the attention budget",
    "Move situational guidance into skills that load on demand, so the always-on instructions stay short enough to be followed reliably.",
  ),
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
