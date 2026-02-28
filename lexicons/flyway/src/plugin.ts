/**
 * Flyway lexicon plugin.
 *
 * Provides serializer, template detection, code generation,
 * lint rules, and LSP/MCP integration for Flyway TOML config.
 */

import { createRequire } from "module";
import type { LexiconPlugin, IntrinsicDef, SkillDefinition, InitTemplateSet } from "@intentius/chant/lexicon";
const require = createRequire(import.meta.url);
import type { LintRule } from "@intentius/chant/lint/rule";
import type { PostSynthCheck } from "@intentius/chant/lint/post-synth";
import { flywaySerializer } from "./serializer";
import { parseTOML } from "@intentius/chant/toml";

export const flywayPlugin: LexiconPlugin = {
  name: "flyway",
  serializer: flywaySerializer,

  lintRules(): LintRule[] {
    const { hardcodedCredentialsRule } = require("./lint/rules/hardcoded-credentials");
    const { hardcodedUrlRule } = require("./lint/rules/hardcoded-url");
    const { missingSchemasRule } = require("./lint/rules/missing-schemas");
    const { invalidMigrationNameRule } = require("./lint/rules/invalid-migration-name");
    const { duplicateVersionRule } = require("./lint/rules/duplicate-version");
    return [hardcodedCredentialsRule, hardcodedUrlRule, missingSchemasRule, invalidMigrationNameRule, duplicateVersionRule];
  },

  postSynthChecks(): PostSynthCheck[] {
    const { wfw101 } = require("./lint/post-synth/wfw101");
    const { wfw102 } = require("./lint/post-synth/wfw102");
    const { wfw103 } = require("./lint/post-synth/wfw103");
    const { wfw104 } = require("./lint/post-synth/wfw104");
    const { wfw105 } = require("./lint/post-synth/wfw105");
    const { wfw106 } = require("./lint/post-synth/wfw106");
    const { wfw107 } = require("./lint/post-synth/wfw107");
    const { wfw108 } = require("./lint/post-synth/wfw108");
    const { wfw109 } = require("./lint/post-synth/wfw109");
    const { wfw110 } = require("./lint/post-synth/wfw110");
    const { wfw111 } = require("./lint/post-synth/wfw111");
    return [wfw101, wfw102, wfw103, wfw104, wfw105, wfw106, wfw107, wfw108, wfw109, wfw110, wfw111];
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
    const { flywayCompletions } = require("./lsp/completions");
    return flywayCompletions(ctx);
  },

  hoverProvider(ctx: import("@intentius/chant/lsp/types").HoverContext) {
    const { flywayHover } = require("./lsp/hover");
    return flywayHover(ctx);
  },

  templateParser() {
    const { FlywayParser } = require("./import/parser");
    return new FlywayParser();
  },

  templateGenerator() {
    const { FlywayGenerator } = require("./import/generator");
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
    return [
      {
        name: "diff",
        description: "Compare current build output against previous output for Flyway config",
        inputSchema: {
          type: "object" as const,
          properties: {
            path: {
              type: "string",
              description: "Path to the infrastructure project directory",
            },
          },
        },
        async handler(params: Record<string, unknown>): Promise<unknown> {
          const { diffCommand } = await import("@intentius/chant/cli/commands/diff");
          const result = await diffCommand({
            path: (params.path as string) ?? ".",
            serializers: [flywaySerializer],
          });
          return result;
        },
      },
    ];
  },

  mcpResources() {
    return [
      {
        uri: "resource-catalog",
        name: "Flyway Resource Catalog",
        description: "JSON list of all supported Flyway config types",
        mimeType: "application/json",
        async handler(): Promise<string> {
          const lexicon = require("./generated/lexicon-flyway.json") as Record<string, { resourceType: string; kind: string }>;
          const entries = Object.entries(lexicon).map(([className, entry]) => ({
            className,
            resourceType: entry.resourceType,
            kind: entry.kind,
          }));
          return JSON.stringify(entries);
        },
      },
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

  skills(): SkillDefinition[] {
    return [
      {
        name: "chant-flyway",
        description: "Flyway migration lifecycle — scaffold, build, validate, deploy, rollback, Desktop workflow, troubleshoot",
        content: `---
skill: chant-flyway
description: Build, validate, and deploy Flyway database migrations from a chant project
user-invocable: true
---

# Flyway Migration Operational Playbook

## How chant and Flyway relate

chant is a **synthesis-only** tool — it compiles TypeScript source files into \`flyway.toml\` (TOML config). chant does NOT call Flyway or interact with databases. Your job as an agent is to bridge the two:

- Use **chant** for: build, lint, diff (local TOML comparison)
- Use **flyway CLI** for: migrate, validate, info, clean, baseline, repair, diff, generate, undo

The source of truth for migration configuration is the TypeScript in \`src/\`. The generated \`flyway.toml\` is an intermediate artifact — never edit it by hand.

## Scaffolding a new project

### Initialize with a template

\`\`\`bash
chant init --lexicon flyway                        # default: single environment
chant init --lexicon flyway --template multi-env    # dev/shadow/staging/prod
chant init --lexicon flyway --template vault-secured # Vault for credentials
chant init --lexicon flyway --template docker-dev   # Docker provisioner
\`\`\`

### Available templates

| Template | What it generates | Best for |
|----------|-------------------|----------|
| *(default)* | FlywayProject + single dev Environment | Getting started |
| \`multi-env\` | 4 environments (dev/shadow/staging/prod) | Standard multi-env workflow |
| \`vault-secured\` | VaultResolver + secured environments | Enterprise credential management |
| \`docker-dev\` | Docker provisioner + clean shadow | Local development |

## Build and validate

### Build the config

\`\`\`bash
chant build src/ --output flyway.toml
\`\`\`

### Lint the source

\`\`\`bash
chant lint src/
\`\`\`

### What each step catches

| Step | Catches | When to run |
|------|---------|-------------|
| \`chant lint\` | Hardcoded credentials (WFW001), hardcoded URLs (WFW002), missing schemas (WFW003), invalid migration name (WFW004), duplicate version (WFW005) | Every edit |
| \`chant build\` | Post-synth: prod-clean-enabled (WFW101), missing validate-on-migrate (WFW102), prod-baseline (WFW103), unresolved refs (WFW104), empty locations (WFW105), invalid callback (WFW106), enterprise-only callback (WFW107), missing env URL (WFW108), provisioner missing filePath (WFW109), schema mismatch (WFW110) | Before deploy |
| \`flyway validate\` | Schema history mismatches, failed checksums | Before production migrate |

## Diff and preview

Before deploying, preview what will change at both the TOML and database levels.

### TOML-level diff (local, no database)

\`\`\`bash
# Build current config
chant build src/ --output flyway.toml

# Compare against previous build (uses chant's built-in diff)
chant diff
\`\`\`

### Database-level preview

\`\`\`bash
# Show pending migrations and current state
flyway -environment=dev info

# Validate that pending migrations are well-formed
flyway -environment=dev validate

# For production — always validate before migrate
flyway -environment=prod validate
\`\`\`

### Safe preview checklist

1. \`chant build\` — generates fresh \`flyway.toml\`
2. \`chant diff\` — review TOML changes since last build
3. \`flyway info\` — confirm which migrations are pending
4. \`flyway validate\` — ensure no checksum mismatches or conflicts
5. Review migration SQL files for correctness
6. Only then proceed to \`flyway migrate\`

## Running migrations

### Deployment strategies

| Strategy | Steps | When to use |
|----------|-------|-------------|
| **Safe path** (production) | build → lint → validate → info → migrate → verify | Any production deployment |
| **Fast path** (dev) | build → migrate | Local development iteration |
| **Desktop path** | edit schema model → diff → generate → apply → push | Redgate Desktop workflow |

### Safe path (production)

\`\`\`bash
# 1. Build config
chant build src/ --output flyway.toml

# 2. Lint
chant lint src/

# 3. Validate against target environment
flyway -environment=prod validate

# 4. Preview pending migrations
flyway -environment=prod info

# 5. Apply migrations
flyway -environment=prod migrate

# 6. Verify
flyway -environment=prod info
\`\`\`

### Fast path (dev)

\`\`\`bash
chant build src/ --output flyway.toml
flyway -environment=dev migrate
\`\`\`

### Environment management

\`\`\`bash
# Dev environment
flyway -environment=dev migrate

# Staging (from CI)
flyway -environment=staging migrate

# Production (with validation)
flyway -environment=prod validate
flyway -environment=prod migrate
\`\`\`

## Desktop workflow (Redgate Flyway Desktop)

The Desktop workflow uses a schema model as the source of truth, then auto-generates versioned migrations from diffs against a shadow database.

### Key concepts

- **Schema model** — a folder of SQL files representing the desired database state
- **Shadow database** — a disposable database rebuilt from migrations (\`provisioner: "clean"\`)
- **Development database** — the live dev database you modify directly
- \`flyway diff\` — compares development DB against the schema model
- \`flyway generate\` — creates a new versioned migration from the diff

### Typical Desktop flow

\`\`\`bash
# 1. Make changes directly in your development database (via SQL editor, ORM, etc.)

# 2. Diff: compare development DB to schema model
flyway diff -diff.source=env:development -diff.target=schemaModel

# 3. Generate: create a versioned migration from the diff
flyway generate

# 4. Apply: run the new migration against shadow to verify
flyway -environment=shadow migrate

# 5. Verify: confirm schema model is in sync
flyway diff -diff.source=env:shadow -diff.target=schemaModel

# 6. Push migrations to version control
\`\`\`

### DesktopProject composite

\`\`\`typescript
import { DesktopProject } from "@intentius/chant-lexicon-flyway";

const result = DesktopProject({
  name: "my-app",
  databaseType: "postgresql",
  devUrl: "jdbc:postgresql://localhost:5432/devdb",
  shadowUrl: "jdbc:postgresql://localhost:5432/shadowdb",
  schemas: ["public"],
  schemaModelLocation: "./schema-model",
  undoScripts: true,
  environments: [
    { name: "staging", url: "jdbc:postgresql://staging:5432/db" },
    { name: "prod", url: "jdbc:postgresql://prod:5432/db" },
  ],
});
\`\`\`

This generates: FlywayProject, FlywayConfig (with \`schemaModelLocation\`), FlywayDesktopConfig (\`developmentEnvironment\`, \`shadowEnvironment\`, undo settings), development Environment, shadow Environment (with \`provisioner: "clean"\`), and any downstream environments.

## Rollback and undo

### flyway undo (Enterprise tier)

\`\`\`bash
# Undo the last applied versioned migration
flyway -environment=prod undo
\`\`\`

Requires U-prefixed undo scripts (e.g., \`U1__Undo_create_users.sql\`) and an Enterprise license.

### flyway repair

\`\`\`bash
# Fix checksum mismatches in schema history
flyway -environment=dev repair
\`\`\`

Use \`repair\` when applied migrations have been edited and checksums no longer match. This updates the schema history — it does NOT change the database schema.

### Manual rollback pattern

When \`undo\` is unavailable (Community/Teams tier), write a compensating migration:

\`\`\`sql
-- V3__Undo_add_column.sql
ALTER TABLE users DROP COLUMN IF EXISTS middle_name;
\`\`\`

### When to use each approach

| Approach | Tier | What it does | When to use |
|----------|------|-------------|-------------|
| \`flyway undo\` | Enterprise | Runs U-script, removes last V from history | Clean rollback of recent migration |
| \`flyway repair\` | All | Updates checksums in history table | Checksum mismatch after harmless edit |
| Compensating V-migration | All | Forward-only fix via new migration | No undo scripts; production rollback |

## Resolvers and credentials

Flyway supports multiple resolver types for injecting secrets into \`flyway.toml\` without hardcoding them.

### Resolver types

| Syntax | Source | Best for |
|--------|--------|----------|
| \`\${env.VAR_NAME}\` | Environment variable | CI/CD pipelines, local dev |
| \`\${vault.key}\` | HashiCorp Vault | Enterprise secret management |
| \`\${localSecret.key}\` | \`flyway.user.toml\` | Local developer secrets |
| \`\${googlesecrets.name}\` | GCP Secret Manager | GCP-hosted environments |

### When to use which resolver

- **Local development**: \`\${localSecret.key}\` with \`flyway.user.toml\`, or plain values in dev Environment
- **CI/CD**: \`\${env.VAR}\` — inject from pipeline secrets
- **Production (Vault)**: \`\${vault.key}\` with a VaultResolver
- **Production (GCP)**: \`\${googlesecrets.name}\` with a GcpResolver

Additional resolver types supported: \`\${dapr.key}\` (Dapr), \`\${clone.key}\` (Clone), \`\${azuread.key}\` (Azure AD), \`\${git.key}\` (Git). These are less common — see Flyway documentation for details.

### Two-file pattern (flyway.user.toml)

Split configuration into two files:

- **\`flyway.toml\`** — committed to VCS. Contains project structure, environments, migration config. Uses \`\${localSecret.key}\` for credentials.
- **\`flyway.user.toml\`** — gitignored. Contains actual secret values for the \`localSecret\` resolver.

\`\`\`toml
# flyway.user.toml (gitignored)
[localSecret]
dev_password = "actual_password_here"
prod_password = "actual_prod_password"
\`\`\`

In your chant source, reference these via the resolve intrinsic:

\`\`\`typescript
import { resolve } from "@intentius/chant-lexicon-flyway/intrinsics";

export const dev = new Environment({
  url: "jdbc:postgresql://localhost:5432/devdb",
  user: "dev_user",
  password: resolve("localSecret", "dev_password"),
  schemas: ["public"],
  displayName: "dev",
});
\`\`\`

## Composites

Composites are pre-built project patterns that generate multiple resources from a single configuration object. Use them to reduce boilerplate and enforce conventions.

### Available composites

| Composite | What it generates | Best for |
|-----------|-------------------|----------|
| \`StandardProject\` | project + dev (clean) + prod + config | Basic two-environment setup |
| \`MultiEnvironmentProject\` | project + N envs + optional shadow + config | Custom environment topologies |
| \`DesktopProject\` | project + config + desktop + dev + shadow + downstream envs | Redgate Desktop workflow |
| \`VaultSecuredProject\` | project + vault resolver + envs + config | HashiCorp Vault credentials |
| \`GcpSecuredProject\` | project + GCP resolver + envs + config | GCP Secret Manager credentials |
| \`CiPipelineProject\` | project + env with \`\${env.PREFIX_*}\` refs + strict config | CI/CD pipeline environments |
| \`DockerDevEnvironment\` | single env with auto-built JDBC URL + docker provisioner | Docker-based local dev |
| \`BlueprintMigrationSet\` | migration file name metadata + callbacks | Planning migration sequences |

### environmentGroup helper

Use \`environmentGroup()\` to define shared config with per-environment overrides:

\`\`\`typescript
import { environmentGroup } from "@intentius/chant-lexicon-flyway";

const envs = environmentGroup({
  schemas: ["public", "audit"],
  flyway: { validateMigrationNaming: true, outOfOrder: false },
  environments: {
    dev: {
      url: "jdbc:postgresql://localhost:5432/devdb",
      user: "dev_user",
      password: "dev_pass",
    },
    staging: {
      url: "jdbc:postgresql://staging:5432/db",
      user: "staging_user",
      flyway: { placeholders: { env: "staging" } },
    },
    prod: {
      url: "jdbc:postgresql://prod:5432/db",
      user: "prod_user",
      flyway: { placeholders: { env: "prod" }, cleanDisabled: true },
    },
  },
});
\`\`\`

**Merge semantics**: scalars — child wins; objects (e.g., \`placeholders\`) — deep merge (child keys override, parent keys preserved); arrays (e.g., \`locations\`) — child replaces parent entirely.

## CI/CD integration

### General pattern

\`\`\`bash
# In your CI pipeline:
# 1. Build config (chant runs in CI, no database needed)
chant build src/ --output flyway.toml

# 2. Lint (optional but recommended)
chant lint src/

# 3. Run migrations against target environment
flyway -environment=ci migrate
\`\`\`

### CiPipelineProject composite

\`\`\`typescript
import { CiPipelineProject } from "@intentius/chant-lexicon-flyway";

const result = CiPipelineProject({
  name: "my-app",
  databaseType: "postgresql",
  envVarPrefix: "FLYWAY",
  environmentName: "ci",
});
\`\`\`

This generates an environment with \`\${env.FLYWAY_URL}\`, \`\${env.FLYWAY_USER}\`, \`\${env.FLYWAY_PASSWORD}\` references and a strict config (\`validateMigrationNaming\`, \`validateOnMigrate\`, \`cleanDisabled: true\`).

### Environment variable injection

Set these in your CI provider's secret management:

\`\`\`bash
FLYWAY_URL=jdbc:postgresql://prod-host:5432/proddb
FLYWAY_USER=flyway_ci
FLYWAY_PASSWORD=<from-secret-store>
\`\`\`

## Migration file naming

| Prefix | Pattern | Example | Description |
|--------|---------|---------|-------------|
| V | V{version}__{description}.sql | V1__Create_users.sql | Versioned migration |
| R | R__{description}.sql | R__Refresh_views.sql | Repeatable migration |
| U | U{version}__{description}.sql | U1__Undo_create_users.sql | Undo migration (Enterprise) |

## Troubleshooting

| Problem | Diagnostic | Fix |
|---------|-----------|-----|
| "Validate failed" | \`flyway info\` — check for PENDING/FAILED | Fix migration SQL, then \`flyway repair\` |
| "Checksum mismatch" | Applied migration was modified | \`flyway repair\` to update checksums |
| "Out of order" | Migration version lower than applied | Set \`outOfOrder = true\` or fix version |
| "Schema not found" | Target schema doesn't exist | Create schema or fix \`schemas\` array |
| "Connection refused" | Database unreachable | Check \`url\`, network, database status |
| "Authentication failed" | Bad credentials | Check \`user\`/\`password\`, resolver config |
| Provisioner failure (clean) | \`cleanDisabled = true\` on shadow env | Set \`cleanDisabled = false\` or remove from shadow |
| Provisioner failure (docker) | Docker not running or image pull failed | Check \`docker ps\`, verify \`dockerImage\` value |
| Callback error | Callback script has SQL error | Check callback SQL in \`sql/callbacks/\`, fix syntax |
| "undo is not supported" | Using \`flyway undo\` without Enterprise license | Upgrade to Enterprise or use compensating V-migration |
| TOML parse error | Malformed \`flyway.toml\` output | Run \`chant build\` and check for TypeScript errors in \`src/\` |
| Encoding mismatch | Migration file encoding differs from config | Set \`encoding\` in FlywayConfig to match files (UTF-8 recommended) |
| Placeholder not resolved | \`\${placeholder}\` in SQL not matched | Check \`placeholders\` map in environment or config |
| Schema model out of sync | Desktop \`diff\` shows unexpected changes | Run \`flyway diff\` and \`flyway generate\` to reconcile |

## Quick reference

\`\`\`bash
# Build
chant build src/ --output flyway.toml

# Lint
chant lint src/

# Diff (TOML-level)
chant diff

# Info
flyway -environment=dev info

# Migrate
flyway -environment=dev migrate

# Validate
flyway -environment=dev validate

# Repair
flyway -environment=dev repair

# Baseline
flyway -environment=dev baseline

# Clean (dev only!)
flyway -environment=dev clean

# Undo (Enterprise)
flyway -environment=dev undo

# Desktop: diff
flyway diff -diff.source=env:development -diff.target=schemaModel

# Desktop: generate migration
flyway generate
\`\`\`
`,
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
    ];
  },
};
