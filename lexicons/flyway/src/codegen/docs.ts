/**
 * Documentation generation for the Flyway lexicon.
 *
 * Generates Starlight MDX pages for Flyway config types using the core docs pipeline.
 */

import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { docsPipeline, writeDocsSite, type DocsConfig } from "@intentius/chant/codegen/docs";

/**
 * Extract service name from Flyway type: "Flyway::Resolver.Vault" → "Resolvers"
 */
function serviceFromType(resourceType: string): string {
  const parts = resourceType.split("::");
  if (parts.length < 2) return "Core";
  const sub = parts[1];
  if (sub.startsWith("Resolver.")) return "Resolvers";
  if (sub.startsWith("Provisioner.")) return "Provisioners";
  if (sub.startsWith("Database.")) return "Databases";
  if (sub === "Environment" || sub === "Environment.Flyway") return "Environments";
  return "Core";
}

const overview = `The **Flyway** lexicon provides typed constructors for Flyway v10+ TOML
configuration files. It covers projects, environments, resolvers, provisioners,
placeholders, callbacks, and database-specific settings.

Install it with:

\`\`\`bash
npm install --save-dev @intentius/chant-lexicon-flyway
\`\`\`

## Quick Start

\`\`\`typescript
import { FlywayProject, FlywayConfig, Environment } from "@intentius/chant-lexicon-flyway";

export const project = new FlywayProject({
  id: "my-project",
  name: "my-project",
  databaseType: "postgresql",
});

export const config = new FlywayConfig({
  locations: ["filesystem:sql/migrations"],
  defaultSchema: "public",
  encoding: "UTF-8",
  validateMigrationNaming: true,
  cleanDisabled: true,
});

export const dev = new Environment({
  url: "jdbc:postgresql://localhost:5432/devdb",
  user: "dev_user",
  password: "dev_pass",
  schemas: ["public"],
  displayName: "dev",
});
\`\`\`

The lexicon provides **5 resource types** (FlywayProject, FlywayConfig, Environment, FlywayDesktopConfig, RedgateCompareConfig),
**20 property types** (resolvers, provisioners, database configs), and composites
(StandardProject, MultiEnvironmentProject, VaultSecuredProject, DesktopProject,
environmentGroup) for common patterns.

## Lint Rules

chant includes lint rules for Flyway config. For example:
- Hardcoded credentials in environment configs
- Production environments with clean enabled
- Missing schema definitions
- Unresolved resolver references
- Invalid callback event names

See [Lint Rules](./lint-rules) for the full list.
`;

const outputFormat = `The Flyway lexicon serializes resources into **TOML** format compatible with
Flyway v10+ CLI configuration (\`flyway.toml\`).

## Building

Run \`chant build\` to produce Flyway config from your declarations:

\`\`\`bash
chant build
# Writes dist/flyway.toml
\`\`\`

The generated file includes:

- Root-level project properties (id, name, databaseType)
- \`[flyway]\` namespace with global settings
- \`[environments.<name>]\` sections for each environment
- \`[environments.<name>.resolvers.<type>]\` for credential resolvers
- \`[flywayDesktop]\` and \`[redgateCompare]\` optional namespaces

## Key conversions

| Chant (TypeScript) | TOML output | Rule |
|--------------------|-------------|------|
| \`new FlywayProject({...})\` | Root-level keys | Project properties at document root |
| \`new FlywayConfig({...})\` | \`[flyway]\` section | Global Flyway settings |
| \`new Environment({displayName: "dev", ...})\` | \`[environments.dev]\` | Named environment section |
| \`resolve("vault", "password")\` | \`\${vault.password}\` | Resolver reference string |
| \`placeholder("defaultSchema")\` | \`\${flyway:defaultSchema}\` | Built-in placeholder string |

## Applying

The output is standard Flyway TOML. Use with the Flyway CLI:

\`\`\`bash
flyway -environment=dev migrate
flyway -environment=prod validate
\`\`\`
`;

/**
 * Generate documentation for the Flyway lexicon.
 */
export async function generateDocs(opts?: { verbose?: boolean }): Promise<void> {
  const pkgDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

  const config: DocsConfig = {
    name: "flyway",
    displayName: "Flyway",
    description: "Typed constructors for Flyway database migration configuration",
    distDir: join(pkgDir, "dist"),
    outDir: join(pkgDir, "docs"),
    overview,
    outputFormat,
    serviceFromType,
    suppressPages: ["rules"],
    extraPages: [
      {
        slug: "flyway-concepts",
        title: "Flyway Concepts",
        description: "How Flyway TOML config maps to chant constructs — namespaces, environments, resolvers",
        content: `Every exported resource declaration becomes a section in the generated \`flyway.toml\`. The serializer handles the translation automatically:

## TOML Namespaces

Flyway TOML has four top-level namespaces:

| Namespace | Chant Type | Description |
|-----------|-----------|-------------|
| Root level | \`FlywayProject\` | Project metadata (id, name, databaseType) |
| \`[flyway]\` | \`FlywayConfig\` | Global migration settings |
| \`[environments.<name>]\` | \`Environment\` | Per-environment connection config |
| \`[flywayDesktop]\` | \`FlywayDesktopConfig\` | Flyway Desktop IDE settings |
| \`[redgateCompare]\` | \`RedgateCompareConfig\` | Redgate Compare options |

## Resolver References

Flyway supports secret resolvers that inject credentials at runtime:

\`\`\`typescript
import { Environment, VaultResolver, resolve } from "@intentius/chant-lexicon-flyway";

export const vault = new VaultResolver({
  url: "https://vault.example.com",
  token: "\${env.VAULT_TOKEN}",
  engineName: "secret",
  engineVersion: "v2",
});

export const prod = new Environment({
  url: resolve("vault", "db-url"),
  user: resolve("vault", "db-user"),
  password: resolve("vault", "db-password"),
  schemas: ["public"],
  displayName: "prod",
});
\`\`\`

This generates:

\`\`\`toml
[environments.prod]
url = "\${vault.db-url}"
user = "\${vault.db-user}"
password = "\${vault.db-password}"
schemas = ["public"]

[environments.prod.resolvers.vault]
url = "https://vault.example.com"
token = "\${env.VAULT_TOKEN}"
engineName = "secret"
engineVersion = "v2"
\`\`\`

## Per-Environment Flyway Overrides

Flyway v10+ supports per-environment flyway settings via \`[environments.<name>.flyway]\` sections. These override the global \`[flyway]\` settings for a specific environment:

\`\`\`typescript
import { Environment } from "@intentius/chant-lexicon-flyway";

export const prod = new Environment({
  url: "jdbc:postgresql://prod:5432/db",
  schemas: ["public"],
  displayName: "prod",
  flyway: {
    validateOnMigrate: true,
    cleanDisabled: true,
    placeholders: { logLevel: "warn" },
  },
});
\`\`\`

This generates:

\`\`\`toml
[environments.prod]
url = "jdbc:postgresql://prod:5432/db"
schemas = ["public"]

[environments.prod.flyway]
validateOnMigrate = true
cleanDisabled = true

[environments.prod.flyway.placeholders]
logLevel = "warn"
\`\`\`

The \`environmentGroup()\` composite makes this pattern even easier by deep-merging shared config into per-environment overrides — see the [Examples](/chant/lexicons/flyway/examples/) page.

## Provisioners

Provisioners automate environment setup:

| Provisioner | Use Case |
|-------------|----------|
| \`clean\` | Clean shadow databases before migration |
| \`docker\` | Spin up database containers for dev |
| \`backup\` | Restore from backup before applying |
| \`snapshot\` | Restore from snapshot |
| \`createdb\` | Create database if it doesn't exist |
`,
      },
      {
        slug: "lint-rules",
        title: "Lint Rules",
        description: "Built-in lint rules and post-synth checks for Flyway config",
        content: `The Flyway lexicon ships lint rules that run during \`chant lint\` and post-synth checks that validate the serialized TOML after \`chant build\`.

## Lint rules

### WFW001 — Hardcoded credentials
**Severity:** error | **Category:** security

Flags hardcoded password/user strings in Environment constructors.

### WFW002 — Hardcoded URL
**Severity:** warning | **Category:** security

Flags hardcoded JDBC URLs in Environment constructors.

### WFW003 — Missing schemas
**Severity:** warning | **Category:** correctness

Flags Environment constructors without a schemas property.

### WFW004 — Invalid migration name
**Severity:** warning | **Category:** correctness

Flags migration filenames that don't follow V/R/U naming convention.

### WFW005 — Duplicate version
**Severity:** error | **Category:** correctness

Flags duplicate version numbers in migration arrays.

## Post-synth checks

| Rule | Description |
|------|-------------|
| WFW101 | Production environment with clean enabled |
| WFW102 | Production environment missing validateOnMigrate |
| WFW103 | Production environment with baselineOnMigrate |
| WFW104 | Unresolved resolver reference |
| WFW105 | Empty or missing flyway.locations |
| WFW106 | Invalid callback event name |
| WFW107 | Enterprise-only callback (undo) |
| WFW108 | Environment without URL |
| WFW109 | Provisioner config mismatch |
| WFW110 | Environment schemas differ from parent environment schemas |
| WFW111 | Unknown key in TOML output — key is not a recognized Flyway property |
`,
      },
      {
        slug: "examples",
        title: "Examples",
        description: "Walkthrough of Flyway examples — standard projects, Desktop workflows, and environment overrides",
        content: `Runnable examples live in the lexicon's \`examples/\` directory. Clone the repo and try them:

\`\`\`bash
cd examples/basic-project
bun install
chant build    # produces flyway.toml
chant lint     # runs lint rules
bun test       # runs the example's tests
\`\`\`

## Basic Project

\`examples/basic-project/\` — a single-environment setup (dev only) using raw primitives (\`FlywayProject\`, \`FlywayConfig\`, \`Environment\`).

\`\`\`typescript
import { FlywayProject, FlywayConfig, Environment } from "@intentius/chant-lexicon-flyway";

export const project = new FlywayProject({
  name: "basic-app",
});

export const config = new FlywayConfig({
  defaultSchema: "public",
  locations: ["filesystem:sql"],
  databaseType: "postgresql",
  validateMigrationNaming: true,
  baselineOnMigrate: false,
});

export const dev = new Environment({
  name: "dev",
  url: "jdbc:postgresql://localhost:5432/basic_app_dev",
  schemas: ["public"],
  provisioner: "clean",
});
\`\`\`

## Desktop Project

\`examples/desktop-project/\` — the canonical Redgate Desktop workflow with development + shadow environments, \`[flywayDesktop]\` and \`[redgateCompare]\` sections.

\`\`\`typescript
import {
  DesktopProject, FlywayProject, FlywayConfig,
  Environment, FlywayDesktopConfig, RedgateCompareConfig,
} from "@intentius/chant-lexicon-flyway";

const result = DesktopProject({
  name: "inventory-service",
  databaseType: "postgresql",
  devUrl: "jdbc:postgresql://localhost:5432/inventory_dev",
  shadowUrl: "jdbc:postgresql://localhost:5432/inventory_shadow",
  schemas: ["public", "inventory"],
  environments: [
    { name: "test", url: "jdbc:postgresql://test:5432/db" },
    { name: "prod", url: "jdbc:postgresql://prod:5432/db" },
  ],
  filterFile: "./Filter.scpf",
});

export const project = new FlywayProject(result.project);
export const config = new FlywayConfig(result.config);
export const desktop = new FlywayDesktopConfig(result.desktop);
export const compare = new RedgateCompareConfig(result.compare!);
export const development = new Environment(result.development);
export const shadow = new Environment(result.shadow);
\`\`\`

**Key patterns:**
- Shadow always gets \`provisioner: "clean"\` (forgetting this breaks Desktop workflows)
- Uses \`schemaModelLocation\` in \`[flyway]\` (not the deprecated \`schemaModel\` in \`[flywayDesktop]\`)
- \`[redgateCompare]\` section only emitted when \`filterFile\` is provided

## Environment Overrides

\`examples/environment-overrides/\` — shared config deep-merged into per-environment overrides using \`environmentGroup()\`. Addresses the #1 Flyway feature request: per-environment placeholders without config repetition.

\`\`\`typescript
import { environmentGroup, Environment } from "@intentius/chant-lexicon-flyway";

const envs = environmentGroup({
  schemas: ["public"],
  flyway: {
    locations: ["filesystem:migrations"],
    cleanDisabled: true,
    placeholders: { appName: "payments", logLevel: "info" },
  },
  environments: {
    dev: {
      url: "jdbc:postgresql://localhost:5432/payments_dev",
      flyway: {
        cleanDisabled: false,
        placeholders: { logLevel: "debug" },
      },
    },
    staging: {
      url: "jdbc:postgresql://staging:5432/payments",
    },
    prod: {
      url: "jdbc:postgresql://prod:5432/payments",
      flyway: {
        validateOnMigrate: true,
        placeholders: { logLevel: "warn" },
      },
    },
  },
});

export const devEnv = new Environment(envs.dev);
export const stagingEnv = new Environment(envs.staging);
export const prodEnv = new Environment(envs.prod);
\`\`\`

**Deep merge semantics:**
- Scalars: child wins (override)
- Objects (like \`placeholders\`): recursive merge — child keys override, parent keys preserved
- Arrays (like \`locations\`): replace, not concatenate

**Result:** \`dev.flyway.placeholders = { appName: "payments", logLevel: "debug" }\` — \`appName\` inherited, \`logLevel\` overridden.

## Multi-Environment

\`examples/multi-environment/\` — four environments (dev, shadow, staging, prod) using the \`MultiEnvironmentProject\` composite.

## Vault-Secured

\`examples/vault-secured/\` — environments with HashiCorp Vault-backed credentials using \`\${vault.*}\` resolver references.

## Docker Dev

\`examples/docker-dev/\` — local development with Docker-provisioned databases.

## CI Pipeline

\`examples/ci-pipeline/\` — CI/CD-optimized project with environment variable credentials (\`\${env.*}\` patterns).

## Azure Secured

\`examples/azure-secured/\` — Azure AD authentication with \`AzureAdResolver\` for managed identity or service principal credentials to Azure SQL / PostgreSQL.

## GCP Secured

\`examples/gcp-secured/\` — environments with Google Cloud Secret Manager credentials.

## Multi-Schema

\`examples/multi-schema/\` — multiple schemas with cross-schema placeholder references.

## Callbacks

\`examples/callbacks/\` — lifecycle callbacks with \`BlueprintMigrationSet\`.

## Migration Lifecycle

\`examples/migration-lifecycle/\` — full runnable lifecycle: Docker, SQL migrations (V1→V3), and \`environmentGroup\` inheritance.
`,
      },
      {
        slug: "composites",
        title: "Composites",
        description: "Pre-built composite patterns for common Flyway project layouts",
        content: `Composites are factory functions that produce coordinated sets of resources for common Flyway project patterns. Instead of wiring up project, config, environments, and resolvers individually, call one function and export the results.

## StandardProject

The simplest starting point — a two-environment setup (dev + prod) with sensible defaults.

\`\`\`typescript
import { StandardProject, FlywayProject, FlywayConfig, Environment } from "@intentius/chant-lexicon-flyway";

const result = StandardProject({
  name: "my-app",
  databaseType: "postgresql",
  devUrl: "jdbc:postgresql://localhost:5432/dev",
  prodUrl: "jdbc:postgresql://prod:5432/app",
});

export const project = new FlywayProject(result.project);
export const config = new FlywayConfig(result.config);
export const dev = new Environment(result.dev);
export const prod = new Environment(result.prod);
\`\`\`

## MultiEnvironmentProject

N environments with shared config and increasing safety settings, plus an optional shadow database.

\`\`\`typescript
import { MultiEnvironmentProject } from "@intentius/chant-lexicon-flyway";

const result = MultiEnvironmentProject({
  name: "payments",
  databaseType: "postgresql",
  environments: [
    { name: "dev", url: "jdbc:postgresql://localhost:5432/pay_dev" },
    { name: "staging", url: "jdbc:postgresql://staging:5432/payments" },
    { name: "prod", url: "jdbc:postgresql://prod:5432/payments" },
  ],
  shadowUrl: "jdbc:postgresql://localhost:5432/pay_shadow",
  schemas: ["public", "payments"],
});
\`\`\`

## DesktopProject

Redgate Flyway Desktop workflow with development + shadow environments, \`[flywayDesktop]\` and \`[redgateCompare]\` sections. Shadow always gets \`provisioner: "clean"\` so Desktop schema comparisons work correctly.

\`\`\`typescript
import { DesktopProject } from "@intentius/chant-lexicon-flyway";

const result = DesktopProject({
  name: "inventory-service",
  databaseType: "postgresql",
  devUrl: "jdbc:postgresql://localhost:5432/inventory_dev",
  shadowUrl: "jdbc:postgresql://localhost:5432/inventory_shadow",
  schemas: ["public", "inventory"],
  filterFile: "./Filter.scpf",
});
\`\`\`

## VaultSecuredProject

HashiCorp Vault-backed credentials for all environments. Generates \`\${vault.*}\` resolver references and Vault resolver configuration automatically.

\`\`\`typescript
import { VaultSecuredProject } from "@intentius/chant-lexicon-flyway";

const result = VaultSecuredProject({
  name: "payments-db",
  databaseType: "postgresql",
  vaultUrl: "https://vault.internal:8200",
  vaultSecretPath: "secret/data/payments/db",
  environments: [
    { name: "staging", url: "jdbc:...", userKey: "staging_user", passwordKey: "staging_pass" },
    { name: "prod", url: "jdbc:...", userKey: "prod_user", passwordKey: "prod_pass" },
  ],
});
\`\`\`

## GcpSecuredProject

Google Cloud Secret Manager-backed credentials using the \`googlesecrets\` resolver type.

## CiPipelineProject

CI/CD-optimized project with \`\${env.*}\` patterns for environment variable injection. Designed for environments where credentials come from CI secret stores.

## DockerDevEnvironment

Local development with Docker-provisioned databases. Produces an environment with a Docker provisioner that spins up a database container automatically.

## BlueprintMigrationSet

Re-usable migration set pattern for shared schema definitions across multiple services.

## environmentGroup

Not a composite — a helper that deep-merges shared config into per-environment overrides. See the [Examples](/chant/lexicons/flyway/examples/) page for usage.
`,
      },
      {
        slug: "getting-started",
        title: "Getting Started",
        description: "Install the Flyway lexicon and build your first typed Flyway config",
        content: `## Installation

\`\`\`bash
# Initialize a new chant project with the Flyway lexicon
chant init --lexicon flyway my-flyway-project
cd my-flyway-project

# Or add to an existing project
npm install --save-dev @intentius/chant-lexicon-flyway
\`\`\`

## Your first Flyway config

Create \`src/infra.ts\`:

\`\`\`typescript
import {
  FlywayProject,
  FlywayConfig,
  Environment,
} from "@intentius/chant-lexicon-flyway";

export const project = new FlywayProject({
  id: "my-app",
  name: "my-app",
  databaseType: "postgresql",
});

export const config = new FlywayConfig({
  locations: ["filesystem:sql/migrations"],
  defaultSchema: "public",
  cleanDisabled: true,
  validateMigrationNaming: true,
});

export const dev = new Environment({
  url: "jdbc:postgresql://localhost:5432/myapp_dev",
  user: "dev_user",
  password: "dev_pass",
  schemas: ["public"],
  displayName: "dev",
});

export const prod = new Environment({
  url: "jdbc:postgresql://prod:5432/myapp",
  user: "\${vault.db-user}",
  password: "\${vault.db-password}",
  schemas: ["public"],
  displayName: "prod",
  cleanDisabled: true,
  validateOnMigrate: true,
});
\`\`\`

## Build and lint

\`\`\`bash
# Generate flyway.toml from your TypeScript declarations
chant build

# Run lint rules to catch configuration issues
chant lint
\`\`\`

The \`chant build\` command writes \`dist/flyway.toml\`. The \`chant lint\` command checks for:
- Hardcoded credentials
- Production environments without safety settings
- Missing migration locations
- Invalid callback events

## Using the StandardProject composite

For the common two-environment pattern, use the \`StandardProject\` composite:

\`\`\`typescript
import { StandardProject, FlywayProject, FlywayConfig, Environment } from "@intentius/chant-lexicon-flyway";

const result = StandardProject({
  name: "my-app",
  databaseType: "postgresql",
  devUrl: "jdbc:postgresql://localhost:5432/dev",
  prodUrl: "jdbc:postgresql://prod:5432/app",
});

export const project = new FlywayProject(result.project);
export const config = new FlywayConfig(result.config);
export const dev = new Environment(result.dev);
export const prod = new Environment(result.prod);
\`\`\`

## Next steps

- Browse [Examples](/chant/lexicons/flyway/examples/) for more patterns
- See [Composites](/chant/lexicons/flyway/composites/) for factory helpers
- Review [Lint Rules](/chant/lexicons/flyway/lint-rules/) for available checks
`,
      },
      {
        slug: "importing-toml",
        title: "Importing TOML",
        description: "Convert an existing flyway.toml into typed TypeScript declarations",
        content: `If you already have a \`flyway.toml\` file, chant can convert it into typed TypeScript declarations.

## Quick import

\`\`\`bash
chant import flyway.toml
\`\`\`

This reads your TOML config and generates a \`src/infra.ts\` file with typed constructors.

## Before and after

**Before** — \`flyway.toml\`:

\`\`\`toml
id = "payments"
name = "payments"
databaseType = "postgresql"

[flyway]
locations = ["filesystem:sql/migrations"]
defaultSchema = "public"
cleanDisabled = true

[environments.dev]
url = "jdbc:postgresql://localhost:5432/payments_dev"
user = "dev_user"
schemas = ["public"]

[environments.prod]
url = "jdbc:postgresql://prod:5432/payments"
user = "\${vault.db-user}"
password = "\${vault.db-password}"
schemas = ["public"]
cleanDisabled = true
validateOnMigrate = true

[environments.prod.resolvers.vault]
url = "https://vault.internal:8200"
token = "\${env.VAULT_TOKEN}"
engineName = "secret"
engineVersion = "v2"
\`\`\`

**After** — \`src/infra.ts\`:

\`\`\`typescript
import {
  FlywayProject, FlywayConfig, Environment,
  VaultResolver, resolve,
} from "@intentius/chant-lexicon-flyway";

export const project = new FlywayProject({
  id: "payments",
  name: "payments",
  databaseType: "postgresql",
});

export const config = new FlywayConfig({
  locations: ["filesystem:sql/migrations"],
  defaultSchema: "public",
  cleanDisabled: true,
});

export const dev = new Environment({
  url: "jdbc:postgresql://localhost:5432/payments_dev",
  user: "dev_user",
  schemas: ["public"],
  displayName: "dev",
});

export const vaultResolver = new VaultResolver({
  url: "https://vault.internal:8200",
  token: "\${env.VAULT_TOKEN}",
  engineName: "secret",
  engineVersion: "v2",
});

export const prod = new Environment({
  url: "jdbc:postgresql://prod:5432/payments",
  user: resolve("vault", "db-user"),
  password: resolve("vault", "db-password"),
  schemas: ["public"],
  cleanDisabled: true,
  validateOnMigrate: true,
  displayName: "prod",
});
\`\`\`

## What changes

| TOML | TypeScript |
|------|-----------|
| Inline strings | Typed constructor properties |
| \`\${resolver.key}\` patterns | \`resolve("resolver", "key")\` calls |
| \`\${flyway:name}\` placeholders | \`FLYWAY.name\` constants |
| Nested resolver configs | Separate \`VaultResolver\` / \`GcpResolver\` exports |

## Round-trip fidelity

Running \`chant build\` on the generated TypeScript produces TOML that is semantically identical to the original input. The only differences are formatting (key ordering, whitespace).
`,
      },
      {
        slug: "skills",
        title: "Skills",
        description: "AI skill and MCP tools for Flyway configuration assistance",
        content: `The Flyway lexicon includes the **chant-flyway** AI skill that provides context-aware assistance when working with Flyway configurations.

## MCP integration

When running \`chant serve mcp\`, the Flyway skill is automatically available to MCP-compatible AI tools (Claude, Cursor, etc.).

## What the skill provides

### Context

The skill gives the AI assistant knowledge of:
- All Flyway resource types (FlywayProject, FlywayConfig, Environment, resolvers, provisioners)
- Property constraints and valid values
- TOML serialization rules
- Composite patterns and when to use each
- Lint rule explanations

### Capabilities

With the Flyway skill active, an AI assistant can:
- **Generate** typed Flyway configs from natural language descriptions
- **Explain** existing configurations and their TOML output
- **Debug** lint rule violations with fix suggestions
- **Migrate** from plain TOML to typed TypeScript declarations
- **Recommend** composites based on project requirements

## Example prompts

- "Create a Flyway config for a PostgreSQL project with dev, staging, and prod environments"
- "Add Vault-secured credentials to my production environment"
- "Why is WFW101 flagging my config?"
- "Convert this flyway.toml to chant TypeScript"

## LSP integration

The Flyway lexicon also provides LSP support via \`chant serve lsp\`:
- **Completions** — type \`new \` to get Flyway resource completions
- **Hover** — hover over type names to see TOML serialization hints
`,
      },
    ],
    basePath: "/chant/lexicons/flyway/",
  };

  const result = await docsPipeline(config);
  writeDocsSite(config, result);

  if (opts?.verbose) {
    console.error(
      `Generated docs: ${result.stats.resources} resources, ${result.stats.properties} properties, ${result.stats.services} services, ${result.stats.rules} rules`,
    );
  }
}
