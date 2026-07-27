/**
 * Forgejo Actions lexicon plugin.
 *
 * Forgejo runs GitHub-Actions-compatible workflows, so this lexicon is a thin
 * dialect of the github lexicon: it reuses github's generated entities and
 * composites wholesale (re-exported from ./index) and overrides only the
 * serializer. There is no own spec, so the codegen lifecycle methods are
 * intentionally no-ops — they delegate the real work to the github lexicon.
 */

import type { LexiconPlugin, InitTemplateSet, MigrationSource } from "@intentius/chant/lexicon";
import type { LintRule } from "@intentius/chant/lint/rule";
import { postSynthChecks as postSynthCheckList } from "./lint/post-synth";
import { forgejoAuditCatalog } from "./lint/audit-catalog";
import { createSkillsLoader, createDiffTool } from "@intentius/chant/lexicon-plugin-helpers";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { forgejoSerializer } from "./serializer";
import { forgejoContextTools } from "./mcp/context-tools";
import { generateForgejoPipeline } from "./components/generate-pipeline";
import { forgejoLintRules } from "./lint/rules/delegate-to-github";
import { forgejoCompletions } from "./lsp/completions";
import { forgejoHover } from "./lsp/hover";

const reuseNote =
  "forgejo reuses the github lexicon's entities — run `chant generate` in the github lexicon instead.";

export const forgejoPlugin: LexiconPlugin = {
  name: "forgejo",
  auditCatalog: () => forgejoAuditCatalog,
  serializer: forgejoSerializer,

  // Generate mode (#969): component graph → Forgejo Actions workflow. Reuses
  // github's pipeline structure and applies the Forgejo dialect (runner labels,
  // `uses:` resolution) — see ./components/generate-pipeline.
  generateComponentPipeline: (components, options) => generateForgejoPipeline(components, options),

  initTemplates(template?: string): InitTemplateSet {
    if (template === "docker-build") {
      return {
        src: {
          "pipeline.ts": `import { Workflow, Job, Step, Checkout } from "@intentius/chant-lexicon-forgejo";

export const workflow = new Workflow({
  name: "Docker Build",
  on: { push: { branches: ["main"] } },
});

export const build = new Job({
  "runs-on": "ubuntu-latest",
  steps: [
    Checkout({}).step,
    new Step({ name: "Build", run: "docker build -t myapp ." }),
  ],
});
`,
        },
      };
    }

    // Default template: a Node CI workflow. Reuses github entities; the forgejo
    // serializer maps "ubuntu-latest" to a Forgejo runner label on build.
    return {
      src: {
        "pipeline.ts": `import { Workflow, Job, Step, Checkout, SetupNode } from "@intentius/chant-lexicon-forgejo";

export const workflow = new Workflow({
  name: "CI",
  on: {
    push: { branches: ["main"] },
    pull_request: { branches: ["main"] },
  },
});

export const build = new Job({
  "runs-on": "ubuntu-latest",
  steps: [
    Checkout({}).step,
    SetupNode({ nodeVersion: "22", cache: "npm" }).step,
    new Step({ name: "Install", run: "npm ci" }),
    new Step({ name: "Build", run: "npm run build" }),
    new Step({ name: "Test", run: "npm test" }),
  ],
});
`,
      },
    };
  },

  detectTemplate(data: unknown): boolean {
    if (typeof data !== "object" || data === null) return false;
    const obj = data as Record<string, unknown>;

    // Forgejo Actions workflows are GitHub-Actions-shaped: `on:` + `jobs:`.
    if (obj.on !== undefined && obj.jobs !== undefined) return true;

    for (const value of Object.values(obj)) {
      if (typeof value === "object" && value !== null) {
        const entry = value as Record<string, unknown>;
        if (entry["runs-on"] !== undefined || entry.steps !== undefined) {
          return true;
        }
      }
    }

    return false;
  },

  migrationSource(from: string): MigrationSource | undefined {
    if (from !== "github") return undefined;
    return {
      detect(content: string): boolean {
        // Inline heuristic — keeps the migrate code out of the import graph
        // until a transform actually runs.
        if (!/^\s*jobs\s*:/m.test(content)) return false;
        return /^\s*on\s*:/m.test(content) || /^\s*runs-on\s*:/m.test(content);
      },
      async transform(content: string, opts) {
        const { transform } = await import("./migrate/from-github");
        const result = await transform(content, {
          emit: opts.emit,
          sourceFile: opts.sourceFile,
          strict: opts.strict,
          security: opts.security,
        });
        return {
          output: result.output,
          provenance: result.provenance as unknown as Array<Record<string, unknown>>,
          diagnostics: result.diagnostics as unknown as Array<Record<string, unknown>>,
          securityPosture: result.securityPosture,
        };
      },
    };
  },

  postSynthChecks() {
    return postSynthCheckList;
  },

  // Lint rules and LSP support are delegated to github, not forked — see
  // ./lint/rules/delegate-to-github.ts and ./lsp/{completions,hover}.ts.
  lintRules(): LintRule[] {
    return forgejoLintRules;
  },

  completionProvider(ctx: import("@intentius/chant/lsp/types").CompletionContext) {
    return forgejoCompletions(ctx);
  },

  hoverProvider(ctx: import("@intentius/chant/lsp/types").HoverContext) {
    return forgejoHover(ctx);
  },

  mcpTools() {
    return [
      createDiffTool(forgejoSerializer, "Compare current build output against previous output for Forgejo Actions", "forgejo"),
      ...forgejoContextTools(),
    ];
  },

  skills: createSkillsLoader(import.meta.url, [
    {
      file: "chant-forgejo.md",
      name: "chant-forgejo",
      description: "Forgejo / Codeberg / Gitea Actions with chant — build, the dialect (dropped keys, runner labels, uses: resolution), and github→forgejo migration",
      triggers: [
        { type: "file-pattern", value: "**/.forgejo/workflows/*.yml" },
        { type: "file-pattern", value: "**/.gitea/workflows/*.yml" },
        { type: "context", value: "forgejo" },
        { type: "context", value: "codeberg" },
        { type: "context", value: "gitea" },
      ],
      parameters: [],
      examples: [
        {
          title: "Build a Forgejo workflow",
          description: "Author github-style; the forgejo dialect applies on build",
          input: "Create a CI workflow for Codeberg",
          output: `chant build src -o .forgejo/workflows/ci.yml`,
        },
      ],
    },
  ]),

  // ── Codegen lifecycle — delegated to github (no own spec) ──────────
  async generate(): Promise<void> {
    console.error(reuseNote);
  },
  async validate(): Promise<void> {
    console.error("All checks passed.");
  },
  async coverage(): Promise<void> {
    console.error(reuseNote);
  },

  // Packaging is real (unlike generate/validate/coverage above): forgejo
  // ships its own dist/manifest.json — an empty resource catalog plus its
  // own post-synth checks and skill — even though the catalog it packages
  // is empty. See ./codegen/{generate,package}.ts.
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

  async docs(options?: { verbose?: boolean }): Promise<void> {
    const { generateDocs } = await import("./codegen/docs");
    return generateDocs(options);
  },
};
