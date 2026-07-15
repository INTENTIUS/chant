import type { Serializer } from "./serializer";
import type { LintRule } from "./lint/rule";
import type { RuleSpec } from "./lint/declarative";
import type { PostSynthCheck } from "./lint/post-synth";
import type { TemplateParser, TemplateIR } from "./import/parser";
import type { TypeScriptGenerator } from "./import/generator";
import type { ArtifactIntegrity } from "./lexicon-integrity";
import type { CompletionContext, CompletionItem, HoverContext, HoverInfo, CodeActionContext, CodeAction } from "./lsp/types";
import type { McpToolContribution, McpResourceContribution } from "./mcp/types";
import type { DriverComponent } from "./components/driver";
import type { EmulatorCapability } from "./op/emulator-lifecycle";
import type { RuleMeta } from "./audit/catalog";
import type { ReferenceCatalog } from "./graph-refs";

// Re-exported so lexicons can author a reference catalog (#778) from the same
// `@intentius/chant/lexicon` entry they import the plugin contract from.
export type { ReferenceCatalog, IdentityRule, RefRule } from "./graph-refs";

/**
 * Manifest for a packaged lexicon — metadata embedded in the tarball.
 */
export interface LexiconManifest {
  name: string;
  version: string;
  chantVersion?: string;
  namespace?: string;
  intrinsics?: IntrinsicDef[];
  pseudoParameters?: Record<string, string>;
}

/**
 * Metadata about when and how a package was generated.
 */
export interface PackageMetadata {
  generatedAt: string;
  chantVersion: string;
  generatorVersion: string;
  sourceSchemaCount: number;
}

/**
 * Container for all artifacts in a lexicon bundle.
 */
export interface BundleSpec {
  manifest: LexiconManifest;
  registry: string;
  typesDTS: string;
  rules: Map<string, string>;
  skills: Map<string, string>;
  integrity?: ArtifactIntegrity;
  metadata?: PackageMetadata;
}

/**
 * Trigger that determines when a skill should be suggested.
 */
export interface SkillTrigger {
  type: "command" | "file-pattern" | "context";
  value: string;
}

/**
 * Parameter definition for a skill.
 */
export interface SkillParameter {
  name: string;
  description: string;
  type: string;
  required?: boolean;
  default?: string;
}

/**
 * Example showing how a skill is used.
 */
export interface SkillExample {
  title: string;
  description?: string;
  input?: string;
  output?: string;
}

/**
 * Definition of a skill provided by a lexicon plugin.
 * Content is full markdown with optional YAML frontmatter.
 */
export interface SkillDefinition {
  readonly name: string;
  readonly description: string;
  readonly content: string;
  readonly triggers?: SkillTrigger[];
  readonly parameters?: SkillParameter[];
  readonly examples?: SkillExample[];
  readonly preConditions?: string[];
  readonly postConditions?: string[];
}

/**
 * Definition of a lexicon-specific intrinsic function
 */
export interface IntrinsicDef {
  readonly name: string;
  readonly description?: string;
  readonly outputKey?: string;
  readonly isTag?: boolean;
}

/**
 * Options passed to a MigrationSource by `chant migrate`.
 */
export interface MigrateOptions {
  /** Output format. */
  emit?: "yaml" | "ts";
  /** Recognise composite patterns when emitting. */
  useComposites?: boolean;
  /** Source file path (for provenance display only). */
  sourceFile?: string;
  /** Escalate needs-review diagnostics to errors. */
  strict?: boolean;
  /** Run security-aware migration analysis (classify property fates + run
   * target security checks). Enabled by `chant migrate --validate`. */
  security?: boolean;
}

/**
 * Result of `MigrationSource.transform()`.
 *
 * Provenance is a generic side channel: each record is `{ sourceKey, rule,
 * category, note?, ... }`. Diagnostics are SARIF-compatible records derived
 * from provenance (concrete shape lives in `packages/core/src/lint/rule.ts`).
 */
export interface MigrationResult {
  /** Rendered output (YAML by default, TS when emit: "ts"). */
  output: string;
  /** Per-key provenance records (typed loosely at the core level). */
  provenance: Array<Record<string, unknown>>;
  /** SARIF-shaped diagnostics. */
  diagnostics: Array<Record<string, unknown>>;
  /** Markdown "Security posture" section, when security analysis ran (#306). */
  securityPosture?: string;
}

/**
 * Edge that translates one lexicon's source format into this lexicon's IR
 * and output. Exposed via `LexiconPlugin.migrationSource(from)`.
 */
export interface MigrationSource {
  /** Lightweight detector: does this content look like the expected source? */
  detect(content: string): boolean;
  /** Run the translation. */
  transform(content: string, opts: MigrateOptions): Promise<MigrationResult>;
}

/**
 * Structured init template output from a lexicon plugin.
 */
export interface InitTemplateSet {
  /** Source files written to src/ */
  src: Record<string, string>;
  /** Application scaffold files written to project root */
  root?: Record<string, string>;
  /** Scripts merged into generated package.json */
  scripts?: Record<string, string>;
}

/**
 * Plugin interface for lexicon packages.
 *
 * Required lifecycle methods enforce consistency: every lexicon must support
 * generate, validate, coverage, and package operations.
 */
/**
 * Where a lexicon pins an upstream schema/spec version, and where to look for a
 * newer one — the lexicon's own declaration for the self-upgrade tooling
 * (`chant dev pinned-upgrade`), so core never hard-codes per-lexicon upstream
 * repos or version-constant locations. See ./codegen/pinned-upgrade.ts.
 */
export interface UpstreamPin {
  /** Source file (relative to the lexicon package root) holding the pinned version constant. */
  readonly file: string;
  /** Regex whose first capture group is the current pinned version in `file`. */
  readonly pattern: RegExp;
  /** Rebuild a line that matched `pattern`, substituting the new version. */
  replace(newVersion: string, line: string): string;
  /** Where to query for the latest stable upstream tag. */
  readonly upstream: {
    readonly owner: string;
    readonly repo: string;
    /** `releases` = published releases; `tags` = every git tag. */
    readonly kind: "releases" | "tags";
    /** Only consider tags ending with this suffix (e.g. "-ee" for GitLab). */
    readonly tagSuffix?: string;
  };
}

/** One CI job in a generated pipeline (generate mode) — a thin trigger for one component in one wave. */
export interface ComponentPipelineJob {
  /** CI job name (safe as a YAML key). */
  jobName: string;
  /** The component this job triggers. */
  component: string;
  /** The stage/wave this job runs in. */
  stage: string;
  /** Direct dependency job names this job waits on (mirrors the component's `dependsOn`). */
  needs: string[];
}

/** Generic knobs for generate mode, applied once across every generated job (never per component). */
export interface ComponentPipelineOptions {
  /** Target environment threaded into the trigger command. */
  env?: string;
  /** The trigger command per component, argv with `{name}` substituted. */
  runCommand?: string[];
  /** Extra script lines appended to every job. */
  extraScript?: string[];
  /** Script lines run before the trigger command in every job. */
  beforeScript?: string[];
  /** Container image every job runs in. */
  image?: string;
  /** Top-level CI `variables:` block. */
  variables?: Record<string, string>;
}

/** The synthesized CI pipeline for a component graph (generate mode). */
export interface ComponentPipelineResult {
  /** The synthesized CI YAML (e.g. `.gitlab-ci.yml` content). */
  yaml: string;
  /** Wave-ordered stage names (matches the driver's graph waves 1:1). */
  stages: string[];
  /** Every generated job, in emit order. */
  jobs: ComponentPipelineJob[];
}

export interface LexiconPlugin {
  // ── Required ──────────────────────────────────────────────
  /** Human-readable name (e.g. "aws", "gcp") */
  readonly name: string;

  /** Serializer for build output */
  readonly serializer: Serializer;

  /** Generate lexicon artifacts (types, lexicon JSON, runtime) from spec */
  generate(options?: { verbose?: boolean }): Promise<void>;

  /** Validate generated lexicon artifacts */
  validate(options?: { verbose?: boolean }): Promise<void>;

  /** Analyze lexicon coverage across resource dimensions */
  coverage(options?: { verbose?: boolean; minOverall?: number }): Promise<void>;

  /** Package lexicon into distributable tarball */
  package(options?: { verbose?: boolean; force?: boolean }): Promise<void>;

  /** Local emulator (#920), if this lexicon has one (Floci for aws, floci-az/gcp,
   * mudflaps/spritzer for fly). Drives `chant emulator up|down|status` and lets a
   * consumer (behold `--local`) boot it + point apply/observe at it — no cloud
   * account. Absent when the lexicon has no local emulator. */
  readonly emulator?: EmulatorCapability;

  // ── Optional extensions ───────────────────────────────────
  /** Return lint rules provided by this lexicon */
  lintRules?(): LintRule[];

  /** Return declarative rule specs for compilation via rule() */
  declarativeRules?(): RuleSpec[];

  /** Return post-synthesis checks for build validation */
  postSynthChecks?(): PostSynthCheck[];

  /**
   * Audit catalog metadata (title/tier/fix/authority/category) for this
   * lexicon's `postSynthChecks`, keyed by check id — the per-provider half of
   * `chant audit`'s rule catalog (#687, epic #350). Core aggregates these over
   * its static catalog via `resolveAuditCatalog` (./audit/catalog.ts). Omit
   * for lexicons whose rule metadata still lives in core's static catalog.
   */
  auditCatalog?(): Record<string, RuleMeta>;

  /** Return intrinsic function definitions */
  intrinsics?(): IntrinsicDef[];

  /** Return pseudo-parameter names (e.g. "MyDomain::StackName") */
  pseudoParameters?(): string[];

  /**
   * Detect whether raw template content belongs to this lexicon.
   * @param data - Parsed JSON object from a template file
   * @returns true if this plugin can handle the template
   */
  detectTemplate?(data: unknown): boolean;

  /** Return a parser for importing external templates into IR */
  templateParser?(): TemplateParser;

  /** Return a generator for converting IR to TypeScript */
  templateGenerator?(): TypeScriptGenerator;

  /** Return skills provided by this lexicon */
  skills?(): SkillDefinition[];

  /** Return source file templates for `chant init` project scaffolding */
  initTemplates?(template?: string): InitTemplateSet;

  /** Optional initialization hook */
  init?(): void | Promise<void>;

  /** How this lexicon pins its upstream schema version + where to check for a newer one (self-upgrade tooling — see ./codegen/pinned-upgrade.ts). Omit for lexicons with no pinned upstream. */
  readonly upstreamPin?: UpstreamPin;

  /**
   * Generate a CI pipeline from the discovered component graph — the
   * `chant build --components --generate <name>` seam. Only CI-provider
   * lexicons (gitlab, github, forgejo) implement this; core owns the generic
   * driver (discovery + graph waves) and dispatches here. Omit for lexicons
   * that are not CI providers.
   */
  generateComponentPipeline?(
    components: DriverComponent[],
    options?: ComponentPipelineOptions,
  ): ComponentPipelineResult;

  // LSP
  /** Provide completions for LSP */
  completionProvider?(ctx: CompletionContext): CompletionItem[];

  /** Provide hover information for LSP */
  hoverProvider?(ctx: HoverContext): HoverInfo | undefined;

  /** Provide code actions for LSP */
  codeActionProvider?(ctx: CodeActionContext): CodeAction[];

  // Docs
  /** Generate documentation pages */
  docs?(options?: { verbose?: boolean }): Promise<void>;

  // MCP
  /** Return MCP tool contributions */
  mcpTools?(): McpToolContribution[];

  /** Return MCP resource contributions */
  mcpResources?(): McpResourceContribution[];

  // Migration
  /**
   * Return a migration source for translating from another lexicon's
   * format into this lexicon. Returns undefined if `from` is not supported.
   *
   * Example: the gitlab lexicon implements `migrationSource("github")` to
   * translate `.github/workflows/*.yml` into `.gitlab-ci.yml`.
   */
  migrationSource?(from: string): MigrationSource | undefined;

  // State
  /**
   * Query deployed resources and return API metadata. Opt-in.
   *
   * Use this when each chant entity has a 1:1 cloud equivalent — e.g. an
   * AWS CFN resource, a K8s object, an ARM resource, a Temporal namespace.
   *
   * `entities` carries the chant-side entity declarations for this lexicon,
   * keyed by chant entity name (e.g. the export name from a `*.ts` file).
   * Implementations that need to map cloud-side names back to chant entity
   * names (e.g. Temporal — server-side namespace `prod` ↔ chant entity `ns`
   * declared with `name: "prod"`) read this; implementations that already
   * have name parity (e.g. AWS CloudFormation logical IDs == chant entity
   * names) can ignore it.
   *
   * `entityNames` is preserved as a convenience for the simple case.
   */
  describeResources?(options: {
    environment: string;
    buildOutput: string;
    entityNames: string[];
    entities: Map<string, { entityType: string; props: Record<string, unknown> }>;
    /**
     * Restrict the result to chant-owned resources (those carrying the
     * ownership marker, #119). Where a lexicon has no durable marker channel,
     * it must log that ownership is unavailable rather than silently returning
     * everything.
     */
    owned?: boolean;
  }): Promise<Record<string, ResourceMetadata>>;

  /**
   * Reference catalog for live edge reconstruction (#778). Declares how this
   * lexicon's observed resources reference each other — an identity map (which
   * attrs identify each kind) plus reference rules (which attr paths point at
   * other resources, as a peer edge or containment). Consumed by
   * `chant graph --live` to turn a bag of live nodes into a graph. Data, not a
   * method. Opt-in.
   */
  referenceCatalog?: ReferenceCatalog;

  /**
   * Enrich live IR node attributes for edge reconstruction (#784). Returns
   * `nodeId → attributes` with cross-resource references resolved to the
   * referenced node id, so the reference resolver ({@link referenceCatalog}) can
   * match them. Opt-in — for lexicons whose `describeResources` metadata is too
   * thin to carry references (e.g. AWS CloudFormation, where it's sourced from
   * the fuller `exportResources` config).
   */
  enrichLiveAttrs?(options: { environment: string; owned?: boolean }): Promise<Record<string, Record<string, unknown>>>;

  /**
   * List runtime artifacts in the given environment. Opt-in.
   *
   * Use this for lexicons whose chant entities describe *authoring*
   * primitives rather than 1:1 cloud resources — e.g. Helm (charts vs
   * releases), Docker (Compose vs running containers). The contract is
   * context-keyed: given an environment, list all artifacts visible there.
   * There is no `declared` comparison axis — `state diff --live` reports
   * added/removed/changed between snapshots, not vs. declared.
   *
   * `entities` is passed for cases where the lexicon needs to know what
   * was declared in order to scope its enumeration (e.g. a per-tenant
   * runtime where the declared entities name which tenants to query).
   */
  listArtifacts?(options: {
    environment: string;
    entities: Map<string, { entityType: string; props: Record<string, unknown> }>;
  }): Promise<Record<string, ArtifactMetadata>>;

  // Live export (cloud → code)
  /**
   * Export full-fidelity import IR from a live API — the cloud→code primitive
   * that lets chant regenerate TypeScript from running cloud/cluster state.
   *
   * Deliberately separate from {@link describeResources}: that returns scrubbed
   * *output* metadata for diffing, this returns full *input* config — enough to
   * regenerate a resource, and therefore possibly containing secrets. The
   * scrubbing boundary stays single-purpose; never overload one method for both.
   *
   * The return type {@link ExportedTemplate} is branded distinct from the
   * observation types so a full-fidelity export can never flow into the
   * observation/`state` code paths by accident.
   *
   * `owned` is accepted now but inert until ownership marking exists (#119/#120).
   *
   * `verbatim` controls fidelity: by default an implementation strips
   * server-defaulted and server-managed fields to reach the declared shape
   * (the form a user would have authored). `verbatim: true` keeps them. Targets
   * whose live config is already the declared shape (e.g. a CloudFormation
   * original template) may ignore it.
   */
  exportResources?(options: {
    environment: string;
    selector?: ResourceSelector;
    owned?: boolean;
    verbatim?: boolean;
  }): Promise<ExportedTemplate>;
}

/**
 * The observation view of a lexicon — every capability except live export.
 *
 * State/observation code (snapshots, `state diff --live`) consumes lexicons
 * through this type so that `exportResources` is unreachable from those paths:
 * a full-fidelity {@link ExportedTemplate} (which may carry secrets) must never
 * be read where scrubbed {@link ResourceMetadata} is expected. A full
 * {@link LexiconPlugin} is assignable to this type; accessing `exportResources`
 * on it is a compile error.
 */
export type ObservationLexicon = Omit<LexiconPlugin, "exportResources">;

/**
 * Narrows which live resources {@link LexiconPlugin.exportResources} and the
 * `owned` filter operate on. Both fields are optional; omit to export all.
 */
export interface ResourceSelector {
  /** Restrict to a single chant resource type (e.g. "AWS::S3::Bucket"). */
  readonly type?: string;
  /** Restrict to a single resource name. */
  readonly name?: string;
}

/**
 * Full-fidelity import IR read from a live API, branded distinct from the
 * scrubbed observation metadata. It IS a {@link TemplateIR} — it feeds the
 * existing `templateGenerator()` unchanged — but the phantom brand keeps it
 * from being passed where observation metadata is expected, and keeps
 * observation metadata from being passed where an export is expected.
 *
 * The brand is type-only; nothing is added at runtime.
 */
export type ExportedTemplate = TemplateIR & {
  /** Phantom marker — never present at runtime. */
  readonly __fidelity?: "full-config";
};

/**
 * Metadata about a deployed resource, returned by describeResources.
 */
export interface ResourceMetadata {
  /** Entity type (e.g. AWS::S3::Bucket, K8s::Apps::Deployment) */
  type: string;
  /** Provider-assigned physical ID (ARN, resource ID, pod name) */
  physicalId?: string;
  /** Provider-specific status string */
  status: string;
  /** ISO timestamp of last update */
  lastUpdated?: string;
  /** Cloud-assigned output properties */
  attributes?: Record<string, unknown>;
  /**
   * Live ownership verdict from the resource's marker (#119/#120), when the
   * lexicon could determine it. `owned` = carries chant's marker; `foreign` =
   * no marker. Absent = the lexicon has no marker channel here. The change set
   * reads this — never the snapshot — to decide whether an orphan is a delete.
   */
  ownership?: "owned" | "foreign";
}

/**
 * Metadata about a runtime artifact, returned by listArtifacts. Same shape
 * as ResourceMetadata; the conceptual distinction is whether the lexicon's
 * chant entities have 1:1 runtime equivalents (resources) or whether the
 * runtime artifacts are created by tooling outside chant's entity model
 * (artifacts — e.g. Helm releases, Docker containers).
 */
export interface ArtifactMetadata {
  /** Artifact type (e.g. Helm::Release, Docker::Container) */
  type: string;
  /** Server-side identifier */
  physicalId?: string;
  /** Provider-specific status string */
  status: string;
  /** ISO timestamp of last update */
  lastUpdated?: string;
  /** Provider-specific properties */
  attributes?: Record<string, unknown>;
}

/**
 * Type guard to check if a value is a LexiconPlugin.
 * Checks for required lifecycle methods in addition to name/serializer.
 */
export function isLexiconPlugin(value: unknown): value is LexiconPlugin {
  if (
    typeof value !== "object" ||
    value === null ||
    !("name" in value) ||
    typeof (value as Record<string, unknown>).name !== "string" ||
    !("serializer" in value) ||
    typeof (value as Record<string, unknown>).serializer !== "object"
  ) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.generate === "function" &&
    typeof obj.validate === "function" &&
    typeof obj.coverage === "function" &&
    typeof obj.package === "function"
  );
}
