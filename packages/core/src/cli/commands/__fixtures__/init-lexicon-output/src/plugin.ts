import type { LexiconPlugin } from "@intentius/chant/lexicon";
import { fixtureSerializer } from "./serializer";

/**
 * fixture lexicon plugin.
 *
 * Implements all required LexiconPlugin lifecycle methods.
 */
export const fixturePlugin: LexiconPlugin = {
  name: "fixture",
  serializer: fixtureSerializer,

  // ── Required lifecycle methods ────────────────────────────────

  async generate(options?: { verbose?: boolean }): Promise<void> {
    const { generate } = await import("./codegen/generate");
    await generate(options);
  },

  async validate(options?: { verbose?: boolean }): Promise<void> {
    const { validate } = await import("./validate");
    const { printValidationResult } = await import("@intentius/chant/codegen/validate");
    const result = await validate();
    printValidationResult(result);
  },

  async coverage(options?: { verbose?: boolean; minOverall?: number }): Promise<void> {
    // TODO: Implement coverage analysis
    console.error("Coverage analysis not yet implemented");
  },

  async package(options?: { verbose?: boolean; force?: boolean }): Promise<void> {
    const { packageLexicon } = await import("./codegen/package");
    const { writeBundleSpec } = await import("@intentius/chant/codegen/package");
    const { join, dirname } = await import("path");
    const { fileURLToPath } = await import("url");

    const { spec, stats } = await packageLexicon(options);
    const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
    writeBundleSpec(spec, join(pkgDir, "dist"));

    console.error(`Packaged ${stats.resources} resources, ${stats.ruleCount} rules, ${stats.skillCount} skills`);
  },

  // ── Optional extensions (uncomment and implement as needed) ───

  // lintRules(): LintRule[] {
  //   return [];
  // },

  // declarativeRules(): RuleSpec[] {
  //   return [];
  // },

  // postSynthChecks(): PostSynthCheck[] {
  //   return [];
  // },

  // intrinsics(): IntrinsicDef[] {
  //   return [];
  // },

  // pseudoParameters(): string[] {
  //   return [];
  // },

  // detectTemplate(data: unknown): boolean {
  //   return false;
  // },

  // templateParser(): TemplateParser {
  //   // return new MyParser();
  // },

  // templateGenerator(): TypeScriptGenerator {
  //   // return new MyGenerator();
  // },

  // skills(): SkillDefinition[] {
  //   return [];
  // },

  // completionProvider(ctx: CompletionContext): CompletionItem[] {
  //   return [];
  // },

  // hoverProvider(ctx: HoverContext): HoverInfo | undefined {
  //   return undefined;
  // },

  // docs(options?: { verbose?: boolean }): Promise<void> {
  //   const { generateDocs } = await import("./codegen/docs");
  //   return generateDocs(options);
  // },
};
