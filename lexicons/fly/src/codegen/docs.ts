/**
 * fly (Machines API / "flaps") documentation generator.
 *
 * Calls the core docsPipeline with fly-specific config: service grouping and
 * overview content. Produces a standalone Starlight docs site at
 * lexicons/fly/docs/, like the aws and gcp lexicons.
 */

import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { docsPipeline, writeDocsSite, type DocsConfig } from "@intentius/chant/codegen/docs";

const pkgDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/**
 * Group a fly resource type into a service bucket for the reference sidebar.
 * fly type names are `Fly::Machines::<Kind>`, so the middle segment is always
 * "Machines"; grouping by the leaf kind gives a more useful split (Apps,
 * Machines, Storage, Networking, Secrets).
 */
export function serviceFromType(resourceType: string): string {
  const kind = resourceType.split("::")[2] ?? resourceType;
  switch (kind) {
    case "App":
      return "Apps";
    case "Machine":
      return "Machines";
    case "Volume":
      return "Storage";
    case "IPAddress":
    case "Certificate":
      return "Networking";
    case "Secret":
      return "Secrets";
    default:
      return "Machines";
  }
}

const overview = `The **Fly Machines** lexicon defines Fly.io apps and machines using chant's declarative TypeScript syntax. Resources are serialized to the JSON create bodies the Machines API ("flaps") accepts, so the applier can POST them straight through and the mudflaps emulator can round-trip them offline.

This lexicon is generated from Fly's published [Machines API OpenAPI spec](https://docs.machines.dev/openapi.json).

Install it with:

\`\`\`bash
npm install --save-dev @intentius/chant-lexicon-fly
\`\`\`

## Quick Start

\`\`\`typescript
import { App, Machine, MachineConfig, MachineGuest, Fly } from "@intentius/chant-lexicon-fly";

const app = new App({ name: "my-app", org_slug: Fly.OrgSlug });

const web = new Machine({
  name: "web",
  region: Fly.Region,
  config: new MachineConfig({
    image: "flyio/hellofly:latest",
    guest: new MachineGuest({ cpu_kind: "shared", cpus: 1, memory_mb: 256 }),
  }),
});

export { app, web };
\`\`\`

\`Fly.Region\` and \`Fly.OrgSlug\` are pseudo-parameters resolved from the environment at build time (\`FLY_REGION\`, \`FLY_ORG\` / \`FLY_ORG_SLUG\`).`;

const outputFormat = `The fly lexicon serializes resources into the JSON create bodies the Machines API ("flaps") accepts.

## Building

Each declared resource becomes a single flaps request keyed by its logical name:

\`\`\`json
{
  "web": {
    "endpoint": "/v1/apps/my-app/machines",
    "method": "POST",
    "body": { "name": "web", "region": "iad", "config": { ... } }
  }
}
\`\`\`

- An \`App\` becomes \`POST /v1/apps { app_name, org_slug? }\`.
- A \`Machine\` becomes \`POST /v1/apps/{app}/machines\` with the full \`MachineConfig\` as \`config\`. The owning app is a URL path segment, not a body field.
- \`Volume\`, \`IPAddress\`, \`Certificate\`, and \`Secret\` are app-scoped and POST under their app.

Every serialized machine carries the \`managed-by: chant\` ownership marker in \`config.metadata\`, which the owned-only prune reads back.

## Applying

The output is applied against flaps directly (or the mudflaps emulator offline). Endpoint and auth come from \`FLY_FLAPS_BASE_URL\` and \`FLY_API_TOKEN\`.`;

/**
 * Generate documentation for the fly Machines lexicon.
 */
export async function generateDocs(options?: { verbose?: boolean }): Promise<void> {
  const config: DocsConfig = {
    name: "fly",
    displayName: "Fly Machines",
    description: "Typed constructors for Fly.io apps and machines, serialized to Machines API create bodies",
    distDir: join(pkgDir, "dist"),
    outDir: join(pkgDir, "docs"),
    srcDir: join(pkgDir, "src"),
    basePath: process.env.DOCS_BASE_PATH ?? "/chant/lexicons/fly/",
    overview,
    outputFormat,
    serviceFromType,
  };

  const result = docsPipeline(config);
  writeDocsSite(config, result);

  if (options?.verbose) {
    console.error(
      `Generated docs: ${result.stats.resources} resources, ${result.stats.properties} properties, ${result.stats.services} services, ${result.stats.rules} rules`,
    );
  }
}
