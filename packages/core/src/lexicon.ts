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
 * Plugin interface for lexicon packages.
 *
 * Required lifecycle methods enforce consistency: every lexicon must support
 * generate, validate, coverage, package, and rollback operations.
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

  /** List or restore generation snapshots */
  rollback(options?: { restore?: string; verbose?: boolean }): Promise<void>;

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
  initTemplates?(): Record<string, string>;

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
    typeof obj.package === "function" &&
    typeof obj.rollback === "function"
  );
}
