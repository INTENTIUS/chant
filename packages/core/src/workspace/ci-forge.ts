/**
 * `ci.forge` and `ci.system` (#5170): the forge the repository is on and the
 * CI system that runs its jobs, read from the declaration at base, as
 * `ci.locks` is (./ci-locks.ts). Null outside a workspace and when the
 * declaration names neither, and then each command takes the forge from its
 * job or its flags, and the CI system is the forge's own.
 */
import type { ForgeCi } from "../ci-system";
import { CI_SYSTEMS, isCiSystem } from "../ci-system";
import { scopeSource } from "./write-scope";

/** The `ci.forge` and `ci.system` of the workspace holding `cwd`, read at `at` when given, else at base, else from the working tree. */
export function ciForgeAt(cwd: string, at?: string): ForgeCi | null {
  return scopeSource(cwd, at).declaration?.ci?.forgeCi ?? null;
}

/**
 * Why `chant build --components --generate <lexicon>` would write the wrong
 * CI system's files for the declaration's `ci.system`, or undefined when it
 * writes the right one. A lexicon that names no CI system is left to the
 * generator, which refuses one with no pipeline generator.
 */
export function generateTargetProblem(lexicon: string, declared: ForgeCi | null): string | undefined {
  if (!declared || !isCiSystem(lexicon) || lexicon === declared.ci) return undefined;
  return `chant.workspace.json names ci.system ${declared.ci} for the ${declared.forge} forge, and --generate ${lexicon} writes ${lexicon}'s pipeline files; generate ${declared.ci}, or change ci.system (one of ${CI_SYSTEMS.join(", ")})`;
}
