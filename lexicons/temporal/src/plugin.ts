/**
 * Temporal lexicon plugin — implements the LexiconPlugin lifecycle.
 *
 * All resources are hand-written; there is no remote spec to generate from.
 * The generate step is a no-op. The package step builds dist/manifest.json
 * and copies skill markdown files.
 */

import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { LexiconPlugin } from "@intentius/chant/lexicon";
import { discoverLintRules, discoverPostSynthChecks } from "@intentius/chant/lint/discover";
import { createSkillsLoader, createDiffTool, createCatalogResource } from "@intentius/chant/lexicon-plugin-helpers";
import { temporalSerializer } from "./serializer";

const srcDir = dirname(fileURLToPath(import.meta.url));
const rulesDir = join(srcDir, "lint/rules");
const postSynthDir = join(srcDir, "lint/post-synth");

export const temporalPlugin: LexiconPlugin = {
  name: "temporal",
  serializer: temporalSerializer,

  // ── Required lifecycle methods ──────────────────────────────────────

  async generate(options?: { verbose?: boolean }): Promise<void> {
    const { generate, writeGeneratedFiles } = await import("./codegen/generate");
    const { dirname: pathDirname } = await import("path");
    const { fileURLToPath: toPath } = await import("url");
    const pkgDir = pathDirname(pathDirname(toPath(import.meta.url)));
    const result = await generate(options);
    writeGeneratedFiles(result, pkgDir);
  },

  async validate(options?: { verbose?: boolean }): Promise<void> {
    const { validate } = await import("./validate");
    const result = await validate(options);
    if (result.failed > 0) {
      throw new Error(`Temporal lexicon validation failed:\n${result.errors.join("\n")}`);
    }
  },

  async coverage(options?: { verbose?: boolean }): Promise<void> {
    const { analyze, printCoverageResult } = await import("./coverage");
    const result = analyze();
    printCoverageResult(result, options?.verbose ?? true);
  },

  async package(options?: { verbose?: boolean; force?: boolean }): Promise<void> {
    const { packageLexicon } = await import("./codegen/package");
    const { writeBundleSpec } = await import("@intentius/chant/codegen/package");
    const { join: pathJoin, dirname: pathDirname } = await import("path");
    const { fileURLToPath: toPath } = await import("url");

    const { spec, stats } = await packageLexicon(options);
    const pkgDir = pathDirname(pathDirname(toPath(import.meta.url)));
    writeBundleSpec(spec, pathJoin(pkgDir, "dist"));

    console.error(`Packaged ${stats.resources} resources, ${stats.ruleCount} rules, ${stats.skillCount} skills`);
  },

  // ── Optional extensions ─────────────────────────────────────────────

  lintRules() {
    return discoverLintRules(rulesDir, import.meta.url);
  },

  postSynthChecks() {
    return discoverPostSynthChecks(postSynthDir, import.meta.url);
  },

  skills() {
    return createSkillsLoader(import.meta.url, [
      {
        file: "chant-temporal.md",
        name: "chant-temporal",
        description: "Temporal server setup, namespace provisioning, and schedule registration",
        triggers: [
          { type: "file-pattern", value: "**/*.ts" },
          { type: "context", value: "temporal" },
          { type: "context", value: "workflow" },
        ],
        parameters: [],
        examples: [],
      },
      {
        file: "chant-temporal-ops.md",
        name: "chant-temporal-ops",
        description: "Signal workflows, diagnose stuck activities, reset checkpoints",
        triggers: [
          { type: "context", value: "temporal workflow" },
          { type: "context", value: "stuck activity" },
          { type: "context", value: "chant run" },
        ],
        parameters: [],
        examples: [],
      },
    ])();
  },

  mcpTools() {
    return [
      createDiffTool(
        temporalSerializer,
        "Compare current Temporal build output (docker-compose.yml, temporal-setup.sh, schedules/) against previous version",
      ),
    ];
  },

  mcpResources() {
    return [
      createCatalogResource(
        import.meta.url,
        "Temporal Resource Types",
        "All supported Temporal resource types: TemporalServer, TemporalNamespace, SearchAttribute, TemporalSchedule",
        "lexicon-temporal.json",
      ),
      {
        uri: "examples/dev-server",
        name: "Local Dev Server Example",
        description: "Minimal Temporal dev server with namespace for local development",
        mimeType: "text/typescript",
        async handler(): Promise<string> {
          return [
            'import { TemporalServer, TemporalNamespace } from "@intentius/chant-lexicon-temporal";',
            "",
            "// Local dev server — runs via `temporal server start-dev`",
            'export const server = new TemporalServer({ mode: "dev" });',
            "",
            "export const ns = new TemporalNamespace({",
            '  name: "default",',
            '  retention: "7d",',
            "});",
          ].join("\n");
        },
      },
      {
        uri: "examples/cloud-setup",
        name: "Temporal Cloud Setup Example",
        description: "Namespace and search attributes for Temporal Cloud (no local server)",
        mimeType: "text/typescript",
        async handler(): Promise<string> {
          return [
            'import { TemporalNamespace, SearchAttribute, TemporalSchedule } from "@intentius/chant-lexicon-temporal";',
            "",
            "export const ns = new TemporalNamespace({",
            '  name: "prod",',
            '  retention: "30d",',
            '  description: "Production workflow namespace",',
            "});",
            "",
            "export const projectAttr = new SearchAttribute({",
            '  name: "Project",',
            '  type: "Keyword",',
            '  namespace: "prod",',
            "});",
            "",
            "export const dailyReport = new TemporalSchedule({",
            '  scheduleId: "daily-report",',
            "  spec: {",
            '    cronExpressions: ["0 8 * * *"],',
            "  },",
            "  action: {",
            '    workflowType: "reportWorkflow",',
            '    taskQueue: "reports",',
            "  },",
            "  policies: {",
            '    overlap: "Skip",',
            "  },",
            "});",
          ].join("\n");
        },
      },
    ];
  },

  // ── initTemplates ────────────────────────────────────────────────────
  // 3 templates: "local" (default), "cloud", "full"

  initTemplates(template?: string) {
    if (template === "cloud") {
      return {
        src: {
          "temporal.ts": [
            'import { TemporalNamespace, SearchAttribute, TemporalSchedule } from "@intentius/chant-lexicon-temporal";',
            "",
            "// Namespace — provision once after connecting to Temporal Cloud",
            "export const ns = new TemporalNamespace({",
            '  name: "my-namespace",',
            '  retention: "30d",',
            '  description: "Production deployment namespace",',
            "});",
            "",
            "// Search attributes — register once per namespace",
            "export const projectAttr = new SearchAttribute({",
            '  name: "Project",',
            '  type: "Keyword",',
            '  namespace: "my-namespace",',
            "});",
            "",
            "// Schedule — daily maintenance run",
            "export const maintenanceSchedule = new TemporalSchedule({",
            '  scheduleId: "daily-maintenance",',
            "  spec: {",
            '    cronExpressions: ["0 2 * * *"],',
            "  },",
            "  action: {",
            '    workflowType: "maintenanceWorkflow",',
            '    taskQueue: "maintenance-queue",',
            "  },",
            "  policies: {",
            '    overlap: "Skip",',
            "  },",
            "});",
          ].join("\n"),
        },
      };
    }

    if (template === "full") {
      return {
        src: {
          "temporal.ts": [
            'import {',
            '  TemporalServer,',
            '  TemporalNamespace,',
            '  SearchAttribute,',
            '  TemporalSchedule,',
            '} from "@intentius/chant-lexicon-temporal";',
            "",
            "// Full server stack (auto-setup + postgres + UI)",
            "export const server = new TemporalServer({",
            '  version: "1.26.2",',
            '  mode: "full",',
            "  port: 7233,",
            "  uiPort: 8080,",
            "});",
            "",
            "export const ns = new TemporalNamespace({",
            '  name: "default",',
            '  retention: "7d",',
            "});",
            "",
            "export const projectAttr = new SearchAttribute({",
            '  name: "Project",',
            '  type: "Keyword",',
            "});",
            "",
            "export const weeklyBackup = new TemporalSchedule({",
            '  scheduleId: "weekly-backup",',
            "  spec: {",
            '    cronExpressions: ["0 3 * * SUN"],',
            "  },",
            "  action: {",
            '    workflowType: "backupWorkflow",',
            '    taskQueue: "backup-queue",',
            "  },",
            "});",
          ].join("\n"),
        },
      };
    }

    // default = "local"
    return {
      src: {
        "temporal.ts": [
          'import { TemporalServer, TemporalNamespace } from "@intentius/chant-lexicon-temporal";',
          "",
          "// Local dev server — runs via `temporal server start-dev`",
          "export const server = new TemporalServer({ mode: \"dev\" });",
          "",
          "export const ns = new TemporalNamespace({",
          '  name: "default",',
          '  retention: "7d",',
          "});",
        ].join("\n"),
      },
    };
  },

  async docs(options?) {
    const { generateDocs } = await import("./codegen/docs");
    return generateDocs(options);
  },
};
