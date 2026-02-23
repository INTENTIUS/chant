import { describe, test, expect } from "bun:test";
import { lintCommand } from "../../packages/core/src/cli/commands/lint";
import { build } from "../../packages/core/src/build";
import { resolve } from "path";
import { gitlabSerializer } from "../../lexicons/gitlab/src/serializer";

const srcDir = resolve(import.meta.dir, "src");

describe("gitlab-aws-alb-infra example", () => {
  test("passes strict lint", async () => {
    const result = await lintCommand({
      path: srcDir,
      format: "stylish",
      fix: true,
    });

    if (!result.success || result.errorCount > 0 || result.warningCount > 0) {
      console.log(result.output);
    }

    expect(result.success).toBe(true);
    expect(result.errorCount).toBe(0);
    expect(result.warningCount).toBe(0);
  });

  test("build produces valid GitLab CI YAML", async () => {
    const result = await build(srcDir, [gitlabSerializer]);

    expect(result.errors).toHaveLength(0);

    const output = result.outputs.get("gitlab");
    expect(output).toBeDefined();

    expect(output).toContain("stages:");
    expect(output).toContain("deploy");
    expect(output).toContain("cloudformation");
  });
});
