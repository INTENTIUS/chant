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
 * - the runner that calls those two commands and no other (`./run.ts`);
 * - the stack outputs `member-outputs` feeds into chant parameters
 *   (`./stack-outputs.ts`, `./member-outputs.ts`, #4455), contributed
 *   through {@link pulumiCapabilityPlugin} (`./capability-plugin.ts`);
 * - `readDrift`, which `chant workspace drift --member <pulumi member>`
 *   reaches through `chant lifecycle drift` in the member's reader project
 *   (`./drift-read.ts`);
 * - the checks a pulumi surface admits (#4468): PUL101 over `pulumi.member`
 *   in source, PUL001 and PUL002 over the member read (`./lint/`);
 * - completion and hover over `Pulumi.yaml`, a stack's `Pulumi.<stack>.yaml`,
 *   the workspace member entry and `pulumi.member` (`./lsp/`);
 * - its docs section (`./codegen/docs.ts`, `docs/pages/`);
 * - audit metadata for PUL001 and PUL002 (`./lint/audit-catalog.ts`), the
 *   `chant-pulumi` skill (`./skills/`), and the `PulumiWatchOp` composite
 *   over the `pulumiPreview` and `pulumiDrift` activities (`./composites/`,
 *   `./op/`), following the terraform lexicon (#4494).
 */
import { isAbsolute, resolve } from "node:path";
import type { LexiconPlugin } from "@intentius/chant/lexicon";
import type { CompletionContext, HoverContext } from "@intentius/chant/lsp/types";
import { createSkillsLoader } from "@intentius/chant/lexicon-plugin-helpers";
import { pulumiConfigSchema, type PulumiConfig } from "./config";
import { pulumiSerializer } from "./serializer";
import { lastMemberReport, readPulumiMember, setLastMemberReport } from "./workspace-member";
import { rules } from "./lint/rules";
import { postSynthChecks } from "./lint/post-synth";
import { pulumiAuditCatalog } from "./lint/audit-catalog";
import { completions } from "./lsp/completions";
import { hover } from "./lsp/hover";

const loadSkills = createSkillsLoader(import.meta.url, [
  {
    file: "chant-pulumi.md",
    name: "chant-pulumi",
    description:
      "Add a Pulumi program to a chant workspace as a member, read its preview into the change set and its refresh as drift, and watch it with PulumiWatchOp",
  },
]);

export const pulumiPlugin: LexiconPlugin = {
  name: "pulumi",
  serializer: pulumiSerializer,
  configSchema: pulumiConfigSchema,

  // A pulumi workspace member's reader project (#3179): its checked-in stack
  // export, never the program. See ./workspace-member.ts. `chant workspace
  // graph` writes `dir` absolute; a project that writes the namespace itself
  // can write it relative to the project root (#4468).
  async buildRoots(ctx) {
    setLastMemberReport(undefined);
    const configured = (ctx.config as { pulumi?: PulumiConfig }).pulumi?.member;
    if (!configured) return { entities: new Map() };
    const member =
      ctx.projectRoot && !isAbsolute(configured.dir) ? { ...configured, dir: resolve(ctx.projectRoot, configured.dir) } : configured;
    const read = readPulumiMember({ member });
    setLastMemberReport(read.report);
    return { entities: read.entities, warnings: read.warnings };
  },

  graphMeta() {
    const report = lastMemberReport();
    return report ? { pulumiMember: report } : undefined;
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
