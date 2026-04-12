/**
 * Flyway lexicon plugin.
 *
 * Provides serializer, template detection, code generation,
 * lint rules, and LSP/MCP integration for Flyway TOML config.
 */

import type { LexiconPlugin, IntrinsicDef, InitTemplateSet } from "@intentius/chant/lexicon";
import type { LintRule } from "@intentius/chant/lint/rule";
import { discoverPostSynthChecks } from "@intentius/chant/lint/discover";
import { createSkillsLoader, createDiffTool, createCatalogResource } from "@intentius/chant/lexicon-plugin-helpers";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { flywaySerializer } from "./serializer";
import { parseTOML } from "@intentius/chant/toml";
import { hardcodedCredentialsRule } from "./lint/rules/hardcoded-credentials";
import { hardcodedUrlRule } from "./lint/rules/hardcoded-url";
import { missingSchemasRule } from "./lint/rules/missing-schemas";
import { invalidMigrationNameRule } from "./lint/rules/invalid-migration-name";
import { duplicateVersionRule } from "./lint/rules/duplicate-version";
import { flywayCompletions } from "./lsp/completions";
import { flywayHover } from "./lsp/hover";
import { FlywayParser } from "./import/parser";
import { FlywayGenerator } from "./import/generator";

export const flywayPlugin: LexiconPlugin = {
  name: "flyway",
  serializer: flywaySerializer,

  lintRules(): LintRule[] {
    return [hardcodedCredentialsRule, hardcodedUrlRule, missingSchemasRule, invalidMigrationNameRule, duplicateVersionRule];
  },

  postSynthChecks() {
    const postSynthDir = join(dirname(fileURLToPath(import.meta.url)), "lint", "post-synth");
    return discoverPostSynthChecks(postSynthDir, import.meta.url);
  },

  intrinsics(): IntrinsicDef[] {
    return [
      {
        name: "resolve",
        description: "Resolver reference — ${resolverName.key}",
      },
      {
        name: "placeholder",
        description: "Built-in placeholder reference — ${flyway:name}",
      },
      {
        name: "env",
        description: "Environment variable reference — ${env.VAR_NAME}",
      },
    ];
  },

  pseudoParameters(): string[] {
    return [
      "flyway:defaultSchema",
      "flyway:user",
      "flyway:database",
      "flyway:timestamp",
      "flyway:filename",
      "flyway:workingDirectory",
      "flyway:table",
      "flyway:environment",
    ];
  },

  initTemplates(template?: string): InitTemplateSet {
    if (template === "multi-env") {
      return {
        src: {
          "config.ts": `import { FlywayConfig } from "@intentius/chant-lexicon-flyway";

export const config = new FlywayConfig({
  locations: ["filesystem:sql/migrations"],
  defaultSchema: "public",
  encoding: "UTF-8",
  validateMigrationNaming: true,
  cleanDisabled: true,
  table: "flyway_schema_history",
});
`,
          "infra.ts": `import { FlywayProject, Environment } from "@intentius/chant-lexicon-flyway";

export const project = new FlywayProject({
  id: "my-project",
  name: "my-project",
  databaseType: "postgresql",
});

export const dev = new Environment({
  url: "jdbc:postgresql://localhost:5432/devdb",
  user: "dev_user",
  password: "dev_pass",
  schemas: ["public"],
  displayName: "dev",
});

export const shadow = new Environment({
  url: "jdbc:postgresql://localhost:5432/shadowdb",
  user: "dev_user",
  password: "dev_pass",
  schemas: ["public"],
  displayName: "shadow",
  provisioner: "clean",
});

export const staging = new Environment({
  url: "jdbc:postgresql://staging-host:5432/stagingdb",
  user: "staging_user",
  schemas: ["public"],
  displayName: "staging",
});

export const prod = new Environment({
  url: "jdbc:postgresql://prod-host:5432/proddb",
  user: "prod_user",
  schemas: ["public"],
  displayName: "prod",
});
`,
        },
      };
    }

    if (template === "vault-secured") {
      return {
        src: {
          "config.ts": `import { FlywayConfig } from "@intentius/chant-lexicon-flyway";

export const config = new FlywayConfig({
  locations: ["filesystem:sql/migrations"],
  defaultSchema: "public",
  encoding: "UTF-8",
  validateMigrationNaming: true,
  cleanDisabled: true,
});
`,
          "infra.ts": `import { FlywayProject, Environment, VaultResolver } from "@intentius/chant-lexicon-flyway";
import { resolve } from "@intentius/chant-lexicon-flyway/intrinsics";

export const project = new FlywayProject({
  id: "my-project",
  name: "my-project",
  databaseType: "postgresql",
});

export const vault = new VaultResolver({
  url: "https://vault.example.com",
  token: "\${env.VAULT_TOKEN}",
  engineName: "secret",
  engineVersion: "v2",
});

export const dev = new Environment({
  url: "jdbc:postgresql://localhost:5432/devdb",
  user: "dev_user",
  password: "dev_pass",
  schemas: ["public"],
  displayName: "dev",
});

export const prod = new Environment({
  url: resolve("vault", "prod-db-url"),
  user: resolve("vault", "prod-db-user"),
  password: resolve("vault", "prod-db-password"),
  schemas: ["public"],
  displayName: "prod",
});
`,
        },
      };
    }

    if (template === "docker-dev") {
      return {
        src: {
          "config.ts": `import { FlywayConfig } from "@intentius/chant-lexicon-flyway";

export const config = new FlywayConfig({
  locations: ["filesystem:sql/migrations"],
  defaultSchema: "public",
  encoding: "UTF-8",
  validateMigrationNaming: true,
});
`,
          "infra.ts": `import { FlywayProject, Environment } from "@intentius/chant-lexicon-flyway";

export const project = new FlywayProject({
  id: "my-project",
  name: "my-project",
  databaseType: "postgresql",
});

export const dev = new Environment({
  url: "jdbc:postgresql://localhost:5432/devdb",
  user: "postgres",
  password: "postgres",
  schemas: ["public"],
  displayName: "dev",
  provisioner: "docker",
});

export const shadow = new Environment({
  url: "jdbc:postgresql://localhost:5432/shadowdb",
  user: "postgres",
  password: "postgres",
  schemas: ["public"],
  displayName: "shadow",
  provisioner: "clean",
});
`,
        },
      };
    }

    // Default template — single environment
    return {
      src: {
        "config.ts": `import { FlywayConfig } from "@intentius/chant-lexicon-flyway";

export const config = new FlywayConfig({
  locations: ["filesystem:sql/migrations"],
  defaultSchema: "public",
  encoding: "UTF-8",
  validateMigrationNaming: true,
  cleanDisabled: true,
  table: "flyway_schema_history",
});
`,
        "infra.ts": `import { FlywayProject, Environment } from "@intentius/chant-lexicon-flyway";

export const project = new FlywayProject({
  id: "my-project",
  name: "my-project",
  databaseType: "postgresql",
});

export const dev = new Environment({
  url: process.env.FLYWAY_URL ?? "jdbc:postgresql://localhost:5432/devdb",
  user: process.env.FLYWAY_USER ?? "dev_user",
  password: process.env.FLYWAY_PASSWORD ?? "dev_pass",
  schemas: ["public"],
  displayName: "dev",
});
`,
      },
    };
  },

  detectTemplate(data: unknown): boolean {
    if (typeof data !== "object" || data === null) return false;
    const obj = data as Record<string, unknown>;

    // Flyway TOML has [flyway] or [environments] sections
    if (obj.flyway !== undefined) return true;
    if (obj.environments !== undefined) return true;

    // Check if the raw content is TOML with flyway sections
    if (typeof data === "string") {
      try {
        const parsed = parseTOML(data as string);
        return parsed.flyway !== undefined || parsed.environments !== undefined;
      } catch {
        return false;
      }
    }

    return false;
  },

  completionProvider(ctx: import("@intentius/chant/lsp/types").CompletionContext) {
    return flywayCompletions(ctx);
  },

  hoverProvider(ctx: import("@intentius/chant/lsp/types").HoverContext) {
    return flywayHover(ctx);
  },

  templateParser() {
    return new FlywayParser();
  },

  templateGenerator() {
    return new FlywayGenerator();
  },

  async docs(options?: { verbose?: boolean }): Promise<void> {
    const { generateDocs } = await import("./codegen/docs");
    await generateDocs(options);
  },

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
    const { analyzeFlywyCoverage } = await import("./coverage");
    await analyzeFlywyCoverage({
      verbose: options?.verbose,
      minOverall: options?.minOverall,
    });
  },

  async package(options?: { verbose?: boolean; force?: boolean }): Promise<void> {
    const { packageLexicon } = await import("./codegen/package");
    const { writeBundleSpec } = await import("@intentius/chant/codegen/package");
    const { join, dirname } = await import("path");
    const { fileURLToPath } = await import("url");

    const { spec, stats } = await packageLexicon({ verbose: options?.verbose, force: options?.force });

    const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
    const distDir = join(pkgDir, "dist");
    writeBundleSpec(spec, distDir);

    console.error(`Packaged ${stats.resources} resources, ${stats.ruleCount} rules, ${stats.skillCount} skills`);
  },

  mcpTools() {
    return [createDiffTool(flywaySerializer, "Compare current build output against previous output for Flyway config")];
  },

  mcpResources() {
    return [
      createCatalogResource(import.meta.url, "Flyway Resource Catalog", "JSON list of all supported Flyway config types", "lexicon-flyway.json"),
      {
        uri: "examples/multi-environment",
        name: "Multi-Environment Flyway Config",
        description: "A Flyway config with dev, shadow, staging, and production environments",
        mimeType: "text/toml",
        async handler(): Promise<string> {
          return `[flyway]
locations = ["filesystem:sql/migrations"]
defaultSchema = "public"
schemas = ["public"]
encoding = "UTF-8"
validateMigrationNaming = true
cleanDisabled = true

[environments.dev]
url = "jdbc:postgresql://localhost:5432/devdb"
user = "dev_user"
schemas = ["public"]

[environments.shadow]
url = "jdbc:postgresql://localhost:5432/shadowdb"
user = "dev_user"
schemas = ["public"]
provisioner = "clean"

[environments.prod]
url = "jdbc:postgresql://prod-host:5432/proddb"
user = "prod_user"
schemas = ["public"]
`;
        },
      },
      {
        uri: "examples/vault-secured",
        name: "Vault-Secured Flyway Config",
        description: "A Flyway config using HashiCorp Vault for credential resolution",
        mimeType: "text/toml",
        async handler(): Promise<string> {
          return `[flyway]
locations = ["filesystem:sql/migrations"]
defaultSchema = "public"
cleanDisabled = true

[environments.dev]
url = "jdbc:postgresql://localhost:5432/devdb"
user = "dev_user"
password = "dev_pass"
schemas = ["public"]

[environments.prod]
url = "\${vault.prod-db-url}"
user = "\${vault.prod-db-user}"
password = "\${vault.prod-db-password}"
schemas = ["public"]

[environments.prod.resolvers.vault]
url = "https://vault.example.com"
token = "\${env.VAULT_TOKEN}"
engineName = "secret"
engineVersion = "v2"
`;
        },
      },
    ];
  },

  skills: createSkillsLoader(import.meta.url, [
    {
      file: "chant-flyway.md",
      name: "chant-flyway",
      description: "Flyway migration lifecycle — scaffold, build, validate, deploy, rollback, Desktop workflow, troubleshoot",
      triggers: [
        { type: "file-pattern", value: "**/*.flyway.ts" },
        { type: "file-pattern", value: "**/flyway/**/*.ts" },
        { type: "file-pattern", value: "**/flyway.toml" },
        { type: "context", value: "flyway" },
        { type: "context", value: "migration" },
        { type: "context", value: "database migration" },
        { type: "context", value: "flyway desktop" },
        { type: "context", value: "schema model" },
        { type: "context", value: "flyway undo" },
      ],
      preConditions: [
        "chant CLI is installed (chant --version succeeds)",
        "Flyway CLI is installed (flyway --version succeeds)",
        "Project has chant source files in src/",
      ],
      postConditions: [
        "Migrations are in a consistent state (flyway validate succeeds)",
        "No FAILED migrations in flyway info output",
      ],
      parameters: [],
      examples: [
        {
          title: "Basic Flyway project",
          description: "Create a FlywayProject with a dev Environment",
          input: "Create a Flyway config for PostgreSQL",
          output: `import { FlywayProject, FlywayConfig, Environment } from "@intentius/chant-lexicon-flyway";

export const project = new FlywayProject({
  id: "my-project",
  name: "my-project",
  databaseType: "postgresql",
});

export const config = new FlywayConfig({
  locations: ["filesystem:sql/migrations"],
  defaultSchema: "public",
  cleanDisabled: true,
});

export const dev = new Environment({
  url: "jdbc:postgresql://localhost:5432/devdb",
  user: "dev_user",
  password: "dev_pass",
  schemas: ["public"],
  displayName: "dev",
});`,
        },
        {
          title: "Deploy migrations",
          description: "Build config and run migrations",
          input: "Deploy my Flyway migrations to dev",
          output: `chant build src/ --output flyway.toml
flyway -environment=dev validate
flyway -environment=dev migrate
flyway -environment=dev info`,
        },
        {
          title: "Preview migration changes",
          description: "Build config and preview what will change before deploying",
          input: "Show me what migrations are pending for production",
          output: `# Build current config
chant build src/ --output flyway.toml

# Review TOML changes
chant diff

# Check pending migrations against prod
flyway -environment=prod info

# Validate before deploying
flyway -environment=prod validate`,
        },
        {
          title: "Set up Desktop workflow",
          description: "Create a DesktopProject for Redgate Flyway Desktop with diff and generate",
          input: "Set up a Flyway Desktop project with schema model",
          output: `import { DesktopProject } from "@intentius/chant-lexicon-flyway";

const result = DesktopProject({
  name: "my-app",
  databaseType: "postgresql",
  devUrl: "jdbc:postgresql://localhost:5432/devdb",
  shadowUrl: "jdbc:postgresql://localhost:5432/shadowdb",
  schemaModelLocation: "./schema-model",
  undoScripts: true,
});

// After build:
// flyway diff -diff.source=env:development -diff.target=schemaModel
// flyway generate
// flyway -environment=shadow migrate`,
        },
        {
          title: "Add Vault-secured production environment",
          description: "Use VaultSecuredProject composite for HashiCorp Vault credentials",
          input: "Add a Vault-secured production environment",
          output: `import { VaultSecuredProject } from "@intentius/chant-lexicon-flyway";

const result = VaultSecuredProject({
  name: "my-app",
  databaseType: "postgresql",
  vaultUrl: "https://vault.example.com",
  vaultToken: "\${env.VAULT_TOKEN}",
  environments: [
    { name: "dev", url: "jdbc:postgresql://localhost:5432/devdb" },
    {
      name: "prod",
      url: "jdbc:postgresql://prod:5432/db",
      userKey: "prod-db-user",
      passwordKey: "prod-db-password",
    },
  ],
});`,
        },
      ],
    },
    {
      file: "chant-flyway-migrations.md",
      name: "chant-flyway-migrations",
      description: "Flyway migration naming, versioned vs repeatable, callbacks, and multi-environment patterns",
      triggers: [
        { type: "context", value: "flyway migration" },
        { type: "context", value: "versioned migration" },
        { type: "context", value: "repeatable migration" },
        { type: "context", value: "flyway callback" },
        { type: "context", value: "migration naming" },
      ],
      parameters: [],
      examples: [
        {
          title: "Multi-environment config",
          input: "Set up Flyway for dev, staging, and production",
          output: "import { environmentGroup } from \"@intentius/chant-lexicon-flyway\";\n\nconst envs = environmentGroup({ schemas: [\"public\"], environments: { dev: { url: \"...\" }, prod: { url: \"...\" } } });",
        },
      ],
    },
    {
      file: "chant-flyway-security.md",
      name: "chant-flyway-security",
      description: "Flyway credential management, vault integration, clean protection, and security best practices",
      triggers: [
        { type: "context", value: "flyway security" },
        { type: "context", value: "flyway vault" },
        { type: "context", value: "flyway credentials" },
        { type: "context", value: "clean protection" },
      ],
      parameters: [],
      examples: [
        {
          title: "Vault-secured production",
          input: "Secure Flyway credentials with HashiCorp Vault",
          output: "import { VaultSecuredProject } from \"@intentius/chant-lexicon-flyway\";\n\nconst result = VaultSecuredProject({ name: \"my-app\", vaultUrl: \"https://vault.example.com\", ... });",
        },
      ],
    },
  ]),
};
