import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkExamplesBuild } from "./check-lexicon-examples";

/**
 * chant #1067 — proof that "every shipped example builds" actually builds
 * one, rather than counting example directories the way every prior
 * check-lexicon.ts check did. The fixture reproduces the exact defect
 * found in `lexicons/aws/examples/core-concepts`: two files in the same
 * example independently exporting a top-level binding of the same name,
 * which is fine on its own but a "Duplicate export name" discovery error
 * the moment the whole `src/` directory is built as one project — which is
 * exactly what each example's own `npm run build` does.
 *
 * These fixtures import the real, already-installed `@intentius/chant-lexicon-aws`
 * package (workspace-linked), so no lexicon plugin needs to be faked.
 */

function writeLexiconDirWithExample(
  lexiconDir: string,
  exampleName: string,
  files: Record<string, string>,
): void {
  const srcDir = join(lexiconDir, "examples", exampleName, "src");
  mkdirSync(srcDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(srcDir, name), content);
  }
}

describe("checkExamplesBuild", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "chant-check-lexicon-examples-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("a clean example builds", async () => {
    writeLexiconDirWithExample(dir, "clean", {
      "bucket.ts": `import { Bucket } from "@intentius/chant-lexicon-aws";

export const appBucket = new Bucket({
  BucketName: "my-app-bucket",
});
`,
    });

    const results = await checkExamplesBuild(dir);
    const clean = results.find((r) => r.example === "clean");
    expect(clean).toMatchObject({ ok: true });
  });

  test("two files independently exporting the same top-level name fails to build (the core-concepts defect)", async () => {
    writeLexiconDirWithExample(dir, "broken", {
      "a.ts": `import { Bucket } from "@intentius/chant-lexicon-aws";

export const dataBucket = new Bucket({
  BucketName: "a-bucket",
});
`,
      "b.ts": `import { Bucket } from "@intentius/chant-lexicon-aws";

export const dataBucket = new Bucket({
  BucketName: "b-bucket",
});
`,
    });

    const results = await checkExamplesBuild(dir);
    const broken = results.find((r) => r.example === "broken");
    expect(broken?.ok).toBe(false);
    expect(broken?.detail).toMatch(/Duplicate export name "dataBucket" found/);
  });

  test("an empty src/ directory is skipped, not reported as a failure", async () => {
    writeLexiconDirWithExample(dir, "empty", {});
    const results = await checkExamplesBuild(dir);
    expect(results.find((r) => r.example === "empty")).toBeUndefined();
  });

  test("returns [] when there is no examples/ directory at all", async () => {
    const noExamplesDir = mkdtempSync(join(tmpdir(), "chant-check-lexicon-examples-none-"));
    try {
      expect(await checkExamplesBuild(noExamplesDir)).toEqual([]);
    } finally {
      rmSync(noExamplesDir, { recursive: true, force: true });
    }
  });
});
