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
 * The catalog covers exactly the post-synth checks run by the audit across all
 * lexicons (CI: GHA/WGL/WFJ; IaC and manifests: WK8/WAW/AZR/WGC/WHM/DKRD/ARGO).
 * A drift-guard test asserts it stays in sync with the lexicons, and that every
 * entry has a `category`.
 */

export type Tier = "merge-worthy" | "report-only";

/** deterministic = safe auto-fix/diff; guidance = report text only (needs judgment). */
export type FixKind = "deterministic" | "guidance";

/**
 * What kind of finding this is — orthogonal to `tier` (fix confidence). Lets the
 * report say "N security, M best-practice, K correctness" instead of branding
 * everything "security." `security` = exposure/vuln/supply-chain; `correctness`
 * = a structural bug (broken reference, invalid schema, never-runs); everything
 * else is `best-practice` (hygiene/style/deprecation/reliability).
 */
export type Category = "security" | "correctness" | "best-practice";

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
  ARGO002: "correctness",
  ARGO003: "correctness",
  ARGO005: "best-practice",
  COR020: "correctness",
  EXT001: "correctness",
  GHA006: "correctness",
  GHA009: "correctness",
  GHA011: "correctness",
  GHA013: "security",
  GHA017: "security",
  GHA018: "security",
  GHA019: "correctness",
  GHA021: "security",
  GHA022: "best-practice",
  GHA023: "best-practice",
  GHA024: "best-practice",
  GHA025: "security",
  GHA026: "best-practice",
  GHA027: "best-practice",
  GHA028: "correctness",
  GHA029: "security",
  GHA030: "security",
  GHA031: "security",
  GHA032: "security",
  GHA033: "security",
  GHA034: "security",
  GHA035: "security",
  GHA036: "security",
  GHA037: "security",
  GHA038: "security",
  GHA039: "security",
  GHA040: "security",
  GHA041: "security",
  GHA042: "security",
  GHA043: "security",
  GHA044: "security",
  GHA045: "security",
  GHA046: "correctness",
  GHA047: "correctness",
  GHA048: "correctness",
  GHA049: "security",
  GHA050: "security",
  GHA051: "best-practice",
  GHA052: "security",
  GHA053: "security",
  GHA054: "security",
  GHA055: "best-practice",
  GHA056: "best-practice",
  GHA057: "security",
  GHA058: "best-practice",
  WFJ010: "correctness",
  WFJ011: "correctness",
  WGL010: "correctness",
  WGL011: "correctness",
  WGL012: "best-practice",
  WGL013: "correctness",
  WGL014: "correctness",
  WGL015: "correctness",
  WGL016: "security",
  WGL017: "security",
  WGL018: "best-practice",
  WGL019: "best-practice",
  WGL020: "correctness",
  WGL021: "best-practice",
  WGL022: "best-practice",
  WGL023: "best-practice",
  WGL024: "best-practice",
  WGL025: "best-practice",
  WGL026: "security",
  WGL027: "correctness",
  WGL028: "best-practice",
  WGL029: "security",
  WGL030: "security",
  WGL031: "security",
  WGL032: "security",
  WGL033: "security",
  WGL034: "security",
  WGL035: "security",
  WGL036: "security",
  WGL037: "security",
  WGL038: "security",
  WGL039: "security",
  WGL040: "security",
  WGL041: "correctness",
  WGL042: "best-practice",
  WGL043: "security",
  WGL044: "security",
  WGL045: "security",
  WGL046: "security",
  WGL047: "security",
  WGL048: "best-practice",
  WHM005: "best-practice",
  WHM101: "correctness",
  WHM102: "best-practice",
  WHM103: "correctness",
  WHM104: "best-practice",
  WHM105: "best-practice",
  WHM201: "best-practice",
  WHM202: "best-practice",
  WHM203: "best-practice",
  WHM204: "best-practice",
  WHM301: "best-practice",
  WHM302: "best-practice",
  WHM401: "security",
  WHM402: "security",
  WHM403: "security",
  WHM404: "security",
  WHM405: "best-practice",
  WHM406: "best-practice",
  WHM407: "security",
  WHM501: "best-practice",
  WHM502: "correctness",
  WK8005: "security",
  WK8006: "best-practice",
  WK8041: "security",
  WK8042: "security",
  WK8101: "correctness",
  WK8102: "best-practice",
  WK8103: "correctness",
  WK8104: "best-practice",
  WK8105: "best-practice",
  WK8201: "best-practice",
  WK8202: "security",
  WK8203: "security",
  WK8204: "security",
  WK8205: "security",
  WK8207: "security",
  WK8208: "security",
  WK8209: "security",
  WK8301: "best-practice",
  WK8302: "best-practice",
  WK8303: "best-practice",
  WK8304: "best-practice",
  WK8305: "correctness",
  WK8306: "correctness",
  WK8401: "correctness",
  WK8402: "best-practice",
  WK8403: "best-practice",
};

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
  GHA034: meta("GHA034", M, G, "Write permissions granted workflow-wide", "Move write scopes to the single job that needs them; keep the workflow least-privilege.", [SCORECARD_TOKEN, GH_TOKEN]),
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
  WGL029: meta("WGL029", M, G, "include/component resolved by a moving ref", "Pin `include:project`/component to a tag or commit SHA, not a branch.", [SCORECARD_PINNED]),
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

  // ── Kubernetes (WK8 / ARGO) ────────────────────────────────────────
  ARGO002: meta("ARGO002", M, G, "Argo Application references an undeclared AppProject", "Declare the named AppProject or reference an existing project."),
  ARGO003: meta("ARGO003", M, G, "Argo Application targets an unregistered cluster", "Point spec.destination at a registered cluster or the in-cluster target."),
  ARGO005: meta("ARGO005", R, G, "Argo source.path may not resolve", "Ensure the source path exists under the build root."),
  WK8005: meta("WK8005", M, G, "Hardcoded secret in env var", "Use a secretKeyRef instead of a literal value, and rotate the secret.", [K8S_SECRETS]),
  WK8006: meta("WK8006", M, G, "Image uses :latest or no tag", "Pin the image to an explicit version tag (ideally a digest).", [SCORECARD_PINNED]),
  WK8041: meta("WK8041", M, G, "Hardcoded API key in env var", "Move the key to a Secret and rotate it.", [K8S_SECRETS]),
  WK8042: meta("WK8042", M, G, "Private key stored in a ConfigMap", "Store private keys in a Secret, not a ConfigMap.", [K8S_SECRETS]),
  WK8101: meta("WK8101", M, G, "Deployment selector does not match template labels", "Align spec.selector with the pod template labels."),
  WK8102: meta("WK8102", R, G, "Resource missing metadata labels", "Add metadata labels for filtering and tooling."),
  WK8103: meta("WK8103", M, G, "Container missing name", "Add the required container `name`."),
  WK8104: meta("WK8104", R, G, "Container ports not named", "Name ports for clearer Service/NetworkPolicy config."),
  WK8105: meta("WK8105", R, G, "imagePullPolicy not explicit", "Set imagePullPolicy explicitly to avoid surprising defaults."),
  WK8201: meta("WK8201", R, G, "Container missing resource limits", "Set CPU and memory limits."),
  WK8202: meta("WK8202", M, G, "Privileged container", "Remove privileged: true; grant only the specific capabilities needed.", [K8S_PSS]),
  WK8203: meta("WK8203", M, G, "Root filesystem is writable", "Set readOnlyRootFilesystem: true.", [K8S_PSS]),
  WK8204: meta("WK8204", M, G, "Container may run as root", "Set runAsNonRoot: true (and a non-zero runAsUser).", [K8S_PSS]),
  WK8205: meta("WK8205", M, G, "Capabilities not dropped", "drop: [ALL] and add back only what is required.", [K8S_PSS]),
  WK8207: meta("WK8207", M, G, "Pod uses host network", "Remove hostNetwork; it bypasses network isolation.", [K8S_PSS]),
  WK8208: meta("WK8208", M, G, "Pod shares host PID namespace", "Remove hostPID.", [K8S_PSS]),
  WK8209: meta("WK8209", M, G, "Pod shares host IPC namespace", "Remove hostIPC.", [K8S_PSS]),
  WK8301: meta("WK8301", R, G, "Container missing probes", "Add liveness and readiness probes."),
  WK8302: meta("WK8302", R, G, "Deployment has a single replica", "Use replicas >= 2 for availability."),
  WK8303: meta("WK8303", R, G, "No PodDisruptionBudget for an HA Deployment", "Add a PDB to protect availability during disruptions."),
  WK8304: meta("WK8304", R, G, "SSL redirect without a certificate", "Provide a certificate and HTTPS listen-ports for the ssl-redirect annotation."),
  WK8305: meta("WK8305", M, G, "Ingress backend port does not match the Service", "Point the Ingress backend at a declared Service port."),
  WK8306: meta("WK8306", M, G, "Container command starts with a flag", "The first command element should be a binary, not a flag."),
  WK8401: meta("WK8401", M, G, "shmSize exceeds the container memory limit", "Lower shmSize or raise the memory limit so the pod can schedule."),
  WK8402: meta("WK8402", R, G, "RayCluster missing spec.rayVersion", "Set spec.rayVersion so KubeRay picks the right autoscaler image."),
  WK8403: meta("WK8403", R, G, "rayVersion does not match the head image tag", "Align spec.rayVersion with the Ray version in the head container image."),

  // ── CloudFormation cross-cutting (COR / EXT) ───────────────────────
  // The AWS-specific WAW* entries moved to the aws lexicon's auditCatalog();
  // the DKRD/AZR/WGC blocks moved to the docker/azure/gcp lexicons (#687).
  COR020: meta("COR020", M, G, "Circular resource dependency", "Break the dependency cycle between resources."),
  EXT001: meta("EXT001", M, G, "Extension constraint violation", "Fix the cross-property constraint flagged by the cfn-lint extension schema."),

  // ── Helm (WHM) ─────────────────────────────────────────────────────
  WHM005: meta("WHM005", R, G, "Sub-chart wrapper with no templates", "Deploy the upstream chart directly instead of an empty wrapper."),
  WHM101: meta("WHM101", M, G, "Chart.yaml missing required fields", "Set apiVersion (v2), name, and version in Chart.yaml."),
  WHM102: meta("WHM102", R, G, "Missing values.schema.json", "Add a values.schema.json to validate values."),
  WHM103: meta("WHM103", M, G, "Invalid Go template syntax", "Fix the unbalanced template braces."),
  WHM104: meta("WHM104", R, G, "Missing NOTES.txt", "Add templates/NOTES.txt for application charts."),
  WHM105: meta("WHM105", R, G, "Missing _helpers.tpl", "Add templates/_helpers.tpl."),
  WHM201: meta("WHM201", R, G, "Missing standard Helm labels", "Add the recommended app.kubernetes.io labels."),
  WHM202: meta("WHM202", R, G, "Hook weights undefined", "Define hook weights when multiple hooks exist."),
  WHM203: meta("WHM203", R, G, "Undocumented values", "Document values via schema or comments."),
  WHM204: meta("WHM204", R, G, "Dependencies pinned, not ranged", "Use semver ranges for chart dependencies."),
  WHM301: meta("WHM301", R, G, "No Helm test", "Add at least one Helm test for application charts."),
  WHM302: meta("WHM302", R, G, "Container resources not set", "Set limits/requests via values or defaults."),
  WHM401: meta("WHM401", M, G, "Container image uses :latest or no tag", "Pin the image to an explicit version tag.", [SCORECARD_PINNED]),
  WHM402: meta("WHM402", M, G, "Container may run as root", "Set runAsNonRoot in the security context.", [K8S_PSS]),
  WHM403: meta("WHM403", M, G, "Root filesystem writable", "Set readOnlyRootFilesystem.", [K8S_PSS]),
  WHM404: meta("WHM404", M, G, "Privileged container", "Remove privileged mode.", [K8S_PSS]),
  WHM405: meta("WHM405", R, G, "Resource specs missing cpu/memory", "Set cpu and memory in limits/requests."),
  WHM406: meta("WHM406", R, G, "CRDs in crds/ are never upgraded", "Manage CRD upgrades outside Helm or via a separate chart."),
  WHM407: meta("WHM407", M, G, "Inline Secret data", "Use ExternalSecret/SealedSecret instead of inline Secret data.", [K8S_SECRETS]),
  WHM501: meta("WHM501", R, G, "Unused values key", "Remove values defined but never referenced."),
  WHM502: meta("WHM502", M, G, "Deprecated/invalid Kubernetes API version", "Update to a supported apiVersion."),
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
  if (lexicons.length === 0) return catalog;
  // Lazy import so importing this module doesn't pull in the plugin/config graph
  // (matches ./core.ts's `load` — see #408).
  const { loadPlugins } = await import("../cli/plugins");
  let plugins: Array<{ auditCatalog?(): Record<string, RuleMeta> }>;
  try {
    plugins = await loadPlugins(lexicons);
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
