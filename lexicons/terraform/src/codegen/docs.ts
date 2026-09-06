import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { docsPipeline, writeDocsSite } from "@intentius/chant/codegen/docs";
import type { DocsConfig } from "@intentius/chant/codegen/docs";

const overview = `
The Terraform lexicon reads an estate's existing \`.tf\` files. There is no
generated resource surface here and nothing is emitted back over the HCL:
Terraform's types live in provider registries, one schema per provider and
version, and an estate that already has a root module does not need a second,
generated copy of it.

What you declare is the directory. Each entry in \`terraform.roots\` names a
root module; \`buildRoots()\` parses it at build time and every HCL block joins
the build as an entity keyed \`<root>/<address>\`, carrying the block body
verbatim. Those entities are what the post-synth checks and \`chant audit\`
read.

See [Getting Started](getting-started/) for the config shape, the block-to-entity
mapping, and what TF001 reports.
`;

/**
 * Generate the docs site for the terraform lexicon.
 *
 * `basePath` is what the unified site at /chant needs so assets and internal
 * links resolve once this site is copied under it (scripts/build-docs.test.ts
 * asserts it). Authored pages come from `docs/pages/` by default.
 */
export async function generateDocs(options?: { verbose?: boolean }): Promise<void> {
  const pkgDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

  const config: DocsConfig = {
    name: "terraform",
    displayName: "Terraform",
    description: "Existing Terraform root modules as declarable chant entities",
    distDir: join(pkgDir, "dist"),
    outDir: join(pkgDir, "docs"),
    basePath: process.env.DOCS_BASE_PATH ?? "/chant/lexicons/terraform/",
    overview,
    serviceFromType: (type: string) => type.split("::")[1] ?? type,
  };

  const result = docsPipeline(config);
  writeDocsSite(config, result);

  if (options?.verbose) {
    console.error(`Generated ${result.pages.size} documentation pages`);
  }
}
