import { describe, test, expect } from "bun:test";
import { lintCommand } from "../../../../packages/core/src/cli/commands/lint";
import { build } from "../../../../packages/core/src/build";
import { resolve } from "path";
import { awsSerializer } from "../../src/serializer";

const srcDir = resolve(import.meta.dir, "src");

describe("core-concepts example", () => {
  test("lint runs without crashing", async () => {
    const result = await lintCommand({
      path: srcDir,
      format: "stylish",
      fix: true,
    });

    // Snippets are isolated examples — warnings are expected.
    expect(result.output).toBeDefined();
  });

  test("all snippet files can be imported", async () => {
    const glob = new Bun.Glob("*.ts");
    const files: string[] = [];
    for await (const file of glob.scan({ cwd: srcDir })) {
      if (file === "_.ts" || file === "_.d.ts") continue;
      files.push(file);
    }

    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const fullPath = resolve(srcDir, file);
      expect(() => require(fullPath)).not.toThrow();
    }
  });

  test("build produces valid CloudFormation", async () => {
    const result = await build(srcDir, [awsSerializer]);

    if (result.errors.length > 0) {
      console.log("Build errors:", result.errors);
    }

    expect(result.errors).toHaveLength(0);

    const template = result.outputs.get("aws");
    expect(template).toBeDefined();

    const parsed = JSON.parse(template!);

    expect(parsed.AWSTemplateFormatVersion).toBe("2010-09-09");
    expect(parsed.Resources).toBeDefined();
  });
});
