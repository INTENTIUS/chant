import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditIntrinsics } from "./check-lexicon-intrinsics";

/**
 * chant #1067 — proof that the intrinsic-foldability audit actually
 * validates, rather than just counting. Each case here is a small,
 * synthetic lexicon (plugin.ts + index.ts + intrinsics.ts) so the
 * fixtures encode the exact failure shapes #1039 shipped: a genuine
 * tagged template registered with the wrong `isTag`, and a plain call
 * registered with the wrong `isTag`, in both directions — plus a
 * registration naming something the package never exports.
 */

function writeFixture(dir: string): void {
  mkdirSync(join(dir, "src"), { recursive: true });

  writeFileSync(
    join(dir, "src/plugin.ts"),
    `export const testPlugin = {
  name: "test",
  intrinsics() {
    return [
      { name: "Tag1", description: "a genuine tagged template", isTag: true },
      { name: "Plain1", description: "a genuine plain call", isTag: false },
      { name: "Mismatch1", description: "claims tag but is a plain call", isTag: true },
      { name: "Mismatch2", description: "claims plain but is a tagged template", isTag: false },
      { name: "Missing1", description: "registered but never exported", isTag: false },
    ];
  },
};
`,
  );

  writeFileSync(
    join(dir, "src/index.ts"),
    `export { Tag1, Plain1, Mismatch1, Mismatch2 } from "./intrinsics";
`,
  );

  writeFileSync(
    join(dir, "src/intrinsics.ts"),
    `export function Tag1(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.join("");
}

export function Plain1(x: string): string {
  return x;
}

// Registered as isTag: true above — this is the #1039 "aws Sub" shape,
// inverted: a plain call wrongly claimed as a tag.
export function Mismatch1(x: string): string {
  return x;
}

// Registered as isTag: false above — this is the #1039 "gitlab reference()"
// shape: a genuine tagged template wrongly claimed as a plain call.
export function Mismatch2(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.join("");
}
`,
  );
}

describe("auditIntrinsics", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "chant-check-lexicon-intrinsics-"));
    writeFixture(dir);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("a genuine tagged template registered as isTag: true passes", () => {
    const items = auditIntrinsics(dir);
    const item = items.find((i) => i.name === "Tag1");
    expect(item).toMatchObject({ exported: true, actualIsTag: true, ok: true });
  });

  test("a genuine plain call registered as isTag: false passes", () => {
    const items = auditIntrinsics(dir);
    const item = items.find((i) => i.name === "Plain1");
    expect(item).toMatchObject({ exported: true, actualIsTag: false, ok: true });
  });

  test("a plain call wrongly registered as isTag: true fails (aws Sub shape, inverted)", () => {
    const items = auditIntrinsics(dir);
    const item = items.find((i) => i.name === "Mismatch1");
    expect(item?.ok).toBe(false);
    expect(item?.exported).toBe(true);
    expect(item?.actualIsTag).toBe(false);
    expect(item?.detail).toMatch(/plain call.*but registered with isTag: true/);
  });

  test("a tagged template wrongly registered as isTag: false fails (gitlab reference() shape)", () => {
    const items = auditIntrinsics(dir);
    const item = items.find((i) => i.name === "Mismatch2");
    expect(item?.ok).toBe(false);
    expect(item?.exported).toBe(true);
    expect(item?.actualIsTag).toBe(true);
    expect(item?.detail).toMatch(/authored as a tagged template.*isTag: false/);
  });

  test("a registered intrinsic that isn't exported fails, distinctly from a signature mismatch", () => {
    const items = auditIntrinsics(dir);
    const item = items.find((i) => i.name === "Missing1");
    expect(item?.exported).toBe(false);
    expect(item?.ok).toBe(false);
    expect(item?.detail).toMatch(/not exported from src\/index\.ts/);
  });

  test("returns [] for a lexicon with no intrinsics() method", () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "chant-check-lexicon-intrinsics-empty-"));
    try {
      mkdirSync(join(emptyDir, "src"), { recursive: true });
      writeFileSync(join(emptyDir, "src/plugin.ts"), `export const testPlugin = { name: "test" };\n`);
      expect(auditIntrinsics(emptyDir)).toEqual([]);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  test("returns [] for a lexicon whose intrinsics() legitimately registers none (gcp/k8s shape)", () => {
    const emptyArrayDir = mkdtempSync(join(tmpdir(), "chant-check-lexicon-intrinsics-emptyarray-"));
    try {
      mkdirSync(join(emptyArrayDir, "src"), { recursive: true });
      writeFileSync(
        join(emptyArrayDir, "src/plugin.ts"),
        `export const testPlugin = {
  name: "test",
  intrinsics() {
    return [];
  },
};
`,
      );
      expect(auditIntrinsics(emptyArrayDir)).toEqual([]);
    } finally {
      rmSync(emptyArrayDir, { recursive: true, force: true });
    }
  });
});
