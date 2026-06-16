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
 * The catalog covers exactly the post-synth checks run by the audit (github
 * GHA*, gitlab WGL*, forgejo WFJ*). A drift-guard test asserts it stays in
 * sync with the lexicons.
 */

export type Tier = "merge-worthy" | "report-only";

/** deterministic = safe auto-fix/diff; guidance = report text only (needs judgment). */
export type FixKind = "deterministic" | "guidance";

export interface Authority {
  name: string;
  url: string;
}

export interface RuleMeta {
  id: string;
  tier: Tier;
  fixKind: FixKind;
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
const SCORECARD_TOKEN: Authority = {
  name: "OSSF Scorecard — Token-Permissions",
  url: "https://github.com/ossf/scorecard/blob/main/docs/checks.md#token-permissions",
};
const GH_TOKEN: Authority = {
  name: "GitHub — Automatic token authentication",
  url: "https://docs.github.com/en/actions/security-for-github-actions/security-guides/automatic-token-authentication",
};
const SCORECARD_PINNED: Authority = {
  name: "OSSF Scorecard — Pinned-Dependencies",
  url: "https://github.com/ossf/scorecard/blob/main/docs/checks.md#pinned-dependencies",
};
const GH_THIRD_PARTY: Authority = {
  name: "GitHub — Using third-party actions",
  url: "https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions#using-third-party-actions",
};
const GH_INJECTION: Authority = {
  name: "GitHub — Understanding the risk of script injections",
  url: "https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions#understanding-the-risk-of-script-injections",
};
const GH_PWN: Authority = {
  name: "GitHub Security Lab — Preventing pwn requests",
  url: "https://securitylab.github.com/resources/github-actions-preventing-pwn-requests/",
};
const GH_SECRETS: Authority = {
  name: "GitHub — Using secrets in GitHub Actions",
  url: "https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions",
};
const GH_OIDC: Authority = {
  name: "GitHub — Security hardening with OpenID Connect",
  url: "https://docs.github.com/en/actions/concepts/security/openid-connect",
};

function meta(
  id: string,
  tier: Tier,
  fixKind: FixKind,
  title: string,
  remediation: string,
  authority?: Authority[],
): RuleMeta {
  return { id, tier, fixKind, title, remediation, authority, yamlBased: true };
}

const M = "merge-worthy" as const;
const R = "report-only" as const;
const D = "deterministic" as const;
const G = "guidance" as const;

/** Every audited post-synth check, keyed by id. */
export const RULE_CATALOG: Record<string, RuleMeta> = {
  // ── GitHub Actions (GHA) ───────────────────────────────────────────
  GHA006: meta("GHA006", R, G, "Duplicate workflow name", "Give each workflow a unique `name:`."),
  GHA009: meta("GHA009", M, G, "Empty matrix dimension", "Remove the empty matrix axis or give it values; an empty axis produces zero jobs."),
  GHA011: meta("GHA011", M, G, "needs references a non-existent job", "Fix the `needs:` target to name a real job."),
  GHA013: meta("GHA013", M, G, "Missing job permissions on a sensitive trigger", "Add an explicit least-privilege `permissions:` block to jobs under `pull_request_target`/`workflow_dispatch`.", [SCORECARD_TOKEN, GH_TOKEN]),
  GHA017: meta("GHA017", M, D, "No explicit permissions block", "Add a top-level `permissions: { contents: read }` and widen only where a job needs it.", [SCORECARD_TOKEN, GH_TOKEN]),
  GHA018: meta("GHA018", M, G, "pull_request_target checks out untrusted code", "Don't check out / run PR head code under `pull_request_target`; split into a privileged + unprivileged workflow.", [GH_PWN]),
  GHA019: meta("GHA019", M, G, "Circular needs chain", "Break the cycle in the job dependency graph."),
  GHA021: meta("GHA021", M, D, "actions/checkout not pinned to a SHA", "Pin `actions/checkout` to a full 40-char commit SHA.", [SCORECARD_PINNED, GH_THIRD_PARTY]),
  GHA022: meta("GHA022", R, G, "Job without timeout-minutes", "Add `timeout-minutes:` to bound runaway jobs."),
  GHA023: meta("GHA023", R, G, "Deprecated ::set-output", "Replace `::set-output` with `$GITHUB_OUTPUT`."),
  GHA024: meta("GHA024", R, G, "Missing concurrency block", "Add a `concurrency:` group to deploy workflows."),
  GHA025: meta("GHA025", M, G, "Unrestricted pull_request_target", "Gate `pull_request_target` jobs and avoid running untrusted code with elevated scope.", [GH_PWN]),
  GHA026: meta("GHA026", R, G, "Secret used without environment protection", "Move secret-consuming jobs behind a protected `environment:`."),
  GHA027: meta("GHA027", R, G, "Cleanup step without if: always()", "Add `if: always()` to cleanup steps."),
  GHA028: meta("GHA028", M, G, "Workflow with no triggers", "Add an `on:` trigger; the workflow never runs without one."),
  GHA029: meta("GHA029", M, D, "Action not pinned to a commit SHA", "Pin the action to a full commit SHA instead of a tag/branch.", [SCORECARD_PINNED, GH_THIRD_PARTY]),
  GHA030: meta("GHA030", M, D, "Container image not pinned to a digest", "Pin the image to an immutable `@sha256:` digest.", [SCORECARD_PINNED]),
  GHA031: meta("GHA031", M, G, "Possible action impersonation", "Verify the action owner/slug; it resembles a well-known action.", [SCORECARD_PINNED]),
  GHA032: meta("GHA032", M, G, "Archived/abandoned or vulnerable action", "Replace the archived action or one with a disclosed security issue."),
  GHA033: meta("GHA033", M, D, "Blanket write-all permissions", "Replace `write-all` with the specific scopes the jobs need (default `contents: read`).", [SCORECARD_TOKEN, GH_TOKEN]),
  GHA034: meta("GHA034", M, D, "Write permissions granted workflow-wide", "Move write scopes to the single job that needs them; keep the workflow least-privilege.", [SCORECARD_TOKEN, GH_TOKEN]),
  GHA035: meta("GHA035", M, G, "Elevated token on an untrusted-code trigger", "Drop the elevated `permissions:` on triggers that can run untrusted code.", [GH_PWN, SCORECARD_TOKEN]),
  GHA036: meta("GHA036", M, G, "Untrusted input interpolated into run:", "Pass untrusted `${{ }}` values via an `env:` var and reference `\"$VAR\"`, never inline in the script.", [GH_INJECTION]),
  GHA037: meta("GHA037", M, G, "Untrusted input written to GITHUB_ENV/GITHUB_PATH", "Don't write untrusted input to `$GITHUB_ENV`/`$GITHUB_PATH`; sanitize or avoid.", [GH_INJECTION]),
  GHA038: meta("GHA038", M, G, "workflow_run checks out untrusted code in a privileged context", "Avoid checking out untrusted code under `workflow_run`; treat it as privileged.", [GH_PWN]),
  GHA039: meta("GHA039", M, G, "Auth gate on a spoofable author field", "Gate on a non-spoofable identity, not a commit-author field.", [GH_PWN]),
  GHA040: meta("GHA040", M, G, "Self-hosted runner on an untrusted-code trigger", "Don't run untrusted-code triggers on self-hosted runners.", [GH_PWN]),
  GHA041: meta("GHA041", M, G, "Blanket secrets: inherit", "Pass only the specific secrets the reusable workflow needs.", [GH_SECRETS]),
  GHA042: meta("GHA042", M, G, "Entire secrets context passed", "Pass named secrets instead of the whole `secrets` context.", [GH_SECRETS]),
  GHA043: meta("GHA043", M, G, "Secret consumed without an environment gate", "Put secret-consuming jobs behind a protected environment.", [GH_SECRETS]),
  GHA044: meta("GHA044", M, G, "Hardcoded registry/container credential", "Remove the hardcoded credential, move it to a secret, and rotate it (responsible disclosure first).", [GH_SECRETS]),
  GHA045: meta("GHA045", M, G, "Secret interpolated into run:", "Reference secrets via `env:`, not inline in the shell command.", [GH_INJECTION, GH_SECRETS]),
  GHA046: meta("GHA046", M, G, "Constant/unsound guard condition", "Fix the always-true/false `if:` — it may neutralize a security gate."),
  GHA047: meta("GHA047", M, G, "Ineffective contains() guard (reversed args)", "Swap the `contains()` arguments so the guard actually filters."),
  GHA048: meta("GHA048", M, G, "Obfuscated guard condition", "Simplify the indirect `if:` so its effect is reviewable."),
  GHA049: meta("GHA049", M, G, "Persisted checkout credentials reachable by an artifact", "Use `persist-credentials: false` or exclude `.git` from uploaded artifacts.", [GH_SECRETS]),
  GHA050: meta("GHA050", M, G, "Cache populated in a privileged context", "Don't populate caches from untrusted code paths (poisoning risk).", [GH_PWN]),
  GHA051: meta("GHA051", R, G, "Long-lived token instead of OIDC", "Migrate publish/release to OIDC short-lived credentials."),
  GHA052: meta("GHA052", M, G, "Software piped to a shell without verification", "Verify a checksum/signature before executing fetched scripts.", [SCORECARD_PINNED]),
  GHA053: meta("GHA053", M, G, "Re-enables unsafe set-env/add-path", "Remove `ACTIONS_ALLOW_UNSECURE_COMMANDS`; use `$GITHUB_ENV`/`$GITHUB_PATH`.", [GH_INJECTION]),
  GHA054: meta("GHA054", M, G, "Feature with a known security footgun", "Replace the flagged feature with the safe alternative."),
  GHA055: meta("GHA055", R, G, "Runtime install of a tool already on the runner", "Drop the redundant install to save time."),
  GHA056: meta("GHA056", R, G, "Workflow without a name", "Add a `name:` to the workflow."),
  GHA057: meta("GHA057", M, G, "Dependency update can execute untrusted code", "Disable the option that lets dependency updates run external code.", [GH_PWN]),
  GHA058: meta("GHA058", R, G, "Dependency update has no cooldown window", "Add a cooldown so new releases aren't merged instantly."),

  // ── GitLab CI (WGL) ────────────────────────────────────────────────
  WGL010: meta("WGL010", M, G, "Job references an undefined stage", "Add the stage to `stages:` or fix the job's `stage:`."),
  WGL011: meta("WGL011", M, G, "Job rules always evaluate to never", "Fix the `rules:` so the job can run; it is currently unreachable."),
  WGL012: meta("WGL012", R, G, "Deprecated property", "Replace the deprecated GitLab CI property."),
  WGL013: meta("WGL013", M, G, "Invalid needs target", "Fix the dangling/self `needs:` reference."),
  WGL014: meta("WGL014", M, G, "Invalid extends target", "Point `extends:` at a template that exists in the pipeline."),
  WGL015: meta("WGL015", M, G, "Circular needs chain", "Break the cycle in the job dependency graph."),
  WGL016: meta("WGL016", M, G, "Hardcoded secret in variables", "Move the secret out of `variables:` into a masked/protected CI variable and rotate it.", [GH_SECRETS]),
  WGL017: meta("WGL017", M, G, "Insecure (non-HTTPS) registry", "Use an HTTPS registry endpoint."),
  WGL018: meta("WGL018", R, G, "Missing job timeout", "Add a `timeout:` to bound long-running jobs."),
  WGL019: meta("WGL019", R, G, "Missing retry on deploy job", "Add a `retry:` strategy to deploy jobs."),
  WGL020: meta("WGL020", M, G, "Duplicate job names", "Rename so each job resolves to a unique name."),
  WGL021: meta("WGL021", R, G, "Unused global variable", "Remove the unused global `variables:` entry."),
  WGL022: meta("WGL022", R, G, "Missing artifacts expiry", "Add `expire_in:` to artifacts to avoid disk bloat."),
  WGL023: meta("WGL023", R, G, "Overly broad rules (when: always)", "Add real conditions to the job's `rules:`."),
  WGL024: meta("WGL024", R, G, "Manual job without allow_failure", "Add `allow_failure: true` so a manual job doesn't block the pipeline."),
  WGL025: meta("WGL025", R, G, "Cache without a key", "Add a `cache.key` to avoid cross-job cache collisions."),
  WGL026: meta("WGL026", M, G, "Privileged DinD service without TLS", "Set `DOCKER_TLS_CERTDIR` for privileged Docker-in-Docker services."),
  WGL027: meta("WGL027", M, G, "Empty script", "Give the job a non-empty `script:`; it currently does nothing."),
  WGL028: meta("WGL028", R, G, "Redundant needs", "Drop `needs:` already implied by stage ordering."),
  WGL029: meta("WGL029", M, D, "include/component resolved by a moving ref", "Pin `include:project`/component to a tag or commit SHA, not a branch.", [SCORECARD_PINNED]),
  WGL030: meta("WGL030", M, G, "Insecure or mutable include:remote", "Use HTTPS and pin the remote include to an immutable ref.", [SCORECARD_PINNED]),
  WGL031: meta("WGL031", M, D, "Container image not pinned to a digest", "Pin the image to an immutable `@sha256:` digest.", [SCORECARD_PINNED]),
  WGL032: meta("WGL032", M, G, "Possible include/component impersonation", "Verify the include source; it resembles a well-known project.", [SCORECARD_PINNED]),
  WGL033: meta("WGL033", M, G, "OIDC id_token without a scoped audience", "Set a specific `aud:` on the OIDC id_token.", [GH_OIDC]),
  WGL034: meta("WGL034", M, G, "OIDC id_token mintable from a merge-request pipeline", "Restrict OIDC token minting to protected pipelines.", [GH_OIDC, GH_PWN]),
  WGL035: meta("WGL035", M, G, "Untrusted CI variable interpolated into a script", "Pass untrusted variables via the environment and quote them; don't inline.", [GH_INJECTION]),
  WGL036: meta("WGL036", M, G, "Privileged service reachable from merge-request pipelines", "Block privileged/DinD services on merge-request pipelines.", [GH_PWN]),
  WGL037: meta("WGL037", M, G, "Security gate on an untrusted ref regex", "Don't gate security decisions on a regex over an untrusted ref variable.", [GH_PWN]),
  WGL038: meta("WGL038", M, G, "Secret reachable from a merge-request pipeline", "Scope secret-like variables to protected branches/pipelines.", [GH_SECRETS, GH_PWN]),
  WGL039: meta("WGL039", M, G, "Secret printed to job logs", "Stop echoing the secret-like variable; mask it.", [GH_SECRETS]),
  WGL040: meta("WGL040", M, G, "Hardcoded credential in a registry login", "Move the credential to a masked CI variable and rotate it.", [GH_SECRETS]),
  WGL041: meta("WGL041", M, G, "Tautological rules:if condition", "Fix the always-true `rules:if`; it may neutralize a gate."),
  WGL042: meta("WGL042", R, G, "Unreachable rules after an unconditional match", "Remove the dead `rules:` entries after the catch-all."),
  WGL043: meta("WGL043", M, G, "Match-anything regex gate in rules:if", "Tighten the regex; a match-anything gate is no gate.", [GH_PWN]),
  WGL044: meta("WGL044", M, G, "Public artifacts expose build output", "Mark sensitive artifacts non-public (`public: false`)."),
  WGL045: meta("WGL045", M, G, "Artifact path may capture a credential file", "Narrow the artifact path so it can't capture credential files.", [GH_SECRETS]),
  WGL046: meta("WGL046", M, G, "Cache populated in a merge-request pipeline", "Don't populate caches from merge-request pipelines (poisoning risk).", [GH_PWN]),
  WGL047: meta("WGL047", M, G, "Software piped to a shell without verification", "Verify a checksum/signature before executing fetched scripts.", [SCORECARD_PINNED]),
  WGL048: meta("WGL048", R, G, "Pipeline without workflow:name", "Add a `workflow:name` for clearer pipeline naming."),

  // ── Forgejo (WFJ) ──────────────────────────────────────────────────
  WFJ010: meta("WFJ010", M, G, "Unresolved action reference on Forgejo", "Use an action reference Forgejo can resolve (full URL or a mirrored action)."),
  WFJ011: meta("WFJ011", M, G, "GitHub-hosted runner label with no Forgejo equivalent", "Use a runner label your Forgejo instance provides."),
};

/** Look up catalog metadata for a check id, if known. */
export function ruleMeta(id: string): RuleMeta | undefined {
  return RULE_CATALOG[id];
}
