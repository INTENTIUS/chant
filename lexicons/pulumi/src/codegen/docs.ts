import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { docsPipeline, writeDocsSite } from "@intentius/chant/codegen/docs";
import type { DocsConfig } from "@intentius/chant/codegen/docs";

const overview = `
The Pulumi lexicon makes a Pulumi program a chant workspace member. It
declares no resource types and writes nothing: the program stays as it is,
applied by \`pulumi up\` as before. chant reads it four ways.

| Read | Source |
|---|---|
| the member's graph | the \`pulumi stack export\` checked in beside \`Pulumi.yaml\` as \`stack-export.json\` |
| its part of the change set | \`pulumi preview --json\` |
| its drift records | \`pulumi refresh --preview-only --json\`, one resource at a time, or \`plunge drift --stream\` |
| its outputs, for another member's parameters | \`pulumi stack output --json --show-secrets=false\` (applied) and the preview (planned) |

The graph read never runs \`pulumi\`. The other reads run those commands, or
\`plunge preview\`, \`plunge stack output\` and \`plunge drift\` for a member on
plunge, as ruled on [#4476](https://github.com/INTENTIUS/chant/issues/4476).
Nothing else runs, so chant never changes a stack.

See [Getting Started](getting-started/) to add a Pulumi member to a
workspace, and [The pulumi member](member/) for what each read returns.
[The stack export](stack-export/) covers the file the graph is read from and
the checks that read it, [Watching a member](watching/) the \`PulumiWatchOp\`
composite, and [A member on plunge](plunge/) members that run on plunge.
`;

/**
 * Generate the docs section for the pulumi lexicon (#4468). Authored pages
 * come from `docs/pages/`; the overview, the rules page and the sidebar are
 * the pipeline's.
 */
export async function generateDocs(options?: { verbose?: boolean }): Promise<void> {
  const pkgDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

  const config: DocsConfig = {
    name: "pulumi",
    displayName: "Pulumi",
    description: "A Pulumi program as a workspace member: its graph, change set, drift and outputs",
    distDir: join(pkgDir, "dist"),
    outDir: join(pkgDir, "docs"),
    basePath: process.env.DOCS_BASE_PATH ?? "/chant/lexicons/pulumi/",
    overview,
    suppressPages: ["serialization"],
  };

  const result = docsPipeline(config);
  writeDocsSite(config, result);

  if (options?.verbose) {
    console.error(`Generated ${result.pages.size} documentation pages`);
  }
}
