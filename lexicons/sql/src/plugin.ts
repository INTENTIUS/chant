/**
 * The sql lexicon plugin.
 *
 * One lexicon, a subpath per database dialect (#3047, "Packaging"); ClickHouse
 * is the first, at `@intentius/chant-lexicon-sql/clickhouse`. Generation reads
 * the pinned ClickHouse server's catalog (src/spec/), and the rest of the
 * plugin is the shared machinery every dialect plugs into.
 */

import type { LexiconPlugin } from "@intentius/chant/lexicon";
import type { CompletionContext, HoverContext } from "@intentius/chant/lsp/types";
import { sqlSerializer } from "./serializer";
import { rules } from "./lint/rules";
import { completions } from "./lsp/completions";
import { hover } from "./lsp/hover";
import { sqlConfigSchema } from "./config";
import { versionFromReleaseTag } from "./spec/pin";

export const sqlPlugin: LexiconPlugin = {
  name: "sql",
  serializer: sqlSerializer,
  configSchema: sqlConfigSchema,

  async generate(options?: { verbose?: boolean }): Promise<void> {
    const { generate, writeGeneratedFiles } = await import("./codegen/generate");
    writeGeneratedFiles(await generate(options));
  },

  async validate(_options?: { verbose?: boolean }): Promise<void> {
    const { validate } = await import("./validate");
    const { printValidationResult } = await import("@intentius/chant/codegen/validate");
    printValidationResult(await validate());
  },

  async coverage(options?: { verbose?: boolean; minOverall?: number }): Promise<void> {
    const { analyze, printCoverage } = await import("./coverage");
    printCoverage(analyze(), options);
  },

  async package(options?: { verbose?: boolean; force?: boolean }): Promise<void> {
    const { packageLexicon } = await import("./codegen/package");
    const { writeBundleSpec } = await import("@intentius/chant/codegen/package");
    const { join, dirname } = await import("path");
    const { fileURLToPath } = await import("url");
    const { spec, stats } = await packageLexicon(options);
    writeBundleSpec(spec, join(dirname(dirname(fileURLToPath(import.meta.url))), "dist"));
    console.error(`Packaged ${stats.ruleCount} rules, ${stats.skillCount} skills`);
  },

  lintRules() {
    return rules;
  },

  postSynthChecks() {
    return [];
  },

  completionProvider(ctx: CompletionContext) {
    return completions(ctx);
  },

  hoverProvider(ctx: HoverContext) {
    return hover(ctx);
  },

  async docs(options?: { verbose?: boolean }): Promise<void> {
    const { generateDocs } = await import("./codegen/docs");
    await generateDocs(options);
  },

  /**
   * The pin is a ClickHouse LTS release. GitHub tags them `v26.8.15.10-lts`;
   * the constant holds `26.8.15.10`, which is also the docker tag. A move also
   * needs `CLICKHOUSE_IMAGE_DIGEST` updated: generation refuses a server whose
   * version is not the pin.
   */
  upstreamPin: {
    file: "src/spec/pin.ts",
    pattern: /export const CLICKHOUSE_VERSION\s*=\s*"([^"]+)"/,
    replace: (v: string, line: string) => line.replace(/= "[^"]+"/, `= "${versionFromReleaseTag(v)}"`),
    upstream: { owner: "ClickHouse", repo: "ClickHouse", kind: "releases", tagSuffix: "-lts" },
  },
};
