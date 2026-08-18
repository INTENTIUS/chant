import type { LexiconPlugin, InitTemplateSet } from "@intentius/chant/lexicon";
import type { CompletionContext, HoverContext } from "@intentius/chant/lsp/types";
import { createSkillsLoader } from "@intentius/chant/lexicon-plugin-helpers";
import { renderSerializer } from "./serializer";
import { rules } from "./lint/rules";
import { postSynthChecks } from "./lint/post-synth";
import { renderAuditCatalog } from "./lint/audit-catalog";
import { completions } from "./lsp/completions";
import { hover } from "./lsp/hover";
import { detectTemplate as detectRenderTemplate } from "./detect";
import { RENDER_ENV_OWNERSHIP_KEYS } from "./ownership";

/**
 * render lexicon plugin.
 *
 * Implements all required LexiconPlugin lifecycle methods.
 */
export const renderPlugin: LexiconPlugin = {
  name: "render",
  // Services and env groups carry the env-var marker; describeResources reads
  // it back. See ./ownership.ts for the two-tier story.
  ownershipChannel: { keys: RENDER_ENV_OWNERSHIP_KEYS, reads: ["describeResources"] },
  auditCatalog: () => renderAuditCatalog,
  serializer: renderSerializer,

  // ── Required lifecycle methods ────────────────────────────────

  async generate(options?: { verbose?: boolean }): Promise<void> {
    const { generate } = await import("./codegen/generate");
    await generate(options);
  },

  async validate(options?: { verbose?: boolean }): Promise<void> {
    const { validate } = await import("./validate");
    const { printValidationResult } = await import("@intentius/chant/codegen/validate");
    const result = await validate();
    printValidationResult(result);
  },

  async coverage(options?: { verbose?: boolean; minOverall?: number }): Promise<void> {
    const { analyzeRenderCoverage } = await import("./coverage");
    await analyzeRenderCoverage({ verbose: options?.verbose, minOverall: options?.minOverall });
  },

  async package(options?: { verbose?: boolean; force?: boolean }): Promise<void> {
    const { packageLexicon } = await import("./codegen/package");
    const { writeBundleSpec } = await import("@intentius/chant/codegen/package");
    const { join, dirname } = await import("path");
    const { fileURLToPath } = await import("url");

    const { spec, stats } = await packageLexicon(options);
    const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
    writeBundleSpec(spec, join(pkgDir, "dist"));

    console.error(`Packaged ${stats.resources} resources, ${stats.ruleCount} rules, ${stats.skillCount} skills`);
  },

  // ── Optional extensions ────────────────────────────────────

  lintRules() {
    return rules;
  },

  postSynthChecks() {
    return postSynthChecks;
  },

  skills: createSkillsLoader(import.meta.url, [
    {
      file: "chant-render.md",
      name: "chant-render",
      description:
        "Author, lint, and deploy Render services, datastores, and env groups from a chant project, applied straight to the Render Public API",
      triggers: [
        { type: "file-pattern" as const, value: "*.render.ts" },
        { type: "context" as const, value: "render" },
        { type: "context" as const, value: "render.com" },
      ],
      parameters: [
        {
          name: "resourceType",
          type: "string",
          description:
            "Render resource type to work with (WebService, StaticSite, PrivateService, BackgroundWorker, CronJob, Postgres, KeyValue, EnvGroup, Project, Environment, Disk, CustomDomain, RegistryCredential, Webhook)",
        },
      ],
      examples: [
        {
          title: "Author a web service and a database",
          output:
            'new Postgres({ name: "app-db", plan: "free", version: "16" });\nnew WebService({ name: "app-web", repo: "https://github.com/…", serviceDetails: new WebServiceDetails({ runtime: "node", envSpecificDetails: new NativeEnvironmentDetails({ buildCommand: "npm ci", startCommand: "npm start" }) }), envVars: [new EnvVar({ key: "DATABASE_URL", value: db.internalConnectionString })] })',
        },
        {
          title: "Deploy to a workspace",
          input: "Apply the stack to Render",
          output: "export RENDER_API_KEY=… RENDER_OWNER_ID=… && chant run render",
        },
      ],
    },
    {
      file: "chant-render-patterns.md",
      name: "chant-render-patterns",
      description:
        "Render patterns in chant — env groups, projects and environments, disks, custom domains, image-backed and cron services, and the ownership model",
      triggers: [
        { type: "context" as const, value: "render env group" },
        { type: "context" as const, value: "render disk" },
        { type: "context" as const, value: "render custom domain" },
        { type: "context" as const, value: "render cron" },
      ],
      parameters: [],
      examples: [
        {
          title: "Env group shared by two services",
          input: "Share env vars between a web service and a worker",
          output: 'new EnvGroup({ name: "shared", envVars: [new EnvVar({ key: "LOG_LEVEL", value: "info" })], serviceIds: [web, worker] })',
        },
      ],
    },
  ]),

  mcpTools() {
    // No MCP tools yet: Render's read-only context is the chant-render skills.
    return [];
  },

  mcpResources() {
    return [];
  },

  detectTemplate(data: unknown) {
    return detectRenderTemplate(data);
  },

  pseudoParameters(): string[] {
    return ["Render::OwnerId", "Render::Region"];
  },

  initTemplates(template?: string): InitTemplateSet {
    if (template === "database") {
      return {
        src: {
          "infra.ts": `import {
  WebService,
  WebServiceDetails,
  NativeEnvironmentDetails,
  EnvVar,
  GeneratedEnvVar,
  Postgres,
  Render,
} from "@intentius/chant-lexicon-render";

// A Postgres database and a web service wired to it. The connection string is
// read from the live database at apply time, after it exists. The owner comes
// from Render.OwnerId (RENDER_OWNER_ID); the region from Render.Region
// (RENDER_REGION, default "oregon").
const db = new Postgres({
  name: "app-db",
  plan: "free",
  version: "16",
  region: Render.Region,
});

const web = new WebService({
  name: "app-web",
  repo: "https://github.com/render-examples/express-hello-world",
  branch: "main",
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
`,
        },
      };
    }

    if (template === "static") {
      return {
        src: {
          "infra.ts": `import { StaticSite, StaticSiteDetails, Route } from "@intentius/chant-lexicon-render";

// A static site built from a repo and served from its publish path, with an
// SPA rewrite. The owner comes from Render.OwnerId (RENDER_OWNER_ID).
const site = new StaticSite({
  name: "my-site",
  repo: "https://github.com/render-examples/vite-react-hello-world",
  branch: "main",
  serviceDetails: new StaticSiteDetails({
    buildCommand: "npm ci && npm run build",
    publishPath: "dist",
    routes: [new Route({ type: "rewrite", source: "/*", destination: "/index.html" })],
  }),
});

export { site };
`,
        },
      };
    }

    // Default: one web service — the smallest complete deploy.
    return {
      src: {
        "infra.ts": `import { WebService, WebServiceDetails, NativeEnvironmentDetails, Render } from "@intentius/chant-lexicon-render";

// One Render web service — the smallest complete deploy. The serializer turns
// this into the POST /services body renderApply issues. The owner comes from
// Render.OwnerId (RENDER_OWNER_ID); the region from Render.Region
// (RENDER_REGION, default "oregon").
const web = new WebService({
  name: "my-web",
  repo: "https://github.com/render-examples/express-hello-world",
  branch: "main",
  serviceDetails: new WebServiceDetails({
    runtime: "node",
    plan: "starter",
    region: Render.Region,
    envSpecificDetails: new NativeEnvironmentDetails({ buildCommand: "npm ci", startCommand: "npm start" }),
  }),
});

export { web };
`,
      },
    };
  },

  completionProvider(ctx: CompletionContext) {
    return completions(ctx);
  },

  hoverProvider(ctx: HoverContext) {
    return hover(ctx);
  },

  async docs(options?) {
    const { generateDocs } = await import("./codegen/docs");
    return generateDocs(options);
  },

  // The read-back seam for plan + drift. Lists live Render resources over the
  // Public API, keyed by chant entity name, with an ownership verdict core's
  // change set reads. Endpoint + auth reuse the applier (RENDER_API_BASE_URL /
  // RENDER_API_KEY / RENDER_OWNER_ID), so it reads the same target renderApply writes.
  async describeResources(options) {
    const { describeResources } = await import("./describe-resources");
    return describeResources(options);
  },
};
