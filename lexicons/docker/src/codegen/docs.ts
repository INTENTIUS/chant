/**
 * Docker lexicon docs generation.
 *
 * Uses the shared docsPipeline/writeDocsSite flow like every other lexicon
 * (chant #1731, #1755). Hand-written prose lives under docs/pages/, each
 * page tagged with a Diátaxis quadrant; index.mdx and serialization.mdx are
 * generated from the overview/outputFormat strings below, and rules.mdx is
 * generated from the rule sources under src/lint/ the same way it always
 * was — this used to be the one lexicon whose rules table could drift from
 * source without anything catching it (#1312), and the shared pipeline
 * keeps that guarantee.
 */

import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { docsPipeline, writeDocsSite, type DocsConfig } from "@intentius/chant/codegen/docs";

const overview = `
The **Docker** lexicon provides typed constructors for Docker Compose services
and Dockerfile build instructions — services, volumes, networks, configs, secrets,
and multi-stage Dockerfiles.

\`\`\`bash
npm install --save-dev @intentius/chant-lexicon-docker
\`\`\`

## Quick Start

\`\`\`typescript
import { Service, Volume, Dockerfile, env } from "@intentius/chant-lexicon-docker";

export const db = new Service({
  image: "postgres:16-alpine",
  environment: {
    POSTGRES_DB: "myapp",
    POSTGRES_PASSWORD: env("DB_PASSWORD", { required: true }),
  },
  volumes: ["pgdata:/var/lib/postgresql/data"],
});

export const pgdata = new Volume({});

export const api = new Service({
  image: "myapp:1.0",
  ports: ["8080:8080"],
  depends_on: ["db"],
});
\`\`\`

Build:

\`\`\`bash
chant build src --lexicon docker -o docker-compose.yml
\`\`\`

## Output Domains

| Entity | Output file | Section |
|--------|-------------|---------|
| \`Service\` | \`docker-compose.yml\` | \`services:\` |
| \`Volume\` | \`docker-compose.yml\` | \`volumes:\` |
| \`Network\` | \`docker-compose.yml\` | \`networks:\` |
| \`Config\` | \`docker-compose.yml\` | \`configs:\` |
| \`Secret\` | \`docker-compose.yml\` | \`secrets:\` |
| \`Dockerfile\` | \`Dockerfile.{name}\` | — |`;

const outputFormat = `
The Docker lexicon serializes to two output formats.

## docker-compose.yml

\`\`\`bash
chant build src --lexicon docker -o docker-compose.yml
\`\`\`

Each entity type maps to a top-level Compose section. The TypeScript export name becomes the key within that section.

\`\`\`typescript
export const db = new Service({ image: "postgres:16-alpine" });
export const pgdata = new Volume({});
export const backend = new Network({ driver: "bridge" });
\`\`\`

Produces:

\`\`\`yaml
services:
  db:
    image: postgres:16-alpine

volumes:
  pgdata: null

networks:
  backend:
    driver: bridge
\`\`\`

\`defaultLabels()\` entities are not emitted as separate keys — their labels are merged into each service.

## Dockerfile.\\{name\\}

\`\`\`bash
chant build src --lexicon docker
# Writes Dockerfile.app, Dockerfile.builder, etc.
\`\`\`

Each \`Dockerfile\` entity produces a separate file. The export name is the suffix.

\`\`\`typescript
export const builder = new Dockerfile({ from: "node:20-alpine", ... });
// → Dockerfile.builder
\`\`\`

## Field mapping

| TypeScript | docker-compose.yml | Notes |
|-----------|-------------------|-------|
| \`env("X", { required: true })\` | \`\${X:?X is required}\` | Compose interpolation |
| \`env("X", { default: "v" })\` | \`\${X:-v}\` | Compose interpolation |
| \`env("X")\` | \`\${X}\` | Compose interpolation |
| \`external: true\` | \`external: true\` | Volume/Network |

## Specifying lexicon at build time

The \`--lexicon docker\` flag restricts output to Docker entities only — useful in mixed-lexicon projects:

\`\`\`bash
# Only Docker output
chant build src --lexicon docker -o docker-compose.yml

# Other lexicons still get their own outputs
chant build src --lexicon aws -o template.json
\`\`\``;

export async function generateDocs(opts?: { verbose?: boolean }): Promise<void> {
  const pkgDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

  const config: DocsConfig = {
    name: "docker",
    displayName: "Docker",
    description: "Typed constructors for Docker Compose and Dockerfile configuration",
    distDir: join(pkgDir, "dist"),
    outDir: join(pkgDir, "docs"),
    basePath: "/chant/lexicons/docker/",
    overview,
    outputFormat,
  };

  const result = docsPipeline(config);
  writeDocsSite(config, result);

  if (opts?.verbose) {
    console.error("Documentation generated");
  }
}
