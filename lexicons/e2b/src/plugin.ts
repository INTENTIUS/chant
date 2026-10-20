import type { LexiconPlugin } from "@intentius/chant/lexicon";
import type { CompletionContext, HoverContext } from "@intentius/chant/lsp/types";
import { createSkillsLoader } from "@intentius/chant/lexicon-plugin-helpers";
import { e2bSerializer } from "./serializer";
import { e2bConfigSchema } from "./config";
import { createE2bOpRuntime } from "./op/runtime";
import { rules } from "./lint/rules";
import { postSynthChecks } from "./lint/post-synth";
import { e2bAuditCatalog } from "./lint/audit-catalog";
import { completions } from "./lsp/completions";
import { hover } from "./lsp/hover";

/**
 * e2b lexicon plugin: `chant run <op> --on e2b`, and the `Template` a
 * steward's sandbox is made from.
 *
 * The op runtime is most of the lexicon. Its one declarable kind is written
 * by hand, so `generate` only writes the post-synth barrel, there is no
 * upstream spec to validate against or measure coverage of, and `package`
 * bundles the hand-written catalog.
 */
export const e2bPlugin: LexiconPlugin = {
  name: "e2b",
  serializer: e2bSerializer,
  configSchema: e2bConfigSchema,
  auditCatalog: () => e2bAuditCatalog,

  // Construction is pure: the key, the steward and the repository are
  // resolved on the first call, so loading the plugin costs nothing.
  opRuntime: createE2bOpRuntime(),

  skills: createSkillsLoader(import.meta.url, [
    {
      file: "chant-e2b-ops.md",
      name: "chant-e2b-ops",
      description: "Run chant ops on a steward sandbox with `--on e2b`, on hosted E2B or any API that speaks E2B's",
      triggers: [{ type: "context" as const, value: "e2b" }],
    },
  ]),

  async generate(): Promise<void> {
    const { generate } = await import("./codegen/generate");
    generate();
  },

  // Nothing upstream to check the hand-written kind against.
  async validate(): Promise<void> {},
  async coverage(): Promise<void> {},

  async package(options?: { verbose?: boolean; force?: boolean }): Promise<void> {
    const { packageLexicon } = await import("./codegen/package");
    const { writeBundleSpec } = await import("@intentius/chant/codegen/package");
    const { join, dirname } = await import("path");
    const { fileURLToPath } = await import("url");
    const { spec } = await packageLexicon(options);
    writeBundleSpec(spec, join(dirname(dirname(fileURLToPath(import.meta.url))), "dist"));
  },

  lintRules() {
    return rules;
  },

  postSynthChecks() {
    return postSynthChecks;
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
