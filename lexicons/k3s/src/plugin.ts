import type { LexiconPlugin, SkillDefinition, IntrinsicDef } from "@intentius/chant/lexicon";
import type { LintRule } from "@intentius/chant/lint/rule";
import type { PostSynthCheck } from "@intentius/chant/lint/post-synth";
import type { CompletionContext, CompletionItem, HoverContext, HoverInfo } from "@intentius/chant/lsp/types";
import type { McpToolContribution, McpResourceContribution } from "@intentius/chant/mcp/types";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { k3sSerializer } from "./serializer";
import { rules } from "./lint/rules";
import { postSynthChecks } from "./lint/post-synth";
import { k3sAuditCatalog } from "./lint/audit-catalog";
import { completions } from "./lsp/completions";
import { hover } from "./lsp/hover";

/**
 * k3s lexicon plugin.
 *
 * Implements all required LexiconPlugin lifecycle methods.
 */
export const k3sPlugin: LexiconPlugin = {
  name: "k3s",
  serializer: k3sSerializer,

  /**
   * Where the upstream pin lives and where to look for a newer one, for
   * the self-upgrade tooling (#523). k3s releases carry a `+k3s1` build
   * suffix; the release tag is the version constant verbatim.
   */
  upstreamPin: {
    file: "src/spec/fetch.ts",
    pattern: /export const K3S_VERSION\s*=\s*"([^"]+)"/,
    replace: (v: string, line: string) => line.replace(/= "[^"]+"/, `= "${v}"`),
    upstream: { owner: "k3s-io", repo: "k3s", kind: "releases" },
  },

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

  // ── Optional extensions ────────────────────────────────────

  lintRules() {
    return rules;
  },

  postSynthChecks() {
    return postSynthChecks;
  },

  auditCatalog() {
    return k3sAuditCatalog;
  },

  skills() {
    const skills: SkillDefinition[] = [];
    const dir = dirname(fileURLToPath(import.meta.url));
    const entries = [
      {
        file: "chant-k3s.md",
        name: "chant-k3s",
        description:
          "Declare k3s host configuration — server/agent config.yaml and registries.yaml — as typed chant source",
      },
    ];
    for (const entry of entries) {
      try {
        const content = readFileSync(join(dir, "skills", entry.file), "utf-8");
        skills.push({ name: entry.name, description: entry.description, content });
      } catch {
        // skill file missing from a partial checkout — skip rather than throw
      }
    }
    return skills;
  },

  mcpTools() {
    return []; // TODO: Implement MCP tools
  },

  mcpResources() {
    return []; // TODO: Implement MCP resources
  },

  detectTemplate(data: unknown) {
    return false; // TODO: Detect if a template belongs to this lexicon
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
