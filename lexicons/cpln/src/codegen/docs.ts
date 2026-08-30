/**
 * cpln documentation generator.
 *
 * Calls the core `docsPipeline` with cpln-specific config. The prose pages live
 * as authored `.mdx` under `docs/pages/`, each naming its Diátaxis quadrant in
 * frontmatter (chant #1731 / #1733); the pipeline reads them, expands markers
 * and builds the sidebar from the quadrant. Only the overview and the output
 * format description stay here, because they are interpolated into generated
 * pages rather than being pages of their own.
 */

import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { docsPipeline, writeDocsSite, type DocsConfig } from "@intentius/chant/codegen/docs";

const pkgDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const overview = `The **cpln** lexicon declares [Control Plane](https://controlplane.com) infrastructure as typed chant resources. Control Plane is a hybrid multi-cloud platform: workloads deploy into Global Virtual Clouds that span AWS, GCP, Azure and private clouds, with geo-routing, TLS termination and identity-based cloud access handled by the platform.

Types are generated from Control Plane's served OpenAPI document (\`https://api.cpln.io/openapi.json\`), so they track the real API.

Install it with:

\`\`\`bash
npm install --save-dev @intentius/chant-lexicon-cpln
\`\`\`

## Quick Start

\`\`\`typescript
import { Gvc, Workload } from "@intentius/chant-lexicon-cpln";

export const gvc = new Gvc({
  name: "prod",
  spec: {
    staticPlacement: {
      locationLinks: ["/org/acme/location/aws-us-east-1"],   // placement is GVC-level
    },
  },
});

export const web = new Workload({
  name: "web",
  gvc: "prod",
  spec: {
    type: "serverless",                                       // exactly one HTTP port
    containers: [{
      name: "main",
      image: "nginx:1.27",
      ports: [{ number: 8080, protocol: "http" }],
    }],
    firewallConfig: {
      external: { inboundAllowCIDR: ["0.0.0.0/0"] },          // closed by default
    },
  },
});
\`\`\`

## The loop

1. \`chant build\` — synthesize and lint. The CPL rules catch the silent failures Control Plane does not report: an unqualified identity link, a scale-to-zero that never happens, a secret reference with no field.
2. \`cpln apply --file dist/cpln.yaml --ready\` — reconcile. Ordering across documents is resolved by \`cpln apply\` itself.
3. \`chant plan\` — read the live org back and diff. Ownership comes from the \`tags\` marker chant stamps at synthesis.
`;

const outputFormat = "multi-document Control Plane YAML for `cpln apply --file`";

/**
 * Generate the documentation site for the cpln lexicon.
 */
export async function generateDocs(options?: { verbose?: boolean }): Promise<void> {
  const config: DocsConfig = {
    name: "cpln",
    displayName: "Control Plane",
    description: "Control Plane (cpln) GVCs, workloads, identities and secrets as typed estate.",
    distDir: join(pkgDir, "dist"),
    outDir: join(pkgDir, "docs"),
    srcDir: join(pkgDir, "src"),
    basePath: process.env.DOCS_BASE_PATH ?? "/chant/lexicons/cpln/",
    overview,
    outputFormat,
    serviceFromType: (type: string) => type.split("::")[1] ?? type,
  };

  const result = docsPipeline(config);
  writeDocsSite(config, result);

  if (options?.verbose) {
    console.error(
      `Generated docs: ${result.stats.resources} resources, ${result.stats.properties} properties, ` +
        `${result.stats.services} services, ${result.stats.rules} rules`,
    );
  }
}
