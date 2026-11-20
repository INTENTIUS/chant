/**
 * An environment's config and secret set on its stage's wave jobs (#5348).
 *
 * The Op waves generators (GitHub, GitLab, Forgejo) call
 * {@link opWavesWithEnvironmentSets} first with the options they were given.
 * With `environmentSets`, each wave takes the set of its environment: the
 * spec's `labels.Env` when it names one (a stage of a pipeline, #5324,
 * names its stage there), else the wave's name. The set's config, its
 * record and its forge secrets join the wave's `variables`, which every job
 * of the wave reads, and the read of the store secrets joins the wave's
 * `prelude`, the lines of the command's own step, which run after the
 * wave's trade and the product's login. A set's variable replaces a wave
 * variable of the same name.
 *
 * Before merge (`beforeMerge`) a wave's plan job runs the pull request's
 * code with the wave's variables, so a set that holds a secret is refused
 * there; its config goes on as above.
 *
 * Without `environmentSets` the spec and the options come back as they
 * were, so the files render byte for byte as before.
 */

import type { OpWavesPipelineOptions } from "../lexicon";
import type { OpWavesSpec } from "./op-waves";
import { environmentSetJobInputs, resolveEnvironmentSet, type EnvironmentSetForge, type ResolvedEnvironmentSet } from "../components/environment-sets";
import { FORGE_TOKEN_VARS } from "../ci-handover";
import { OIDC_REQUEST_VARS } from "../ci-identity";

/** The environment a wave's set is read for: the spec's `labels.Env`, else the wave's name. */
export function opWaveSetEnvironment(spec: Pick<OpWavesSpec, "labels">, wave: { name: string }): string {
  return spec.labels?.Env ?? wave.name;
}

/** The forge's spelling of a passed secret: `${{ secrets.<s> }}`, or GitLab's `$<s>` (none when the names match, since GitLab passes it as it is). */
function forgeSecret(forge: EnvironmentSetForge, variable: string, secret: string): string | undefined {
  if (forge !== "gitlab") return `\${{ secrets.${secret} }}`;
  return variable === secret ? undefined : `$${secret}`;
}

/**
 * The variables a job of the set's stage sets, as the forge reads them:
 * the config, the record and, unless `secrets` is false, the forge secrets.
 * Throws on a name the jobs set or drop themselves.
 */
export function environmentSetForgeVariables(set: ResolvedEnvironmentSet, forge: EnvironmentSetForge, options: { secrets?: boolean } = {}): Record<string, string> {
  const inputs = environmentSetJobInputs(set, forge, options);
  const reserved = new Set<string>([...FORGE_TOKEN_VARS, ...OIDC_REQUEST_VARS]);
  const out: Record<string, string> = { ...inputs.variables };
  for (const [variable, secret] of Object.entries(inputs.secrets)) {
    const spelled = forgeSecret(forge, variable, secret);
    if (spelled !== undefined) out[variable] = spelled;
  }
  for (const name of Object.keys(out)) {
    if (reserved.has(name)) throw new Error(`the set of ${set.entry} sets ${name}, which the jobs set or drop themselves; give it another name`);
  }
  return out;
}

/** `spec` and `options` with each wave's environment set on its jobs; both as given without `environmentSets`. */
export function opWavesWithEnvironmentSets(spec: OpWavesSpec, options: OpWavesPipelineOptions, forge: EnvironmentSetForge): { spec: OpWavesSpec; options: OpWavesPipelineOptions } {
  const sets = options.environmentSets;
  if (!sets) return { spec, options };
  const waveJobs = { ...(options.waveJobs ?? {}) };
  const waves = spec.waves.map((wave) => {
    const env = opWaveSetEnvironment(spec, wave);
    let set: ResolvedEnvironmentSet;
    try {
      set = resolveEnvironmentSet(sets, env);
    } catch (err) {
      throw new Error(`Op waves "${spec.name}": wave "${wave.name}" runs in ${env}, and ${err instanceof Error ? err.message : String(err)}`);
    }
    if (options.beforeMerge && set.secrets.length > 0) {
      throw new Error(
        `Op waves "${spec.name}": the set of ${set.entry} holds secrets (${set.secrets.map((s) => s.name).join(", ")}), and before merge a wave's plan job runs the pull request's code with the wave's variables; run the stage's waves on a push to pass them`,
      );
    }
    const inputs = environmentSetJobInputs(set, forge);
    if (inputs.setup.length > 0) {
      const own = waveJobs[wave.name] ?? {};
      waveJobs[wave.name] = { ...own, prelude: [...inputs.setup, ...(own.prelude ?? [])] };
    }
    return { ...wave, variables: { ...(wave.variables ?? {}), ...environmentSetForgeVariables(set, forge) } };
  });
  const { environmentSets: _sets, ...rest } = options;
  return { spec: { ...spec, waves }, options: { ...rest, ...(Object.keys(waveJobs).length > 0 ? { waveJobs } : {}) } };
}
