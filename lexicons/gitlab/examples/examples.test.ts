import { describeAllExamples, describeExample } from "@intentius/chant-test-utils/example-harness";
import { describe, test, expect } from "vitest";
import { lintCommand } from "@intentius/chant/cli/commands/lint";
import { gitlabSerializer } from "@intentius/chant-lexicon-gitlab";
import { resolve } from "path";
import { readdirSync } from "fs";

const config = {
  lexicon: "gitlab",
  serializer: gitlabSerializer,
  outputKey: "gitlab",
  examplesDir: import.meta.dirname,
};

describeAllExamples(config, {
  "getting-started": {
    checks: (output) => {
      expect(output).toContain("stages:");
      expect(output).toContain("build:");
      expect(output).toContain("test:");
      expect(output).toContain("stage:");
      expect(output).toContain("script:");
    },
  },
  "node-pipeline": {
    checks: (output) => {
      expect(output).toContain("stages:");
      expect(output).toContain("build:");
      expect(output).toContain("test:");
      expect(output).toContain("stage:");
      expect(output).toContain("script:");
      expect(output).toContain("npm install");
    },
  },
  "python-pipeline": {
    checks: (output) => {
      expect(output).toContain("stages:");
      expect(output).toContain("test:");
      expect(output).toContain("stage:");
      expect(output).toContain("script:");
      expect(output).toContain("python");
    },
  },
  "docker-build": {
    checks: (output) => {
      expect(output).toContain("stages:");
      expect(output).toContain("stage:");
      expect(output).toContain("script:");
      expect(output).toContain("docker");
    },
  },
  "review-app": {
    checks: (output) => {
      expect(output).toContain("stages:");
      expect(output).toContain("stage:");
      expect(output).toContain("script:");
      expect(output).toContain("environment:");
    },
  },
  "multi-stage-deploy": {
    skipLint: true,
    checks: (output) => {
      expect(output).toContain("stages:");
      expect(output).toContain("stage:");
      expect(output).toContain("script:");
      expect(output).toContain("deploy");
      expect(output).toContain("environment:");
      expect(output).toContain("staging");
      expect(output).toContain("when: manual");
    },
  },
  "monorepo-pipeline": {
    skipLint: true,
    checks: (output) => {
      expect(output).toContain("stages:");
      expect(output).toContain("trigger:");
      expect(output).toContain("include:");
      expect(output).toContain("packages/api");
      expect(output).toContain("changes:");
    },
  },
  "docs-snippets": { skipLint: true, skipBuild: true },
});

// docs-snippets has a unique pattern: relaxed lint + file import validation
describe("gitlab docs-snippets example", () => {
  const srcDir = resolve(import.meta.dirname, "docs-snippets", "src");

  test("lint runs without crashing", async () => {
    const result = await lintCommand({
      path: srcDir,
      format: "stylish",
      fix: true,
    });
    expect(result.output).toBeDefined();
  });

  test("all snippet files can be imported", async () => {
    const files = readdirSync(srcDir).filter((f) => f.endsWith(".ts") && f !== "_.ts");
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(() => require(resolve(srcDir, file))).not.toThrow();
    }
  }, 30_000);
});
