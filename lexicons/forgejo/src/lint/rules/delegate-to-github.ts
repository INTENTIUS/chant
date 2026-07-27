/**
 * Forgejo lint rules — wrapped from github, not duplicated.
 *
 * Forgejo has no lint rules of its own: entities, composites, and every
 * expression helper a forgejo project imports are the exact same github
 * classes (see src/index.ts's `export * from "@intentius/chant-lexicon-github"`).
 * A forgejo workflow is TypeScript indistinguishable in shape from an
 * equivalent github workflow, so github's lint rules (GHA001-GHA058 — typed
 * composites, secret detection, supply-chain checks, etc.) apply to it
 * unmodified. Re-implementing or forking any of them here would drift from
 * github's the first time either side changed.
 *
 * Each rule is wrapped rather than re-exported verbatim under github's own
 * id: `chant lint`/`chant audit` can load the github and forgejo plugins in
 * the same process (e.g. `chant audit` scans a repo without knowing its CI
 * provider up front — see packages/core/src/audit/core.ts's
 * `defaultChecksProvider`, which already loads forgejo+github together for
 * post-synth checks), and `loadPlugins`' cross-lexicon conflict check
 * (packages/core/src/cli/conflict-check.ts) hard-fails on two plugins
 * claiming the same rule id. Prefixing with `WFJ-` — forgejo's existing
 * post-synth namespace — keeps every id globally unique while leaving the
 * check (and fix, where one exists) exactly as github wrote it; only the
 * `id` field changes.
 */

import type { LintRule } from "@intentius/chant/lint/rule";
import { githubPlugin } from "@intentius/chant-lexicon-github";

/** Wrap a github lint rule under forgejo's `WFJ-` namespace, unmodified otherwise. */
export function wrapGithubRule(rule: LintRule): LintRule {
  return { ...rule, id: `WFJ-${rule.id}` };
}

export const forgejoLintRules: LintRule[] = (githubPlugin.lintRules?.() ?? []).map(wrapGithubRule);
