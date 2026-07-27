import { describe, test, expect } from "vitest";
import { generateIntrinsics } from "./docs-sections";
import { intrinsicFolds } from "../lexicon";
import type { DocsConfig, ManifestJSON } from "./docs-types";

/**
 * chant #1062 (epic #1019) — the per-lexicon intrinsic foldability matrix.
 * `generateIntrinsics`'s "Folds?" column must come from {@link intrinsicFolds}
 * (`../lexicon.ts`), the SAME predicate `fold()` uses to decide whether a
 * registered tag actually folds — not a second `isTag`-shaped guess that
 * could silently disagree with it. This test locks in that the column
 * exists, has the right value per intrinsic, and tracks `intrinsicFolds`
 * rather than restating its logic.
 */

const config: DocsConfig = {
  name: "test",
  displayName: "Test",
  description: "A test lexicon",
  distDir: "/tmp/does-not-matter",
  outDir: "/tmp/does-not-matter",
};

function manifestWith(intrinsics: ManifestJSON["intrinsics"]): ManifestJSON {
  return { name: "test", version: "0.0.0", intrinsics };
}

describe("generateIntrinsics — Folds? column", () => {
  test("a registered tagged-template intrinsic folds", () => {
    const page = generateIntrinsics(config, manifestWith([{ name: "Sub", isTag: true }]));
    expect(page).toContain("| Function | Description | Output Key | Tag? | Folds? |");
    expect(page).toContain("| `Sub` | — | `Sub` | Yes | Yes |");
  });

  test("a plain-call intrinsic its lexicon never opted in does not fold", () => {
    const page = generateIntrinsics(config, manifestWith([{ name: "Ref", isTag: false }]));
    expect(page).toContain("| `Ref` | — | `Ref` | No | No |");
  });

  test("a plain-call intrinsic opted into call-form folding does fold (chant #1044)", () => {
    const page = generateIntrinsics(config, manifestWith([{ name: "Ref", isTag: false, foldsAsCall: true }]));
    expect(page).toContain("| `Ref` | — | `Ref` | No | Yes |");
  });

  test("an intrinsic with isTag omitted does not fold (same as isTag: false)", () => {
    const page = generateIntrinsics(config, manifestWith([{ name: "reference", outputKey: "!reference" }]));
    expect(page).toContain("| `reference` | — | `!reference` | No | No |");
  });

  test("Folds? always matches intrinsicFolds() for every row, never a restated copy", () => {
    const intrinsics: NonNullable<ManifestJSON["intrinsics"]> = [
      { name: "Sub", isTag: true },
      { name: "Ref" },
      { name: "GetAtt", isTag: false },
      { name: "Join", isTag: false, foldsAsCall: true },
    ];
    const page = generateIntrinsics(config, manifestWith(intrinsics));
    for (const fn of intrinsics) {
      const expected = intrinsicFolds(fn) ? "Yes" : "No";
      const row = page.split("\n").find((line) => line.startsWith(`| \`${fn.name}\` |`));
      expect(row, `no row rendered for ${fn.name}`).toBeDefined();
      const cells = (row as string).split("|").map((c) => c.trim());
      // | `name` | description | outputKey | Tag? | Folds? |  →  ["", "`name`", desc, key, tag, folds, ""]
      expect(cells[5]).toBe(expected);
    }
  });
});
