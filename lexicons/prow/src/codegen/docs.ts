/**
 * Documentation generation for the prow lexicon.
 *
 * Generates Starlight MDX pages for prow entities using the core docs pipeline.
 * The overview prose lives here; authored pages live under docs/pages/.
 */

import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { docsPipeline, writeDocsSite, type DocsConfig } from "@intentius/chant/codegen/docs";

function serviceFromType(resourceType: string): string {
  const parts = resourceType.split("::");
  return parts.length >= 2 ? parts[1] : "Prow";
}

const overview = `The prow lexicon declares the job config [Prow](https://docs.prow.k8s.io/)
loads. Every job carries its pod spec and the conditions it runs on. The types are generated from sigs.k8s.io/prow at a
pinned commit. Job fields come from Prow's own Go types, and the pod spec,
decoration config and refs come from its ProwJob CRD, so a field Prow does not
know is a type error.

\`\`\`ts
import { Presubmit, PodSpec } from "@intentius/chant-lexicon-prow";

export const jobs = [
  new Presubmit({
    repo: "acme/app",
    name: "pull-app-unit",
    always_run: true,
    decorate: true,
    branches: ["^main$"],
    spec: new PodSpec({
      automountServiceAccountToken: false,
      containers: [{ name: "test", image: "golang:1.26", command: ["go", "test", "./..."] }],
    }),
  }),
];
\`\`\`

\`chant build\` writes one job config file. The \`repo\` of a presubmit or
postsubmit is the key the file lists it under, so the built job does not carry
it. Jobs keep the order of an exported array, and each job keeps the order of
its fields. A \`JobConfig\` declaration's \`header\` becomes comment lines at
the top. \`chant import\` reads an existing job config into these
declarations, and building the import writes the same file.

## Checks

Four errors catch what Prow's config loader refuses. PROW101 is a duplicated
job name and PROW102 a periodic without exactly one schedule. PROW103 is a
kubernetes job with no pod spec, and PROW106 is \`always_run\` beside a change
filter. PROW104 warns about a presubmit whose pod reads a Secret, since the
pull request's code can read it too. PROW105 warns about a presubmit on a build
cluster where other jobs hold a Secret or a cloud identity. PROW001 is a lint
error for a credential written into a job's environment in source.
`;

export async function generateDocs(opts?: { verbose?: boolean }): Promise<void> {
  const pkgDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

  const config: DocsConfig = {
    name: "prow",
    displayName: "Prow",
    description: "Prow presubmits, postsubmits and periodics as declarables, built to the job config Prow loads",
    distDir: join(pkgDir, "dist"),
    outDir: join(pkgDir, "docs"),
    basePath: process.env.DOCS_BASE_PATH ?? "/chant/lexicons/prow/",
    overview,
    serviceFromType,
  };

  const result = docsPipeline(config);
  writeDocsSite(config, result);

  if (opts?.verbose) {
    console.error(`Generated ${result.pages.size} documentation pages`);
  }
}
