import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { foldProject, type FoldProjectVerdict } from "@intentius/chant";
import type { BuildParamValue } from "@intentius/chant/build-params";
import { findInfraFiles } from "@intentius/chant/discovery/files";
import { discoverCorpus, entryBuildParams, type CorpusEntry } from "./differential-corpus";

/**
 * chant#2422 — `foldProject()` answers the question a real build asks, or it
 * answers a harsher one.
 *
 * The entry took only `intrinsics`, so `createFoldSession`'s other two inputs
 * were never supplied: `FoldSession.lexiconPackages` was always empty and
 * `session.buildParams` always unset. An empty package set "disables
 * lexicon-package resolution entirely rather than falling back to something
 * more permissive", so through this entry nothing reading a lexicon data
 * export as a value could fold, and nothing reading `params` could either,
 * even though both fold under `chant build --fold`.
 *
 * Found by the specification's corpus cross-check
 * (INTENTIUS/typescript-as-data#25), which carved the affected files out under
 * two named limits rather than counting them as disagreements.
 *
 * The tests below are deliberately two shapes. The targeted ones name one file
 * and one cause, so a regression says which input went missing. The corpus-wide
 * one asserts the property that matters and cannot be satisfied by special-
 * casing: supplying more of the session never makes a file fold *less*.
 */

const ROOT = resolve(import.meta.dirname, "..");

/** The corpus entry whose `srcDir` ends with `suffix`. */
async function entryFor(suffix: string): Promise<CorpusEntry> {
  const entries = await discoverCorpus();
  const found = entries.find((e) => e.srcDir.endsWith(suffix));
  if (!found) throw new Error(`no corpus entry under ${suffix} (corpus has ${entries.length} entries)`);
  return found;
}

/** This entry's build parameters, resolved the way the CLI resolves them. */
async function paramsOf(entry: CorpusEntry): Promise<Record<string, BuildParamValue>> {
  const provenance = await entryBuildParams(entry);
  return Object.fromEntries(provenance.map((p) => [p.name, p.value]));
}

/** Fold one entry twice: with nothing but intrinsics, and with everything a build has. */
async function bothWays(entry: CorpusEntry): Promise<{
  files: string[];
  bare: Map<string, FoldProjectVerdict>;
  full: Map<string, FoldProjectVerdict>;
}> {
  const files = await findInfraFiles(entry.srcDir);
  const buildParams = await paramsOf(entry);
  const bare = await foldProject(files, entry.intrinsics);
  const full = await foldProject(files, entry.intrinsics, {
    lexicons: entry.lexicons,
    ...(Object.keys(buildParams).length > 0 ? { buildParams } : {}),
  });
  return { files, bare, full };
}

describe("foldProject — the lexicon list (chant#2422)", () => {
  test("a file reading a lexicon data export cannot fold without it, and folds with it", async () => {
    const entry = await entryFor("lexicons/gitlab/examples/docs-snippets/src");
    const file = resolve(entry.srcDir, "workflow.ts");
    const { bare, full } = await bothWays(entry);

    // `CI` is gitlab's data export. With no package list there is nothing to
    // resolve it against, so the identifier is simply unbound.
    expect(bare.get(file)?.verdict).toBe("run");
    expect(bare.get(file)?.reason).toContain("unresolved identifier: CI");
    expect(full.get(file)?.verdict).toBe("fold");
  }, 60_000);

  test("the list alone is enough — an entry with no build parameters still flips", async () => {
    const entry = await entryFor("lexicons/gitlab/examples/docs-snippets/src");
    const files = await findInfraFiles(entry.srcDir);
    const file = resolve(entry.srcDir, "workflow.ts");

    const listOnly = await foldProject(files, entry.intrinsics, { lexicons: entry.lexicons });
    expect(listOnly.get(file)?.verdict).toBe("fold");
  }, 60_000);
});

describe("foldProject — build parameters (chant#2422)", () => {
  test("a file reading `params` cannot fold without them, and folds with them", async () => {
    const entry = await entryFor("examples/argo-cd-gke/src");
    const file = resolve(entry.srcDir, "config.ts");
    const { bare, full } = await bothWays(entry);

    expect(bare.get(file)?.verdict).toBe("run");
    expect(bare.get(file)?.reason).toContain("unresolved identifier: params");
    expect(full.get(file)?.verdict).toBe("fold");
  }, 60_000);

  test("the lexicon list alone does not unblock it — `params` is the other input", async () => {
    const entry = await entryFor("examples/argo-cd-gke/src");
    const files = await findInfraFiles(entry.srcDir);
    const file = resolve(entry.srcDir, "config.ts");

    const listOnly = await foldProject(files, entry.intrinsics, { lexicons: entry.lexicons });
    expect(listOnly.get(file)?.verdict).toBe("run");
    expect(listOnly.get(file)?.reason).toContain("unresolved identifier: params");
  }, 60_000);
});

describe("foldProject — over the whole corpus (chant#2422)", () => {
  test("supplying the session never makes a file fold less, and makes many fold that could not", async () => {
    const entries = await discoverCorpus();
    const regressed: string[] = [];
    const flipped: string[] = [];

    for (const entry of entries) {
      const { files, bare, full } = await bothWays(entry);
      for (const file of files) {
        const was = bare.get(file)?.verdict;
        const now = full.get(file)?.verdict;
        if (was === "fold" && now !== "fold") regressed.push(file.slice(ROOT.length + 1));
        if (was !== "fold" && now === "fold") flipped.push(file.slice(ROOT.length + 1));
      }
    }

    expect(regressed, "a fuller session must never take a fold away").toEqual([]);
    // #2422 measured 21 files flipping from the lexicon list alone at
    // chant-v0.70.1, counted per file with `tryFoldFile`. Through
    // `foldProject`, with the build parameters supplied as well and the taint
    // fixpoint free to carry a folded `config.ts` to its importers, the number
    // is far larger. The floor is deliberately the issue's own number rather
    // than today's: this guards the inputs being threaded at all, and should
    // not have to be edited every time an example changes.
    expect(flipped.length).toBeGreaterThanOrEqual(21);
  }, 600_000);
});

describe("a failed pre-build names its own cause (chant#2423)", () => {
  test("the reason at the export site carries the located cause on the `new` line", async () => {
    const entry = await entryFor("examples/local-fly/src");
    const file = resolve(entry.srcDir, "infra.ts");
    const files = await findInfraFiles(entry.srcDir);

    // Deliberately without the lexicon list, which is what makes `Fly` unbound
    // and so makes the pre-build of `const app = new App({...})` fail. The
    // pre-build swallows that by design, and the first reference to `app` then
    // rejects at the export site, which is the consequence rather than the
    // cause.
    const verdicts = await foldProject(files, entry.intrinsics);
    const reason = verdicts.get(file)?.reason ?? "";

    expect(verdicts.get(file)?.verdict).toBe("run");
    expect(reason, "the reference site is still where the rejection is raised").toContain(
      "same-file resource `app` used as a value is not foldable",
    );
    expect(reason, "and the located cause is appended").toMatch(/\(\d+:\d+ - unresolved identifier: Fly\)/);

    // The whole point of naming the cause: fixing it fixes the file.
    const full = await foldProject(files, entry.intrinsics, { lexicons: entry.lexicons });
    expect(full.get(file)?.verdict).toBe("fold");
  }, 60_000);
});
