import { describe, test, expect } from "bun:test";
import { lintCommand } from "../../packages/core/src/cli/commands/lint";
import { build } from "../../packages/core/src/build";
import { resolve } from "path";
import { awsSerializer } from "../../lexicons/aws/src/serializer";
import { gitlabSerializer } from "../../lexicons/gitlab/src/serializer";

const srcDir = resolve(import.meta.dir, "src");

describe("cross-lexicon example", () => {
  test("passes strict lint", async () => {
    const result = await lintCommand({ path: srcDir, format: "stylish" });
    expect(result.errorCount).toBe(0);
  });

  test("build produces both AWS and GitLab outputs", async () => {
    const result = await build(srcDir, [awsSerializer, gitlabSerializer]);
    expect(result.errors).toHaveLength(0);

    // Two lexicon outputs
    expect(result.outputs.size).toBe(2);
    expect(result.outputs.has("aws")).toBe(true);
    expect(result.outputs.has("gitlab")).toBe(true);

    // AWS output: valid CloudFormation with resources + cross-lexicon Output
    const awsOutput = result.outputs.get("aws")!;
    const cfText = typeof awsOutput === "string" ? awsOutput : awsOutput.primary;
    const cfTemplate = JSON.parse(cfText);
    expect(cfTemplate.AWSTemplateFormatVersion).toBe("2010-09-09");
    expect(cfTemplate.Resources.deployBucket).toBeDefined();
    expect(cfTemplate.Resources.deployRole).toBeDefined();
    // Auto-generated output for the cross-lexicon AttrRef
    expect(cfTemplate.Outputs).toBeDefined();

    // GitLab output: valid YAML with stages and jobs
    const gitlabOutput = typeof result.outputs.get("gitlab") === "string"
      ? result.outputs.get("gitlab")!
      : (result.outputs.get("gitlab") as { primary: string }).primary;
    expect(gitlabOutput).toContain("stages:");
    expect(gitlabOutput).toContain("deploy:");

    // Deploy ordering: AWS before GitLab
    expect(result.manifest.deployOrder).toEqual(["aws", "gitlab"]);
  });
});
