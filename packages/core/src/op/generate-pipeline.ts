/**
 * Generate mode's Op counterpart (#927): synthesize scheduled CI for
 * stateless Ops — the cron-triggered sibling of `generateComponentsPipeline`
 * (../components/cli-support.ts, #563/#688). A component pipeline triggers a
 * deploy-time graph on `workflow_dispatch`; this triggers already-built Ops
 * on a cron, each via `chant run <name>` on the local executor — the same
 * one-shot invocation documented at docs/src/content/docs/guide/ops.mdx. Core
 * owns only Op discovery, so a typo'd name fails fast before any CI is
 * generated; the CI-specific synthesis is contributed by the target
 * lexicon's `generateOpPipeline` (../lexicon.ts), exactly like
 * `generateComponentPipeline`.
 *
 * There is no dependency graph between scheduled Ops the way there is
 * between components — `Op.depends` orders phases within one run, not
 * separately scheduled cron triggers — so this does not call
 * `resolveComponentGraph`; each `ScheduledOpSpec` is generated independently.
 */

import { discoverOps } from "./discover";
import {
  isLexiconPlugin,
  type LexiconPlugin,
  type ComponentPipelineOptions,
  type ScheduledOpSpec,
  type OpPipelineFile,
  type OpPipelineJob,
} from "../lexicon";

/**
 * Load a lexicon's plugin (`@intentius/chant-lexicon-<name>`) to reach its
 * `generateOpPipeline`. Tolerant: returns null when the package can't be
 * resolved. Kept local (rather than imported from
 * `../components/cli-support.ts`) so this module carries no dependency on
 * `components/`.
 */
async function loadLexiconPlugin(name: string): Promise<LexiconPlugin | null> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import(`@intentius/chant-lexicon-${name}`)) as Record<string, unknown>;
  } catch {
    return null;
  }
  for (const value of Object.values(mod)) {
    if (isLexiconPlugin(value)) return value;
  }
  return null;
}

/** Result of generating scheduled CI for a set of Ops (generate mode's Op counterpart, #927). */
export interface GenerateOpsPipelineResult {
  success: boolean;
  /** One generated CI file per scheduled Op, when `success` is true. */
  files?: OpPipelineFile[];
  /** Every generated job, for a machine-readable view. */
  jobs?: OpPipelineJob[];
  error?: string;
}

/**
 * Synthesize scheduled CI for `ops` targeting `lexicon`: validate every named
 * Op exists (`discoverOps`, under the git root — mirrors `chant run <name>`'s
 * own resolution), then dispatch to the lexicon's `generateOpPipeline`. No
 * deploy/audit logic is inlined into the generated YAML — the finding-mode
 * behavior lives in the Op's own activity args, set by the composite that
 * built it (`WorkflowAuditOp`, `PipelineAuditOp`, `ReconcileOp`, …); this
 * function only wires the cron trigger and the token/permission surface the
 * declared `findingMode` needs.
 */
export async function generateOpsPipeline(
  ops: ScheduledOpSpec[],
  lexicon: string,
  options?: ComponentPipelineOptions,
  cwd?: string,
): Promise<GenerateOpsPipelineResult> {
  const plugin = await loadLexiconPlugin(lexicon);
  if (!plugin?.generateOpPipeline) {
    return {
      success: false,
      error: `Lexicon "${lexicon}" does not support Op generate mode (no generateOpPipeline). GitLab, GitHub, and Forgejo are supported today.`,
    };
  }

  const discovered = await discoverOps({ cwd });
  if (discovered.errors.length > 0) {
    return { success: false, error: discovered.errors.join("\n") };
  }

  const unknown = ops.filter((spec) => !discovered.ops.has(spec.name));
  if (unknown.length > 0) {
    const known = [...discovered.ops.keys()].sort().join(", ");
    return {
      success: false,
      error: `Unknown Op(s): ${unknown.map((s) => s.name).join(", ")}.${known ? ` Known Ops: ${known}` : " No Ops discovered."}`,
    };
  }

  const { files, jobs } = plugin.generateOpPipeline(ops, options);
  return { success: true, files, jobs };
}
