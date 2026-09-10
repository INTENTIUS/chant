import type { LexiconPlugin } from "@intentius/chant/lexicon";
import type { CompletionContext, HoverContext } from "@intentius/chant/lsp/types";
import { augurSerializer } from "./serializer";
import { rules } from "./lint/rules";
import { postSynthChecks } from "./lint/post-synth";
import { augurAuditCatalog } from "./lint/audit-catalog";
import { completions } from "./lsp/completions";
import { hover } from "./lsp/hover";
import { createAugurPredict } from "./predict-behaviour";
import { PROFILE_TYPE } from "./resources";

/**
 * augur lexicon plugin — the first implementation of `predictBehaviour()`
 * (#2357, contract #2356).
 *
 * There is no upstream schema to pin here and no substrate to serialize back
 * to. augur's subject is the *request* a behaviour engine is handed: which of
 * chant's entity kinds have an equivalent on the engine's side, what a graph
 * looks like on the wire, and what happens when there is no engine to send it
 * to. So `spec/` and `codegen/` stay near-empty, the way
 * `lexicons/terraform`'s do, and for a related reason — neither lexicon
 * generates a resource surface from an upstream schema.
 *
 * What it does declare is `Augur::Profile`: a traffic level to predict at. The
 * estate is declared by whichever lexicons a project already uses, and augur
 * reads it rather than restating it.
 */
export const augurPlugin: LexiconPlugin = {
  name: "augur",
  serializer: augurSerializer,

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
    // No upstream spec to measure a generated surface against. The coverage
    // this lexicon has an opinion about is a different one — which chant entity
    // types reach a behaviour engine — and it is reported by
    // `coverageReport()` below rather than pretended at here.
    console.error(
      "Coverage analysis not applicable: this lexicon generates no types from an upstream spec. " +
        "For the entity-type-to-engine-kind coverage table, see src/mapping.ts and coverageReport().",
    );
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
   * The fourth observation method (#2356), and the first lexicon to implement
   * it. See `./predict-behaviour.ts` for the four moves and their order; the
   * environment and the transport are injected there so a test can drive the
   * whole method against a fixture engine, and the shipped plugin takes the
   * process environment and `./engine.ts`'s transport chooser.
   *
   * No `observeResourcesDeep`, no `describeResources`, no `listArtifacts`, and
   * that is the shape rather than a gap: augur has no substrate to read. The
   * three reads report what something holds; this one reports what an engine
   * believes would happen at a level nobody has run.
   */
  predictBehaviour: createAugurPredict(),

  lintRules() {
    return rules;
  },

  postSynthChecks() {
    return postSynthChecks;
  },

  auditCatalog() {
    return augurAuditCatalog;
  },

  /**
   * `recommended`/`all`, derived from the audit catalog rather than a
   * hand-kept id list, so a check that lands later is picked up the moment its
   * catalog entry ships.
   */
  lintPresets() {
    const ids = Object.keys(augurAuditCatalog);
    const recommended = ids.filter((id) => augurAuditCatalog[id].tier === "merge-worthy");
    return { recommended, all: ids };
  },

  /**
   * The coverage this lexicon actually has an opinion about.
   *
   * `unaccountedKinds` is empty by construction: `coverageFor` in
   * `./mapping.ts` is total over entity types, so every type is mapped,
   * declared unmapped, or reported as having no row — and the third is a
   * statement about *this* table rather than an unaccounted kind of some
   * upstream spec's. There is no upstream spec here to leave anything
   * unaccounted for, which is why this reports zero rather than declining to
   * report.
   */
  async coverageReport() {
    return { unaccountedKinds: [] };
  },

  /**
   * No `mcpTools()` and no `mcpResources()`, deliberately. The two shapes
   * every other lexicon uses have nothing to serve here: `createDiffTool`
   * diffs one build's serializer output against the last, and this
   * serializer's output is a list of questions rather than an estate;
   * `createCatalogResource` serves the generated resource registry, and this
   * lexicon generates none (`src/codegen/generate.ts` writes `{}` on purpose).
   * So the members are absent rather than faked, and `chant dev check-lexicon`
   * reports two tier-2 gaps that are real. The rest of this lexicon's tier-2
   * surface — skills, a second example, init templates — is #2371.
   */

  /**
   * `Augur::Profile` is chant's own type and arrives as TypeScript, so there
   * is no foreign template format to detect. Returning `false` says that
   * plainly: no file on disk belongs to this lexicon by content.
   */
  detectTemplate(data: unknown) {
    return typeof data === "object" && data !== null && !Array.isArray(data)
      ? (data as Record<string, unknown>).augur === "augur/profiles/v1"
      : false;
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

export { PROFILE_TYPE };
