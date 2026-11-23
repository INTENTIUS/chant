import { describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { lexiconDependencies, lexiconsToGenerate } from "./generate-lexicon-deps";

function workspace(lexicons: Record<string, { deps?: string[]; dev?: string[]; generate?: boolean }>): string {
  const root = mkdtempSync(join(tmpdir(), "lexicon-deps-"));
  for (const [name, spec] of Object.entries(lexicons)) {
    mkdirSync(join(root, "lexicons", name), { recursive: true });
    const named = (list: string[] = []) => Object.fromEntries(list.map((d) => [d, "*"]));
    writeFileSync(
      join(root, "lexicons", name, "package.json"),
      JSON.stringify({
        name: `@intentius/chant-lexicon-${name}`,
        scripts: spec.generate === false ? {} : { generate: "tsx src/codegen/generate-cli.ts" },
        dependencies: named(spec.deps),
        devDependencies: named(spec.dev),
      }),
    );
  }
  return root;
}

describe("generate-lexicon-deps (#5515)", () => {
  test("follows imports transitively, each dependency before the lexicons importing it", () => {
    const root = workspace({
      k8s: { deps: ["@intentius/chant-lexicon-otel", "@intentius/chant-lexicon-prometheus", "js-yaml"] },
      prometheus: { deps: ["@intentius/chant-lexicon-otel"] },
      otel: { deps: ["@intentius/chant-lexicon-sql"] },
      sql: {},
    });
    expect(lexiconDependencies(root, "k8s")).toEqual(["sql", "otel", "prometheus"]);
  });

  test("a lexicon that imports no other lexicon has nothing to generate", () => {
    const root = workspace({ gcp: { deps: ["js-yaml"] } });
    expect(lexiconsToGenerate(root, "gcp")).toEqual([]);
  });

  test("skips a dependency with no generate script and a package that is not a workspace lexicon", () => {
    const root = workspace({
      gitlab: { deps: ["@intentius/chant-lexicon-github", "@intentius/chant-lexicon-elsewhere"], dev: ["@intentius/chant-lexicon-plain"] },
      github: {},
      plain: { generate: false },
    });
    expect(lexiconDependencies(root, "gitlab")).toEqual(["github", "plain"]);
    expect(lexiconsToGenerate(root, "gitlab")).toEqual(["github"]);
  });

  test("refuses a cycle and an unknown lexicon", () => {
    const root = workspace({ a: { deps: ["@intentius/chant-lexicon-b"] }, b: { deps: ["@intentius/chant-lexicon-a"] } });
    expect(() => lexiconDependencies(root, "a")).toThrow(/cycle/);
    expect(() => lexiconDependencies(root, "nope")).toThrow(/no lexicons\/nope/);
  });

  test("in this repository, k8s builds against sql, otel and prometheus", () => {
    const root = resolve(import.meta.dirname, "..");
    expect(lexiconsToGenerate(root, "k8s")).toEqual(["sql", "otel", "prometheus"]);
  });
});
