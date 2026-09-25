import type { LexiconPlugin } from "@intentius/chant/lexicon";
import type { CompletionContext, HoverContext } from "@intentius/chant/lsp/types";
import { createSkillsLoader } from "@intentius/chant/lexicon-plugin-helpers";
import { systemoneSerializer } from "./serializer";
import { rules } from "./lint/rules";
import { postSynthChecks } from "./lint/post-synth";
import { systemoneAuditCatalog } from "./lint/audit-catalog";
import { completions } from "./lsp/completions";
import { hover } from "./lsp/hover";
import { systemoneConfigSchema } from "./config";
import { backendEntities } from "./backend-entities";

const loadSkills = createSkillsLoader(import.meta.url, [
  {
    file: "chant-systemone.md",
    name: "chant-systemone",
    description: "Ask a workspace's decision points through a Jev-compatible backend with the decide Op activity",
  },
]);

/**
 * systemone lexicon plugin: verbs only.
 *
 * There is no upstream schema and no resource. The wire format (`POST
 * /v1/systemone`, #2491) is small and has no published schema, and a decision
 * point is workspace data core validates. What the plugin contributes is the
 * `systemone` config namespace, SYS001 and SYS010, the skill, and editor help
 * for the `decide` step's options. The activity and its contract are found at
 * the `./op/activities` and `./op/activity-contracts` subpaths.
 */
export const systemonePlugin: LexiconPlugin = {
  name: "systemone",
  serializer: systemoneSerializer,
  configSchema: systemoneConfigSchema,

  async generate(options?: { verbose?: boolean }): Promise<void> {
    const { generate, writeGeneratedFiles } = await import("./codegen/generate");
    writeGeneratedFiles(await generate(options));
  },

  async validate(_options?: { verbose?: boolean }): Promise<void> {
    const { validate } = await import("./validate");
    const { printValidationResult } = await import("@intentius/chant/codegen/validate");
    printValidationResult(await validate());
  },

  async coverage(_options?: { verbose?: boolean; minOverall?: number }): Promise<void> {
    console.error("Coverage analysis not applicable: this lexicon generates no types from an upstream spec");
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

  /** Each backend in `systemone.backends` joins the build as an entity (`./backend-entities.ts`). */
  async buildRoots(ctx) {
    return { entities: backendEntities(ctx.config), warnings: [] };
  },

  lintRules() {
    return rules;
  },

  postSynthChecks() {
    return postSynthChecks;
  },

  auditCatalog() {
    return systemoneAuditCatalog;
  },

  skills() {
    return loadSkills();
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
