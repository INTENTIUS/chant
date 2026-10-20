/**
 * e2b documentation generator.
 *
 * Calls the core docsPipeline. The how-to and reference pages are authored
 * MDX under `docs/pages/`, each tagged with its Diátaxis quadrant; this file
 * holds the overview and the serialization page. writeDocsSite puts the pages
 * in the main docs site under docs/src/content/docs/lexicons/e2b/ (chant #3993).
 */

import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { docsPipeline, writeDocsSite, type DocsConfig } from "@intentius/chant/codegen/docs";

const pkgDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const overview = `The **e2b** lexicon runs chant Ops on a steward: one [E2B](https://e2b.dev) sandbox that outlives every run. \`chant run <op> --on e2b\` hands the run to it. The steward keeps a clone of the project and its installed tools on its disk, runs one Op at a time, and sleeps paused between runs. Any API that speaks E2B's can host it, hosted E2B or a platform of your own.

The lexicon also declares one kind, \`Template\`, for the image a steward is made from. \`chant build\` writes each template as the \`e2b.<name>.Dockerfile\` and \`e2b.<name>.toml\` pair that \`e2b template build\` reads.

Install it with:

\`\`\`bash
npm install --save-dev @intentius/chant-lexicon-e2b
\`\`\`

## Quick Start

Point a profile at your E2B account in \`chant.config.ts\`:

\`\`\`typescript
import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-e2b";

export default {
  lexicons: ["e2b"],
  e2b: {
    profiles: {
      prod: {
        apiKey: { env: "E2B_API_KEY" },
        template: "chant-steward",
        gitToken: { env: "GITHUB_TOKEN" },
      },
    },
    defaultProfile: "prod",
  },
} satisfies ChantConfig;
\`\`\`

Declare the template it names, with the tools the project's Ops call:

\`\`\`typescript
import { Template } from "@intentius/chant-lexicon-e2b";

const steward = new Template({
  name: "chant-steward",
  fromImage: "node:22-bookworm",
  run: ["apt-get update && apt-get install -y --no-install-recommends jq && rm -rf /var/lib/apt/lists/*"],
  cpuCount: 2,
  memoryMB: 2048,
});

export { steward };
\`\`\`

Then build the template once and run an Op on the steward:

\`\`\`bash
chant build src --lexicon e2b -o dist/e2b.json
(cd dist && e2b template build --config e2b.chant-steward.toml)
chant run prod-apply --on e2b
\`\`\``;

const outputFormat = `The e2b lexicon writes each \`Template\` as two files that \`e2b template build\` reads, named after the template so several can share a directory.

## Building

\`e2b.<name>.Dockerfile\` starts \`FROM\` the template's \`fromImage\`. Each \`env\` entry becomes an \`ENV\` line and each \`run\` step a \`RUN\` line, in order, with \`WORKDIR\` between them when \`workdir\` is set:

\`\`\`dockerfile
FROM node:22-bookworm
ENV CI="1"
RUN apt-get update && apt-get install -y --no-install-recommends jq && rm -rf /var/lib/apt/lists/*
\`\`\`

\`e2b.<name>.toml\` names the template and its Dockerfile. The other settings appear only when the declaration sets them:

\`\`\`toml
# Built with: e2b template build --config e2b.chant-steward.toml
template_name = "chant-steward"
dockerfile = "e2b.chant-steward.Dockerfile"
cpu_count = 2
memory_mb = 2048
\`\`\`

The primary output is a JSON index of the templates, keyed by the name each was exported as:

\`\`\`json
{
  "templates": {
    "steward": {
      "name": "chant-steward",
      "dockerfile": "e2b.chant-steward.Dockerfile",
      "config": "e2b.chant-steward.toml",
      "cpuCount": 2,
      "memoryMB": 2048
    }
  }
}
\`\`\`

A project that declares no template gets \`{ "templates": {} }\`.

## Applying

chant does not build templates. Run \`e2b template build --config e2b.<name>.toml\` in the output directory, once, and again when the declaration changes. A profile's \`template\` then names the template, and the next steward made from that profile starts from it. A steward that already exists keeps the sandbox it has; delete it to have the next run make a new one.`;

/**
 * Generate the e2b lexicon's docs.
 */
export async function generateDocs(options?: { verbose?: boolean }): Promise<void> {
  const config: DocsConfig = {
    name: "e2b",
    displayName: "E2B",
    description: "Run chant Ops on a steward sandbox on E2B, and declare the template it is made from",
    distDir: join(pkgDir, "dist"),
    outDir: join(pkgDir, "docs"),
    srcDir: join(pkgDir, "src"),
    basePath: process.env.DOCS_BASE_PATH ?? "/chant/lexicons/e2b/",
    overview,
    outputFormat,
    serviceFromType: (type: string) => type.split("::")[1] ?? type,
  };

  const result = docsPipeline(config);
  writeDocsSite(config, result);

  if (options?.verbose) {
    console.error(`Generated docs: ${result.stats.resources} resources, ${result.stats.rules} rules`);
  }
}
