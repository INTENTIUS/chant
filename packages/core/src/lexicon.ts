import type { Serializer } from "./serializer";
import type { LintRule } from "./lint/rule";
import type { RuleSpec } from "./lint/declarative";
import type { PostSynthCheck } from "./lint/post-synth";
import type { TemplateParser, TemplateIR } from "./import/parser";
import type { TypeScriptGenerator } from "./import/generator";
import type { ArtifactIntegrity } from "./lexicon-integrity";
import type { CompletionContext, CompletionItem, HoverContext, HoverInfo, CodeActionContext, CodeAction } from "./lsp/types";
import type { McpToolContribution, McpResourceContribution } from "./mcp/types";

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

  // ── Optional extensions ───────────────────────────────────
  /** Return lint rules provided by this lexicon */
  lintRules?(): LintRule[];

  /** Return declarative rule specs for compilation via rule() */
  declarativeRules?(): RuleSpec[];

  /** Return post-synthesis checks for build validation */
  postSynthChecks?(): PostSynthCheck[];

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
   * List runtime artifacts in the given environment. Opt-in.
   *
   * Use this for lexicons whose chant entities describe *authoring*
   * primitives rather than 1:1 cloud resources — e.g. Helm (charts vs
   * releases), Docker (Compose vs running containers), Flyway (migration
   * scripts vs applied migrations). The contract is context-keyed: given an
   * environment, list all artifacts visible there. There is no `declared`
   * comparison axis — `state diff --live` reports added/removed/changed
   * between snapshots, not vs. declared.
   *
   * `entities` is passed for cases where the lexicon needs to know what
   * was declared in order to enumerate (e.g. Flyway needs the declared
   * `Flyway::Environment` entities to know which DBs to query).
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
 * (artifacts — e.g. Helm releases, Docker containers, Flyway migrations).
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
