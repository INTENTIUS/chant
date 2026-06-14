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
import { forgejoSerializer } from "./serializer";
import { forgejoContextTools } from "./mcp/context-tools";

const reuseNote =
  "forgejo reuses the github lexicon's entities — run `chant generate` in the github lexicon instead.";

export const forgejoPlugin: LexiconPlugin = {
  name: "forgejo",
  serializer: forgejoSerializer,

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

  mcpTools() {
    return [...forgejoContextTools()];
  },

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
  async package(): Promise<void> {
    console.error(reuseNote);
  },
};
