import { describe, test, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { GitLabParser } from "./parser";
import { GitLabGenerator } from "./generator";

const parser = new GitLabParser();
const generator = new GitLabGenerator();

const pipelinesDir = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  "testdata",
  "pipelines",
);

describe("roundtrip: parse → generate", () => {
  // ---- inline tests (existing smoke tests) ----

  test("simple pipeline roundtrip", () => {
    const yaml = `
stages:
  - test

test-job:
  stage: test
  script:
    - npm test
`;
    const ir = parser.parse(yaml);
    const files = generator.generate(ir);

    expect(files).toHaveLength(1);
    const content = files[0].content;

    // Should produce valid-looking TypeScript
    expect(content).toContain("import");
    expect(content).toContain("export const");
    expect(content).toContain("new Job(");
    expect(content).toContain('"test"');
    expect(content).toContain("npm test");
  });

  test("multi-job pipeline roundtrip", () => {
    const yaml = `
stages:
  - build
  - test
  - deploy

build-app:
  stage: build
  script:
    - npm ci
    - npm run build

run-tests:
  stage: test
  script:
    - npm test

deploy-prod:
  stage: deploy
  script:
    - deploy.sh
`;
    const ir = parser.parse(yaml);
    // the Pipeline and 3 jobs
    expect(ir.resources).toHaveLength(4);

    const files = generator.generate(ir);
    const content = files[0].content;

    expect(content).toContain("buildApp");
    expect(content).toContain("runTests");
    expect(content).toContain("deployProd");
    expect(content).toContain("new Pipeline(");
    expect(content).toContain('stages: ["build", "test", "deploy"]');
  });

  test("pipeline with defaults and workflow roundtrip", () => {
    const yaml = `
default:
  interruptible: true

workflow:
  name: CI

test-job:
  stage: test
  script:
    - test
`;
    const ir = parser.parse(yaml);
    const files = generator.generate(ir);
    const content = files[0].content;

    expect(content).toContain("new Default(");
    expect(content).toContain("new Workflow(");
    expect(content).toContain("new Job(");
  });

  // ---- fixture-based tests ----

  test("simple.gitlab-ci.yml fixture roundtrip", () => {
    const yaml = readFileSync(join(pipelinesDir, "simple.gitlab-ci.yml"), "utf-8");
    const ir = parser.parse(yaml);
    const files = generator.generate(ir);

    expect(files).toHaveLength(1);
    const content = files[0].content;

    // the Pipeline and 1 job
    expect(ir.resources).toHaveLength(2);
    expect(content).toContain("new Job(");
    expect(content).toContain("npm ci");
    expect(content).toContain("npm test");
    expect(content).toContain("node:22-alpine");
  });

  test("multi-stage.gitlab-ci.yml fixture roundtrip", () => {
    const yaml = readFileSync(join(pipelinesDir, "multi-stage.gitlab-ci.yml"), "utf-8");
    const ir = parser.parse(yaml);
    const files = generator.generate(ir);

    const content = files[0].content;

    // the Pipeline and 4 jobs: build-app, lint, unit-tests, deploy-staging
    expect(ir.resources).toHaveLength(5);
    expect(content).toContain("buildApp");
    expect(content).toContain("lint");
    expect(content).toContain("unitTests");
    expect(content).toContain("deployStaging");
    expect(content).toContain('stages: ["build", "test", "deploy"]');
    // Artifacts and cache references
    expect(content).toContain("dist/");
    expect(content).toContain("package-lock.json");
  });

  test("docker-build.gitlab-ci.yml fixture roundtrip", () => {
    const yaml = readFileSync(join(pipelinesDir, "docker-build.gitlab-ci.yml"), "utf-8");
    const ir = parser.parse(yaml);
    const files = generator.generate(ir);

    const content = files[0].content;

    // the Pipeline and 2 jobs
    expect(ir.resources).toHaveLength(3);
    expect(content).toContain("buildImage");
    expect(content).toContain("pushLatest");
    expect(content).toContain("docker:27-cli");
    expect(content).toContain("docker:27-dind");
    expect(content).toContain("docker build");
    expect(content).toContain("docker push");
  });

  test("deploy-envs.gitlab-ci.yml fixture roundtrip", () => {
    const yaml = readFileSync(join(pipelinesDir, "deploy-envs.gitlab-ci.yml"), "utf-8");
    const ir = parser.parse(yaml);
    const files = generator.generate(ir);

    const content = files[0].content;

    // the Pipeline and 5 jobs: build, deploy-review, stop-review, deploy-staging, deploy-production
    expect(ir.resources).toHaveLength(6);
    expect(content).toContain("deployReview");
    expect(content).toContain("stopReview");
    expect(content).toContain("deployStaging");
    expect(content).toContain("deployProduction");
    // Environment constructs
    expect(content).toContain("review/$CI_COMMIT_REF_SLUG");
    expect(content).toContain("staging");
    expect(content).toContain("production");
  });

  test("includes-templates.gitlab-ci.yml fixture roundtrip", () => {
    const yaml = readFileSync(join(pipelinesDir, "includes-templates.gitlab-ci.yml"), "utf-8");
    const ir = parser.parse(yaml);
    const files = generator.generate(ir);

    const content = files[0].content;

    // default + build + unit-test + integration-test + deploy
    expect(ir.resources.length).toBeGreaterThanOrEqual(3);
    expect(content).toContain("new Default(");
    // Include references are the Pipeline's include (#3742)
    expect(content).toContain("new Pipeline(");
    expect(content).toContain("Auto-DevOps.gitlab-ci.yml");
    expect(content).toContain("interruptible");
  });

  test("monorepo.gitlab-ci.yml fixture roundtrip", () => {
    const yaml = readFileSync(join(pipelinesDir, "monorepo.gitlab-ci.yml"), "utf-8");
    const ir = parser.parse(yaml);
    const files = generator.generate(ir);

    const content = files[0].content;

    // the Pipeline, frontend, backend, e2e-matrix, deploy-all
    expect(ir.resources).toHaveLength(5);
    expect(content).toContain("frontend");
    expect(content).toContain("backend");
    expect(content).toContain("e2eMatrix");
    expect(content).toContain("deployAll");
    // Monorepo-specific constructs
    expect(content).toContain("cypress");
  });

  // ---- fixture directory sweep ----

  test("all pipeline fixtures parse and generate without error", () => {
    const fixtures = readdirSync(pipelinesDir).filter((f) => f.endsWith(".yml"));
    expect(fixtures.length).toBeGreaterThanOrEqual(6);

    for (const fixture of fixtures) {
      const yaml = readFileSync(join(pipelinesDir, fixture), "utf-8");
      const ir = parser.parse(yaml);
      expect(ir.resources.length).toBeGreaterThan(0);

      const files = generator.generate(ir);
      expect(files.length).toBeGreaterThan(0);
      expect(files[0].content).toContain("import");
      expect(files[0].content).toContain("export const");
    }
  });
});

describe("roundtrip: parse → generate → build (#3742)", () => {
  test("top-level include, variables and stages come back from the build, an unused stage and the order included", async () => {
    const { mkdirSync, rmSync, writeFileSync } = await import("fs");
    const { build } = await import("@intentius/chant/build");
    const { gitlabSerializer } = await import("../serializer");
    const { gitlabPlugin } = await import("../plugin");
    const { parseYAML } = await import("@intentius/chant/yaml");

    const yaml = `
include:
  - local: ci/shared.yml
variables:
  GIT_DEPTH: "0"
stages: [review, apply, ops]

plan:
  stage: review
  script: [plan.sh]

apply:
  stage: apply
  script: [apply.sh]
`;
    const [file] = generator.generate(parser.parse(yaml));
    expect(file!.content).toContain("new Pipeline(");
    expect(file!.content).toContain("new Include(");

    const dir = join(dirname(fileURLToPath(import.meta.url)), `.import-build-tmp-${process.pid}`);
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src", file!.path), file!.content);
      const result = await build(join(dir, "src"), [gitlabSerializer], undefined, {
        intrinsics: gitlabPlugin.intrinsics!(),
        lexicons: ["gitlab"],
      });
      expect(result.errors).toEqual([]);
      const out = result.outputs.get("gitlab");
      const doc = parseYAML(typeof out === "string" ? out : String((out as { primary?: string }).primary)) as Record<string, unknown>;
      expect(doc.include).toEqual([{ local: "ci/shared.yml" }]);
      expect(doc.variables).toEqual({ GIT_DEPTH: "0" });
      expect(doc.stages).toEqual(["review", "apply", "ops"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
