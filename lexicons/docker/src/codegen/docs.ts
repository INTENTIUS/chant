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

// "Optional: hand this page to your coding agent", shown under the overview's
// title. The Dockerfile shape is the ordered \`steps\` list from chant #3926.
const prompt = `Read https://intentius.io/chant/lexicons/docker/ and https://intentius.io/chant/lexicons/docker/dockerfiles/ first.
Bring this project's Docker files into chant TypeScript under src/.
Import each existing file. \`-o\` names a directory, and each import writes main.ts in it: \`chant import --lexicon docker docker-compose.yml -o src/compose/\`, and \`chant import --lexicon docker Dockerfile -o src/<name>/\` for each Dockerfile.
An imported Dockerfile is exported as \`app\`. Rename each export after its image, since the export name sets the output file (Dockerfile.<export>), and point the Compose service's \`build.dockerfile\` at that export (\`dockerfile: webImage\`) instead of the old file name.
Write every Dockerfile stage as an ordered \`steps\` list, one instruction per step, with FROM as the stage's \`from\` and ARGs before the first FROM in \`globalArgs\`:
  steps: [{ workdir: "/app" }, { copy: "package*.json ./" }, { run: "npm ci" }, { copy: ". ." }, { user: "node" }, { cmd: ["node", "dist/index.js"] }]
Where two Dockerfiles repeat a stage or a run of steps, export it once as a const (a \`DockerfileStage\` or a \`DockerfileStep[]\`) from its own module and import it in both. Spread imported consts, not function results; a Dockerfile that needs parameters is a \`Composite\`.
Run \`chant build src --lexicon docker -o build/docker-compose.yml\` (Dockerfiles are written beside it) and compare with the original files, then \`chant lint src\`. Run \`chant lint src --fix\` for DKRS002 (per-kind fields to \`steps\`, then reorder the steps it writes), fix every other finding by hand, and repeat until lint is clean.
Report the generated docker-compose.yml and each Dockerfile.<name>, and any finding you left and why.
Do not push an image, run \`docker compose up\` against anything but the local Docker daemon, or change files outside this project.
Never deploy to a real cloud account or shared environment (with \`chant run\`, \`chant components\` or a platform's own CLI), approve (a pull request review, \`chant approve\` or \`chant run approve\`), override a policy denial (\`chant approve policy-override\`), or merge; never cut or publish a release (\`chant release cut --yes\` or \`chant release publish\`), push or delete a \`ci/*\` tag (\`chant ci tick\` pushes them), or change the value of an existing flag; never touch \`.chant/allowed_signers\` or \`chant/lifecycle\`.`;

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
    prompt,
  };

  const result = docsPipeline(config);
  writeDocsSite(config, result);

  if (opts?.verbose) {
    console.error("Documentation generated");
  }
}
