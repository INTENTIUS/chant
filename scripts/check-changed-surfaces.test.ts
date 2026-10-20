import { describe, expect, it } from "vitest";
import { gatedByValidate, touchedLexicons, verdict } from "./check-changed-surfaces";
import type { SurfaceDelta } from "../packages/core/src/codegen/surface-snapshot";

const none: SurfaceDelta = { added: [], changed: [], removed: [], renamed: [], severity: "none" };
const added = (name: string): SurfaceDelta => ({ ...none, added: [{ name, entry: { kind: "resource", resourceType: `Test::${name}` } }], severity: "additive" });

describe("touchedLexicons (#2814)", () => {
  it("names a lexicon from a source change or a snapshot change", () => {
    expect(
      touchedLexicons([
        "lexicons/fly/src/codegen/generate.ts",
        "lexicons/github/surface.snapshot.json",
        "lexicons/fly/src/serializer.ts",
      ]),
    ).toEqual(["fly", "github"]);
  });

  it("ignores generated output, docs and files outside a lexicon's src", () => {
    expect(
      touchedLexicons([
        "lexicons/fly/src/generated/index.d.ts",
        "lexicons/fly/docs/src/content/docs/index.mdx",
        "lexicons/fly/package.json",
        "packages/core/src/index.ts",
      ]),
    ).toEqual([]);
  });
});

describe("gatedByValidate", () => {
  it("is true for a lexicon whose validate opts into the snapshot check", () => {
    expect(gatedByValidate(`validateLexiconArtifacts({ checkSurfaceSnapshot: "always" })`)).toBe(true);
    expect(gatedByValidate(`validateLexiconArtifacts({ checkSurfaceSnapshot: true })`)).toBe(true);
  });

  it("is false for one that does not", () => {
    expect(gatedByValidate(`validateLexiconArtifacts({ basePath })`)).toBe(false);
  });
});

describe("verdict", () => {
  it("passes when the fresh surface matches the snapshot", () => {
    expect(verdict(none, null)).toBe("matches");
  });

  it("fails when the change adds drift that base does not have", () => {
    expect(verdict(added("Widget"), none)).toBe("changed-without-snapshot");
  });

  it("passes upstream drift that base has too", () => {
    expect(verdict(added("Widget"), added("Widget"))).toBe("upstream-drift");
  });

  it("fails when the change adds drift on top of upstream drift", () => {
    const both: SurfaceDelta = { ...none, added: [...added("Widget").added, ...added("Gadget").added], severity: "additive" };
    expect(verdict(both, added("Widget"))).toBe("changed-without-snapshot");
  });
});
