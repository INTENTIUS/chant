import { describe, test, expect } from "bun:test";
import { lintCommand } from "../../../../packages/core/src/cli/commands/lint";
import { resolve } from "path";

const srcDir = resolve(import.meta.dir, "src");

describe("docs-snippets example", () => {
  test("lint runs without crashing", async () => {
    const result = await lintCommand({
      path: srcDir,
      format: "stylish",
      fix: true,
    });

    // Snippets are isolated examples — warnings (COR001, COR004, etc.) are expected.
    // This test catches broken imports, syntax errors, and unexpected failures.
    expect(result.output).toBeDefined();
  });

  test("all snippet files can be imported", async () => {
    const glob = new Bun.Glob("*.ts");
    const files: string[] = [];
    for await (const file of glob.scan({ cwd: srcDir })) {
      if (file === "_.ts") continue;
      files.push(file);
    }

    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const fullPath = resolve(srcDir, file);
      // Verify each snippet can be loaded without throwing
      expect(() => require(fullPath)).not.toThrow();
    }
  });
});
