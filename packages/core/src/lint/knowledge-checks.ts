import type { PostSynthCheck, PostSynthDiagnostic } from "./post-synth";
import type { OkfBundle } from "../okf-read";
import { bindConcepts } from "../okf-read";

/**
 * COR026: Stale Knowledge Binding (#1865, design #1059, epic #1057)
 *
 * A concept's `binds` frontmatter key names a discovered entity's logical
 * name (#1864, `../okf-read.ts`'s `bindConcepts`). A name that resolves to
 * nothing is a stale binding — the entity was renamed or removed, or the
 * concept was authored against a name that never existed — and per #1059's
 * stated failure posture ("the spec permits broken links, which argues for
 * warn") that is a warning, never a build failure: knowledge is deliberately
 * softer than the typed graph it describes, and OKF itself tolerates broken
 * links (epic #1057).
 *
 * The converse is deliberately silent: a concept with no `binds` at all is
 * orphaned knowledge, not an omission (a runbook, a decision about the
 * project as a whole), and `bindConcepts` never reports it as unresolved in
 * the first place — see its own doc comment. A project with no knowledge
 * bundle loads an empty one (`loadOkfBundle`), so this check produces no
 * diagnostics either.
 *
 * Wired into `chant build` (`../cli/commands/build.ts`) alongside
 * `coreReceiptChecks` — same reasons COR023/COR024 are build-owned rather
 * than a per-file `LintRule`: the check needs the full discovered entity map
 * (`ctx.entities`), not one `ts.SourceFile`, and that map only exists after
 * discovery has run. Unlike COR023/024 it never reads `ctx.outputs` — the
 * bundle is loaded once, up front (async — `loadOkfBundle` reads the
 * filesystem), and closed over here so the check itself stays the same sync
 * shape every other `PostSynthCheck` has.
 */

export const STALE_KNOWLEDGE_BINDING_CHECK_ID = "COR026";

/**
 * Build the COR026 check for one loaded bundle. A factory, not a bare
 * constant, because — unlike `coreReceiptChecks`, which needs nothing but
 * `ctx.entities` — this check needs the bundle loaded from disk, and
 * `loadOkfBundle` is async while `PostSynthCheck#check` is not. The caller
 * loads the bundle once (`resolveKnowledgeDir` + `loadOkfBundle`) and passes
 * it in; see `../cli/commands/build.ts`.
 */
export function staleKnowledgeBindingCheck(bundle: OkfBundle): PostSynthCheck {
  return {
    id: STALE_KNOWLEDGE_BINDING_CHECK_ID,
    description:
      "A knowledge concept's `binds` entry must name a discovered entity — a name that resolves to nothing is a stale binding",
    check(ctx) {
      const { unresolved } = bindConcepts(bundle, ctx.entities);
      return unresolved.map(
        ({ concept, name }): PostSynthDiagnostic => ({
          checkId: STALE_KNOWLEDGE_BINDING_CHECK_ID,
          severity: "warning",
          message:
            `Knowledge concept "${concept.path}" binds "${name}", but no discovered entity has that name — ` +
            `a stale binding. The entity may have been renamed or removed, or the concept was authored ` +
            `against a name that never existed. Update the concept's \`binds\` frontmatter, or remove the ` +
            `entry if the concept no longer applies.`,
        }),
      );
    },
  };
}

/**
 * Core's own post-synth check over knowledge bindings, run by `chant build`
 * over the full build result — unscoped, like `coreReceiptChecks`, since a
 * concept's `binds` can name any discovered entity regardless of which
 * lexicon owns it.
 */
export function coreKnowledgeChecks(bundle: OkfBundle): PostSynthCheck[] {
  return [staleKnowledgeBindingCheck(bundle)];
}
