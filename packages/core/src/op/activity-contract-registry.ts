/**
 * Activity contract registry — the schema-shaped sibling of
 * `./activity-registry.ts` (chant #2101).
 *
 * `activity-contract.ts` left contract ownership per-caller on purpose: an
 * activity declares its contract alongside its implementation, and whoever
 * builds a contract map decides which activities it covers. What was missing
 * was the other half of that arrangement, a way for the checks that validate
 * Op steps to SEE a contract a lexicon declared. OPS012 and OPS013
 * (`../lint/rules/op/`) walk every Op entity in the build, including steps
 * calling `terraformPlan`, `k3sInstall`, `flyApply` or `gcpApply`, over
 * core's own static table alone. Since #2122 moved those checks into core
 * they fire on every project that declares an Op, so an Op built out of one
 * lexicon's steps failed `chant build` outright even though `loadActivities`
 * resolves the very same names at run time. Both terraform examples that
 * carry an Op kept it outside `src/` because of the older, lexicon-hosted
 * form of the same gap, which meant no example ever proved its Op builds.
 *
 * The resolution mirrors activities exactly, by convention:
 * `@intentius/chant-lexicon-<name>/op/activity-contracts` is imported for
 * every configured lexicon and every {@link ActivityContract} it exports is
 * collected, keyed by the contract's declared `name`. A lexicon that ships
 * no such module is skipped, the same way `loadActivities` skips one that
 * contributes no activities. A plugin may also hand its contracts over
 * directly through {@link LexiconActivityContractContributor}, for a lexicon
 * whose contracts are not reachable at a subpath (a bundled single-file
 * plugin, a project-local one).
 *
 * The merged map reaches a post-synth check as
 * `PostSynthContext.activityContracts` (`../lint/post-synth.ts`), filled in
 * by whoever runs the checks: `chant build`, `chant lint` and
 * `check-lexicon`'s example harness all do. A check merges it over its own
 * base table rather than replacing it, so a context that carries none (a
 * hand-built one in a test) behaves exactly as before this existed.
 */

import * as coreContracts from "./activities/activity-contracts";
import { collectActivityContracts, type ActivityContract } from "./activity-contract";

/**
 * The shape {@link loadActivityContracts} reads off a plugin: an optional
 * member returning this lexicon's contracts directly, for one that cannot be
 * reached by the subpath convention. Structural on purpose, so core's op
 * layer does not depend on `../lexicon.ts`.
 */
export interface LexiconActivityContractContributor {
  /** The lexicon's name, as in `@intentius/chant-lexicon-<name>`. */
  name: string;
  /** This lexicon's activity contracts, if it declares them in code rather than at the conventional subpath. */
  activityContracts?(): ActivityContract[];
}

/**
 * Build the activity-contract map for build-time validation: core's own
 * contracts (`./activities/activity-contracts`, a static import so a project
 * that has installed nothing but chant still gets them) plus every contract
 * the named lexicons contribute.
 *
 * `lexicons` may be plain names or plugin-shaped objects; a plugin's
 * `activityContracts()` is read after its conventional module, so a plugin
 * that declares both wins on a name collision with itself. Across lexicons,
 * last one in wins, which is the same rule `loadActivities` applies to
 * implementations.
 *
 * Never throws: an absent lexicon, a missing subpath, or a plugin member that
 * throws all leave the map as it was.
 */
export async function loadActivityContracts(
  lexicons: ReadonlyArray<string | LexiconActivityContractContributor> = [],
): Promise<Map<string, ActivityContract>> {
  const contracts = new Map<string, ActivityContract>();

  collectActivityContracts(coreContracts as unknown as Record<string, unknown>, contracts);

  for (const entry of lexicons) {
    const name = typeof entry === "string" ? entry : entry.name;
    try {
      const spec = `@intentius/chant-lexicon-${name}/op/activity-contracts`;
      collectActivityContracts((await import(spec)) as Record<string, unknown>, contracts);
    } catch {
      // Lexicon absent or declares no contracts at the conventional subpath.
    }

    if (typeof entry !== "string" && typeof entry.activityContracts === "function") {
      try {
        for (const contract of entry.activityContracts()) contracts.set(contract.name, contract);
      } catch {
        // A plugin member that throws contributes nothing, the same as one that is absent.
      }
    }
  }

  return contracts;
}

/**
 * Merge a check's own base contracts with the ones the build loaded, into the
 * map `validateActivitySteps`/`validateStepOutputRefs` take. The loaded set
 * wins on a name collision: it is the one resolved against the lexicons this
 * build actually configured, whereas the base table is whatever the check
 * imported statically.
 *
 * `loaded` being `undefined` is the ordinary case for a hand-built
 * `PostSynthContext` and yields the base table unchanged.
 */
export function mergeActivityContracts(
  base: ReadonlyMap<string, ActivityContract>,
  loaded: ReadonlyMap<string, ActivityContract> | undefined,
): ReadonlyMap<string, ActivityContract> {
  if (!loaded || loaded.size === 0) return base;
  const merged = new Map(base);
  for (const [name, contract] of loaded) merged.set(name, contract);
  return merged;
}
