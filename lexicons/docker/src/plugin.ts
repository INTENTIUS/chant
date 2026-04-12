/**
 * Docker lexicon plugin.
 *
 * Provides serializer, lint rules, post-synth checks, intrinsics, LSP support,
 * and code generation for Docker Compose and Dockerfile resources.
 */

import type { LexiconPlugin, IntrinsicDef, InitTemplateSet } from "@intentius/chant/lexicon";
import type { LintRule } from "@intentius/chant/lint/rule";
import { discoverPostSynthChecks } from "@intentius/chant/lint/discover";
import { createSkillsLoader, createDiffTool, createCatalogResource } from "@intentius/chant/lexicon-plugin-helpers";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { dockerSerializer } from "./serializer";
import { noLatestTagRule } from "./lint/rules/no-latest-tag";
import { dockerCompletions } from "./lsp/completions";
import { dockerHover } from "./lsp/hover";
import { DockerParser } from "./import/parser";
import { DockerGenerator } from "./import/generator";

export const dockerPlugin: LexiconPlugin = {
  name: "docker",
  serializer: dockerSerializer,

  lintRules(): LintRule[] {
    return [noLatestTagRule];
  },

  postSynthChecks() {
    const postSynthDir = join(dirname(fileURLToPath(import.meta.url)), "lint", "post-synth");
    return discoverPostSynthChecks(postSynthDir, import.meta.url);
  },

  intrinsics(): IntrinsicDef[] {
    return [
      {
        name: "env",
        description: "Docker Compose variable interpolation — ${VAR}, ${VAR:-default}, ${VAR:?error}",
        outputKey: "env",
        isTag: false,
      },
    ];
  },

  initTemplates(template?: string): InitTemplateSet {
    if (template === "webapp") {
      return {
        src: {
          "compose.ts": `import { Service, Volume } from "@intentius/chant-lexicon-docker";

export const db = new Service({
  image: "postgres:16-alpine",
  environment: {
    POSTGRES_DB: "myapp",
    POSTGRES_USER: "myapp",
    POSTGRES_PASSWORD: "secret",
  },
  volumes: ["pgdata:/var/lib/postgresql/data"],
});

export const pgdata = new Volume({});

export const api = new Service({
  image: "myapp:1.0",
  ports: ["8080:8080"],
  depends_on: ["db"],
  environment: {
    DATABASE_URL: "postgresql://myapp:secret@db:5432/myapp",
  },
});
`,
        },
      };
    }

    // Default template
    return {
      src: {
        "compose.ts": `import { Service } from "@intentius/chant-lexicon-docker";

export const api = new Service({
  image: "myapp:1.0",
  ports: ["8080:8080"],
  restart: "unless-stopped",
});
`,
      },
    };
  },

  detectTemplate(data: unknown): boolean {
    if (typeof data !== "object" || data === null) return false;
    const obj = data as Record<string, unknown>;
    // Docker Compose files have a services: key
    return "services" in obj;
  },

  completionProvider(ctx: import("@intentius/chant/lsp/types").CompletionContext) {
    return dockerCompletions(ctx);
  },

  hoverProvider(ctx: import("@intentius/chant/lsp/types").HoverContext) {
    return dockerHover(ctx);
  },

  templateParser() {
    return new DockerParser();
  },

  templateGenerator() {
    return new DockerGenerator();
  },

  async generate(options?: { verbose?: boolean }): Promise<void> {
    const { generate, writeGeneratedFiles } = await import("./codegen/generate");
    const { dirname: pathDirname } = await import("path");
    const { fileURLToPath: urlToPath } = await import("url");

    const result = await generate({ verbose: options?.verbose ?? true });
    const pkgDir = pathDirname(pathDirname(urlToPath(import.meta.url)));
    writeGeneratedFiles(result, pkgDir);

    console.error(
      `Generated ${result.resources} entities, ${result.properties} property types, ${result.enums} enums`,
    );
    if (result.warnings.length > 0) {
      console.error(`${result.warnings.length} warnings`);
    }
  },

  async validate(options?: { verbose?: boolean }): Promise<void> {
    const { validate } = await import("./validate");
    const { printValidationResult } = await import("@intentius/chant/codegen/validate");
    const result = await validate();
    printValidationResult(result);
  },

  async coverage(options?: { verbose?: boolean; minOverall?: number }): Promise<void> {
    const { analyzeDockerCoverage } = await import("./coverage");
    await analyzeDockerCoverage({
      verbose: options?.verbose,
      minOverall: options?.minOverall,
    });
  },

  async package(options?: { verbose?: boolean; force?: boolean }): Promise<void> {
    const { packageLexicon } = await import("./codegen/package");
    const { writeBundleSpec } = await import("@intentius/chant/codegen/package");
    const { join: pathJoin, dirname: pathDirname } = await import("path");
    const { fileURLToPath: urlToPath } = await import("url");

    const { spec, stats } = await packageLexicon({ verbose: options?.verbose, force: options?.force });

    const pkgDir = pathDirname(pathDirname(urlToPath(import.meta.url)));
    const distDir = pathJoin(pkgDir, "dist");
    writeBundleSpec(spec, distDir);

    console.error(`Packaged ${stats.resources} entities, ${stats.ruleCount} rules, ${stats.skillCount} skills`);
  },

  mcpTools() {
    return [createDiffTool(dockerSerializer, "Compare current build output against previous output for Docker Compose")];
  },

  mcpResources() {
    return [
      createCatalogResource(import.meta.url, "Docker Entity Catalog", "JSON list of all supported Docker entity types", "lexicon-docker.json"),
      {
        uri: "examples/basic-app",
        name: "Basic App Example",
        description: "A basic Docker Compose application with a service and volume",
        mimeType: "text/typescript",
        async handler(): Promise<string> {
          return `import { Service, Volume } from "@intentius/chant-lexicon-docker";

export const db = new Service({
  image: "postgres:16-alpine",
  environment: {
    POSTGRES_DB: "myapp",
    POSTGRES_USER: "myapp",
    POSTGRES_PASSWORD: "secret",
  },
  volumes: ["pgdata:/var/lib/postgresql/data"],
});

export const pgdata = new Volume({});

export const api = new Service({
  image: "myapp:1.0",
  ports: ["8080:8080"],
  depends_on: ["db"],
});
`;
        },
      },
    ];
  },

  async docs(options?: { verbose?: boolean }): Promise<void> {
    const { generateDocs } = await import("./codegen/docs");
    await generateDocs(options);
  },

  skills: createSkillsLoader(import.meta.url, [
    {
      file: "chant-docker.md",
      name: "chant-docker",
      description: "Docker Compose service/volume/network lifecycle — build, serialize, deploy",
      triggers: [
        { type: "file-pattern", value: "**/*.compose.ts" },
        { type: "file-pattern", value: "**/docker-compose.ts" },
        { type: "context", value: "docker compose" },
        { type: "context", value: "docker service" },
        { type: "context", value: "dockerfile" },
        { type: "context", value: "container" },
      ],
      parameters: [],
      examples: [
        {
          title: "Basic service with database",
          description: "Create a web service and PostgreSQL database",
          input: "Create a Node.js API with a PostgreSQL database",
          output: `new Service({ image: "myapi:1.0", depends_on: ["db"] })`,
        },
      ],
    },
    {
      file: "chant-docker-patterns.md",
      name: "chant-docker-patterns",
      description: "Docker Compose patterns — databases, caches, networks, multi-stage builds",
      triggers: [
        { type: "context", value: "docker compose" },
        { type: "context", value: "multi-stage" },
        { type: "context", value: "dockerfile pattern" },
        { type: "context", value: "docker network" },
        { type: "context", value: "docker volume" },
      ],
      parameters: [],
      examples: [
        {
          title: "Multi-stage Dockerfile",
          input: "Create a multi-stage Dockerfile for Node.js",
          output: `new Dockerfile({ stages: [{ from: "node:20-alpine", as: "build", ... }] })`,
        },
      ],
    },
  ]),
};
