import type { AuditEntitiesInput, LexiconPlugin } from "@intentius/chant/lexicon";
import type { CompletionContext, HoverContext } from "@intentius/chant/lsp/types";
import type { Declarable } from "@intentius/chant/declarable";
import { createSkillsLoader } from "@intentius/chant/lexicon-plugin-helpers";
import { terraformSerializer } from "./serializer";
import { rules } from "./lint/rules";
import { postSynthChecks } from "./lint/post-synth";
import { withCallersChain } from "./lint/post-synth/scope";
import { terraformAuditCatalog } from "./lint/audit-catalog";
import { completions } from "./lsp/completions";
import { hover } from "./lsp/hover";
import { terraformConfigSchema, type TerraformConfig } from "./config";
import { renderTerraformRoots } from "./hcl/roots";
import { auditRootName, parseTerraformRootContent, RESOURCE_TYPE } from "./hcl/parse";
import { descendModules } from "./hcl/descend";
import { TERRAFORM_STATE_OWNERSHIP_KEYS } from "./state-ownership";

const loadSkills = createSkillsLoader(import.meta.url, [
  {
    file: "chant-terraform.md",
    name: "chant-terraform",
    description:
      "Read an existing Terraform root module into chant's build and audit, and drive it with the init/plan/apply Ops",
  },
]);

/**
 * terraform lexicon plugin.
 *
 * There is no upstream schema to pin here: Terraform's resource surface lives
 * in provider registries, one schema per provider, and this lexicon reads the
 * HCL an estate already has rather than generating types for it. So `spec/`
 * and `codegen/` stay near-empty and there is no `upstreamPin`.
 */
export const terraformPlugin: LexiconPlugin = {
  name: "terraform",
  serializer: terraformSerializer,
  configSchema: terraformConfigSchema,

  // ── Required lifecycle methods ────────────────────────────────

  async generate(options?: { verbose?: boolean }): Promise<void> {
    const { generate } = await import("./codegen/generate");
    await generate(options);
  },

  async validate(_options?: { verbose?: boolean }): Promise<void> {
    const { validate } = await import("./validate");
    const { printValidationResult } = await import("@intentius/chant/codegen/validate");
    const result = await validate();
    printValidationResult(result);
  },

  async coverage(_options?: { verbose?: boolean; minOverall?: number }): Promise<void> {
    // No upstream spec to measure against. See the note on the plugin.
    console.error("Coverage analysis not applicable: this lexicon generates no types from an upstream spec");
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

  /**
   * The ownership channel is per mode, and the channel declared here names
   * the stock one, because a project's roots are stock unless it opts into
   * choudoufu.
   *
   * On a stock root the channel is the state file, not a tag or a label
   * (#2087): every address `terraform show -json` returns is `owned` and
   * everything else is `unknown`. On a live root (#2104) it is choudoufu's
   * two marker tags, `./live-ownership.ts`'s `TERRAFORM_LIVE_MARKER_KEYS`,
   * and the verdicts come from `live-plan -json`'s own sections. Both
   * readings resolve a real verdict on this path, which is what declaring
   * `describeResources` here claims and what the conformance suite checks,
   * for both modes. See `./describe-resources.ts` and
   * `docs/pages/observation.mdx`.
   */
  ownershipChannel: {
    keys: TERRAFORM_STATE_OWNERSHIP_KEYS,
    reads: ["describeResources"],
  },

  async describeResources(options) {
    const { describeResources } = await import("./describe-resources");
    return describeResources(options);
  },

  /**
   * The kinds a live root can enumerate beyond its declaration (#1278,
   * #2104). Empty on a project with no live root, because `live-ls` is the
   * only estate-wide read this lexicon has and a stock root has none: a state
   * file knows what it created and nothing else.
   */
  ambientKinds() {
    return [RESOURCE_TYPE];
  },

  async observeAmbient(options) {
    const { observeAmbient } = await import("./describe-resources");
    return observeAmbient(options);
  },

  async teardownOwned(options) {
    const { teardownOwned } = await import("./describe-resources");
    return teardownOwned(options);
  },

  /**
   * Each entry in `terraform.roots` is a root module directory that parses at
   * build time into one entity per HCL block. The render lives in
   * `./hcl/roots.ts`; this member only reads the namespace and hands over the
   * project root, which is what relative `dir` paths resolve against.
   */
  async buildRoots(ctx): Promise<{ entities: Map<string, Declarable>; warnings: string[] }> {
    const namespace = (ctx.config as { terraform?: TerraformConfig }).terraform;
    const roots = namespace?.roots ?? {};
    if (Object.keys(roots).length === 0) return { entities: new Map(), warnings: [] };
    return renderTerraformRoots({
      projectRoot: ctx.projectRoot,
      roots,
      binary: namespace?.binary,
      callModuleType: namespace?.callModuleType,
    });
  },

  lintRules() {
    return rules;
  },

  /**
   * The generated barrel of checks, each wrapped so a finding inside a
   * descended child module names the call chain that reached it (#2112). See
   * `./lint/post-synth/scope.ts`.
   */
  postSynthChecks() {
    return withCallersChain(postSynthChecks);
  },

  auditCatalog() {
    return terraformAuditCatalog;
  },

  /**
   * `recommended`/`all` (chant #2113), the tflint-ruleset-terraform shape:
   * `recommended` is every `merge-worthy` TF rule (a correctness/security
   * finding worth reporting by default), `all` adds the `report-only` ones
   * (hygiene the family grows into as #2109/#2110/#2112 land). Derived from
   * `terraformAuditCatalog` rather than a hand-kept id list, so a rule that
   * lands in a later, parallel issue is picked up automatically the moment
   * its catalog entry ships, with no second list to fall out of sync.
   */
  lintPresets() {
    const ids = Object.keys(terraformAuditCatalog);
    const recommended = ids.filter((id) => terraformAuditCatalog[id].tier === "merge-worthy");
    return { recommended, all: ids };
  },

  /**
   * Parse-to-graph for `chant audit` (#1567, #2085, #2217). `content` is the
   * `# file: <name>`-joined bundle discovery builds for one discovered root
   * module (`classifyTerraform`, `packages/core/src/audit/discover.ts`), and
   * `input` says where that bundle came from.
   *
   * The scope is named after the input's path (`auditRootName`), so two roots
   * in one repository are two roots here as well: they no longer collide in
   * the merged entity map the all-files pass reads, which is what used to
   * produce a finding keyed `<root>/<address>#2` against the file
   * `(cross-file)` that neither directory deserved.
   *
   * When the audit walked a local filesystem, `input.dir` is the root
   * module's directory and the parse descends its local `module` calls
   * exactly as `buildRoots()` does, through the same `descendModules`
   * (`../hcl/descend.ts`): a child module's entities are keyed
   * `<root>/module.<name>/<address>` and carry the caller chain, so TF014 and
   * TF015 fire here with the same `Callers:` line they print on a build, and
   * the root-only rules (TF001 to TF003) still see only the root's own
   * blocks. `input.baseDir` is the audited directory, which bounds the
   * descent the way the project root bounds it on a build. Discovery drops a
   * directory another one calls as a local module, so no module is audited
   * twice.
   *
   * With no `input.dir` (a fetched repository; a caller parsing a bare
   * string) the bundle is parsed alone, and the two child-module rules have
   * no child to report on, since nothing named one.
   *
   * The descent's own refusals (a registry source, a source outside the
   * audited tree, a cycle) are warnings on a build; this hook returns
   * entities only, so on the audit path they are dropped rather than printed.
   *
   * Never throws: malformed HCL yields an empty map.
   */
  async auditEntities(content: string, input?: AuditEntitiesInput): Promise<Map<string, Declarable>> {
    try {
      const root = auditRootName(input?.path);
      const entities = await parseTerraformRootContent(content, root);
      if (input?.dir === undefined) return entities;
      const { entities: children } = await descendModules(entities, {
        dir: input.dir,
        root,
        projectRoot: input.baseDir ?? input.dir,
      });
      for (const [key, entity] of children) entities.set(key, entity);
      return entities;
    } catch {
      return new Map();
    }
  },

  skills: loadSkills,

  mcpTools() {
    return []; // TODO: Implement MCP tools
  },

  mcpResources() {
    return []; // TODO: Implement MCP resources
  },

  detectTemplate(_data: unknown) {
    return false; // TODO: Detect if a template belongs to this lexicon
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
};
