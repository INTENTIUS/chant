import type { LexiconPlugin, SkillDefinition, IntrinsicDef, InitTemplateSet } from "@intentius/chant/lexicon";
import type { LintRule } from "@intentius/chant/lint/rule";
import type { PostSynthCheck } from "@intentius/chant/lint/post-synth";
import type { CompletionContext, CompletionItem, HoverContext, HoverInfo } from "@intentius/chant/lsp/types";
import type { McpToolContribution, McpResourceContribution } from "@intentius/chant/mcp/types";
import { createSkillsLoader } from "@intentius/chant/lexicon-plugin-helpers";
import { cedarSerializer } from "./serializer";
import { rules } from "./lint/rules";
import { postSynthChecks as cedarPostSynthChecks } from "./lint/post-synth";
import { cedarAuditCatalog } from "./lint/audit-catalog";
import { completions } from "./lsp/completions";
import { hover } from "./lsp/hover";
import { cedarMcpResources, cedarMcpTools } from "./mcp/index";
import { cedarInitTemplates } from "./init-templates";
import { cedarConfigSchema } from "./config";
import { detectTemplate as detectCedarTemplate } from "./detect";
import { CedarTemplateGenerator, CedarTemplateParser } from "./import/adapter";
// #1652 — the AVP ownership channel is data on the plugin, so its keys have to
// be a value at module load rather than a dynamic import.
import type { ResourceMetadata } from "@intentius/chant/lexicon";
import { AVP_OWNERSHIP_KEYS } from "./avp/ownership";
import { AVP_AMBIENT_KINDS } from "./avp/ambient";

/**
 * cedar lexicon plugin.
 *
 * Implements all required LexiconPlugin lifecycle methods.
 */
export const cedarPlugin: LexiconPlugin = {
  name: "cedar",
  serializer: cedarSerializer,

  // ── Required lifecycle methods ────────────────────────────────

  async generate(options?: { verbose?: boolean }): Promise<void> {
    // Cedar's codegen input is the project's own schema, so the `cedar` config
    // namespace is read here rather than being decoration (#1650).
    const { generate, writeGeneratedFiles } = await import("./codegen/generate");
    const { loadCedarConfig } = await import("./config");
    const projectRoot = process.cwd();
    const result = await generate({ ...options, projectRoot, config: await loadCedarConfig(projectRoot) });
    writeGeneratedFiles(result);
  },

  async validate(options?: { verbose?: boolean }): Promise<void> {
    const { validate } = await import("./validate");
    const { printValidationResult } = await import("@intentius/chant/codegen/validate");
    const result = await validate();
    printValidationResult(result);
  },

  async coverage(options?: { verbose?: boolean; minOverall?: number }): Promise<void> {
    const { analyzeCedarCoverage } = await import("./coverage");
    const { loadCedarConfig } = await import("./config");
    const projectRoot = process.cwd();
    analyzeCedarCoverage({
      projectRoot,
      config: await loadCedarConfig(projectRoot),
      verbose: options?.verbose,
      minOverall: options?.minOverall,
    });
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
    // Auto-discovered from lint/post-synth/ and committed as a static barrel
    // by `npm run generate:barrels` — adding a check is dropping a file.
    return cedarPostSynthChecks;
  },

  auditCatalog() {
    return cedarAuditCatalog;
  },

  skills: createSkillsLoader(import.meta.url, [
    {
      file: "chant-cedar-authoring.md",
      name: "chant-cedar-authoring",
      description:
        "Author Cedar policies as typed chant resources — schema to generated classes to .cedar and JSON outputs",
      triggers: [
        { type: "file-pattern", value: "**/*.cedarschema" },
        { type: "file-pattern", value: "**/policies.ts" },
        { type: "context", value: "cedar policy" },
        { type: "context", value: "cedar schema" },
        { type: "context", value: "authorization policy" },
      ],
      parameters: [],
      examples: [
        {
          title: "Owner-scoped permit",
          description: "Grant an action to the owner of a resource",
          input: "Let users read documents they own",
          output: `new Policy({ principal: { is: "App::User" }, action: { eq: ReadAction }, when: ["resource.owner == principal"] })`,
        },
      ],
    },
    {
      file: "chant-cedar-avp-embedding.md",
      name: "chant-cedar-avp-embedding",
      description:
        "Embed a typed cedar-lexicon policy into an AWS Verified Permissions policy resource instead of a hand-written string",
      triggers: [
        { type: "context", value: "verified permissions" },
        { type: "context", value: "avp policy store" },
        { type: "context", value: "cedar deployment" },
        { type: "context", value: "cedar-agent" },
      ],
      parameters: [],
      examples: [
        {
          title: "Policy destined for a policy store",
          input: "Deploy this Cedar policy to Verified Permissions",
          output: "Emit the .cedar text and reference it — the typed statement seam lands with #1652",
        },
      ],
    },
    {
      file: "chant-cedar-meta-policy.md",
      name: "chant-cedar-meta-policy",
      description:
        "Organizational policy over Cedar policy sets — the bare-permit wall, forbid conventions, and env-aware severity",
      triggers: [
        { type: "context", value: "cedar lint" },
        { type: "context", value: "bare permit" },
        { type: "context", value: "policy review" },
        { type: "context", value: "meta-policy" },
      ],
      parameters: [],
      examples: [
        {
          title: "The bare-permit wall",
          input: "Is `permit (principal, action, resource);` acceptable?",
          output: "Warn in dev and staging; fail the build in prod",
        },
      ],
    },
  ]),

  initTemplates(template?: string): InitTemplateSet {
    // The branch names are spelled out here rather than only in
    // ./init-templates.ts because `chant dev check-lexicon` counts a lexicon's
    // templates by scanning this file. The content lives next door.
    if (template === "avp-embedding") return cedarInitTemplates("avp-embedding");
    if (template === "gateway-policy-set") return cedarInitTemplates("gateway-policy-set");
    return cedarInitTemplates(template);
  },

  mcpTools() {
    return cedarMcpTools();
  },

  mcpResources() {
    // `createCatalogResource` resolves the registry relative to the module URL
    // it is handed, so it needs this file's — src/generated/, not src/mcp/.
    return cedarMcpResources(import.meta.url);
  },

  detectTemplate(data: unknown) {
    return detectCedarTemplate(data);
  },

  /** `.cedar` text and the JSON policy-set envelope, into the core IR (#1653). */
  templateParser() {
    return new CedarTemplateParser();
  },

  /** The IR back out as `new Policy({ … })` against the generated classes. */
  templateGenerator() {
    return new CedarTemplateGenerator();
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

  /** The shape of the `cedar` key in `chant.config.ts` — see ./config.ts. */
  configSchema: cedarConfigSchema,

  /**
   * The pinned upstream is the Cedar *grammar*, not a downloaded spec (#1650).
   *
   * `CEDAR_WASM_VERSION` is the package version the self-upgrade tooling bumps;
   * `CEDAR_LANG_VERSION` beside it is the language version `generate()` asserts
   * at runtime, since a package bump that leaves the language at 4.5 cannot
   * change what parses. Both live in src/spec/pin.ts, which also carries the
   * content pin over the bundled default schema.
   */
  upstreamPin: {
    file: "src/spec/pin.ts",
    pattern: /export const CEDAR_WASM_VERSION\s*=\s*"([^"]+)"/,
    replace: (v: string, line: string) => line.replace(/= "[^"]+"/, `= "${v}"`),
    upstream: { owner: "cedar-policy", repo: "cedar", kind: "releases" as const },
  },

  // ── AVP lifecycle (#1652) ──────────────────────────────────────

  /**
   * AVP policy stores are taggable; the policies inside them are not, so the
   * per-policy channel is a marker encoded into `Definition.Static.Description`
   * and the store's tags are the coarse channel beside it. Only the two paths
   * that actually read the description are declared (chant #1348) — the full
   * design record is src/avp/OWNERSHIP.md.
   */
  ownershipChannel: {
    keys: AVP_OWNERSHIP_KEYS,
    reads: ["describeResources", "exportResources"] as const,
  },

  /**
   * Observe the declared policy set against a live AVP policy store.
   *
   * The tri-state carries more weight here than on most substrates: a declared
   * policy reported absent becomes a `create`, and creating a permit that
   * already exists duplicates a grant. Every path that did not look says so.
   */
  async describeResources(options: {
    environment: string;
    buildOutput: string;
    entityNames: string[];
    entities: Map<string, { entityType: string; props: Record<string, unknown> }>;
    stack?: string;
    region?: string;
    owned?: boolean;
  }) {
    const { describeAvpResources } = await import("./avp/describe-resources");
    return describeAvpResources({
      environment: options.environment,
      entityNames: options.entityNames,
      entities: options.entities,
      ...(options.owned !== undefined ? { owned: options.owned } : {}),
      ...(options.region ? { client: { region: options.region } } : {}),
    });
  },

  /** The one kind this lexicon deploys, and therefore the one it can enumerate. */
  ambientKinds(): string[] {
    return [...AVP_AMBIENT_KINDS];
  },

  /**
   * Policies in the store that nothing declares — a standing grant nobody in
   * the source tree can see. For an authorization store this is a security
   * finding rather than housekeeping.
   */
  async observeAmbient(options: {
    environment: string;
    kinds: string[];
    observed: Record<string, ResourceMetadata>;
    stack?: string;
    region?: string;
  }) {
    const { observeAvpAmbient } = await import("./avp/ambient");
    return observeAvpAmbient({
      environment: options.environment,
      kinds: options.kinds,
      observed: options.observed,
      ...(options.region ? { client: { region: options.region } } : {}),
    });
  },

  /**
   * Full-fidelity read of the live policies, as import IR. Server-written
   * fields are stripped to the declared shape unless `verbatim` is set — see
   * the note in src/avp/live-export.ts for what counts as server-written when
   * the only thing a user authors is the statement.
   */
  async exportResources(options: {
    environment: string;
    stack?: string;
    region?: string;
    selector?: { type?: string; name?: string };
    owned?: boolean;
    verbatim?: boolean;
  }) {
    const { exportAvpResources } = await import("./avp/live-export");
    return exportAvpResources({
      environment: options.environment,
      ...(options.selector ? { selector: options.selector } : {}),
      ...(options.owned !== undefined ? { owned: options.owned } : {}),
      ...(options.verbatim !== undefined ? { verbatim: options.verbatim } : {}),
      ...(options.region ? { client: { region: options.region } } : {}),
    });
  },
};
