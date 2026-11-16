/**
 * The CI system apart from the forge (#5170).
 *
 * The forge is where pull requests, comments and commit statuses live, and
 * whose REST API chant reads and writes with the forge's token. The CI system
 * is what runs the jobs and reads the pipeline files chant writes. Until
 * #5170 one `ForgeKind` named both, so `github` meant GitHub with GitHub
 * Actions. It still does: each forge's CI system defaults to the forge's own,
 * so a config that names only the forge builds what it always built.
 *
 * A CI system's value is the name of the lexicon that writes its pipeline
 * files, the one `chant build --components --generate <name>` takes:
 * `github` (GitHub Actions), `gitlab` (GitLab CI), `forgejo` (Forgejo
 * Actions) and `prow` (Prow, whose jobs the prow lexicon declares). Prow runs
 * jobs for GitHub repositories, so `prow` pairs with the `github` forge only.
 *
 * Code that reads the forge's API takes the forge (`ForgeKind`, ./pr-forge.ts).
 * Code that writes pipeline files, or reads a job's environment, takes the CI
 * system. `detectCi` in ./ci-detect.ts reads it from a job's environment. This
 * module imports nothing at run time, so chant.config.ts's loader can read it.
 */
import type { ForgeKind } from "./pr-forge";

/** What runs the jobs: the name of the lexicon that writes its pipeline files. */
export type CiSystem = "github" | "gitlab" | "forgejo" | "prow";

/** Every CI system chant writes pipelines for, the defaults first. */
export const CI_SYSTEMS: readonly CiSystem[] = ["github", "gitlab", "forgejo", "prow"];

/** The forges each CI system runs jobs for. */
export const CI_SYSTEM_FORGES: Readonly<Record<CiSystem, readonly ForgeKind[]>> = {
  github: ["github"],
  gitlab: ["gitlab"],
  forgejo: ["forgejo"],
  prow: ["github"],
};

/** The first chant with `@intentius/chant/ci-system`, `ci.forge` and `ci.system` in the workspace declaration, an environment executor's `ci`, and forge reads from a Prow job's environment (#5170). Products feature-detect on it. */
export const FORGE_CI_FLOOR = "0.124.101";

/** A forge and the CI system that runs its jobs. */
export interface ForgeCi {
  forge: ForgeKind;
  ci: CiSystem;
}

/** Whether `value` names a CI system. */
export function isCiSystem(value: unknown): value is CiSystem {
  return typeof value === "string" && (CI_SYSTEMS as readonly string[]).includes(value);
}

/** The CI system a forge runs when nothing names another: its own, so `github` is GitHub Actions. */
export function defaultCiOf(forge: ForgeKind): CiSystem {
  return forge;
}

/** The forge a CI system serves when nothing names one: `prow` serves GitHub, and the others serve their own forge. */
export function defaultForgeOf(ci: CiSystem): ForgeKind {
  return CI_SYSTEM_FORGES[ci][0]!;
}

/** Why `ci` cannot run the jobs of a repository on `forge`, or undefined when it can. */
export function forgeCiProblem(forge: ForgeKind, ci: CiSystem): string | undefined {
  const forges = CI_SYSTEM_FORGES[ci];
  if (forges.includes(forge)) return undefined;
  return `ci: ${ci} runs jobs for a repository on ${forges.join(" or ")}, and this forge is ${forge}`;
}

/** Thrown by {@link resolveForgeCi} for a CI system that cannot serve the forge. */
export class ForgeCiError extends Error {
  constructor(
    readonly forge: ForgeKind,
    readonly ci: CiSystem,
    message: string,
  ) {
    super(message);
    this.name = "ForgeCiError";
  }
}

/**
 * The forge and its CI system, with the CI system defaulting to the forge's
 * own. Throws {@link ForgeCiError} for a pair that cannot run, such as
 * `forge: gitlab` with `ci: prow`.
 */
export function resolveForgeCi(input: { forge: ForgeKind; ci?: CiSystem }): ForgeCi {
  const ci = input.ci ?? defaultCiOf(input.forge);
  const problem = forgeCiProblem(input.forge, ci);
  if (problem) throw new ForgeCiError(input.forge, ci, problem);
  return { forge: input.forge, ci };
}

/**
 * The lexicon that writes `ci`'s pipeline files, by the name
 * `chant build --components --generate` and the lexicon plugins use. The
 * forge lexicons' generators write GitHub Actions, GitLab CI and Forgejo
 * Actions files. For `prow` it is the prow lexicon, whose `forgeJobConfig`
 * keys a job config by the forge's `owner/name`.
 */
export function pipelineLexiconOf(ci: CiSystem): string {
  return ci;
}
