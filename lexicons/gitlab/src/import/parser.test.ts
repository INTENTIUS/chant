import { describe, test, expect } from "bun:test";
import { GitLabParser } from "./parser";

const parser = new GitLabParser();

describe("GitLabParser", () => {
  test("parses simple pipeline with one job", () => {
    const yaml = `
stages:
  - test

test-job:
  stage: test
  script:
    - npm test
`;
    const ir = parser.parse(yaml);
    expect(ir.resources).toHaveLength(1);
    expect(ir.resources[0].type).toBe("GitLab::CI::Job");
    expect(ir.resources[0].properties.stage).toBe("test");
    expect(ir.resources[0].properties.script).toEqual(["npm test"]);
  });

  test("parses multiple jobs", () => {
    const yaml = `
stages:
  - build
  - test

build-job:
  stage: build
  script:
    - make build

test-job:
  stage: test
  script:
    - make test
`;
    const ir = parser.parse(yaml);
    const jobs = ir.resources.filter((r) => r.type === "GitLab::CI::Job");
    expect(jobs).toHaveLength(2);
  });

  test("parses default settings", () => {
    const yaml = `
default:
  interruptible: true
  timeout: 30 minutes
`;
    const ir = parser.parse(yaml);
    const defaults = ir.resources.find((r) => r.type === "GitLab::CI::Default");
    expect(defaults).toBeDefined();
    expect(defaults!.properties.interruptible).toBe(true);
  });

  test("parses workflow", () => {
    const yaml = `
workflow:
  name: My Pipeline
`;
    const ir = parser.parse(yaml);
    const workflow = ir.resources.find((r) => r.type === "GitLab::CI::Workflow");
    expect(workflow).toBeDefined();
    expect(workflow!.properties.name).toBe("My Pipeline");
  });

  test("preserves spec-native snake_case property keys", () => {
    const yaml = `
test-job:
  stage: test
  before_script:
    - echo setup
  after_script:
    - echo done
  script:
    - npm test
`;
    const ir = parser.parse(yaml);
    expect(ir.resources[0].properties.before_script).toEqual(["echo setup"]);
    expect(ir.resources[0].properties.after_script).toEqual(["echo done"]);
  });

  test("converts kebab-case job names to camelCase", () => {
    const yaml = `
my-test-job:
  stage: test
  script:
    - test
`;
    const ir = parser.parse(yaml);
    expect(ir.resources[0].logicalId).toBe("myTestJob");
  });

  test("preserves original name in metadata", () => {
    const yaml = `
deploy-prod:
  stage: deploy
  script:
    - deploy.sh
`;
    const ir = parser.parse(yaml);
    expect(ir.resources[0].metadata?.originalName).toBe("deploy-prod");
  });

  test("records stages in metadata", () => {
    const yaml = `
stages:
  - build
  - test
  - deploy

test-job:
  stage: test
  script:
    - npm test
`;
    const ir = parser.parse(yaml);
    expect(ir.metadata?.stages).toEqual(["build", "test", "deploy"]);
  });

  test("skips reserved keys as jobs", () => {
    const yaml = `
stages:
  - test
variables:
  NODE_ENV: production
include:
  - local: shared.yml

test-job:
  stage: test
  script:
    - npm test
`;
    const ir = parser.parse(yaml);
    // Only the job should be in resources (not stages, variables, include)
    const jobs = ir.resources.filter((r) => r.type === "GitLab::CI::Job");
    expect(jobs).toHaveLength(1);
  });

  test("handles JSON input", () => {
    const json = JSON.stringify({
      stages: ["test"],
      "test-job": { stage: "test", script: ["npm test"] },
    });
    const ir = parser.parse(json);
    expect(ir.resources).toHaveLength(1);
  });

  test("returns empty parameters (GitLab CI has no parameters)", () => {
    const yaml = `
test-job:
  script:
    - test
`;
    const ir = parser.parse(yaml);
    expect(ir.parameters).toEqual([]);
  });
});
