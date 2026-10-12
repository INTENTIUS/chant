/**
 * chant#3612 — `build()` and `foldProject` report the same entities, under the
 * same names, with the same provenance, for projects that use composites.
 *
 * The two share `collectEntities` and `foldProvenanceOfEntities`; what could
 * still differ is what each hands them. These fixtures are real examples, one
 * per lexicon whose composites a project calls, built the way `chant build`
 * builds them (fold on, the plugins' intrinsics, the lexicon names).
 */
import { describe, test, expect, beforeAll } from "vitest";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "../build";
import { foldProject, type FoldProvenance } from "../index";
import { findInfraFiles } from "./files";
import { loadPlugins, resolveProjectLexicons } from "../cli/plugins";
import type { LexiconPlugin } from "../lexicon";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

const FIXTURES = [
  "lexicons/aws/examples/fargate-alb",
  "lexicons/aws/examples/lambda-function",
  "lexicons/aws/examples/multi-service-alb",
  "lexicons/k8s/examples/batch-workers",
  "lexicons/k8s/examples/web-platform",
  "lexicons/sql/examples/postgres-composites",
];

describe("build() and foldProject agree on composite-using projects (chant#3612)", () => {
  // Loading a lexicon (aws's generated barrel above all) is the slow part, and
  // it is not what the tests measure, so it happens once, up front.
  const pluginsOf = new Map<string, LexiconPlugin[]>();
  beforeAll(async () => {
    for (const fixture of FIXTURES) {
      const project = join(repoRoot, fixture);
      pluginsOf.set(fixture, await loadPlugins(await resolveProjectLexicons(project)));
    }
  }, 60_000);

  test.each(FIXTURES)("%s", async (fixture) => {
    const src = join(repoRoot, fixture, "src");
    const plugins = pluginsOf.get(fixture)!;
    const intrinsics = plugins.flatMap((p) => p.intrinsics?.() ?? []);
    const lexicons = plugins.map((p) => p.name);

    const built = await build(src, plugins.map((p) => p.serializer), undefined, { fold: true, intrinsics, lexicons });
    expect(built.errors).toEqual([]);

    const files = await findInfraFiles(src);
    const verdicts = await foldProject(files, intrinsics, { lexicons });
    // Same verdict per file. A file that runs (a `chant.config.ts` in `src`)
    // has no fold provenance in foldProject, so it is left out of both sides.
    const mode = new Map(built.foldDecisions.map((d) => [d.file, d.mode]));
    const folded: FoldProvenance = {};
    for (const [file, verdict] of verdicts) {
      expect({ file, verdict: verdict.verdict }).toEqual({ file, verdict: mode.get(file) });
      Object.assign(folded, verdict.foldProvenance);
    }
    const foldedFiles = new Set(files.filter((file) => verdicts.get(file)!.verdict === "fold"));
    expect(foldedFiles.size).toBeGreaterThan(0);
    const fromBuild = Object.fromEntries(
      Object.entries(built.foldProvenance).filter(([, record]) => foldedFiles.has(record.sourceFile ?? "")),
    );

    // The fixture has to exercise a composite, or the comparison proves nothing.
    expect(Object.values(fromBuild).some((record) => record.composite !== undefined)).toBe(true);
    expect(Object.keys(folded).sort()).toEqual(Object.keys(fromBuild).sort());
    expect(folded).toEqual(fromBuild);
  });
});
