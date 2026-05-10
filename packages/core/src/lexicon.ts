import type { Serializer } from "./serializer";
import type { LintRule } from "./lint/rule";
import type { RuleSpec } from "./lint/declarative";
import type { PostSynthCheck } from "./lint/post-synth";
import type { TemplateParser } from "./import/parser";
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
}

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
