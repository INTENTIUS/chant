import type { LexiconPlugin, SkillDefinition, IntrinsicDef, InitTemplateSet } from "@intentius/chant/lexicon";
import type { LintRule } from "@intentius/chant/lint/rule";
import type { PostSynthCheck } from "@intentius/chant/lint/post-synth";
import type { CompletionContext, CompletionItem, HoverContext, HoverInfo } from "@intentius/chant/lsp/types";
import type { McpToolContribution, McpResourceContribution } from "@intentius/chant/mcp/types";
import { createSkillsLoader } from "@intentius/chant/lexicon-plugin-helpers";
import { flySerializer } from "./serializer";
import { rules } from "./lint/rules";
import { postSynthChecks } from "./lint/post-synth";
import { completions } from "./lsp/completions";
import { hover } from "./lsp/hover";

/**
 * fly lexicon plugin.
 *
 * Implements all required LexiconPlugin lifecycle methods.
 */
export const flyPlugin: LexiconPlugin = {
  name: "fly",
  serializer: flySerializer,

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
    // TODO: Implement coverage analysis
    console.error("Coverage analysis not yet implemented");
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
      file: "chant-fly.md",
      name: "chant-fly",
      description: "Author, lint, and deploy Fly apps and machines from a chant project, applied straight to the Machines API",
      triggers: [
        { type: "file-pattern" as const, value: "*.fly.ts" },
        { type: "context" as const, value: "fly" },
        { type: "context" as const, value: "fly.io" },
      ],
      parameters: [
        {
          name: "resourceType",
          type: "string",
          description: "Fly resource type to work with (App, Machine, Volume, IPAddress, Certificate, Secret)",
        },
      ],
      examples: [
        {
          title: "Author an App and a Machine",
          output: "new App({ name: \"my-app\" });\nnew Machine({ region: \"iad\", config: new MachineConfig({ image: \"flyio/hellofly:latest\" }) })",
        },
        {
          title: "Deploy against mudflaps offline",
          input: "Apply the App + Machine without a Fly account",
          output: "cd examples/local-fly && chant run fly",
        },
      ],
    },
    {
      file: "chant-fly-patterns.md",
      name: "chant-fly-patterns",
      description: "Volumes and mounts, IP assignments, certificates, apply-only secrets, and the app-boundary ownership model for Fly",
      triggers: [
        { type: "context" as const, value: "fly volumes" },
        { type: "context" as const, value: "fly secrets" },
        { type: "context" as const, value: "fly certificates" },
      ],
      parameters: [],
      examples: [
        {
          title: "Machine with a mounted volume",
          input: "Attach a volume to a machine",
          output: "new Volume({ name: \"data\", region: \"iad\", size_gb: 10 });\nnew Machine({ config: new MachineConfig({ mounts: [{ volume: \"data\", path: \"/data\" }] }) })",
        },
      ],
    },
    {
      file: "chant-fly-ops.md",
      name: "chant-fly-ops",
      description: "Operate a live Fly deploy — wait on stuck machines, resolve lease conflicts, prune safely, and target a real org versus the emulator",
      triggers: [
        { type: "context" as const, value: "fly apply" },
        { type: "context" as const, value: "fly prune" },
        { type: "context" as const, value: "flaps lease" },
      ],
      parameters: [],
      examples: [
        {
          title: "Deploy to a real Fly org",
          input: "Point the same code at a real org",
          output: "export FLY_API_TOKEN=... && chant run fly",
        },
      ],
    },
  ]),

  mcpTools() {
    return []; // TODO: Implement MCP tools
  },

  mcpResources() {
    return []; // TODO: Implement MCP resources
  },

  detectTemplate(data: unknown) {
    return false; // TODO: Detect if a template belongs to this lexicon
  },

  pseudoParameters(): string[] {
    return [
      "Fly::Region",
      "Fly::OrgSlug",
      "Fly::AppName",
    ];
  },

  initTemplates(template?: string): InitTemplateSet {
    if (template === "volume") {
      return {
        src: {
          "infra.ts": `import { App, Machine, MachineConfig, MachineGuest, MachineMount, Volume, Fly } from "@intentius/chant-lexicon-fly";

// An app, a persistent volume, and a machine that mounts it. The serializer
// (#738) turns these into the flaps create bodies flyApply POSTs. The region
// comes from Fly.Region (resolved from FLY_REGION, defaulting to "iad").
const app = new App({ name: "my-app", org_slug: Fly.OrgSlug });

const data = new Volume({
  name: "data",
  region: Fly.Region,
  size_gb: 10,
});

const web = new Machine({
  name: "web",
  region: Fly.Region,
  config: new MachineConfig({
    image: "flyio/hellofly:latest",
    guest: new MachineGuest({ cpu_kind: "shared", cpus: 1, memory_mb: 256 }),
    mounts: [new MachineMount({ volume: "data", path: "/data" })],
  }),
});

export { app, data, web };
`,
        },
      };
    }

    if (template === "service") {
      return {
        src: {
          "infra.ts": `import { App, Machine, MachineConfig, MachineGuest, MachineService, MachinePort, Fly } from "@intentius/chant-lexicon-fly";

// An app and a machine exposing a public HTTPS service on port 443 to internal
// 8080. The region comes from Fly.Region (resolved from FLY_REGION, defaulting
// to "iad").
const app = new App({ name: "my-app", org_slug: Fly.OrgSlug });

const web = new Machine({
  name: "web",
  region: Fly.Region,
  config: new MachineConfig({
    image: "flyio/hellofly:latest",
    guest: new MachineGuest({ cpu_kind: "shared", cpus: 1, memory_mb: 256 }),
    services: [
      new MachineService({
        protocol: "tcp",
        internal_port: 8080,
        ports: [new MachinePort({ port: 443, handlers: ["tls", "http"] })],
      }),
    ],
  }),
});

export { app, web };
`,
        },
      };
    }

    // Default: one app and one machine — the smallest complete deploy.
    return {
      src: {
        "infra.ts": `import { App, Machine, MachineConfig, MachineGuest, Fly } from "@intentius/chant-lexicon-fly";

// One Fly app and one machine — the smallest complete deploy. The serializer
// (#738) turns these into the flaps create bodies flyApply POSTs. The region
// comes from Fly.Region (resolved from FLY_REGION, defaulting to "iad").
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

  // State: the read-back seam for plan + drift (#767). Lists live Fly resources
  // over flaps, keyed by chant entity name, with an ownership verdict core's
  // change set reads. Endpoint + auth reuse the applier (FLY_FLAPS_BASE_URL /
  // FLY_API_TOKEN), so it reads the same target flyApply writes.
  async describeResources(options) {
    const { describeResources } = await import("./describe-resources");
    return describeResources(options);
  },
};
