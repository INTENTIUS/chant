/**
 * Pulumi lexicon plugin (#4453).
 *
 * The lexicon declares no resource types, so `generate`, `validate` and
 * `coverage` have nothing to do, and `package` writes a bundle with an empty
 * registry (`./codegen/package.ts`). What it does carry:
 *
 * - the `pulumi` workspace member kind (`workspace-kinds.json`), moved here
 *   from the terraform lexicon, whose graph block reads a member through
 *   {@link pulumiPlugin}'s `buildRoots` (`./workspace-member.ts`);
 * - the change-set adapter over `pulumi preview --json` (`./change-set.ts`);
 * - the drift adapter over `pulumi refresh --preview-only --json`
 *   (`./drift-record.ts`);
 * - the runner that calls those commands and no other (`./run.ts`);
 * - the stack outputs `member-outputs` feeds into chant parameters
 *   (`./stack-outputs.ts`, `./member-outputs.ts`, #4455), contributed
 *   through {@link pulumiCapabilityPlugin} (`./capability-plugin.ts`);
 * - `readDrift`, which `chant workspace drift --member <pulumi member>`
 *   reaches through `chant lifecycle drift` in the member's reader project
 *   (`./drift-read.ts`);
 * - `describeResources`, engine facts for a member on plunge from `plunge
 *   graph --json` (`./describe-resources.ts`, #4529), and a plunge member's
 *   checked-in `engine-graph.json` in the member read (`./engine-graph.ts`);
 * - the checks a pulumi surface admits (#4468): PUL101 over `pulumi.member`
 *   in source, PUL001 and PUL002 over the member read (`./lint/`);
 * - completion and hover over `Pulumi.yaml`, a stack's `Pulumi.<stack>.yaml`,
 *   the workspace member entry and `pulumi.member` (`./lsp/`);
 * - its docs section (`./codegen/docs.ts`, `docs/pages/`);
 * - audit metadata for PUL001 and PUL002 (`./lint/audit-catalog.ts`), the
 *   `chant-pulumi` skill (`./skills/`), and the `PulumiWatchOp` composite
 *   over the `pulumiPreview` and `pulumiDrift` activities (`./composites/`,
 *   `./op/`), following the terraform lexicon (#4494);
 * - the tier-2 contract's remainder (#4510): PUL003 to PUL015 over the
 *   member's export, two more skills, `detectTemplate` for a stack export or
 *   a `Pulumi.yaml`, and three `chant init` templates (`./init-templates.ts`).
 */
import { pulumiCiSetup } from "./ci-setup";
import { basename, isAbsolute, resolve } from "node:path";
import type { InitTemplateSet, LexiconPlugin } from "@intentius/chant/lexicon";
import type { CompletionContext, HoverContext } from "@intentius/chant/lsp/types";
import { createSkillsLoader } from "@intentius/chant/lexicon-plugin-helpers";
import { pulumiConfigSchema, type PulumiConfig } from "./config";
import { pulumiSerializer } from "./serializer";
import { lastMemberReport, readPulumiMember, setLastMemberRead, setLastMemberReport } from "./workspace-member";
import { rules } from "./lint/rules";
import { postSynthChecks } from "./lint/post-synth";
import { pulumiAuditCatalog } from "./lint/audit-catalog";
import { completions } from "./lsp/completions";
import { hover } from "./lsp/hover";
import { PULUMI_RUNTIME_NAMES } from "./lsp/keys";
import { pulumiInitTemplates } from "./init-templates";

const loadSkills = createSkillsLoader(import.meta.url, [
  {
    file: "chant-pulumi.md",
    name: "chant-pulumi",
    description:
      "Add a Pulumi program to a chant workspace as a member, read its preview into the change set and its refresh as drift, and watch it with PulumiWatchOp",
  },
  {
    file: "chant-pulumi-stack-export.md",
    name: "chant-pulumi-stack-export",
    description:
      "Keep a Pulumi member's checked-in stack-export.json current and clean, and fix what PUL001 to PUL015 report about it",
  },
  {
    file: "chant-pulumi-plunge.md",
    name: "chant-pulumi-plunge",
    description:
      "Read a Pulumi member that runs on plunge (a plunge backend URL or engine plunge), with plunge preview, plunge stack output and plunge drift",
  },
]);

export const pulumiPlugin: LexiconPlugin = {
  name: "pulumi",
  serializer: pulumiSerializer,
  configSchema: pulumiConfigSchema,

  // #4550: the engine install lines for the pull request pipeline's default image.
  ciSetup(ctx: { dir: string }): string[] {
    return pulumiCiSetup(ctx);
  },

  // A pulumi workspace member's reader project (#3179): its checked-in stack
  // export, never the program. See ./workspace-member.ts. `chant workspace
  // graph` writes `dir` absolute; a project that writes the namespace itself
  // can write it relative to the project root (#4468).
  async buildRoots(ctx) {
    setLastMemberReport(undefined);
    setLastMemberRead(undefined);
    const configured = (ctx.config as { pulumi?: PulumiConfig }).pulumi?.member;
    if (!configured) return { entities: new Map() };
    const member =
      ctx.projectRoot && !isAbsolute(configured.dir) ? { ...configured, dir: resolve(ctx.projectRoot, configured.dir) } : configured;
    const read = readPulumiMember({ member });
    setLastMemberReport(read.report);
    setLastMemberRead({
      dir: member.dir,
      label: member.label ?? basename(member.dir),
      ...(member.engine ? { engine: member.engine } : {}),
      ...(member.stack ? { stack: member.stack } : {}),
      ...(read.doc !== undefined ? { doc: read.doc } : {}),
    });
    return { entities: read.entities, warnings: read.warnings };
  },

  graphMeta() {
    const report = lastMemberReport();
    return report ? { pulumiMember: report } : undefined;
  },

  /**
   * Engine facts for a member on plunge (#4529): one `plunge graph --json
   * --stack <stack>`, each node's facts on `ResourceMetadata.facts`, and
   * `ownership: "unknown"` on every resource, so nothing decides from it. A
   * stock member runs nothing and is not-observed. See
   * `./describe-resources.ts`.
   */
  async describeResources(options) {
    const { describePulumiResources } = await import("./describe-resources");
    return describePulumiResources(options);
  },

  /**
   * The member's drift, as drift-record stream lines (#4455): `pulumi
   * refresh --preview-only --target` per resource, or `plunge drift
   * --resource --stream` for a member on plunge. See `./drift-read.ts`.
   */
  async readDrift(options) {
    const { readPulumiDrift } = await import("./drift-read");
    return readPulumiDrift(options);
  },

  lintRules() {
    return rules;
  },

  postSynthChecks() {
    return postSynthChecks;
  },

  auditCatalog() {
    return pulumiAuditCatalog;
  },

  /**
   * No `mcpTools()` and no `mcpResources()`, deliberately, as in the
   * terraform lexicon (#2220, #4494). The two shapes other lexicons serve
   * have nothing to serve here: `createDiffTool` diffs one build's serializer
   * output against the last, and this serializer writes `{}` on every build
   * (`./serializer.ts`); `createCatalogResource` serves the generated
   * resource registry, and this lexicon generates none. A member's preview
   * and drift already reach MCP through core's workspace tools, so the two
   * tier-2 "registers" checks stay honest gaps rather than stubs.
   */
  skills: loadSkills,

  /**
   * A `pulumi stack export` document or a parsed `Pulumi.yaml`, recognised by
   * content (#4510), so `chant import` names this lexicon for either and then
   * says it has no template import, rather than finding no lexicon at all.
   *
   * A stack export is `{ version: <number>, deployment: { ... } }` with the
   * deployment holding a `manifest` or a `resources` list. A `Pulumi.yaml` has
   * a string `name` and a `runtime` that is one of Pulumi's runtime names,
   * as a string or as `{ name }`. Nothing else Pulumi writes carries either
   * shape, and neither matches a CloudFormation template, a Kubernetes
   * manifest or a Compose file. Anything else, a raw string included, is
   * false: neither file is read from text here.
   */
  detectTemplate(data: unknown) {
    if (typeof data !== "object" || data === null || Array.isArray(data)) return false;
    const doc = data as Record<string, unknown>;
    const deployment = doc.deployment as Record<string, unknown> | undefined;
    if (typeof doc.version === "number" && typeof deployment === "object" && deployment !== null && !Array.isArray(deployment)) {
      return typeof deployment.manifest === "object" || Array.isArray(deployment.resources);
    }
    if (typeof doc.name !== "string" || doc.name.length === 0) return false;
    const runtime = doc.runtime as unknown;
    const runtimeName =
      typeof runtime === "string" ? runtime : typeof runtime === "object" && runtime !== null ? (runtime as { name?: unknown }).name : undefined;
    return typeof runtimeName === "string" && PULUMI_RUNTIME_NAMES.includes(runtimeName);
  },

  /**
   * `chant init --lexicon pulumi [--template <name>]` (#4510): a project that
   * reads one Pulumi member, by default; `watch`, the same project with a
   * `PulumiWatchOp`; and `plunge`, the watch for a member on plunge. See
   * `./init-templates.ts`.
   */
  initTemplates(template?: string): InitTemplateSet {
    if (template === "watch") return pulumiInitTemplates.watch;
    if (template === "plunge") return pulumiInitTemplates.plunge;
    return pulumiInitTemplates.member;
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

  // No declarable kinds, so no upstream spec to generate from, check against or measure.
  async generate(): Promise<void> {},
  async validate(): Promise<void> {},
  async coverage(): Promise<void> {},

  /** The bundle with `dist/manifest.json` (#4468); see `./codegen/package.ts`. */
  async package(options?: { verbose?: boolean; force?: boolean }): Promise<void> {
    const { packageLexicon } = await import("./codegen/package");
    const { writeBundleSpec } = await import("@intentius/chant/codegen/package");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");

    const { spec, stats } = await packageLexicon(options);
    const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
    writeBundleSpec(spec, join(pkgDir, "dist"));

    console.error(`Packaged ${stats.resources} resources, ${stats.ruleCount} rules, ${stats.skillCount} skills`);
  },
};
