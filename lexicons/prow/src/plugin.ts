import type { LexiconPlugin, InitTemplateSet } from "@intentius/chant/lexicon";
import type { CompletionContext, HoverContext } from "@intentius/chant/lsp/types";
import { prowSerializer } from "./serializer";
import { rules } from "./lint/rules";
import { postSynthChecks } from "./lint/post-synth";
import { prowAuditCatalog } from "./lint/audit-catalog";
import { completions } from "./lsp/completions";
import { hover } from "./lsp/hover";
import { ProwJobConfigParser } from "./import/parser";
import { ProwJobConfigGenerator } from "./import/generator";
import { isJobConfig } from "./job-config";
import { prowSkills } from "./skills";
import { propertyEntityNames } from "./registry";
import { generateProwPipeline } from "./components/generate-pipeline";
import { generateProwOpPipeline } from "./components/generate-op-pipeline";

/**
 * Prow lexicon plugin: the job config Prow loads (presubmits, postsubmits
 * and periodics) as declarables, built to the job config file and imported
 * from one.
 */
export const prowPlugin: LexiconPlugin = {
  name: "prow",
  serializer: prowSerializer,
  // #5189: the jobs chant generates for a component project, as Prow presubmits and postsubmits.
  generateComponentPipeline: (components, options) => generateProwPipeline(components, options),
  // #5189: scheduled Ops as periodics, postsubmits and presubmits, in one job config.
  generateOpPipeline: (ops, options) => generateProwOpPipeline(ops, options),

  async generate(options?: { verbose?: boolean }): Promise<void> {
    const { generate, writeGeneratedFiles } = await import("./codegen/generate");
    writeGeneratedFiles(await generate(options));
  },

  async validate(): Promise<void> {
    const { validate } = await import("./validate");
    const { printValidationResult } = await import("@intentius/chant/codegen/validate");
    printValidationResult(await validate());
  },

  async coverage(): Promise<void> {
    const { jobConfigSchema } = await import("./spec/schema");
    const defs = Object.keys((jobConfigSchema().definitions ?? {}) as Record<string, unknown>);
    console.error(`prow: every definition of the vendored job config schema is an entity (${defs.length})`);
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

  lintRules() {
    return rules;
  },

  /** The pod spec and the other values nested in a job: object literals inside them are already at a job's depth (COR001). */
  propertyClassNames() {
    return propertyEntityNames();
  },

  postSynthChecks() {
    return postSynthChecks;
  },

  auditCatalog() {
    return prowAuditCatalog;
  },

  skills() {
    return prowSkills;
  },

  initTemplates(): InitTemplateSet {
    return {
      src: {
        "jobs.ts": `import { Presubmit, Postsubmit } from "@intentius/chant-lexicon-prow";

const spec = {
  automountServiceAccountToken: false,
  containers: [{ name: "test", image: "golang:1.26", command: ["go", "test", "./..."] }],
};

export const unitTest = new Presubmit({
  repo: "acme/app",
  name: "pull-app-unit",
  always_run: true,
  decorate: true,
  branches: ["^main$"],
  spec,
});

export const mainTest = new Postsubmit({
  repo: "acme/app",
  name: "post-app-unit",
  decorate: true,
  branches: ["^main$"],
  spec,
});
`,
      },
    };
  },

  detectTemplate(data: unknown): boolean {
    return isJobConfig(data);
  },

  templateParser() {
    return new ProwJobConfigParser();
  },

  templateGenerator() {
    return new ProwJobConfigGenerator();
  },

  completionProvider(ctx: CompletionContext) {
    return completions(ctx);
  },

  hoverProvider(ctx: HoverContext) {
    return hover(ctx);
  },

  async docs(options?) {
    const { generateDocs } = await import("./codegen/docs");
    return generateDocs(options);
  },
};
