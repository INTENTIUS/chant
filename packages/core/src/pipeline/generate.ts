/**
 * The pipeline's jobs for a forge, from the folded spec (#5324).
 *
 * Two files:
 *
 * - the merge's waves: the first stage's op-waves spec, rendered by the
 *   lexicon's `generateOpWavesPipeline` with `renderSpec`, so every wave
 *   job runs `chant run wave --render-spec` and reads its spec, and its gate
 *   at the base commit, from `chant pipeline spec --stage <first>`, which
 *   folds `.chant/pipeline.ts` at the commit it is handed. The release cut
 *   and the control dispatch come with that stage's spec;
 * - the promote jobs: one manual job per later stage, from the lexicon's
 *   `generatePipelinePromote`, each running `components promote --to
 *   <stage> --release <release>`.
 */

import { importLexiconPackage, lexiconModulePath } from "../lexicon-module";
import { isLexiconPlugin, type LexiconPlugin, type OpPipelineFile, type OpWavesPipelineOptions } from "../lexicon";
import { activeProductWords } from "../ci-product-words";
import { opWaveBinArgv, type OpWaveJob } from "../op/op-waves";
import type { PipelineSpec } from "./spec";
import { stageWavesSpec } from "./stages";

/** Options for {@link generatePipeline}: the op-waves generator's, without the spec file and the render, which the pipeline sets. */
export type PipelineGenerateOptions = Omit<OpWavesPipelineOptions, "specFile" | "renderSpec">;

/** What {@link generatePipeline} rendered. */
export interface PipelineGenerateResult {
  success: boolean;
  files?: OpPipelineFile[];
  jobs?: OpWaveJob[];
  error?: string;
}

async function pluginOf(name: string): Promise<LexiconPlugin | null> {
  try {
    const mod = (await importLexiconPackage(lexiconModulePath(name) ?? `@intentius/chant-lexicon-${name}`)) as Record<string, unknown>;
    return (Object.values(mod).find((v) => isLexiconPlugin(v)) as LexiconPlugin | undefined) ?? null;
  } catch {
    return null;
  }
}

/** The command a wave job renders its stage's spec with: `<bin> pipeline spec --stage <stage>`. */
export function pipelineSpecCommand(stage: string, bin?: string): string[] {
  return [...opWaveBinArgv(bin), "pipeline", "spec", "--stage", stage];
}

/** The file the first stage's wave jobs write their rendered spec over. */
export function pipelineStageSpecFile(spec: Pick<PipelineSpec, "name">, stage: string): string {
  return `.chant/op-waves/${spec.name}-${stage}.spec.json`;
}

/** Render the pipeline's files for `lexicon`. `plugin` is injected in tests. */
export async function generatePipeline(spec: PipelineSpec, lexicon: string, options: PipelineGenerateOptions = {}, plugin?: LexiconPlugin | null): Promise<PipelineGenerateResult> {
  const found = plugin === undefined ? await pluginOf(lexicon) : plugin;
  if (!found?.generateOpWavesPipeline || !found.generatePipelinePromote) {
    return { success: false, error: `Lexicon "${lexicon}" does not render a pipeline. GitHub, GitLab and Forgejo do.` };
  }
  try {
    const first = spec.stages[0]!.name;
    const bin = options.bin ?? activeProductWords().bin;
    const shape = stageWavesSpec(spec, first);
    const waves = found.generateOpWavesPipeline(shape, {
      ...options,
      ...(bin ? { bin } : {}),
      specFile: pipelineStageSpecFile(spec, first),
      renderSpec: { command: pipelineSpecCommand(first, bin) },
    });
    const later = spec.stages.slice(1);
    const promote = later.length === 0
      ? []
      : found.generatePipelinePromote({
          pipeline: spec.name,
          stages: later.map((s) => ({ name: s.name, ...(s.forgeEnvironment ? { environment: s.forgeEnvironment } : {}) })),
          ...(bin ? { bin } : {}),
          ...(spec.defaults?.runner ? { runner: spec.defaults.runner } : {}),
          ...(options.jobTimeoutMinutes ? { jobTimeoutMinutes: options.jobTimeoutMinutes } : {}),
        });
    return { success: true, files: [...waves.files, ...promote], jobs: waves.jobs };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
