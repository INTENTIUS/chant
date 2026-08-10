import { describe, expect, test } from "vitest";
import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type { CompletionContext } from "@intentius/chant/lsp/types";
import { completions } from "./completions";

// The registry is a build artifact of `npm run generate`, and a fresh clone has
// not run it. Everything below that names a generated class skips when it is
// absent; the two cases that do not depend on it always run.
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

function ctx(partial: Partial<CompletionContext>): CompletionContext {
  return {
    uri: "file:///policies.ts",
    content: "",
    position: { line: 0, character: 0 },
    wordAtCursor: "",
    linePrefix: "",
    ...partial,
  };
}

describe("cedar completions", () => {
  test("returns nothing in an unrelated position", () => {
    expect(completions(ctx({ linePrefix: "const x = 1" }))).toEqual([]);
  });

  test("returns an array even with no cursor context", () => {
    expect(Array.isArray(completions(ctx({})))).toBe(true);
  });

  test.skipIf(!hasGenerated)("suggests Policy after `new `", () => {
    const items = completions(ctx({ linePrefix: "export const p = new " }));

    expect(items.length).toBeGreaterThan(0);
    expect(items.map((i) => i.label)).toContain("Policy");
    expect(items.every((i) => i.kind === "resource")).toBe(true);
  });

  test.skipIf(!hasGenerated)("suggests schema-derived entity classes", () => {
    const labels = completions(ctx({ linePrefix: "new " })).map((i) => i.label);

    expect(labels).toContain("Document");
    expect(labels).toContain("User");
  });

  test.skipIf(!hasGenerated)("narrows on a typed prefix", () => {
    const items = completions(ctx({ linePrefix: "new Docu", wordAtCursor: "Docu" }));

    expect(items.map((i) => i.label)).toContain("Document");
    expect(items.every((i) => i.label.toLowerCase().startsWith("docu"))).toBe(true);
  });

  test.skipIf(!hasGenerated)("carries the Cedar type name as the detail", () => {
    const policy = completions(ctx({ linePrefix: "new Poli", wordAtCursor: "Poli" })).find(
      (i) => i.label === "Policy",
    );

    expect(policy?.detail).toBe("Cedar::Policy");
  });

  test.skipIf(!hasGenerated)("suggests Policy props inside the constructor", () => {
    const content = "export const p = new Policy({\n  ";
    const labels = completions(
      ctx({
        content,
        position: { line: 1, character: 2 },
        linePrefix: "  ",
      }),
    ).map((i) => i.label);

    expect(labels).toContain("effect");
    expect(labels).toContain("principal");
    expect(labels).toContain("when");
  });

  test.skipIf(!hasGenerated)("suggests action constants in an `eq` scope", () => {
    const items = completions(ctx({ linePrefix: "  action: { eq: " }));

    expect(items.map((i) => i.label)).toContain("ReadAction");
    expect(items.map((i) => i.label)).toContain("WriteAction");
    // Entity classes are not actions and must not leak into this position.
    expect(items.map((i) => i.label)).not.toContain("Document");
  });

  test.skipIf(!hasGenerated)("suggests action constants inside an `in` list", () => {
    const labels = completions(ctx({ linePrefix: "  action: { in: [Rea", wordAtCursor: "Rea" })).map(
      (i) => i.label,
    );

    expect(labels).toEqual(["ReadAction"]);
  });

  test.skipIf(!hasGenerated)("documents an action's principals and resources", () => {
    const read = completions(ctx({ linePrefix: "  action: { eq: " })).find((i) => i.label === "ReadAction");

    expect(read?.documentation).toContain("App::User");
    expect(read?.documentation).toContain("App::Document");
  });
});
