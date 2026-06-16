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
const K8S_PSS: Authority = {
  name: "Kubernetes — Pod Security Standards",
  url: "https://kubernetes.io/docs/concepts/security/pod-security-standards/",
};
const K8S_SECRETS: Authority = {
  name: "Kubernetes — Good practices for Secrets",
  url: "https://kubernetes.io/docs/concepts/security/secrets-good-practices/",
};
const DOCKER_SEC: Authority = {
  name: "Docker — Security best practices",
  url: "https://docs.docker.com/develop/security-best-practices/",
};
const AWS_SEC: Authority = {
  name: "AWS — Security Pillar (Well-Architected)",
  url: "https://docs.aws.amazon.com/wellarchitected/latest/security-pillar/welcome.html",
};
const AZ_SEC: Authority = {
  name: "Microsoft Cloud Security Benchmark",
  url: "https://learn.microsoft.com/en-us/security/benchmark/azure/",
};
const GCP_SEC: Authority = {
  name: "Google Cloud — Security best practices",
  url: "https://cloud.google.com/security/best-practices",
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

  // ── Docker (DKRD) ──────────────────────────────────────────────────
  DKRD001: meta("DKRD001", M, G, "Service uses :latest or untagged image", "Pin the image to an explicit version tag (ideally a digest).", [SCORECARD_PINNED]),
  DKRD002: meta("DKRD002", R, G, "Named volume declared but unused", "Remove the unused volume or mount it in a service."),
  DKRD003: meta("DKRD003", M, G, "Service exposes SSH (port 22)", "Don't expose SSH from a container; use exec/ephemeral access instead.", [DOCKER_SEC]),
  DKRD010: meta("DKRD010", R, G, "apt-get install without --no-install-recommends", "Add --no-install-recommends to keep images small."),
  DKRD011: meta("DKRD011", R, G, "ADD used where COPY would do", "Prefer COPY unless fetching a URL or extracting an archive."),
  DKRD012: meta("DKRD012", M, G, "No USER instruction — container runs as root", "Add a non-root USER instruction.", [DOCKER_SEC]),

  // ── AWS CloudFormation (WAW / COR / EXT) ───────────────────────────
  COR020: meta("COR020", M, G, "Circular resource dependency", "Break the dependency cycle between resources."),
  EXT001: meta("EXT001", M, G, "Extension constraint violation", "Fix the cross-property constraint flagged by the cfn-lint extension schema."),
  WAW010: meta("WAW010", R, G, "Redundant DependsOn", "Remove DependsOn already implied by a Ref/GetAtt."),
  WAW011: meta("WAW011", R, G, "Deprecated Lambda runtime", "Upgrade to a supported Lambda runtime."),
  WAW013: meta("WAW013", M, G, "Child stack exports nothing", "Add stackOutput() exports the parent can reference."),
  WAW014: meta("WAW014", R, G, "Nested stack outputs never referenced", "Reference the outputs or split into a separate build."),
  WAW015: meta("WAW015", M, G, "Circular dependency between nested stacks", "Break the cycle between nested stacks."),
  WAW016: meta("WAW016", R, G, "Deprecated property", "Replace the deprecated CloudFormation property."),
  WAW017: meta("WAW017", R, G, "Missing tags on a taggable resource", "Add tags for cost allocation and compliance."),
  WAW018: meta("WAW018", M, G, "S3 bucket missing public access block", "Add a PublicAccessBlockConfiguration blocking all public access.", [AWS_SEC]),
  WAW019: meta("WAW019", M, G, "Security group allows unrestricted ingress on a sensitive port", "Restrict the CIDR on SSH/RDP/database ports to known sources.", [AWS_SEC]),
  WAW020: meta("WAW020", M, G, "IAM policy uses a wildcard Action", "Scope the policy to specific actions (least privilege).", [AWS_SEC]),
  WAW021: meta("WAW021", M, G, "RDS storage not encrypted", "Enable StorageEncrypted for encryption at rest.", [AWS_SEC]),
  WAW022: meta("WAW022", R, G, "Lambda has no VpcConfig", "Consider a VpcConfig for network isolation if the function needs VPC resources."),
  WAW023: meta("WAW023", R, G, "CloudFront has no WAF web ACL", "Consider attaching a WAF web ACL."),
  WAW024: meta("WAW024", R, G, "ALB access logging disabled", "Enable access logging for audit trails."),
  WAW025: meta("WAW025", M, G, "SNS topic not encrypted", "Set KmsMasterKeyId for encryption at rest.", [AWS_SEC]),
  WAW026: meta("WAW026", M, G, "SQS queue not encrypted", "Enable SqsManagedSseEnabled or set KmsMasterKeyId.", [AWS_SEC]),
  WAW027: meta("WAW027", R, G, "DynamoDB point-in-time recovery disabled", "Enable PITR for recovery."),
  WAW028: meta("WAW028", M, G, "EBS volume not encrypted", "Enable encryption at rest.", [AWS_SEC]),
  WAW029: meta("WAW029", M, G, "Invalid DependsOn target", "Fix the dangling/self DependsOn reference."),
  WAW030: meta("WAW030", R, G, "Missing DependsOn for a known ordering pattern", "Add the DependsOn the pattern requires."),
  WAW031: meta("WAW031", R, G, "EKS Addon missing ServiceAccountRoleArn", "Set ServiceAccountRoleArn (IRSA) for addons that need it."),
  WAW032: meta("WAW032", M, G, "EFS transit encryption disabled on Fargate", "Enable transit encryption for the EFS volume.", [AWS_SEC]),
  WAW033: meta("WAW033", M, G, "Solr heap exceeds Fargate task memory", "Lower SOLR_HEAP or raise task memory."),
  WAW034: meta("WAW034", R, G, "Fargate Solr task under-provisioned", "Allocate >= 2048MB for the Solr task."),
  WAW035: meta("WAW035", R, G, "Solr container missing nofile ulimit", "Set a nofile ulimit >= 65535."),
  WAW036: meta("WAW036", M, G, "Non-ASCII characters in resource properties", "Remove non-ASCII characters rejected at changeset time."),
  WAW037: meta("WAW037", M, G, "Null values in resource properties", "Fix the invalid AttrRef producing null property values."),

  // ── Azure ARM (AZR) ────────────────────────────────────────────────
  AZR010: meta("AZR010", R, G, "Redundant dependsOn", "Remove dependsOn already implied by reference()/resourceId()."),
  AZR011: meta("AZR011", M, G, "Missing or invalid apiVersion", "Set a valid YYYY-MM-DD apiVersion on every resource."),
  AZR012: meta("AZR012", R, G, "Deprecated API version", "Move to a current apiVersion."),
  AZR013: meta("AZR013", M, G, "Resource missing location", "Add the required location property."),
  AZR014: meta("AZR014", M, G, "Storage account allows public blob access", "Set allowBlobPublicAccess to false.", [AZ_SEC]),
  AZR015: meta("AZR015", M, G, "Storage account missing encryption", "Enable encryption services for data at rest.", [AZ_SEC]),
  AZR016: meta("AZR016", R, G, "Key Vault soft-delete not enabled", "Enable soft-delete."),
  AZR017: meta("AZR017", R, G, "Key Vault purge protection not enabled", "Enable purge protection."),
  AZR018: meta("AZR018", R, G, "SQL Server missing auditing", "Enable auditing for compliance and threat detection."),
  AZR019: meta("AZR019", M, G, "SQL database missing TDE", "Enable Transparent Data Encryption.", [AZ_SEC]),
  AZR020: meta("AZR020", R, G, "App Service missing managed identity", "Enable a system- or user-assigned identity."),
  AZR021: meta("AZR021", M, G, "App Service not HTTPS-only", "Set httpsOnly to true.", [AZ_SEC]),
  AZR022: meta("AZR022", M, G, "App Service min TLS below 1.2", "Set minTlsVersion to 1.2+.", [AZ_SEC]),
  AZR023: meta("AZR023", R, G, "VM not using a managed disk", "Use a managed disk."),
  AZR024: meta("AZR024", R, G, "VM missing boot diagnostics", "Enable boot diagnostics."),
  AZR025: meta("AZR025", R, G, "AKS cluster missing RBAC", "Enable Kubernetes RBAC."),
  AZR026: meta("AZR026", R, G, "AKS cluster missing network policy", "Configure a networkPolicy."),
  AZR027: meta("AZR027", M, G, "Container Registry admin user enabled", "Disable the admin user; use Azure AD / service principals.", [AZ_SEC]),
  AZR028: meta("AZR028", R, G, "Network interface missing NSG", "Associate an NSG to control traffic."),
  AZR029: meta("AZR029", M, G, "Managed disk missing encryption", "Enable encryption for data at rest.", [AZ_SEC]),

  // ── GCP Config Connector (WGC) ─────────────────────────────────────
  WGC101: meta("WGC101", M, G, "Storage/SQL without encryption configuration", "Configure encryption (e.g. a CMEK key) for data at rest.", [GCP_SEC]),
  WGC102: meta("WGC102", M, G, "Public IAM member (allUsers/allAuthenticatedUsers)", "Remove allUsers/allAuthenticatedUsers bindings.", [GCP_SEC]),
  WGC103: meta("WGC103", R, G, "Missing project-id annotation", "Add the cnrm.cloud.google.com/project-id annotation."),
  WGC104: meta("WGC104", M, G, "Bucket without uniform bucket-level access", "Enable uniformBucketLevelAccess.", [GCP_SEC]),
  WGC105: meta("WGC105", M, G, "Cloud SQL open to 0.0.0.0/0", "Restrict authorizedNetworks to known sources.", [GCP_SEC]),
  WGC106: meta("WGC106", R, G, "Missing deletion-policy annotation", "Add the cnrm.cloud.google.com/deletion-policy annotation."),
  WGC107: meta("WGC107", R, G, "Bucket versioning disabled", "Enable object versioning."),
  WGC108: meta("WGC108", R, G, "Cloud SQL backups disabled", "Enable backup configuration."),
  WGC109: meta("WGC109", M, G, "Firewall open to 0.0.0.0/0", "Restrict sourceRanges to known sources.", [GCP_SEC]),
  WGC110: meta("WGC110", M, G, "KMS key without rotation", "Set a rotationPeriod on the CryptoKey.", [GCP_SEC]),
  WGC111: meta("WGC111", M, G, "Reference to an undefined resource", "Point the reference at a resource in the output."),
  WGC112: meta("WGC112", M, G, "Missing or invalid apiVersion", "Set a valid cnrm.cloud.google.com apiVersion."),
  WGC113: meta("WGC113", R, G, "Alpha API version", "Move to a beta/GA API version."),
  WGC201: meta("WGC201", R, G, "Missing managed-by label", "Add the app.kubernetes.io/managed-by label."),
  WGC202: meta("WGC202", M, G, "Cluster without Workload Identity", "Enable Workload Identity on the ContainerCluster.", [GCP_SEC]),
  WGC203: meta("WGC203", M, G, "Node pool uses broad cloud-platform scope", "Use narrowly-scoped OAuth scopes instead of cloud-platform.", [GCP_SEC]),
  WGC204: meta("WGC204", R, G, "Compute instance without Shielded VM", "Enable Shielded VM configuration."),
  WGC301: meta("WGC301", R, G, "No IAMAuditConfig found", "Configure audit logging via IAMAuditConfig."),
  WGC302: meta("WGC302", R, G, "No Service (enabled APIs) found", "Declare the GCP APIs you depend on."),
  WGC303: meta("WGC303", R, G, "No VPC Service Controls perimeter", "Consider an AccessContextManager ServicePerimeter."),
  WGC401: meta("WGC401", M, G, "Unknown field in resource spec", "Remove the unknown spec field."),
  WGC402: meta("WGC402", M, G, "Missing required spec field", "Add the required spec field."),
  WGC403: meta("WGC403", M, G, "Spec field has wrong type/structure", "Fix the field's type/structure."),

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
