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
 *   <stage> --release <release>`. A stage with agent steps (#5358) gets a
 *   job before its promote that holds a read token only and runs them.
 *
 * Each stage's jobs log in as that stage alone and take that stage's config
 * and secret set (#5348): the first stage's waves trade for the apply
 * identity `ci.identity.cloud` gives the first stage, and each promote job
 * for its own stage's, with its stage's set as variables and the read of
 * its store secrets.
 */

import { importLexiconPackage, lexiconModulePath } from "../lexicon-module";
import { isLexiconPlugin, type LexiconPlugin, type OpPipelineFile, type OpWavesPipelineOptions, type PipelinePromoteStageInputs } from "../lexicon";
import type { OpWavesSpec } from "../op/op-waves";
import { resolveCloudIdentity, type CloudIdentityDeclaration } from "../ci-identity";
import { environmentSetJobInputs, resolveEnvironmentSet, type EnvironmentSetForge } from "../components/environment-sets";
import { environmentSetForgeVariables } from "../op/op-waves-environment-sets";
import { activeProductWords } from "../ci-product-words";
import { opWaveBinArgv, type OpWaveJob } from "../op/op-waves";
import type { PipelineSpec } from "./spec";
import { stageWavesSpec } from "./stages";
import { stageAgentKeyEnvs, stageAgentSteps } from "./agent-steps";

/**
 * Options for {@link generatePipeline}: the op-waves generator's, without
 * the spec file and the render, which the pipeline sets, and the cloud
 * identities (#5348): `ci.identity.cloud`, which gives each stage's jobs
 * that stage's apply identity, resolved for the stage and `member`. With
 * `environmentSets`, each stage's jobs take that stage's config and secret
 * set: the first stage's wave jobs through the op-waves generator, and each
 * later stage's promote job here.
 */
export type PipelineGenerateOptions = Omit<OpWavesPipelineOptions, "specFile" | "renderSpec"> & {
  identity?: CloudIdentityDeclaration;
  member?: string;
};

/** The forges a pipeline renders for, as the set's forge words spell them. */
const SET_FORGES = new Set(["github", "gitlab", "forgejo"]);

/**
 * The first stage's op-waves spec with each wave's cloud identity, from
 * `identity` for the stage, on every wave that names none of its own.
 */
function withStageIdentity(shape: OpWavesSpec, stage: string, identity: CloudIdentityDeclaration | undefined, member: string | undefined): OpWavesSpec {
  const cloud = identity ? resolveCloudIdentity(identity, stage, member)?.apply : undefined;
  if (!cloud) return shape;
  return { ...shape, waves: shape.waves.map((w) => (w.cloud ? w : { ...w, cloud })) };
}

/** What one later stage's promote job adds: its identity and its set. */
function promoteStageInputs(stage: string, lexicon: string, options: PipelineGenerateOptions): PipelinePromoteStageInputs {
  const cloud = options.identity ? resolveCloudIdentity(options.identity, stage, options.member)?.apply : undefined;
  const out: PipelinePromoteStageInputs = cloud ? { cloud } : {};
  if (options.environmentSets && SET_FORGES.has(lexicon)) {
    const forge = lexicon as EnvironmentSetForge;
    const set = resolveEnvironmentSet(options.environmentSets, stage);
    out.variables = environmentSetForgeVariables(set, forge);
    const setup = environmentSetJobInputs(set, forge).setup;
    if (setup.length > 0) out.setup = setup;
  }
  return out;
}

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
    const { identity, member, ...waveOptions } = options;
    const shape = withStageIdentity(stageWavesSpec(spec, first), first, identity, member);
    const waves = found.generateOpWavesPipeline(shape, {
      ...waveOptions,
      ...(bin ? { bin } : {}),
      specFile: pipelineStageSpecFile(spec, first),
      renderSpec: { command: pipelineSpecCommand(first, bin) },
    });
    const later = spec.stages.slice(1);
    const promote = later.length === 0
      ? []
      : found.generatePipelinePromote({
          pipeline: spec.name,
          stages: later.map((s) => ({
            name: s.name,
            ...(s.forgeEnvironment ? { environment: s.forgeEnvironment } : {}),
            ...promoteStageInputs(s.name, lexicon, options),
            // #5358: the stage's agent steps run in a job of their own before the promote.
            ...(stageAgentSteps(spec, s.name).length > 0 ? { agentSteps: { keyEnvs: stageAgentKeyEnvs(spec, s.name) } } : {}),
          })),
          ...(bin ? { bin } : {}),
          ...(spec.defaults?.runner ? { runner: spec.defaults.runner } : {}),
          ...(options.jobTimeoutMinutes ? { jobTimeoutMinutes: options.jobTimeoutMinutes } : {}),
          // #5326: the scheduled re-run of the promotions a soak holds.
          ...(spec.recheck ? { recheck: { schedule: spec.recheck.schedule } } : {}),
          // #5339: with verify-failed among agentFacts' triggers, the promote jobs record failed verifies and soaks for the agent.
          ...(options.agentFacts?.triggers?.includes("verify-failed") ? { agentFacts: { ...(options.agentFacts.relayKeyEnv ? { relayKeyEnv: options.agentFacts.relayKeyEnv } : {}) } } : {}),
        });
    return { success: true, files: [...waves.files, ...promote], jobs: waves.jobs };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
