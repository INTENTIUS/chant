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
 * The only top-level names Terraform's JSON syntax admits
 * (developer.hashicorp.com/terraform/language/syntax/json). Used as a
 * whole-document test in `detectTemplate`: a `.tf.json` file has these keys
 * and nothing else.
 */
const TF_JSON_BLOCK_TYPES = new Set([
  "terraform",
  "provider",
  "variable",
  "output",
  "locals",
  "module",
  "resource",
  "data",
  "moved",
  "import",
  "check",
  "removed",
]);

/**
 * Whether raw text is HCL a Terraform root or module is written in. One
 * top-level block header is enough, and every one of these headers is
 * Terraform's own: `terraform {`, and the labelled `resource`/`data`
 * (two labels), `provider`/`module`/`variable`/`output` (one label). `locals`
 * is left out on purpose, since it is the one block a non-Terraform HCL
 * dialect is also likely to carry.
 */
function looksLikeHcl(text: string): boolean {
  return (
    /^[ \t]*terraform[ \t]*\{/m.test(text) ||
    /^[ \t]*(resource|data)[ \t]+"[^"]+"[ \t]+"[^"]+"[ \t]*\{/m.test(text) ||
    /^[ \t]*(provider|module|variable|output)[ \t]+"[^"]+"[ \t]*\{/m.test(text)
  );
}

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

  /**
   * No `mcpTools()` and no `mcpResources()`, deliberately (#2220). Both were
   * declared returning `[]` behind a TODO, which passed the two tier-2
   * "registers <method>" checks on a member that contributed nothing. Neither
   * of the two shapes every other lexicon uses has anything to serve here:
   * `createDiffTool` diffs one build's serializer output against the last,
   * and this serializer writes nothing (`src/serializer.ts` is a deliberate
   * no-op, the `.tf` files are the artifact); `createCatalogResource` serves
   * the generated resource registry, and this lexicon generates none
   * (`src/codegen/generate.ts` writes `{}` on purpose). So the members are
   * removed rather than faked, and `chant dev check-lexicon` reports two
   * tier-2 gaps that are real.
   */
  skills: loadSkills,

  /**
   * `.tf` (and Terraform's own JSON syntax, `.tf.json`) recognised by content
   * rather than by which directory a file sits in (#2220).
   *
   * Two input shapes, because the two callers hand over different things.
   * `chant import` (`packages/core/src/cli/commands/import.ts`) `JSON.parse`s
   * the file first, so it arrives as an object; the audit's content detection
   * (`packages/core/src/audit/discover.ts`) hands azure its raw string, and a
   * `.tf` file is not JSON at all, so the raw string form is the one that
   * matters for HCL. Anything else reads as false.
   *
   * The object form is exact rather than heuristic: Terraform's JSON syntax
   * admits only the top-level names in {@link TF_JSON_BLOCK_TYPES}, so a
   * document is `.tf.json` when every key is one of them and at least one is
   * present. That refuses a Kubernetes manifest, a CloudFormation template and
   * a Compose file without having to name any of them.
   *
   * Discovery still classifies Terraform by the directory bundle
   * (`classifyTerraform`), because a root module is a directory of files that
   * has to be parsed together and one `.tf` on its own is not an audit input.
   * This makes the per-file question answerable for the callers that ask it
   * one file at a time.
   */
  detectTemplate(data: unknown) {
    if (typeof data === "string") return looksLikeHcl(data);
    if (typeof data !== "object" || data === null || Array.isArray(data)) return false;
    const keys = Object.keys(data as Record<string, unknown>);
    return keys.length > 0 && keys.every((k) => TF_JSON_BLOCK_TYPES.has(k));
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
