import { describe, test, expect } from "bun:test";
import { GitLabParser } from "./parser";
import { GitLabGenerator } from "./generator";

const parser = new GitLabParser();
const generator = new GitLabGenerator();

describe("roundtrip: parse → generate", () => {
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
    expect(ir.resources).toHaveLength(3);

    const files = generator.generate(ir);
    const content = files[0].content;

    expect(content).toContain("buildApp");
    expect(content).toContain("runTests");
    expect(content).toContain("deployProd");
    expect(content).toContain("Pipeline stages: build, test, deploy");
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
});
