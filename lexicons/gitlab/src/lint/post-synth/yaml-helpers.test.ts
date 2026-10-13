import { describe, test, expect } from "vitest";
import {
  extractJobs,
  extractStages,
  extractGlobalVariables,
  extractJobSection,
  extractScriptCommands,
  topLevelSections,
  topLevelKey,
} from "./yaml-helpers";

// The reproduction from #3256.
const ISSUE_3256 = `stages:
  - build
  - deploy

build:
  stage: build
  script:
    - make

Build_Docs:
  stage: build
  script:
    - make docs

deploy:
  stage: deploy
  needs:
    - job: build
      artifacts: true
    - job: Build_Docs
  script:
    - ./deploy.sh
`;

describe("extractJobs", () => {
  test("reads a job id that starts with a capital and needs after an artifacts: line (#3256)", () => {
    const jobs = extractJobs(ISSUE_3256);
    expect([...jobs.keys()]).toEqual(["build", "Build_Docs", "deploy"]);
    expect(jobs.get("Build_Docs")?.stage).toBe("build");
    expect(jobs.get("deploy")?.needs).toEqual(["build", "Build_Docs"]);
  });

  test("skips global keywords, including the deprecated global forms", () => {
    const yaml = `stages: [build]
variables:
  FOO: bar
default:
  image: node:20
include:
  - local: ci/other.yml
workflow:
  name: main
image: node:20
services:
  - docker:dind
cache:
  paths: [node_modules]
before_script:
  - echo hi
after_script:
  - echo bye
build:
  stage: build
  script: make
`;
    expect([...extractJobs(yaml).keys()]).toEqual(["build"]);
  });

  test("keeps hidden jobs and reads extends: as a string or a list", () => {
    const yaml = `.base:
  image: node:20

.lint-base:
  stage: test

lint:
  extends: .base
  script: npm run lint

test:
  extends:
    - .base
    - .lint-base
  script: npm test
`;
    const jobs = extractJobs(yaml);
    expect(jobs.has(".base")).toBe(true);
    expect(jobs.get("lint")?.extends).toEqual([".base"]);
    expect(jobs.get("test")?.extends).toEqual([".base", ".lint-base"]);
  });

  test("reads every needs: form", () => {
    const yaml = `a:
  script: x
b:
  script: x
c:
  script: x
plain:
  needs: [a, 'b']
  script: x
maps:
  needs:
    - job: a
      artifacts: true
    - job: b
      optional: true
    - job: c
      parallel:
        matrix:
          - PROVIDER: aws
  script: x
cross:
  needs:
    - pipeline: $PARENT_PIPELINE_ID
      job: generate
    - project: group/other
      job: build
      ref: main
      artifacts: true
    - a
  script: x
none:
  needs: []
  script: x
scalar:
  needs: a
  script: x
`;
    const jobs = extractJobs(yaml);
    expect(jobs.get("plain")?.needs).toEqual(["a", "b"]);
    expect(jobs.get("maps")?.needs).toEqual(["a", "b", "c"]);
    expect(jobs.get("maps")?.optionalNeeds).toEqual(["b"]);
    expect(jobs.get("cross")?.needs).toEqual(["a"]);
    expect(jobs.get("none")?.needs).toEqual([]);
    expect(jobs.get("scalar")?.needs).toEqual(["a"]);
    expect(jobs.get("a")?.needs).toBeUndefined();
  });

  test("reads job ids with colons, spaces and quotes", () => {
    const yaml = `build:linux:
  stage: build
  script: make
"deploy prod":
  needs: ["build:linux"]
  script: ./deploy
'it''s':
  script: x
`;
    const jobs = extractJobs(yaml);
    expect([...jobs.keys()]).toEqual(["build:linux", "deploy prod", "it's"]);
    expect(jobs.get("deploy prod")?.needs).toEqual(["build:linux"]);
  });

  test("does not depend on blank lines between jobs", () => {
    const yaml = `build:
  stage: build
  script: make
test:
  stage: test
  needs: [build]
  script: make test
`;
    const jobs = extractJobs(yaml);
    expect(jobs.get("test")?.needs).toEqual(["build"]);
    expect(jobs.get("test")?.stage).toBe("test");
  });

  test("unparseable YAML gives no jobs", () => {
    expect(extractJobs("build:\n  script: [unclosed\n").size).toBe(0);
  });
});

describe("extractStages", () => {
  test("reads block and flow lists", () => {
    expect(extractStages("stages:\n  - build\n  - 'test'\n")).toEqual(["build", "test"]);
    expect(extractStages("stages: [build, deploy]\n")).toEqual(["build", "deploy"]);
    expect(extractStages("build:\n  script: x\n")).toEqual([]);
  });
});

describe("extractGlobalVariables", () => {
  test("reads the expanded value:/description: form without treating its keys as variables", () => {
    const vars = extractGlobalVariables(`variables:
  PLAIN: one
  DEPLOY_ENV:
    value: staging
    description: Target environment
`);
    expect([...vars.entries()]).toEqual([
      ["PLAIN", "one"],
      ["DEPLOY_ENV", "staging"],
    ]);
  });
});

describe("topLevelSections / extractJobSection", () => {
  test("topLevelKey unquotes and keeps colons inside the key", () => {
    expect(topLevelKey("build:linux:")).toBe("build:linux");
    expect(topLevelKey('"deploy prod":')).toBe("deploy prod");
    expect(topLevelKey("Build_Docs:")).toBe("Build_Docs");
    expect(topLevelKey("  script:")).toBeUndefined();
    expect(topLevelKey("# build:")).toBeUndefined();
    expect(topLevelKey("---")).toBeUndefined();
  });

  test("cuts at top-level keys, not blank lines", () => {
    const yaml = `build:
  script:
    - make

    - make install
test:
  script: make test
`;
    expect(topLevelSections(yaml).map((s) => s.key)).toEqual(["build", "test"]);
    expect(extractJobSection(yaml, "build")).toContain("make install");
    expect(extractJobSection(yaml, "build")).not.toContain("make test");
  });

  test("matches the exact key", () => {
    const yaml = `build:linux:
  script: linux

build:
  script: plain
`;
    expect(extractJobSection(yaml, "build")).toBe("build:\n  script: plain");
    expect(extractJobSection(yaml, "Build_Docs")).toBeNull();
  });

  test("a job preceded by a comment is still found", () => {
    const yaml = `build:
  script: make

# the docs job
Build_Docs:
  script:
    - make docs
`;
    expect(extractJobSection(yaml, "build")).toBe("build:\n  script: make");
    expect(extractScriptCommands(yaml)).toEqual([
      { job: "build", command: "make" },
      { job: "Build_Docs", command: "make docs" },
    ]);
  });
});
