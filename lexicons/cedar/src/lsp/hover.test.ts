import { describe, expect, test } from "vitest";
import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type { HoverContext } from "@intentius/chant/lsp/types";
import { hover } from "./hover";

const pkgDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const lexiconPath = join(pkgDir, "src", "generated", "lexicon-cedar.json");
const hasGenerated =
  existsSync(lexiconPath) &&
  (() => {
    try {
      return Object.keys(JSON.parse(readFileSync(lexiconPath, "utf-8"))).length > 0;
    } catch {
      return false;
    }
  })();

function ctx(word: string): HoverContext {
  return {
    uri: "file:///policies.ts",
    content: "",
    position: { line: 0, character: 0 },
    word,
    lineText: "",
  };
}

describe("cedar hover", () => {
  test("returns undefined for a word the registry does not know", () => {
    expect(hover(ctx("NotACedarThing"))).toBeUndefined();
    expect(hover(ctx(""))).toBeUndefined();
  });

  test.skipIf(!hasGenerated)("describes Policy with its prop table", () => {
    const info = hover(ctx("Policy"));

    expect(info?.contents).toContain("**Policy**");
    expect(info?.contents).toContain("Cedar::Policy");
    expect(info?.contents).toContain("`effect`");
    expect(info?.contents).toContain("permit");
  });

  test.skipIf(!hasGenerated)("describes an entity type with its attributes", () => {
    const info = hover(ctx("Document"));

    expect(info?.contents).toContain("App::Document");
    expect(info?.contents).toContain("**Attributes:**");
    expect(info?.contents).toContain("classification");
  });

  test.skipIf(!hasGenerated)("marks an optional attribute", () => {
    const info = hover(ctx("User"));

    // `manager` is declared `"manager"?: User` in the default schema.
    expect(info?.contents).toContain("`manager`? —");
    expect(info?.contents).toContain("`email` —");
  });

  test.skipIf(!hasGenerated)("reports what an entity type is a member of", () => {
    expect(hover(ctx("Team"))?.contents).toContain("**Member of:** `App::Group`");
  });

  test.skipIf(!hasGenerated)("describes an action's principals, resources and context", () => {
    const info = hover(ctx("ReadAction"));

    expect(info?.contents).toContain('App::Action::"read"');
    expect(info?.contents).toContain("**Principals:**");
    expect(info?.contents).toContain("App::ServiceAccount");
    expect(info?.contents).toContain("**Resources:**");
    expect(info?.contents).toContain("**Context:**");
    expect(info?.contents).toContain("mfa");
  });

  test.skipIf(!hasGenerated)("describes a record property type as fields", () => {
    const info = hover(ctx("DocumentAttributes"));

    expect(info?.contents).toContain("App::Document.Attributes");
    expect(info?.contents).toContain("**Fields:**");
  });
});
