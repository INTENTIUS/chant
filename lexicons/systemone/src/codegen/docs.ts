import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { docsPipeline, writeDocsSite } from "@intentius/chant/codegen/docs";
import type { DocsConfig } from "@intentius/chant/codegen/docs";

const overview = `
The systemone lexicon asks a workspace's decision points (ws-058) through a
typed-decision model. It is verbs only: there is no resource to declare. A
point's question, inputs and chain of deciders live in the workspace's points
file, and its answers are records.

It adds one Op activity, \`decide\`. Given a point and its inputs, read through
the read contract, it calls the backend the point's model decider names over
the \`POST /v1/systemone\` wire format (TypeSafe's Jev, or any server that
implements the same request and response) and writes the answer record through
core's \`points ask\` path. So the threshold, a model's answer being proposed
rather than decided, the reuse of an existing answer and the escalation to
people are core's, the same as for \`chant workspace points ask\`.

A backend's key comes from an environment variable or a capability a box
declares as brokered, never a literal. chant's reads never call a model.

See [Getting Started](getting-started/) for a first point asked against the
stub server, and [The decide activity](decide/) for its arguments.
`;

/**
 * Generate the docs site for the systemone lexicon. Authored pages come from
 * `docs/pages/`.
 */
export async function generateDocs(options?: { verbose?: boolean }): Promise<void> {
  const pkgDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

  const config: DocsConfig = {
    name: "systemone",
    displayName: "systemone",
    description: "Decision points asked through a Jev-compatible typed-decision backend",
    distDir: join(pkgDir, "dist"),
    outDir: join(pkgDir, "docs"),
    basePath: process.env.DOCS_BASE_PATH ?? "/chant/lexicons/systemone/",
    overview,
    serviceFromType: (type: string) => type.split("::")[1] ?? type,
    suppressPages: ["serialization"],
  };

  const result = docsPipeline(config);
  writeDocsSite(config, result);

  if (options?.verbose) {
    console.error(`Generated ${result.pages.size} documentation pages`);
  }
}
