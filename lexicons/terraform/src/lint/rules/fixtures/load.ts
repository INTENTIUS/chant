/**
 * Shared lint-rule fixture loader, the `lint/rules/` sibling of
 * `../../post-synth/fixtures/load.ts`.
 *
 * A post-synth check's fixtures are `.tf`, a real Terraform root. A lint
 * rule's fixtures are Op-shaped source, the kind `chant lint` runs a rule's
 * `check(context)` against directly. TF101's live under
 * `fixtures/TF101/positive-op.ts` (triggers) and `negative-op.ts` (passes),
 * deliberately unimported and unresolved at the identifier level: TF101
 * itself matches purely on callee name (see `plan-before-apply.ts`'s doc
 * comment), so a fixture that only needs to parse, not typecheck or run as a
 * standalone program, stays honest about what the rule actually reads.
 *
 * On disk these are named `<name>-op.ts`, not `<name>.op.ts`: a real
 * `*.op.ts` file is exactly what `packages/core/src/op/discover.ts`'s
 * `discoverOps()` walks the whole repository (down from the git root, absent
 * a `chant.config.*`) to find and `import()`, and it does that unconditionally
 * in tests like `generate-pipeline.test.ts` that exercise real discovery. A
 * fixture named `positive.op.ts` would be swept into that scan, imported,
 * and fail at the top-level `const plan = terraformPlan(...)` reference,
 * turning into a discovery error that breaks an unrelated, already-passing
 * test. `loadRuleFixture` still hands the rule a logical `.op.ts` filename
 * (below) so parsing and diagnostics see the file the way a real one would
 * appear; only the on-disk name dodges the scan. Both physical files are
 * also excluded from every tsconfig that would otherwise try to compile them
 * as real source (root `tsconfig.json`, `tsconfig.typecheck.json`, and this
 * lexicon's `tsconfig.build.json`).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import type { LintContext } from "@intentius/chant/lint/rule";

const FIXTURES_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Parse `fixtures/<ruleId>/<name>-op.ts` into a {@link LintContext} whose
 * `filePath` is the logical `<name>.op.ts` a real Op file would carry.
 *
 * Three lines per fixture in a test:
 * ```ts
 * const diags = planBeforeApplyRule.check(loadRuleFixture("TF101", "positive"));
 * expect(diags).toHaveLength(1);
 * ```
 */
export function loadRuleFixture(ruleId: string, name: string): LintContext {
  const onDisk = `${name}-op.ts`;
  const logical = `${name}.op.ts`;
  const code = readFileSync(join(FIXTURES_DIR, ruleId, onDisk), "utf-8");
  const sourceFile = ts.createSourceFile(logical, code, ts.ScriptTarget.Latest, true);
  return { sourceFile, entities: [], filePath: logical };
}
