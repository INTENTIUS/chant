/**
 * render documentation generator.
 *
 * Calls the core docsPipeline with render-specific config: service grouping and
 * overview content. Produces a standalone Starlight docs site at
 * lexicons/render/docs/, like the fly and gcp lexicons.
 */

import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { docsPipeline, writeDocsSite, type DocsConfig } from "@intentius/chant/codegen/docs";
import { CATALOG } from "../catalog";

const pkgDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/**
 * The curated top-level render resources, in the order they read best in a
 * reference table. Property types (WebServiceDetails, Image, ...) are grouped
 * separately by the pipeline and are not repeated here.
 */
const RESOURCES: Array<{ className: string; resourceType: string }> = [
  { className: "WebService", resourceType: "Render::Services::WebService" },
  { className: "StaticSite", resourceType: "Render::Services::StaticSite" },
  { className: "PrivateService", resourceType: "Render::Services::PrivateService" },
  { className: "BackgroundWorker", resourceType: "Render::Services::BackgroundWorker" },
  { className: "CronJob", resourceType: "Render::Services::CronJob" },
  { className: "Postgres", resourceType: "Render::Datastores::Postgres" },
  { className: "KeyValue", resourceType: "Render::Datastores::KeyValue" },
  { className: "EnvGroup", resourceType: "Render::Config::EnvGroup" },
  { className: "Project", resourceType: "Render::Projects::Project" },
  { className: "Environment", resourceType: "Render::Projects::Environment" },
  { className: "Disk", resourceType: "Render::Services::Disk" },
  { className: "CustomDomain", resourceType: "Render::Services::CustomDomain" },
  { className: "RegistryCredential", resourceType: "Render::Config::RegistryCredential" },
  { className: "Webhook", resourceType: "Render::Config::Webhook" },
];

/**
 * Group a render resource type into a bucket for the reference sidebar. Type
 * names are `Render::<Group>::<Kind>`; the middle segment is the group
 * (Services, Datastores, Config, Projects). Property types are all filed under
 * Services by the generator; keep them there.
 */
export function serviceFromType(resourceType: string): string {
  return resourceType.split("::")[1] ?? resourceType;
}

/**
 * The reference doc URL for a render resource type — the Public API reference
 * page for its create endpoint.
 */
export function resourceTypeUrl(resourceType: string): string {
  const kind = resourceType.split("::")[2] ?? resourceType;
  switch (kind) {
    case "WebService":
    case "StaticSite":
    case "PrivateService":
    case "BackgroundWorker":
    case "CronJob":
      return "https://api-docs.render.com/reference/create-service";
    case "Postgres":
      return "https://api-docs.render.com/reference/create-postgres";
    case "KeyValue":
      return "https://api-docs.render.com/reference/create-key-value";
    case "EnvGroup":
      return "https://api-docs.render.com/reference/create-env-group";
    case "Project":
      return "https://api-docs.render.com/reference/create-project";
    case "Environment":
      return "https://api-docs.render.com/reference/create-environment";
    case "Disk":
      return "https://api-docs.render.com/reference/add-disk";
    case "CustomDomain":
      return "https://api-docs.render.com/reference/create-custom-domain";
    case "RegistryCredential":
      return "https://api-docs.render.com/reference/create-registry-credential";
    case "Webhook":
      return "https://api-docs.render.com/reference/create-webhook";
    default:
      return "https://api-docs.render.com/reference/introduction";
  }
}

const overview = `The **Render** lexicon defines Render services, datastores, env groups, projects, and environments using chant's declarative TypeScript syntax. Resources are serialized to the JSON create bodies the [Render Public API](https://api-docs.render.com/) accepts, so the applier can POST them straight through — no Blueprint, no CLI, no state file.

This lexicon is generated from Render's published [OpenAPI spec](https://api-docs.render.com/v1.0/openapi/render-public-api-1.json).

Install it with:

\`\`\`bash
npm install --save-dev @intentius/chant-lexicon-render
\`\`\`

## Quick Start

\`\`\`typescript
import {
  WebService, WebServiceDetails, NativeEnvironmentDetails, EnvVar, GeneratedEnvVar, Postgres, Render,
} from "@intentius/chant-lexicon-render";

const db = new Postgres({ name: "app-db", plan: "free", version: "16", region: Render.Region });

const web = new WebService({
  name: "app-web",
  repo: "https://github.com/render-examples/express-hello-world",
  serviceDetails: new WebServiceDetails({
    runtime: "node",
    plan: "starter",
    region: Render.Region,
    envSpecificDetails: new NativeEnvironmentDetails({ buildCommand: "npm ci", startCommand: "npm start" }),
  }),
  envVars: [
    new EnvVar({ key: "DATABASE_URL", value: db.internalConnectionString }),
    new GeneratedEnvVar({ key: "SESSION_SECRET", generateValue: true }),
  ],
});

export { db, web };
\`\`\`

\`Render.OwnerId\` and \`Render.Region\` are pseudo-parameters resolved from the environment at build time (\`RENDER_OWNER_ID\`, \`RENDER_REGION\`). Every \`ownerId\` chant fills in defaults to \`Render.OwnerId\`, so a stack rarely names it. \`db.internalConnectionString\` is an attribute read the applier resolves from the live database.`;

const outputFormat = `The render lexicon serializes resources into the JSON create bodies the Render Public API accepts.

## Building

Each declared resource becomes a single request keyed by its logical name:

\`\`\`json
{
  "web": {
    "kind": "WebService",
    "entityType": "Render::Services::WebService",
    "endpoint": "/services",
    "method": "POST",
    "name": "app-web",
    "body": { "type": "web_service", "name": "app-web", "ownerId": "tea-…", "serviceDetails": { ... }, "envVars": [ ... ] }
  }
}
\`\`\`

- Each service type becomes \`POST /services\` with its \`type\` discriminator re-injected and \`serviceDetails\` in that type's shape.
- \`Postgres\` → \`POST /postgres\`; \`KeyValue\` → \`POST /key-value\`; \`EnvGroup\` → \`POST /env-groups\`; \`Project\` → \`POST /projects\`; \`Environment\` → \`POST /environments\`; \`Disk\` → \`POST /disks\`; \`RegistryCredential\` → \`POST /registrycredentials\`; \`Webhook\` → \`POST /webhooks\`.
- \`CustomDomain\` → \`POST /services/{serviceId}/custom-domains\`; the service is a path segment carried in \`pathParams\`.

Three markers may appear in a body, resolved by the applier once their target is live: \`{ "$ref": "<entity>" }\` (a declared resource's id), \`{ "$attr": { "entity", "attribute" } }\` (an attribute read — \`id\`, \`dashboardUrl\`, or a datastore connection string), and \`{ "$owner": true }\` (the workspace, when neither the author nor \`RENDER_OWNER_ID\` named one).

Every serialized service and env group carries the \`CHANT_MANAGED_BY=chant\` ownership marker (plus \`CHANT_STACK\` / \`CHANT_ENV\`) in its \`envVars\`, which the owned-only prune reads back.

## Applying

The output is applied against the Public API directly by \`renderApply\` (via \`chant run\` and the \`renderDeploy\` Op). Endpoint and auth come from \`RENDER_API_BASE_URL\` and \`RENDER_API_KEY\`; the workspace from \`RENDER_OWNER_ID\` (or the sole workspace the key can see). Each resource is found by name and created or PATCHed; created services are waited to \`live\`; with \`prune\` the owned services and env groups no longer declared — and the disks and custom domains under owned services no longer declared — are deleted.`;

const resourcesPage = `The render lexicon ships ${RESOURCES.length} top-level resources. Each maps to a Public API create body; follow the reference link for the underlying API shape.

| Resource | Type | Group | Create | Reconciled by | Marker | API reference |
|----------|------|-------|--------|---------------|--------|---------------|
${RESOURCES.map((r) => {
  const c = CATALOG[r.resourceType];
  const marker = c.marked ? "yes" : c.boundary === "service" ? "via service" : "—";
  return `| \`${r.className}\` | \`${r.resourceType}\` | ${serviceFromType(r.resourceType)} | \`POST ${c.collection}\` | name${r.className === "Environment" ? " + project" : r.className === "Disk" ? " + service" : ""} | ${marker} | [reference](${resourceTypeUrl(r.resourceType)}) |`;
}).join("\n")}

Property types such as \`WebServiceDetails\`, \`StaticSiteDetails\`, \`CronJobDetails\`, \`NativeEnvironmentDetails\`, \`DockerDetails\`, \`Image\`, \`ServiceDisk\`, \`Route\`, \`Header\`, \`ReadReplica\`, and \`CidrBlockAndDescription\` are authored inline on a resource and are documented alongside the resources they belong to.

## Cross-resource references

Render assigns ids on create, so id-valued fields accept the declared resource in place of a string: \`Disk.serviceId\`, \`CustomDomain.serviceId\`, \`Environment.projectId\`, \`*.environmentId\`, \`EnvGroup.serviceIds\`, \`Image.registryCredentialId\`. Attribute reads on datastores (\`internalConnectionString\`, \`externalConnectionString\`, \`psqlCommand\` / \`cliCommand\`) resolve from the live \`/connection-info\` endpoint; \`id\`, \`dashboardUrl\`, and the other response fields resolve from the live resource.

## Ownership

Services and env groups carry chant's marker in their env vars. Disks and custom domains have no marker but hang off a service and inherit its verdict (the service boundary), so an undeclared disk or domain under a chant-owned service is pruned too. Datastores, projects, environments, registry credentials, and webhooks have no marker channel and no boundary: their ownership verdict is \`unknown\`, and they are removed only by an explicit \`renderDelete\` of a plan that names them.`;

/**
 * Generate documentation for the render lexicon.
 */
export async function generateDocs(options?: { verbose?: boolean }): Promise<void> {
  const config: DocsConfig = {
    name: "render",
    displayName: "Render",
    description: "Typed constructors for Render services, datastores, and env groups, serialized to Public API create bodies",
    distDir: join(pkgDir, "dist"),
    outDir: join(pkgDir, "docs"),
    srcDir: join(pkgDir, "src"),
    basePath: process.env.DOCS_BASE_PATH ?? "/chant/lexicons/render/",
    overview,
    outputFormat,
    serviceFromType,
    extraPages: [
      {
        slug: "resources",
        title: "Resource Reference",
        description: "The render resource types, how each is created and reconciled, and their API documentation links",
        content: resourcesPage,
      },
      {
        slug: "pseudo-params",
        title: "Pseudo-parameters",
        description: "Environment-resolved values: Render.OwnerId, Render.Region",
        content: `Pseudo-parameters stand in for values that vary by environment. Reference them instead of hard-coding, and the serializer resolves each from an environment variable at build time.

| Pseudo-parameter | Environment variable | Fallback |
|------------------|----------------------|----------|
| \`Render.OwnerId\` | \`RENDER_OWNER_ID\` | an \`{ "$owner": true }\` marker the applier resolves from \`GET /owners\` (the sole visible workspace; several is an error) |
| \`Render.Region\` | \`RENDER_REGION\` | \`oregon\` |

\`\`\`typescript
import { KeyValue, Render } from "@intentius/chant-lexicon-render";

const cache = new KeyValue({ name: "cache", plan: "free", region: Render.Region, ownerId: Render.OwnerId });
\`\`\`

With \`RENDER_REGION=frankfurt\` set, \`region\` serializes to \`"frankfurt"\`; unset, it falls back to \`"oregon"\`. Every owner-scoped resource that omits \`ownerId\` gets \`Render.OwnerId\` filled in, so naming it is optional.`,
      },
    ],
  };

  const result = docsPipeline(config);
  writeDocsSite(config, result);

  if (options?.verbose) {
    console.error(
      `Generated docs: ${result.stats.resources} resources, ${result.stats.properties} properties, ${result.stats.services} services, ${result.stats.rules} rules`,
    );
  }
}
