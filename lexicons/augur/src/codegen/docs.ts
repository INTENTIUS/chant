import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { docsPipeline, writeDocsSite } from "@intentius/chant/codegen/docs";
import type { DocsConfig } from "@intentius/chant/codegen/docs";

const overview = `
The augur lexicon turns a project's resource graph into a behaviour engine's
request, and states plainly which of chant's entity kinds it can and cannot put
in front of one.

Nothing here reaches a network at build time. \`chant build\` is offline and
byte-identical on re-run, and the request is assembled the same way from the
same typed source, so a re-run is comparable rather than merely repeated. The
engine itself is reached only by \`predictBehaviour()\`, and only when an
environment variable names one; with none named, augur refuses by name and
draws no overlay rather than reporting an estate that costs nothing.

What you declare is the question. A \`Profile\` carries a traffic level
verbatim — \`1000 rps, p99\` — and \`chant build\` writes the declared profiles
as a small JSON document. The estate itself is already declared by whichever
lexicons a project uses, and augur reads it rather than restating it.

See [The coverage table](coverage/) for which entity types reach the engine and
which are declared unmapped, and [Predicting](predicting/) for the request, the
environment chain and what each refusal means.
`;

/**
 * Generate the docs site for the augur lexicon.
 *
 * `basePath` is what the unified site at /chant needs so assets and internal
 * links resolve once this site is copied under it (scripts/build-docs.test.ts
 * asserts it). Authored pages come from `docs/pages/` by default.
 */
export async function generateDocs(options?: { verbose?: boolean }): Promise<void> {
  const pkgDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

  const config: DocsConfig = {
    name: "augur",
    displayName: "augur",
    description: "A project's resource graph as a behaviour engine's request, with a coverage table",
    distDir: join(pkgDir, "dist"),
    outDir: join(pkgDir, "docs"),
    basePath: process.env.DOCS_BASE_PATH ?? "/chant/lexicons/augur/",
    overview,
    serviceFromType: (type: string) => type.split("::")[1] ?? type,
  };

  const result = docsPipeline(config);
  writeDocsSite(config, result);

  if (options?.verbose) {
    console.error(`Generated ${result.pages.size} documentation pages`);
  }
}
